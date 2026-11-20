-- Integrations (CLAUDE.md §3 Jobs, §8 Secrets, §9):
-- - integration_settings: per organization, which integrations are on and their non-secret
--   settings; secrets (Slack webhook, UpGuard key, external review signing secrets) are
--   encrypted by the API before they are stored. Service role only: the browser never
--   reads this table.
-- - outbound_events: a Postgres-based queue for calls to other services (Slack, the
--   external review service), with attempts and retry times.
-- - inbound_events: event ids already applied from the external review service, so a
--   repeated delivery changes nothing (idempotency).
-- - notification_cursors: how far the notifier has read the audit log.
-- - request_stages.external: the stage is reviewed in an external service; only that
--   service (through the API) changes its status.
-- - vendor_risk_checks: snapshots of external vendor ratings (UpGuard), visible with the request.

create table public.integration_settings (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object' and pg_column_size(config) <= 32768),
  -- AES-256-GCM ciphertext, base64 "iv.ciphertext", of a JSON object of secrets.
  secrets text check (char_length(secrets) <= 16384),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table public.outbound_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('slack', 'external')),
  payload jsonb not null check (pg_column_size(payload) <= 262144),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  delivered_at timestamptz,
  failed_at timestamptz,
  last_error text check (char_length(last_error) <= 500),
  created_at timestamptz not null default now()
);
create index outbound_events_due_idx on public.outbound_events (next_attempt_at) where delivered_at is null and failed_at is null;

create table public.inbound_events (
  org_id uuid not null references public.organizations (id) on delete cascade,
  event_id text not null check (char_length(event_id) between 1 and 200),
  received_at timestamptz not null default now(),
  primary key (org_id, event_id)
);

create table public.notification_cursors (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  last_audit_id bigint not null default 0
);

-- Service role only: no grants and no policies for browser roles.
do $$
declare t text;
begin
  foreach t in array array['integration_settings', 'outbound_events', 'inbound_events', 'notification_cursors'] loop
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated using (private.session_is_strong()) with check (private.session_is_strong())',
      t || '_require_strong_session', t
    );
  end loop;
end;
$$;

-- New audit rows start where the log is now, so turning Slack on does not replay history.
insert into public.notification_cursors (org_id, last_audit_id)
select o.id, coalesce((select max(id) from public.audit_log), 0) from public.organizations o;

create table public.vendor_risk_checks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  request_id uuid not null references public.requests (id) on delete cascade,
  source text not null check (source in ('upguard')),
  hostname text not null check (char_length(hostname) <= 253),
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 32768),
  fetched_by uuid references auth.users (id) on delete set null,
  fetched_at timestamptz not null default now()
);
create index vendor_risk_checks_request_idx on public.vendor_risk_checks (request_id, fetched_at desc);

revoke all on public.vendor_risk_checks from anon, authenticated;
grant select on public.vendor_risk_checks to authenticated;
grant all on public.vendor_risk_checks to service_role;
alter table public.vendor_risk_checks enable row level security;

create policy vendor_risk_checks_require_strong_session on public.vendor_risk_checks
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

create policy vendor_risk_checks_select_with_request on public.vendor_risk_checks
  for select to authenticated
  using (exists (select 1 from public.requests r where r.id = request_id and r.org_id = vendor_risk_checks.org_id));

-- ---------------------------------------------------------------------------
-- External review stages
-- ---------------------------------------------------------------------------

alter table public.request_stages
  add column external boolean not null default false,
  add column external_id text check (char_length(external_id) <= 200),
  add column external_url text check (char_length(external_url) <= 2000 and external_url ~ '^https://');

grant select (external, external_id, external_url) on public.request_stages to authenticated;

-- Backend only, after the external service's signature was verified. Applies a status
-- update to an external stage of the given organization; the request is decided when
-- its last open stage is.
create function public.apply_external_stage_status(
  p_org_id uuid,
  p_stage_id uuid,
  p_status text,
  p_comment text,
  p_conditions text,
  p_external_id text,
  p_external_url text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  stage public.request_stages;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
  v_conditions text := nullif(btrim(coalesce(p_conditions, '')), '');
  decision text;
  final_status public.request_status;
begin
  select s.* into stage from public.request_stages s where s.id = p_stage_id and s.org_id = p_org_id for update;
  if not found or not stage.external then
    return 'not_found';
  end if;
  -- Serialize with other decisions on the same request.
  perform 1 from public.requests r where r.id = stage.request_id for update;
  if stage.status not in ('In review', 'Waiting for requester') then
    return 'closed';
  end if;
  if p_external_url is not null and p_external_url !~ '^https://' then
    raise exception 'external_url must start with https://' using errcode = 'P0001';
  end if;

  update public.request_stages
  set external_id = coalesce(left(p_external_id, 200), external_id),
      external_url = coalesce(p_external_url, external_url)
  where id = stage.id;

  if p_status = 'waiting_for_requester' then
    update public.request_stages
    set status = 'Waiting for requester', sla_paused = true,
        sla_paused_at = case when sla_paused then sla_paused_at else now() end
    where id = stage.id;
  elsif p_status = 'in_review' then
    update public.request_stages
    set status = 'In review',
        sla_due_at = case when sla_paused and sla_paused_at is not null then sla_due_at + (now() - sla_paused_at) else sla_due_at end,
        sla_paused = false, sla_paused_at = null
    where id = stage.id;
  elsif p_status in ('approved', 'approved_with_conditions', 'rejected') then
    decision := case p_status when 'approved' then 'Approved' when 'approved_with_conditions' then 'Approved with conditions' else 'Rejected' end;
    if decision = 'Approved with conditions' and v_conditions is null then
      raise exception 'conditions are required for approved_with_conditions' using errcode = 'P0001';
    end if;
    if decision = 'Rejected' and v_comment is null then
      raise exception 'a comment is required for rejected' using errcode = 'P0001';
    end if;
    update public.request_stages
    set status = decision, decision_comment = left(v_comment, 2000),
        conditions = case when decision = 'Approved with conditions' then left(v_conditions, 2000) end,
        decided_by = null, decided_at = now(), sla_paused = false
    where id = stage.id;

    insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
    values (stage.org_id, null, 'stage.decided', 'request_stage', stage.id::text,
            jsonb_build_object('request_id', stage.request_id, 'stage', stage.name, 'decision', decision, 'external', true));

    if not exists (
      select 1 from public.request_stages s
      where s.request_id = stage.request_id and s.status in ('Not started', 'In review', 'Waiting for requester')
    ) then
      final_status := case
        when exists (select 1 from public.request_stages s where s.request_id = stage.request_id and s.status = 'Rejected') then 'rejected'
        else 'approved'
      end;
      update public.requests set status = final_status where id = stage.request_id;
      insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
      values (stage.org_id, null, 'request.' || final_status::text, 'request', stage.request_id::text, '{}'::jsonb);
    end if;
  else
    raise exception 'unknown status' using errcode = 'P0001';
  end if;

  if p_status in ('waiting_for_requester', 'in_review') then
    insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
    values (stage.org_id, null, 'stage.external_status', 'request_stage', stage.id::text,
            jsonb_build_object('request_id', stage.request_id, 'stage', stage.name, 'status', p_status));
  end if;
  return 'ok';
end;
$$;

revoke all on function public.apply_external_stage_status(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_external_stage_status(uuid, uuid, text, text, text, text, text) to service_role;

-- Submission records which stages are external; managers and reviewers cannot act on them.

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
    (org_id, request_id, position, name, status, note, sla_business_days, sla_due_at, checklist, review_fields, review_rules, external)
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
         case when jsonb_typeof(s.stage -> 'review_rules') = 'array' then s.stage -> 'review_rules' else '[]'::jsonb end,
         coalesce((s.stage ->> 'external')::boolean, false)
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

create or replace function private.reviewable_stage(p_stage_id uuid)
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
    private.oversees_request(request.id, array['org_admin', 'process_manager']::public.org_role[])
    -- reviewer_id is null on an unassigned stage: the comparison must not yield null.
    or stage.reviewer_id is not distinct from caller
  ) then
    raise exception 'you are not a reviewer of this stage' using errcode = '42501';
  end if;

  if stage.external then
    raise exception 'this review happens in an external service' using errcode = 'P0001';
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
