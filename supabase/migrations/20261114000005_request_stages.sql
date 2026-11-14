-- Review stages of a request (CLAUDE.md §4, §6). Stage 1, step 3: triage and the default stages.
--
-- Stages are created by the backend at submission, in the same transaction that marks
-- the request as submitted. The browser can only read them for now; reviewer decisions
-- and info requests arrive with the reviewer queue.

alter type public.request_status add value 'in_review';

create table public.request_stages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  request_id uuid not null references public.requests (id) on delete cascade,
  position integer not null,
  name text not null check (char_length(name) between 1 and 120),
  status text not null check (
    status in ('Not started', 'In review', 'Waiting for requester', 'Approved',
               'Approved with conditions', 'Rejected', 'Not required')
  ),
  -- Why the stage is not required, when it is not.
  note text,
  reviewer_id uuid references auth.users (id) on delete set null,
  sla_business_days integer check (sla_business_days > 0),
  sla_due_at timestamptz,
  -- True while the stage waits for the requester and its SLA clock is stopped.
  sla_paused boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, name),
  unique (request_id, position)
);
create index request_stages_org_id_status_idx on public.request_stages (org_id, status);

create trigger request_stages_set_updated_at
before update on public.request_stages
for each row execute function private.set_updated_at();

revoke all on public.request_stages from anon, authenticated;
grant select on public.request_stages to authenticated;
grant all on public.request_stages to service_role;

alter table public.request_stages enable row level security;

create policy request_stages_require_strong_session on public.request_stages
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

-- Whoever may see the request may see its stages. The subquery runs under the
-- caller's own RLS on requests, so the two can never drift apart.
create policy request_stages_select_with_request on public.request_stages
  for select to authenticated
  using (exists (select 1 from public.requests r where r.id = request_id and r.org_id = request_stages.org_id));

-- ---------------------------------------------------------------------------
-- Submission now also starts the stages.
-- ---------------------------------------------------------------------------

drop function public.submit_request(uuid, jsonb, text, integer, jsonb);

create function public.submit_request(
  p_request_id uuid,
  p_answers jsonb,
  p_risk_tier text,
  p_risk_score integer,
  p_risk_reasons jsonb,
  -- [{"name", "status", "note", "sla_business_days", "sla_due_at"}] in display order
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
    (org_id, request_id, position, name, status, note, sla_business_days, sla_due_at)
  select submitted.org_id, submitted.id, s.ordinality::integer, s.stage ->> 'name', s.stage ->> 'status',
         s.stage ->> 'note', (s.stage ->> 'sla_business_days')::integer, (s.stage ->> 'sla_due_at')::timestamptz
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

revoke all on function public.submit_request(uuid, jsonb, text, integer, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.submit_request(uuid, jsonb, text, integer, jsonb, jsonb) to service_role;
