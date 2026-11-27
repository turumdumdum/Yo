-- Exceptions from any review (CLAUDE.md §7 Exception).
--
-- Until now an exception could only waive a security-baseline control during the security
-- review. Now the reviewer of any stage can raise one from inside that stage: a short title,
-- what deviates, why, compensating measures, remaining risk and an end date within a year,
-- optionally tied to a baseline control and/or a checklist item of the stage.
--
-- Every exception belongs to a stage (stage_id, stage_name). While one waits for an org
-- admin's decision, its stage cannot be approved; once accepted, the stage can only be
-- "Approved with conditions". Approval stays with an org admin other than the person who
-- asked. Visibility follows the request (confidential requests included), as before.

alter table public.review_exceptions
  add column stage_id uuid references public.request_stages (id) on delete cascade,
  add column stage_name text check (char_length(stage_name) between 1 and 80),
  add column title text check (char_length(title) between 1 and 120),
  add column checklist_item text check (char_length(checklist_item) between 1 and 300),
  alter column control_id drop not null,
  alter column control_title drop not null;

-- Existing exceptions came from the security review.
update public.review_exceptions e
set stage_id = s.id, stage_name = s.name, title = e.control_title
from public.request_stages s
where s.request_id = e.request_id and s.name = 'Security review' and e.stage_id is null;
update public.review_exceptions set title = coalesce(title, control_title, 'Exception') where title is null;

-- A title, or the control it waives, names every exception.
alter table public.review_exceptions
  add constraint review_exceptions_named check (title is not null or control_title is not null),
  add constraint review_exceptions_control_pair check ((control_id is null) = (control_title is null));

create index review_exceptions_stage_idx on public.review_exceptions (stage_id);

-- ---------------------------------------------------------------------------
-- Raising an exception from a stage
-- ---------------------------------------------------------------------------

create function private.insert_stage_exception(
  stage public.request_stages,
  p_title text,
  p_deviation text,
  p_justification text,
  p_compensating text,
  p_risk_level text,
  p_expires_on date,
  p_control_id text,
  p_checklist_item text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  item jsonb;
  v_title text := nullif(btrim(coalesce(p_title, '')), '');
  v_checklist text := nullif(btrim(coalesce(p_checklist_item, '')), '');
  v_control text := nullif(btrim(coalesce(p_control_id, '')), '');
  new_id uuid;
begin
  if v_control is not null then
    select i into item from public.requests r, jsonb_array_elements(r.config_requirements) i
    where r.id = stage.request_id and i ->> 'id' = v_control;
    if item is null then
      raise exception 'control not found' using errcode = 'P0002';
    end if;
    v_title := coalesce(v_title, item ->> 'title');
  end if;
  if v_checklist is not null and not exists (
    select 1 from jsonb_array_elements(stage.checklist) c where c ->> 'label' = v_checklist
  ) then
    raise exception 'checklist item not found in this review' using errcode = 'P0002';
  end if;
  v_title := coalesce(v_title, v_checklist);
  if v_title is null then
    raise exception 'give the exception a short title' using errcode = 'P0001';
  end if;
  if nullif(btrim(coalesce(p_deviation, '')), '') is null then
    raise exception 'describe what deviates' using errcode = 'P0001';
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
      (org_id, request_id, stage_id, stage_name, title, checklist_item, control_id, control_title,
       deviation, justification, compensating_controls, risk_level, expires_on, requested_by)
    values
      (stage.org_id, stage.request_id, stage.id, stage.name, left(v_title, 120), v_checklist, v_control, item ->> 'title',
       btrim(p_deviation), btrim(p_justification), btrim(p_compensating), p_risk_level, p_expires_on, (select auth.uid()))
    returning id into new_id;
  exception when unique_violation then
    raise exception 'this control already has an open exception' using errcode = 'P0001';
  when check_violation then
    raise exception 'use at most 1000 characters per text and 120 for the title' using errcode = 'P0001';
  end;

  if v_control is not null then
    perform private.patch_config_item(stage.request_id, v_control, jsonb_build_object('decision', 'exception'));
  end if;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (stage.org_id, (select auth.uid()), 'exception.requested', 'exception', new_id::text,
          jsonb_build_object('request_id', stage.request_id, 'stage', stage.name, 'control', v_control,
                             'risk_level', p_risk_level, 'expires_on', p_expires_on));
  return new_id;
end;
$$;

revoke all on function private.insert_stage_exception(public.request_stages, text, text, text, text, text, date, text, text) from public;

-- The reviewer of the stage (or a manager who may review it) raises an exception.
-- private.reviewable_stage checks the right to review, the review scope and that the stage is open.
create function public.raise_stage_exception(
  p_stage_id uuid,
  p_title text,
  p_deviation text,
  p_justification text,
  p_compensating text,
  p_risk_level text,
  p_expires_on date,
  p_control_id text default null,
  p_checklist_item text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  stage public.request_stages := private.reviewable_stage(p_stage_id);
begin
  return private.insert_stage_exception(stage, p_title, p_deviation, p_justification, p_compensating,
                                        p_risk_level, p_expires_on, p_control_id, p_checklist_item);
end;
$$;

revoke all on function public.raise_stage_exception(uuid, text, text, text, text, text, date, text, text) from public, anon;
grant execute on function public.raise_stage_exception(uuid, text, text, text, text, text, date, text, text) to authenticated;

-- The security review's control exception keeps its signature and now records its stage.
create or replace function public.request_exception(
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
begin
  if nullif(btrim(coalesce(p_control_id, '')), '') is null then
    raise exception 'control not found' using errcode = 'P0002';
  end if;
  return private.insert_stage_exception(stage, null, p_deviation, p_justification, p_compensating,
                                        p_risk_level, p_expires_on, p_control_id, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- Approving any stage respects its exceptions.
-- ---------------------------------------------------------------------------

-- Null when the stage may be approved with this decision, else the reason.
create function private.stage_exception_problem(p_stage_id uuid, p_decision text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (select 1 from public.review_exceptions e where e.stage_id = p_stage_id and e.status = 'pending')
      then 'an exception for this review is waiting for an org admin''s decision'
    when p_decision = 'Approved' and exists (
      select 1 from public.review_exceptions e where e.stage_id = p_stage_id and e.status = 'approved'
    ) then 'exceptions apply: approve with conditions and name them'
  end;
$$;

revoke all on function private.stage_exception_problem(uuid, text) from public;

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
  exception_ids jsonb;
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
  if p_decision in ('Approved', 'Approved with conditions') then
    problem := private.stage_exception_problem(stage.id, p_decision);
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

  -- The decision records which accepted exceptions it relies on.
  select coalesce(jsonb_agg(e.id order by e.created_at), '[]'::jsonb) into exception_ids
  from public.review_exceptions e where e.stage_id = stage.id and e.status = 'approved';

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (stage.org_id, caller, 'stage.decided', 'request_stage', stage.id::text,
          jsonb_build_object('request_id', stage.request_id, 'stage', stage.name, 'decision', p_decision, 'exceptions', exception_ids));

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
