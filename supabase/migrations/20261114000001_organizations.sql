-- Organizations, memberships, invitations, verified domains and the audit log.
-- Stage 1, step 1 (CLAUDE.md §4, §8). Every table has RLS enabled; isolation is
-- proven by supabase/tests/tenant-isolation.test.ts.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create type public.org_role as enum (
  'org_admin',
  'process_manager',
  'reviewer',
  'requester',
  'owner',
  'auditor'
);

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  -- Org admins can enforce Google-only sign-in and restrict joining to verified domains.
  google_sign_in_only boolean not null default false,
  restrict_to_verified_domains boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.memberships (
  org_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_id_idx on public.memberships (user_id);

-- Created and accepted through the API (token generation and email are server-side).
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  email text not null check (email = lower(email)),
  role public.org_role not null,
  invited_by uuid references auth.users (id) on delete set null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create index invitations_org_id_idx on public.invitations (org_id);

create table public.verified_domains (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  domain text not null check (domain = lower(domain) and domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  -- Set only by the backend after a DNS check; never by the browser.
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, domain)
);

-- Append-only. Written by security-definer functions, triggers and the backend.
create table public.audit_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id),
  actor_id uuid,
  action text not null,
  entity_type text not null,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_org_id_created_at_idx on public.audit_log (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Helper functions used by policies. Security definer so that policies on
-- memberships do not recurse into themselves.
-- ---------------------------------------------------------------------------

create function private.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = target_org
      and m.user_id = (select auth.uid())
  );
$$;

create function private.has_org_role(target_org uuid, allowed public.org_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.org_id = target_org
      and m.user_id = (select auth.uid())
      and m.role = any (allowed)
  );
$$;

revoke all on function private.is_org_member(uuid) from public;
revoke all on function private.has_org_role(uuid, public.org_role[]) from public;
grant execute on function private.is_org_member(uuid) to authenticated, service_role;
grant execute on function private.has_org_role(uuid, public.org_role[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function private.set_updated_at();

create function private.audit_log_is_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_log is append-only' using errcode = 'P0001';
end;
$$;

create trigger audit_log_no_update_or_delete
before update or delete on public.audit_log
for each row execute function private.audit_log_is_append_only();

create trigger audit_log_no_truncate
before truncate on public.audit_log
for each statement execute function private.audit_log_is_append_only();

-- An organization must always keep at least one org admin.
create function private.keep_last_org_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'org_admin'
     and (tg_op = 'DELETE' or new.role <> 'org_admin' or new.org_id <> old.org_id)
     and not exists (
       select 1
       from public.memberships m
       where m.org_id = old.org_id
         and m.role = 'org_admin'
         and m.user_id <> old.user_id
     )
  then
    raise exception 'an organization must keep at least one org admin' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger memberships_keep_last_org_admin
before update or delete on public.memberships
for each row execute function private.keep_last_org_admin();

-- Role changes are audited (CLAUDE.md §8).
create function private.audit_membership_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
    values (new.org_id, (select auth.uid()), 'membership.created', 'membership', new.user_id::text,
            jsonb_build_object('role', new.role));
    return new;
  elsif tg_op = 'UPDATE' then
    if new.role is distinct from old.role then
      insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
      values (new.org_id, (select auth.uid()), 'membership.role_changed', 'membership', new.user_id::text,
              jsonb_build_object('from', old.role, 'to', new.role));
    end if;
    return new;
  else
    insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
    values (old.org_id, (select auth.uid()), 'membership.removed', 'membership', old.user_id::text,
            jsonb_build_object('role', old.role));
    return old;
  end if;
end;
$$;

create trigger memberships_audit
after insert or update or delete on public.memberships
for each row execute function private.audit_membership_change();

-- ---------------------------------------------------------------------------
-- RPC: create an organization and make the caller its first org admin.
-- ---------------------------------------------------------------------------

create function public.create_organization(org_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  new_org_id uuid;
begin
  if caller is null then
    raise exception 'not authenticated' using errcode = '28000';
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

revoke all on function public.create_organization(text) from public, anon;
grant execute on function public.create_organization(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Privileges: start from nothing, grant only what a signed-in browser needs.
-- ---------------------------------------------------------------------------

revoke all on public.organizations, public.memberships, public.invitations,
  public.verified_domains, public.audit_log from anon, authenticated;

grant select on public.organizations to authenticated;
grant update (name, google_sign_in_only, restrict_to_verified_domains) on public.organizations to authenticated;

grant select, delete on public.memberships to authenticated;
grant insert (org_id, user_id, role) on public.memberships to authenticated;
grant update (role) on public.memberships to authenticated;

grant select, delete on public.invitations to authenticated;

grant select, delete on public.verified_domains to authenticated;
grant insert (org_id, domain) on public.verified_domains to authenticated;

grant select on public.audit_log to authenticated;

grant all on public.organizations, public.memberships, public.invitations,
  public.verified_domains to service_role;
grant select, insert on public.audit_log to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.invitations enable row level security;
alter table public.verified_domains enable row level security;
alter table public.audit_log enable row level security;

-- organizations: created only through create_organization(); never deleted from the browser.
create policy organizations_select_member on public.organizations
  for select to authenticated
  using (private.is_org_member(id));

create policy organizations_update_admin on public.organizations
  for update to authenticated
  using (private.has_org_role(id, array['org_admin']::public.org_role[]))
  with check (private.has_org_role(id, array['org_admin']::public.org_role[]));

-- memberships: members see their colleagues; only org admins change them.
create policy memberships_select_member on public.memberships
  for select to authenticated
  using (private.is_org_member(org_id));

create policy memberships_insert_admin on public.memberships
  for insert to authenticated
  with check (private.has_org_role(org_id, array['org_admin']::public.org_role[]));

create policy memberships_update_admin on public.memberships
  for update to authenticated
  using (private.has_org_role(org_id, array['org_admin']::public.org_role[]))
  with check (private.has_org_role(org_id, array['org_admin']::public.org_role[]));

create policy memberships_delete_admin on public.memberships
  for delete to authenticated
  using (private.has_org_role(org_id, array['org_admin']::public.org_role[]));

-- invitations: org admins can list and revoke; creation goes through the API.
create policy invitations_select_admin on public.invitations
  for select to authenticated
  using (private.has_org_role(org_id, array['org_admin']::public.org_role[]));

create policy invitations_delete_admin on public.invitations
  for delete to authenticated
  using (private.has_org_role(org_id, array['org_admin']::public.org_role[]));

-- verified_domains: members can read; org admins add and remove. verified_at is backend-only.
create policy verified_domains_select_member on public.verified_domains
  for select to authenticated
  using (private.is_org_member(org_id));

create policy verified_domains_insert_admin on public.verified_domains
  for insert to authenticated
  with check (private.has_org_role(org_id, array['org_admin']::public.org_role[]));

create policy verified_domains_delete_admin on public.verified_domains
  for delete to authenticated
  using (private.has_org_role(org_id, array['org_admin']::public.org_role[]));

-- audit_log: readable by org admins and auditors; no browser writes.
create policy audit_log_select_admin_auditor on public.audit_log
  for select to authenticated
  using (private.has_org_role(org_id, array['org_admin', 'auditor']::public.org_role[]));
