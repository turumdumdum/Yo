-- Stage reviews (CLAUDE.md §6, §8). Stage 1, step 5: reviewer assignment, checklists
-- and decisions. All writes go through security-definer functions that check the
-- caller's role; the browser still has no direct write access to request_stages.

alter type public.request_status add value 'approved';
alter type public.request_status add value 'rejected';

-- ---------------------------------------------------------------------------
-- Organization setting: may a person review their own request?
-- Off by default (separation of duties); small teams can turn it on.
-- ---------------------------------------------------------------------------

alter table public.organizations add column allow_self_review boolean not null default false;
grant update (allow_self_review) on public.organizations to authenticated;

-- Settings changes are audited (CLAUDE.md §8).
create function private.audit_organization_settings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  changes jsonb := '{}'::jsonb;
begin
  if new.name is distinct from old.name then
    changes := changes || jsonb_build_object('name', jsonb_build_array(old.name, new.name));
  end if;
  if new.google_sign_in_only is distinct from old.google_sign_in_only then
    changes := changes || jsonb_build_object('google_sign_in_only', new.google_sign_in_only);
  end if;
  if new.restrict_to_verified_domains is distinct from old.restrict_to_verified_domains then
    changes := changes || jsonb_build_object('restrict_to_verified_domains', new.restrict_to_verified_domains);
  end if;
  if new.allow_self_review is distinct from old.allow_self_review then
    changes := changes || jsonb_build_object('allow_self_review', new.allow_self_review);
  end if;
  if changes <> '{}'::jsonb then
    insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
    values (new.id, (select auth.uid()), 'organization.settings_changed', 'organization', new.id::text, changes);
  end if;
  return new;
end;
$$;

create trigger organizations_audit_settings
after update on public.organizations
for each row execute function private.audit_organization_settings();

-- ---------------------------------------------------------------------------
-- Members: show who is who, and stop adding people without an invitation.
-- ---------------------------------------------------------------------------

alter table public.memberships add column email text;
update public.memberships m set email = u.email from auth.users u where u.id = m.user_id;

create function private.set_membership_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.email := (select u.email from auth.users u where u.id = new.user_id);
  return new;
end;
$$;

create trigger memberships_set_email
before insert on public.memberships
for each row execute function private.set_membership_email();

-- Users join an organization only by invitation or verified domain (CLAUDE.md §8),
-- so org admins can no longer insert memberships directly.
drop policy memberships_insert_admin on public.memberships;
revoke insert on public.memberships from authenticated;

-- ---------------------------------------------------------------------------
-- Stage review data
-- ---------------------------------------------------------------------------

alter table public.request_stages
  -- [{"label": text, "checked": boolean}], a snapshot taken at submission
  add column checklist jsonb not null default '[]'::jsonb check (jsonb_typeof(checklist) = 'array'),
  add column decision_comment text check (char_length(decision_comment) <= 2000),
  add column conditions text check (char_length(conditions) <= 2000),
  add column decided_by uuid references auth.users (id) on delete set null,
  add column decided_at timestamptz;

-- An assigned reviewer must be able to open the request. Security definer, because a
-- policy on requests that read request_stages under RLS would recurse.
create function private.is_stage_reviewer(target_request uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.request_stages s
    where s.request_id = target_request
      and s.reviewer_id = (select auth.uid())
  );
$$;

revoke all on function private.is_stage_reviewer(uuid) from public;
grant execute on function private.is_stage_reviewer(uuid) to authenticated, service_role;

create policy requests_select_stage_reviewer on public.requests
  for select to authenticated
  using (status <> 'draft' and private.is_stage_reviewer(id) and private.is_org_member(org_id));

-- Raises unless the caller may review this stage. Returns the stage, locked.
create function private.reviewable_stage(p_stage_id uuid)
returns public.request_stages
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  stage public.request_stages;
  request public.requests;
begin
  if caller is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;

  select s.* into stage from public.request_stages s where s.id = p_stage_id;
  if not found or not private.is_org_member(stage.org_id) then
    raise exception 'stage not found' using errcode = 'P0002';
  end if;

  -- Lock the request first: it serializes decisions on its stages, so the final
  -- decision is computed from a consistent picture.
  select r.* into request from public.requests r where r.id = stage.request_id for update;
  select s.* into stage from public.request_stages s where s.id = p_stage_id for update;

  if not (
    private.has_org_role(stage.org_id, array['org_admin', 'process_manager']::public.org_role[])
    -- reviewer_id is null on an unassigned stage: the comparison must not yield null.
    or stage.reviewer_id is not distinct from caller
  ) then
    raise exception 'you are not a reviewer of this stage' using errcode = '42501';
  end if;

  if request.requester_id = caller
     and not (select o.allow_self_review from public.organizations o where o.id = stage.org_id) then
    raise exception 'you cannot review your own request' using errcode = '42501';
  end if;

  if stage.status not in ('In review', 'Waiting for requester') then
    raise exception 'this stage is not open for review' using errcode = 'P0001';
  end if;

  return stage;
end;
$$;

revoke all on function private.reviewable_stage(uuid) from public;

-- ---------------------------------------------------------------------------
-- RPC: assign a reviewer (org admin or process manager)
-- ---------------------------------------------------------------------------

create function public.assign_stage_reviewer(p_stage_id uuid, p_reviewer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  stage public.request_stages;
begin
  if (select auth.uid()) is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;

  select s.* into stage from public.request_stages s where s.id = p_stage_id for update;
  if not found or not private.is_org_member(stage.org_id) then
    raise exception 'stage not found' using errcode = 'P0002';
  end if;
  if not private.has_org_role(stage.org_id, array['org_admin', 'process_manager']::public.org_role[]) then
    raise exception 'only an org admin or process manager can assign reviewers' using errcode = '42501';
  end if;
  if stage.status not in ('Not started', 'In review', 'Waiting for requester') then
    raise exception 'this stage is not open for review' using errcode = 'P0001';
  end if;
  if p_reviewer_id is not null and not exists (
    select 1 from public.memberships m
    where m.org_id = stage.org_id
      and m.user_id = p_reviewer_id
      and m.role in ('org_admin', 'process_manager', 'reviewer')
  ) then
    raise exception 'the reviewer must be a member with the Reviewer, Process manager or Org admin role'
      using errcode = 'P0001';
  end if;

  update public.request_stages set reviewer_id = p_reviewer_id where id = p_stage_id;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (stage.org_id, (select auth.uid()), 'stage.reviewer_assigned', 'request_stage', stage.id::text,
          jsonb_build_object('request_id', stage.request_id, 'stage', stage.name, 'reviewer_id', p_reviewer_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: tick a checklist item
-- ---------------------------------------------------------------------------

create function public.set_stage_checklist_item(p_stage_id uuid, p_index integer, p_checked boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  stage public.request_stages := private.reviewable_stage(p_stage_id);
  updated jsonb;
begin
  if p_index is null or p_checked is null or p_index < 0 or p_index >= jsonb_array_length(stage.checklist) then
    raise exception 'unknown checklist item' using errcode = 'P0001';
  end if;

  update public.request_stages
  set checklist = jsonb_set(checklist, array[p_index::text, 'checked'], to_jsonb(p_checked))
  where id = p_stage_id
  returning checklist into updated;

  return updated;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: record a decision. When the last open stage is decided, the request gets
-- its final decision: rejected if any stage was rejected, approved otherwise.
-- ---------------------------------------------------------------------------

create function public.decide_stage(p_stage_id uuid, p_decision text, p_comment text, p_conditions text)
returns public.request_stages
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  stage public.request_stages := private.reviewable_stage(p_stage_id);
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_conditions text := nullif(btrim(coalesce(p_conditions, '')), '');
  final_status public.request_status;
begin
  if p_decision is null or p_decision not in ('Approved', 'Approved with conditions', 'Rejected') then
    raise exception 'unknown decision' using errcode = 'P0001';
  end if;
  if p_decision = 'Approved' and exists (
    select 1 from jsonb_array_elements(stage.checklist) item where not coalesce((item ->> 'checked')::boolean, false)
  ) then
    raise exception 'complete the checklist before approving, or approve with conditions' using errcode = 'P0001';
  end if;
  if p_decision = 'Approved with conditions' and v_conditions is null then
    raise exception 'describe the conditions' using errcode = 'P0001';
  end if;
  if p_decision = 'Rejected' and v_comment is null then
    raise exception 'explain why the stage is rejected' using errcode = 'P0001';
  end if;

  update public.request_stages
  set status = p_decision,
      decision_comment = v_comment,
      conditions = case when p_decision = 'Approved with conditions' then v_conditions end,
      decided_by = caller,
      decided_at = now(),
      sla_paused = false
  where id = p_stage_id
  returning * into stage;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (stage.org_id, caller, 'stage.decided', 'request_stage', stage.id::text,
          jsonb_build_object('request_id', stage.request_id, 'stage', stage.name, 'decision', p_decision));

  if not exists (
    select 1 from public.request_stages s
    where s.request_id = stage.request_id
      and s.status in ('Not started', 'In review', 'Waiting for requester')
  ) then
    final_status := case
      when exists (select 1 from public.request_stages s where s.request_id = stage.request_id and s.status = 'Rejected')
        then 'rejected'
      else 'approved'
    end;
    update public.requests set status = final_status where id = stage.request_id;

    insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
    values (stage.org_id, caller, 'request.' || final_status::text, 'request', stage.request_id::text, '{}'::jsonb);
  end if;

  return stage;
end;
$$;

revoke all on function public.assign_stage_reviewer(uuid, uuid) from public, anon;
revoke all on function public.set_stage_checklist_item(uuid, integer, boolean) from public, anon;
revoke all on function public.decide_stage(uuid, text, text, text) from public, anon;
grant execute on function public.assign_stage_reviewer(uuid, uuid) to authenticated;
grant execute on function public.set_stage_checklist_item(uuid, integer, boolean) to authenticated;
grant execute on function public.decide_stage(uuid, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Submission stores each stage's checklist.
-- ---------------------------------------------------------------------------

create or replace function public.submit_request(
  p_request_id uuid,
  p_answers jsonb,
  p_risk_tier text,
  p_risk_score integer,
  p_risk_reasons jsonb,
  -- [{"name", "status", "note", "sla_business_days", "sla_due_at", "checklist": [text]}] in display order
  p_stages jsonb
)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  submitted public.requests;
begin
  if jsonb_typeof(p_stages) <> 'array' or jsonb_array_length(p_stages) = 0 then
    raise exception 'a submitted request needs at least one stage' using errcode = 'P0001';
  end if;

  update public.requests r
  set status = 'in_review',
      answers = p_answers,
      request_type = p_answers ->> 'requestType',
      risk_tier = p_risk_tier,
      risk_score = p_risk_score,
      risk_reasons = p_risk_reasons,
      submitted_at = now()
  where r.id = p_request_id
    and r.status = 'draft'
  returning r.* into submitted;

  if not found then
    raise exception 'request is not a draft' using errcode = 'P0001';
  end if;

  insert into public.request_stages
    (org_id, request_id, position, name, status, note, sla_business_days, sla_due_at, checklist)
  select submitted.org_id, submitted.id, s.ordinality::integer, s.stage ->> 'name', s.stage ->> 'status',
         s.stage ->> 'note', (s.stage ->> 'sla_business_days')::integer, (s.stage ->> 'sla_due_at')::timestamptz,
         coalesce(
           (select jsonb_agg(jsonb_build_object('label', item, 'checked', false))
            from jsonb_array_elements_text(
              case when jsonb_typeof(s.stage -> 'checklist') = 'array' then s.stage -> 'checklist' else '[]'::jsonb end
            ) item),
           '[]'::jsonb
         )
  from jsonb_array_elements(p_stages) with ordinality as s(stage, ordinality);

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (submitted.org_id, submitted.requester_id, 'request.submitted', 'request', submitted.id::text,
          jsonb_build_object(
            'risk_tier', p_risk_tier,
            'risk_score', p_risk_score,
            'stages', (select jsonb_agg(s ->> 'name') from jsonb_array_elements(p_stages) s
                       where s ->> 'status' <> 'Not required')
          ));

  return submitted;
end;
$$;
