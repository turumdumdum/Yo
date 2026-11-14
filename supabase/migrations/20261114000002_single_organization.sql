-- Self-host runs one company per installation (CLAUDE.md §3). The limit is a
-- setting, on by default; the hosted multi-tenant deployment turns it off with
--   update private.installation_settings set single_organization = false;

create table private.installation_settings (
  -- Single-row table.
  id boolean primary key default true check (id),
  single_organization boolean not null default true
);

insert into private.installation_settings default values;

alter table private.installation_settings enable row level security;
revoke all on private.installation_settings from public, anon, authenticated;

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
