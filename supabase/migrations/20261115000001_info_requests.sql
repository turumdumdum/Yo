-- Info requests (CLAUDE.md §6): a reviewer asks the requester a question inside a stage.
-- The stage moves to "Waiting for requester" and its SLA clock stops until every open
-- question of that stage is answered. Questions and answers are visible to everyone who
-- can see the request.

alter table public.request_stages add column sla_paused_at timestamptz;

create table public.info_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  request_id uuid not null references public.requests (id) on delete cascade,
  stage_id uuid not null references public.request_stages (id) on delete cascade,
  question text not null check (char_length(question) between 1 and 2000),
  asked_by uuid references auth.users (id) on delete set null,
  asked_at timestamptz not null default now(),
  answer text check (char_length(answer) between 1 and 4000),
  answered_by uuid references auth.users (id) on delete set null,
  answered_at timestamptz,
  check ((answer is null) = (answered_at is null))
);
create index info_requests_request_id_idx on public.info_requests (request_id, asked_at);
create index info_requests_stage_id_idx on public.info_requests (stage_id);

revoke all on public.info_requests from anon, authenticated;
grant select on public.info_requests to authenticated;
grant all on public.info_requests to service_role;

alter table public.info_requests enable row level security;

create policy info_requests_require_strong_session on public.info_requests
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

-- Whoever may see the request may see its questions and answers.
create policy info_requests_select_with_request on public.info_requests
  for select to authenticated
  using (exists (select 1 from public.requests r where r.id = request_id and r.org_id = info_requests.org_id));

-- ---------------------------------------------------------------------------
-- RPC: a reviewer asks the requester
-- ---------------------------------------------------------------------------

create function public.ask_requester(p_stage_id uuid, p_question text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  stage public.request_stages := private.reviewable_stage(p_stage_id);
  v_question text := btrim(coalesce(p_question, ''));
  new_id uuid;
begin
  if v_question = '' then
    raise exception 'write a question' using errcode = 'P0001';
  end if;
  if char_length(v_question) > 2000 then
    raise exception 'use at most 2000 characters' using errcode = 'P0001';
  end if;

  insert into public.info_requests (org_id, request_id, stage_id, question, asked_by)
  values (stage.org_id, stage.request_id, stage.id, v_question, caller)
  returning id into new_id;

  -- A second question while already waiting keeps the original pause start.
  update public.request_stages
  set status = 'Waiting for requester',
      sla_paused = true,
      sla_paused_at = case when sla_paused then sla_paused_at else now() end
  where id = stage.id;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (stage.org_id, caller, 'info_request.asked', 'info_request', new_id::text,
          jsonb_build_object('request_id', stage.request_id, 'stage', stage.name));

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: the requester answers. The stage resumes when its last open question is
-- answered, and its due date moves out by the time it was paused.
-- ---------------------------------------------------------------------------

create function public.answer_info_request(p_info_request_id uuid, p_answer text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  info public.info_requests;
  request public.requests;
  stage public.request_stages;
  v_answer text := btrim(coalesce(p_answer, ''));
  new_due timestamptz;
begin
  if caller is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;

  select i.* into info from public.info_requests i where i.id = p_info_request_id;
  if not found or not private.is_org_member(info.org_id) then
    raise exception 'question not found' using errcode = 'P0002';
  end if;

  -- Same lock order as stage decisions: request, then stage.
  select r.* into request from public.requests r where r.id = info.request_id for update;
  select s.* into stage from public.request_stages s where s.id = info.stage_id for update;
  select i.* into info from public.info_requests i where i.id = p_info_request_id for update;

  if request.requester_id is distinct from caller then
    raise exception 'only the requester can answer this question' using errcode = '42501';
  end if;
  if info.answered_at is not null then
    raise exception 'this question has already been answered' using errcode = 'P0001';
  end if;
  if v_answer = '' then
    raise exception 'write an answer' using errcode = 'P0001';
  end if;
  if char_length(v_answer) > 4000 then
    raise exception 'use at most 4000 characters' using errcode = 'P0001';
  end if;

  update public.info_requests
  set answer = v_answer, answered_by = caller, answered_at = now()
  where id = info.id;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (info.org_id, caller, 'info_request.answered', 'info_request', info.id::text,
          jsonb_build_object('request_id', info.request_id, 'stage', stage.name));

  -- Resume only a stage that is still waiting (it may have been decided meanwhile)
  -- and has no other open question.
  if stage.status = 'Waiting for requester'
     and not exists (select 1 from public.info_requests i where i.stage_id = stage.id and i.answered_at is null) then
    new_due := stage.sla_due_at;
    if new_due is not null and stage.sla_paused_at is not null then
      new_due := new_due + (now() - stage.sla_paused_at);
      -- A due date never lands on a weekend.
      while extract(isodow from new_due at time zone 'UTC') in (6, 7) loop
        new_due := new_due + interval '1 day';
      end loop;
    end if;
    update public.request_stages
    set status = 'In review', sla_paused = false, sla_paused_at = null, sla_due_at = new_due
    where id = stage.id;
  end if;
end;
$$;

revoke all on function public.ask_requester(uuid, text) from public, anon;
revoke all on function public.answer_info_request(uuid, text) from public, anon;
grant execute on function public.ask_requester(uuid, text) to authenticated;
grant execute on function public.answer_info_request(uuid, text) to authenticated;

-- The new column is readable like the rest of the stage.
grant select (sla_paused_at) on public.request_stages to authenticated;
