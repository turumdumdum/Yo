-- Security baseline and exceptions (CLAUDE.md §7).
--
-- security_baselines: per-organization catalog of configuration controls, written by the
--   API after validation (packages/shared/src/securityBaseline.ts).
-- requests.config_requirements: the controls that applied at submission, with the
--   security reviewer's decision on each and, after approval, whether it is configured.
-- review_exceptions: approved deviations from a control: who asked, why, compensating
--   measures, risk level, expiry (at most a year) and who accepted the risk. An org admin
--   other than the person who asked decides (separation of duties). Everything audited.
--
-- Approving the security review requires a decision on every required control, no
-- exception still waiting, an approved and unexpired exception for every control marked
-- "exception", and "Approved with conditions" when exceptions apply.

create table public.security_baselines (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  controls jsonb not null check (jsonb_typeof(controls) = 'array' and pg_column_size(controls) <= 131072),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

revoke all on public.security_baselines from anon, authenticated;
grant select on public.security_baselines to authenticated;
grant all on public.security_baselines to service_role;
alter table public.security_baselines enable row level security;

create policy security_baselines_require_strong_session on public.security_baselines
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

create policy security_baselines_select_member on public.security_baselines
  for select to authenticated
  using (private.is_org_member(org_id));

alter table public.requests
  add column config_requirements jsonb not null default '[]'::jsonb
    check (jsonb_typeof(config_requirements) = 'array' and pg_column_size(config_requirements) <= 131072);

create type public.exception_status as enum ('pending', 'approved', 'rejected', 'revoked');

create table public.review_exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  request_id uuid not null references public.requests (id) on delete cascade,
  control_id text not null check (char_length(control_id) between 1 and 40),
  control_title text not null check (char_length(control_title) between 1 and 120),
  deviation text not null check (char_length(deviation) between 1 and 1000),
  justification text not null check (char_length(justification) between 1 and 1000),
  compensating_controls text not null check (char_length(compensating_controls) between 1 and 1000),
  risk_level text not null check (risk_level in ('Low', 'Medium', 'High', 'Critical')),
  expires_on date not null,
  status public.exception_status not null default 'pending',
  requested_by uuid references auth.users (id) on delete set null,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  decision_comment text check (char_length(decision_comment) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index review_exceptions_request_idx on public.review_exceptions (request_id);
create index review_exceptions_org_expiry_idx on public.review_exceptions (org_id, status, expires_on);
-- One open (pending or approved) exception per control and request.
create unique index review_exceptions_one_open on public.review_exceptions (request_id, control_id)
  where status in ('pending', 'approved');

revoke all on public.review_exceptions from anon, authenticated;
grant select on public.review_exceptions to authenticated;
grant all on public.review_exceptions to service_role;
alter table public.review_exceptions enable row level security;

create policy review_exceptions_require_strong_session on public.review_exceptions
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

-- Whoever may see the request may see its exceptions.
create policy review_exceptions_select_with_request on public.review_exceptions
  for select to authenticated
  using (exists (select 1 from public.requests r where r.id = request_id and r.org_id = review_exceptions.org_id));

create trigger review_exceptions_set_updated_at
before update on public.review_exceptions
for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Updates one control of a request's config_requirements.
create function private.patch_config_item(p_request_id uuid, p_control_id text, p_patch jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.requests r
  set config_requirements = (
    select coalesce(jsonb_agg(case when item ->> 'id' = p_control_id then item || p_patch else item end order by ord), '[]'::jsonb)
    from jsonb_array_elements(r.config_requirements) with ordinality as t(item, ord)
  )
  where r.id = p_request_id;
$$;

revoke all on function private.patch_config_item(uuid, text, jsonb) from public;

-- The open security review of a request, checked for the caller's right to review it.
create function private.security_stage_for_review(p_request_id uuid)
returns public.request_stages
language plpgsql
security definer
set search_path = ''
as $$
declare
  stage_id uuid;
begin
  select s.id into stage_id from public.request_stages s where s.request_id = p_request_id and s.name = 'Security review';
  if stage_id is null then
    raise exception 'this request has no security review' using errcode = 'P0001';
  end if;
  return private.reviewable_stage(stage_id);
end;
$$;

revoke all on function private.security_stage_for_review(uuid) from public;

-- Null when the security review may be approved with this decision, else the reason.
create function private.security_config_problem(p_request_id uuid, p_decision text)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  items jsonb;
  missing text;
begin
  select r.config_requirements into items from public.requests r where r.id = p_request_id;
  select item ->> 'title' into missing from jsonb_array_elements(items) item
  where item ->> 'level' = 'required' and coalesce(item ->> 'decision', '') = '' limit 1;
  if missing is not null then
    return format('decide on every required configuration control before approving, starting with “%s”', missing);
  end if;
  if exists (select 1 from public.review_exceptions e where e.request_id = p_request_id and e.status = 'pending') then
    return 'an exception is waiting for an org admin''s decision';
  end if;
  select item ->> 'title' into missing from jsonb_array_elements(items) item
  where item ->> 'decision' = 'exception'
    and not exists (
      select 1 from public.review_exceptions e
      where e.request_id = p_request_id and e.control_id = item ->> 'id' and e.status = 'approved' and e.expires_on >= current_date
    )
  limit 1;
  if missing is not null then
    return format('“%s” is marked as an exception, but no approved exception covers it', missing);
  end if;
  if p_decision = 'Approved' and exists (
    select 1 from public.review_exceptions e where e.request_id = p_request_id and e.status = 'approved'
  ) then
    return 'exceptions apply: approve with conditions and name them';
  end if;
  return null;
end;
$$;

revoke all on function private.security_config_problem(uuid, text) from public;

-- ---------------------------------------------------------------------------
-- Backend only: the controls that applied at submission (while still a draft).
-- ---------------------------------------------------------------------------

create function public.set_request_config_requirements(p_request_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'expected a list of controls' using errcode = 'P0001';
  end if;
  update public.requests set config_requirements = p_items where id = p_request_id and status = 'draft';
  if not found then
    raise exception 'request is not a draft' using errcode = 'P0001';
  end if;
end;
$$;

revoke all on function public.set_request_config_requirements(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_request_config_requirements(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Security reviewer: decide on controls.
-- p_control_id null with 'required' marks every undecided control as required.
-- ---------------------------------------------------------------------------

create function public.set_config_decision(p_request_id uuid, p_control_id text, p_decision text, p_note text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  stage public.request_stages := private.security_stage_for_review(p_request_id);
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  item jsonb;
begin
  if p_decision is not null and p_decision not in ('required', 'not_applicable') then
    raise exception 'choose “must be configured” or “not applicable”; exceptions are requested separately' using errcode = 'P0001';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'use at most 500 characters for the note' using errcode = 'P0001';
  end if;

  if p_control_id is null then
    if p_decision is distinct from 'required' then
      raise exception 'only “must be configured” can be set for all controls at once' using errcode = 'P0001';
    end if;
    update public.requests r
    set config_requirements = (
      select coalesce(jsonb_agg(case when coalesce(i ->> 'decision', '') = '' then i || '{"decision": "required"}'::jsonb else i end order by ord), '[]'::jsonb)
      from jsonb_array_elements(r.config_requirements) with ordinality as t(i, ord)
    )
    where r.id = p_request_id;
  else
    select i into item from public.requests r, jsonb_array_elements(r.config_requirements) i
    where r.id = p_request_id and i ->> 'id' = p_control_id;
    if item is null then
      raise exception 'control not found' using errcode = 'P0002';
    end if;
    if exists (
      select 1 from public.review_exceptions e
      where e.request_id = p_request_id and e.control_id = p_control_id and e.status in ('pending', 'approved')
    ) then
      raise exception 'an exception covers this control: withdraw or revoke it first' using errcode = 'P0001';
    end if;
    if p_decision = 'not_applicable' and v_note is null then
      raise exception 'explain why the control does not apply' using errcode = 'P0001';
    end if;
    perform private.patch_config_item(p_request_id, p_control_id, jsonb_build_object('decision', p_decision, 'note', v_note));
  end if;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (stage.org_id, (select auth.uid()), 'config.decided', 'request', p_request_id::text,
          jsonb_build_object('control', coalesce(p_control_id, '*'), 'decision', p_decision));
end;
$$;

-- ---------------------------------------------------------------------------
-- Exceptions
-- ---------------------------------------------------------------------------

create function public.request_exception(
  p_request_id uuid,
  p_control_id text,
  p_deviation text,
  p_justification text,
  p_compensating text,
  p_risk_level text,
  p_expires_on date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  stage public.request_stages := private.security_stage_for_review(p_request_id);
  item jsonb;
  new_id uuid;
begin
  select i into item from public.requests r, jsonb_array_elements(r.config_requirements) i
  where r.id = p_request_id and i ->> 'id' = p_control_id;
  if item is null then
    raise exception 'control not found' using errcode = 'P0002';
  end if;
  if nullif(btrim(coalesce(p_deviation, '')), '') is null then
    raise exception 'describe what deviates from the control' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_justification, '')), '') is null then
    raise exception 'explain the business reason' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_compensating, '')), '') is null then
    raise exception 'name the compensating measures, or write “none” and why' using errcode = 'P0001';
  end if;
  if p_risk_level is null or p_risk_level not in ('Low', 'Medium', 'High', 'Critical') then
    raise exception 'choose the remaining risk level' using errcode = 'P0001';
  end if;
  if p_expires_on is null or p_expires_on <= current_date or p_expires_on > current_date + 365 then
    raise exception 'the exception must end within a year from today' using errcode = 'P0001';
  end if;

  begin
    insert into public.review_exceptions
      (org_id, request_id, control_id, control_title, deviation, justification, compensating_controls, risk_level, expires_on, requested_by)
    values
      (stage.org_id, p_request_id, p_control_id, item ->> 'title', btrim(p_deviation), btrim(p_justification), btrim(p_compensating),
       p_risk_level, p_expires_on, (select auth.uid()))
    returning id into new_id;
  exception when unique_violation then
    raise exception 'this control already has an open exception' using errcode = 'P0001';
  when check_violation then
    raise exception 'use at most 1000 characters per text' using errcode = 'P0001';
  end;

  perform private.patch_config_item(p_request_id, p_control_id, jsonb_build_object('decision', 'exception'));

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (stage.org_id, (select auth.uid()), 'exception.requested', 'exception', new_id::text,
          jsonb_build_object('request_id', p_request_id, 'control', p_control_id, 'risk_level', p_risk_level, 'expires_on', p_expires_on));
  return new_id;
end;
$$;

-- Org admin, not the person who asked: accept the risk or refuse it.
create function public.decide_exception(p_exception_id uuid, p_approve boolean, p_comment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ex public.review_exceptions;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  if caller is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  select e.* into ex from public.review_exceptions e where e.id = p_exception_id for update;
  if not found or not private.is_org_member(ex.org_id) then
    raise exception 'exception not found' using errcode = 'P0002';
  end if;
  if not private.has_org_role(ex.org_id, array['org_admin']::public.org_role[]) then
    raise exception 'only an org admin can accept or refuse a risk' using errcode = '42501';
  end if;
  if ex.requested_by = caller then
    raise exception 'someone other than the person who asked must decide on an exception' using errcode = '42501';
  end if;
  if ex.status <> 'pending' then
    raise exception 'this exception was already decided' using errcode = 'P0001';
  end if;
  if p_approve is null then
    raise exception 'choose approve or refuse' using errcode = 'P0001';
  end if;
  if not p_approve and v_comment is null then
    raise exception 'explain why the exception is refused' using errcode = 'P0001';
  end if;
  if v_comment is not null and char_length(v_comment) > 1000 then
    raise exception 'use at most 1000 characters for the comment' using errcode = 'P0001';
  end if;

  update public.review_exceptions
  set status = case when p_approve then 'approved' else 'rejected' end::public.exception_status,
      decided_by = caller, decided_at = now(), decision_comment = v_comment
  where id = ex.id;
  if not p_approve then
    perform private.patch_config_item(ex.request_id, ex.control_id, jsonb_build_object('decision', null));
  end if;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (ex.org_id, caller, case when p_approve then 'exception.approved' else 'exception.rejected' end, 'exception', ex.id::text,
          jsonb_build_object('request_id', ex.request_id, 'control', ex.control_id, 'risk_level', ex.risk_level));
end;
$$;

-- An org admin revokes an exception; the person who asked can withdraw it while pending.
-- The control then needs a decision again (or, on an approved request, must be configured).
create function public.revoke_exception(p_exception_id uuid, p_comment text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  ex public.review_exceptions;
  request_status public.request_status;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  if caller is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  select e.* into ex from public.review_exceptions e where e.id = p_exception_id for update;
  if not found or not private.is_org_member(ex.org_id) then
    raise exception 'exception not found' using errcode = 'P0002';
  end if;
  if ex.status not in ('pending', 'approved') then
    raise exception 'this exception is no longer open' using errcode = 'P0001';
  end if;
  if not (
    private.has_org_role(ex.org_id, array['org_admin']::public.org_role[])
    or (ex.status = 'pending' and ex.requested_by = caller)
  ) then
    raise exception 'only an org admin can revoke an exception' using errcode = '42501';
  end if;
  if v_comment is not null and char_length(v_comment) > 1000 then
    raise exception 'use at most 1000 characters for the comment' using errcode = 'P0001';
  end if;

  update public.review_exceptions
  set status = 'revoked', decided_by = caller, decided_at = now(), decision_comment = v_comment
  where id = ex.id;
  select r.status into request_status from public.requests r where r.id = ex.request_id;
  perform private.patch_config_item(ex.request_id, ex.control_id,
    jsonb_build_object('decision', case when request_status = 'approved' then 'required' end));

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (ex.org_id, caller, 'exception.revoked', 'exception', ex.id::text,
          jsonb_build_object('request_id', ex.request_id, 'control', ex.control_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- After approval: the requester or a manager confirms that a control is configured.
-- ---------------------------------------------------------------------------

create function public.confirm_configuration(p_request_id uuid, p_control_id text, p_configured boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  request public.requests;
  item jsonb;
begin
  if caller is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  select r.* into request from public.requests r where r.id = p_request_id for update;
  if not found or not private.is_org_member(request.org_id) or request.deleted_at is not null then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if not (
    request.requester_id = caller
    or private.oversees_request(request.id, array['org_admin', 'process_manager']::public.org_role[])
    or private.is_request_viewer(request.id)
  ) then
    raise exception 'only the requester, the business owner or a manager can confirm the configuration' using errcode = '42501';
  end if;
  if request.status <> 'approved' then
    raise exception 'configuration is confirmed after the request is approved' using errcode = 'P0001';
  end if;
  select i into item from jsonb_array_elements(request.config_requirements) i where i ->> 'id' = p_control_id;
  if item is null then
    raise exception 'control not found' using errcode = 'P0002';
  end if;
  if item ->> 'decision' in ('not_applicable', 'exception') then
    raise exception 'this control does not need to be configured' using errcode = 'P0001';
  end if;
  if p_configured is null then
    raise exception 'choose configured or not' using errcode = 'P0001';
  end if;

  perform private.patch_config_item(p_request_id, p_control_id, jsonb_build_object(
    'configured', p_configured,
    'configured_by', case when p_configured then caller end,
    'configured_at', case when p_configured then now() end
  ));

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (request.org_id, caller, case when p_configured then 'config.confirmed' else 'config.unconfirmed' end, 'request', p_request_id::text,
          jsonb_build_object('control', p_control_id));
end;
$$;

revoke all on function public.set_config_decision(uuid, text, text, text) from public, anon;
revoke all on function public.request_exception(uuid, text, text, text, text, text, date) from public, anon;
revoke all on function public.decide_exception(uuid, boolean, text) from public, anon;
revoke all on function public.revoke_exception(uuid, text) from public, anon;
revoke all on function public.confirm_configuration(uuid, text, boolean) from public, anon;
grant execute on function public.set_config_decision(uuid, text, text, text) to authenticated;
grant execute on function public.request_exception(uuid, text, text, text, text, text, date) to authenticated;
grant execute on function public.decide_exception(uuid, boolean, text) to authenticated;
grant execute on function public.revoke_exception(uuid, text) to authenticated;
grant execute on function public.confirm_configuration(uuid, text, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Approving the security review respects controls and exceptions.
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
  if p_decision in ('Approved', 'Approved with conditions') and stage.name = 'Security review' then
    problem := private.security_config_problem(stage.request_id, p_decision);
    if problem is not null then
      raise exception '%', problem using errcode = 'P0001';
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
