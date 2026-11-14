-- Structured review forms (CLAUDE.md §6, §7, §8). Each organization can configure the
-- form of a stage; the form is copied into the stage at submission, so later changes
-- never alter a review in progress. Reviewers fill it in; approving requires the
-- required answers. The answers are visible to reviewers, managers and auditors, not to
-- the requester (least privilege).

-- ---------------------------------------------------------------------------
-- Per-organization forms. Written by the API (validated with the shared schema).
-- ---------------------------------------------------------------------------

create table public.review_templates (
  org_id uuid not null references public.organizations (id) on delete cascade,
  stage_name text not null check (char_length(stage_name) between 1 and 120),
  fields jsonb not null check (jsonb_typeof(fields) = 'array'),
  rules jsonb not null default '[]'::jsonb check (jsonb_typeof(rules) = 'array'),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (org_id, stage_name),
  check (pg_column_size(fields) + pg_column_size(rules) <= 131072)
);

revoke all on public.review_templates from anon, authenticated;
grant select on public.review_templates to authenticated;
grant all on public.review_templates to service_role;

alter table public.review_templates enable row level security;

create policy review_templates_require_strong_session on public.review_templates
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

create policy review_templates_select_member on public.review_templates
  for select to authenticated
  using (private.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- The form and answers of each stage
-- ---------------------------------------------------------------------------

alter table public.request_stages
  add column review_fields jsonb not null default '[]'::jsonb check (jsonb_typeof(review_fields) = 'array'),
  add column review_rules jsonb not null default '[]'::jsonb check (jsonb_typeof(review_rules) = 'array'),
  add column review_answers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(review_answers) = 'object' and pg_column_size(review_answers) <= 65536);

-- Everything except review_answers stays readable for whoever can see the request.
revoke select on public.request_stages from authenticated;
grant select (
  id, org_id, request_id, position, name, status, note, reviewer_id, sla_business_days, sla_due_at,
  sla_paused, created_at, updated_at, checklist, decision_comment, conditions, decided_by, decided_at,
  review_fields, review_rules
) on public.request_stages to authenticated;

-- First problem with the answers, or null. `p_for_decision` also requires required fields.
-- Keep in sync with validateReviewAnswers() in packages/shared/src/reviewForms.ts.
create function private.review_answers_error(p_fields jsonb, p_answers jsonb, p_for_decision boolean)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  f jsonb;
  v jsonb;
  t text;
  label text;
begin
  for f in select value from jsonb_array_elements(p_fields) loop
    v := p_answers -> (f ->> 'key');
    t := f ->> 'type';
    label := f ->> 'label';
    if v is null or v = 'null'::jsonb
       or (jsonb_typeof(v) = 'string' and btrim(v #>> '{}') = '')
       or (jsonb_typeof(v) = 'array' and jsonb_array_length(v) = 0) then
      if p_for_decision and coalesce((f ->> 'required')::boolean, false) then
        return format('answer "%s"', label);
      end if;
      continue;
    end if;
    if t = 'select' then
      if jsonb_typeof(v) <> 'string' or not coalesce(f -> 'options', '[]'::jsonb) ? (v #>> '{}') then
        return format('choose one of the options for "%s"', label);
      end if;
    elsif t = 'multiselect' then
      if jsonb_typeof(v) <> 'array' or exists (
        select 1 from jsonb_array_elements(v) e
        where jsonb_typeof(e) <> 'string' or not coalesce(f -> 'options', '[]'::jsonb) ? (e #>> '{}')
      ) then
        return format('choose from the options for "%s"', label);
      end if;
    elsif t = 'date' then
      if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
        return format('enter a valid date for "%s"', label);
      end if;
      begin
        perform (v #>> '{}')::date;
      exception when others then
        return format('enter a valid date for "%s"', label);
      end;
    elsif jsonb_typeof(v) <> 'string' or char_length(v #>> '{}') > 2000 then
      return format('use at most 2000 characters for "%s"', label);
    end if;
  end loop;
  return null;
end;
$$;

revoke all on function private.review_answers_error(jsonb, jsonb, boolean) from public;

-- Saves the reviewer's answers as they type. Unknown keys are dropped; required fields
-- are only enforced when deciding.
create function public.save_stage_review_answers(p_stage_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  stage public.request_stages := private.reviewable_stage(p_stage_id);
  cleaned jsonb;
  problem text;
begin
  if jsonb_typeof(p_answers) is distinct from 'object' then
    raise exception 'expected answers by field' using errcode = 'P0001';
  end if;

  select coalesce(jsonb_object_agg(a.key, a.value), '{}'::jsonb) into cleaned
  from jsonb_each(p_answers) a
  where exists (select 1 from jsonb_array_elements(stage.review_fields) f where f ->> 'key' = a.key);

  problem := private.review_answers_error(stage.review_fields, cleaned, false);
  if problem is not null then
    raise exception '%', problem using errcode = 'P0001';
  end if;

  update public.request_stages set review_answers = cleaned where id = p_stage_id;
  return cleaned;
end;
$$;

revoke all on function public.save_stage_review_answers(uuid, jsonb) from public, anon;
grant execute on function public.save_stage_review_answers(uuid, jsonb) to authenticated;

-- Review answers of every stage of a request, for those who may see them: org admins,
-- process managers, auditors and the reviewers of this request. Others get an empty object.
create function public.request_review_answers(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if (select auth.uid()) is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  select r.org_id into v_org from public.requests r where r.id = p_request_id;
  if v_org is null or not private.is_org_member(v_org) then
    return '{}'::jsonb;
  end if;
  if not (
    private.has_org_role(v_org, array['org_admin', 'process_manager', 'auditor']::public.org_role[])
    or private.is_stage_reviewer(p_request_id)
  ) then
    return '{}'::jsonb;
  end if;
  return coalesce(
    (select jsonb_object_agg(s.id::text, s.review_answers) from public.request_stages s where s.request_id = p_request_id),
    '{}'::jsonb
  );
end;
$$;

revoke all on function public.request_review_answers(uuid) from public, anon;
grant execute on function public.request_review_answers(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Approving requires a complete review form.
-- ---------------------------------------------------------------------------

create or replace function public.decide_stage(p_stage_id uuid, p_decision text, p_comment text, p_conditions text)
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
  problem text;
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
  if p_decision in ('Approved', 'Approved with conditions') then
    problem := private.review_answers_error(stage.review_fields, stage.review_answers, true);
    if problem is not null then
      raise exception 'complete the review form before approving: %', problem using errcode = 'P0001';
    end if;
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

-- ---------------------------------------------------------------------------
-- Submission copies each stage's form.
-- ---------------------------------------------------------------------------

create or replace function public.submit_request(
  p_request_id uuid,
  p_answers jsonb,
  p_risk_tier text,
  p_risk_score integer,
  p_risk_reasons jsonb,
  -- [{"name", "status", "note", "sla_business_days", "sla_due_at", "checklist": [text],
  --   "review_fields": [...], "review_rules": [...]}] in display order
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
    (org_id, request_id, position, name, status, note, sla_business_days, sla_due_at, checklist, review_fields, review_rules)
  select submitted.org_id, submitted.id, s.ordinality::integer, s.stage ->> 'name', s.stage ->> 'status',
         s.stage ->> 'note', (s.stage ->> 'sla_business_days')::integer, (s.stage ->> 'sla_due_at')::timestamptz,
         coalesce(
           (select jsonb_agg(jsonb_build_object('label', item, 'checked', false))
            from jsonb_array_elements_text(
              case when jsonb_typeof(s.stage -> 'checklist') = 'array' then s.stage -> 'checklist' else '[]'::jsonb end
            ) item),
           '[]'::jsonb
         ),
         case when jsonb_typeof(s.stage -> 'review_fields') = 'array' then s.stage -> 'review_fields' else '[]'::jsonb end,
         case when jsonb_typeof(s.stage -> 'review_rules') = 'array' then s.stage -> 'review_rules' else '[]'::jsonb end
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
