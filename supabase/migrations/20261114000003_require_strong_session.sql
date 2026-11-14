-- Mandatory MFA is enforced in the database, not only in the UI (CLAUDE.md §8).
-- A session may touch tenant data only if it is "strong":
--   * it has passed a second factor (aal2), or
--   * it was started with an OAuth provider (Google), which carries its own MFA.
-- Email + password sessions without TOTP see no rows and cannot write.
-- Keep in sync with isStrongSession() in packages/shared/src/auth.ts.

create function private.session_is_strong()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
      or coalesce((select auth.jwt()) -> 'amr', '[]'::jsonb) @> '[{"method": "oauth"}]'::jsonb;
$$;

revoke all on function private.session_is_strong() from public;
grant execute on function private.session_is_strong() to authenticated, service_role;

-- Restrictive policies are AND-ed with the permissive ones from earlier migrations.
create policy organizations_require_strong_session on public.organizations
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

create policy memberships_require_strong_session on public.memberships
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

create policy invitations_require_strong_session on public.invitations
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

create policy verified_domains_require_strong_session on public.verified_domains
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

create policy audit_log_require_strong_session on public.audit_log
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

create or replace function public.create_organization(org_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  single_org boolean;
  new_org_id uuid;
begin
  if caller is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;

  -- Locking the settings row serializes concurrent creators, so two callers
  -- cannot both pass the check below.
  select s.single_organization into single_org
  from private.installation_settings s
  for update;

  if single_org and exists (select 1 from public.organizations) then
    raise exception 'this installation allows only one organization' using errcode = 'P0001';
  end if;

  insert into public.organizations (name)
  values (btrim(org_name))
  returning id into new_org_id;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id)
  values (new_org_id, caller, 'organization.created', 'organization', new_org_id::text);

  insert into public.memberships (org_id, user_id, role)
  values (new_org_id, caller, 'org_admin');

  return new_org_id;
end;
$$;
