-- Vendor requests (CLAUDE.md §4, §5). Stage 1, step 2: the request form with autosave.
--
-- A draft is edited by its requester directly from the browser (only the answers column).
-- Submission goes through the API, which validates the answers, computes the risk tier
-- and calls submit_request() with the service role; the browser can never set the status
-- or the risk tier itself.

create type public.request_status as enum ('draft', 'submitted');

create table public.requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  requester_id uuid not null default auth.uid() references auth.users (id),
  status public.request_status not null default 'draft',
  -- Form answers keyed by field (see packages/shared/src/requestForm.ts).
  answers jsonb not null default '{}'::jsonb
    check (jsonb_typeof(answers) = 'object' and pg_column_size(answers) <= 65536),
  service_name text generated always as (answers ->> 'serviceName') stored,
  request_type text,
  risk_tier text check (risk_tier in ('Low', 'Medium', 'High', 'Critical')),
  risk_score integer,
  risk_reasons jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  submitted_at timestamptz,
  -- A submitted request always carries its triage result.
  check (status = 'draft' or (risk_tier is not null and risk_score is not null and submitted_at is not null))
);
create index requests_org_id_status_idx on public.requests (org_id, status, created_at desc);
create index requests_requester_id_idx on public.requests (requester_id);

create trigger requests_set_updated_at
before update on public.requests
for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Privileges and RLS
-- ---------------------------------------------------------------------------

revoke all on public.requests from anon, authenticated;
grant select, delete on public.requests to authenticated;
grant insert (org_id, answers) on public.requests to authenticated;
grant update (answers) on public.requests to authenticated;
grant all on public.requests to service_role;

alter table public.requests enable row level security;

create policy requests_require_strong_session on public.requests
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

-- Requesters see their own requests, drafts included. Org admins, process managers
-- and auditors see every submitted request of their organization. Reviewers get
-- access per stage once stages exist.
create policy requests_select_own on public.requests
  for select to authenticated
  using (requester_id = (select auth.uid()) and private.is_org_member(org_id));

create policy requests_select_submitted_managers on public.requests
  for select to authenticated
  using (
    status <> 'draft'
    and private.has_org_role(org_id, array['org_admin', 'process_manager', 'auditor']::public.org_role[])
  );

-- Every member except the read-only auditor can start a request.
create policy requests_insert_own_draft on public.requests
  for insert to authenticated
  with check (
    requester_id = (select auth.uid())
    and status = 'draft'
    and private.has_org_role(
      org_id,
      array['org_admin', 'process_manager', 'reviewer', 'requester', 'owner']::public.org_role[]
    )
  );

create policy requests_update_own_draft on public.requests
  for update to authenticated
  using (requester_id = (select auth.uid()) and status = 'draft' and private.is_org_member(org_id))
  with check (requester_id = (select auth.uid()) and status = 'draft' and private.is_org_member(org_id));

create policy requests_delete_own_draft on public.requests
  for delete to authenticated
  using (requester_id = (select auth.uid()) and status = 'draft' and private.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- Submission: backend only.
-- ---------------------------------------------------------------------------

create function public.submit_request(
  p_request_id uuid,
  p_answers jsonb,
  p_risk_tier text,
  p_risk_score integer,
  p_risk_reasons jsonb
)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  submitted public.requests;
begin
  update public.requests r
  set status = 'submitted',
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

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (submitted.org_id, submitted.requester_id, 'request.submitted', 'request', submitted.id::text,
          jsonb_build_object('risk_tier', p_risk_tier, 'risk_score', p_risk_score));

  return submitted;
end;
$$;

revoke all on function public.submit_request(uuid, jsonb, text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.submit_request(uuid, jsonb, text, integer, jsonb) to service_role;
