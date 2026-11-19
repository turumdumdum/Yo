-- Settings of the optional AI answer check, per organization: extra instructions from the
-- organization, which questions are checked (and therefore sent to the provider), and
-- whether corrected answers are proposed. Written by the API after validation
-- (packages/shared/src/ai.ts) and audited; read by org admins and process managers.

create table public.ai_settings (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  check_settings jsonb not null check (jsonb_typeof(check_settings) = 'object' and pg_column_size(check_settings) <= 32768),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

revoke all on public.ai_settings from anon, authenticated;
grant select on public.ai_settings to authenticated;
grant all on public.ai_settings to service_role;

alter table public.ai_settings enable row level security;

create policy ai_settings_require_strong_session on public.ai_settings
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

create policy ai_settings_select_managers on public.ai_settings
  for select to authenticated
  using (private.has_org_role(org_id, array['org_admin', 'process_manager']::public.org_role[]));
