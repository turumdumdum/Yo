-- Bulk invitations and the allowed-domains restriction (CLAUDE.md §8: org admins can
-- restrict their organization to its own email domains).
--
-- The domain list doubles as the future "join by verified domain" list. Restricting
-- invitations needs no proof of domain ownership (it only narrows who can join), so
-- domains count for the restriction as soon as they are added. Joining automatically
-- by domain will require verified_at, set by the backend after a DNS check.

create function private.email_domain(p_email text)
returns text
language sql
immutable
set search_path = ''
as $$
  select lower(split_part(p_email, '@', 2));
$$;

-- True when the organization accepts this email address.
create function private.email_domain_allowed(p_org_id uuid, p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select not o.restrict_to_verified_domains
      or exists (
        select 1 from public.verified_domains d
        where d.org_id = o.id and d.domain = private.email_domain(p_email)
      )
  from public.organizations o
  where o.id = p_org_id;
$$;

revoke all on function private.email_domain(text) from public;
revoke all on function private.email_domain_allowed(uuid, text) from public;

-- ---------------------------------------------------------------------------
-- Invitation creation, shared by single and bulk invitations. Caller checks happen
-- in the public functions.
-- ---------------------------------------------------------------------------

create function private.issue_invitation(p_org_id uuid, p_email text, p_role public.org_role, p_caller uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  -- Two random UUIDs: 244 random bits.
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if p_role is null then
    raise exception 'choose a role' using errcode = 'P0001';
  end if;
  if char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'enter a valid email address' using errcode = 'P0001';
  end if;
  if not private.email_domain_allowed(p_org_id, v_email) then
    raise exception 'the domain % is not allowed in this organization', private.email_domain(v_email) using errcode = 'P0001';
  end if;
  if exists (select 1 from public.memberships m where m.org_id = p_org_id and lower(m.email) = v_email) then
    raise exception 'this person is already a member' using errcode = 'P0001';
  end if;

  -- Inviting the same address again replaces the earlier, unused invitation.
  delete from public.invitations i
  where i.org_id = p_org_id and i.email = v_email and i.accepted_at is null;

  insert into public.invitations (org_id, email, role, invited_by, token_hash, expires_at)
  values (p_org_id, v_email, p_role, p_caller, private.invitation_token_hash(v_token), now() + interval '7 days');

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_org_id, p_caller, 'invitation.created', 'invitation', v_email, jsonb_build_object('role', p_role));

  return v_token;
end;
$$;

revoke all on function private.issue_invitation(uuid, text, public.org_role, uuid) from public;

create function private.require_org_admin(p_org_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
begin
  if caller is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if not private.has_org_role(p_org_id, array['org_admin']::public.org_role[]) then
    raise exception 'only an org admin can invite people' using errcode = '42501';
  end if;
  return caller;
end;
$$;

revoke all on function private.require_org_admin(uuid) from public;

create or replace function public.create_invitation(p_org_id uuid, p_email text, p_role public.org_role)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.issue_invitation(p_org_id, p_email, p_role, private.require_org_admin(p_org_id));
end;
$$;

-- Creates many invitations at once. Each row succeeds or fails on its own; the result
-- lists, in input order, {email, role, token} or {email, role, error}.
create function public.create_invitations(p_org_id uuid, p_invitations jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := private.require_org_admin(p_org_id);
  item jsonb;
  v_email text;
  v_role text;
  seen text[] := array[]::text[];
  results jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_invitations) is distinct from 'array' then
    raise exception 'expected a list of invitations' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_invitations) > 500 then
    raise exception 'at most 500 invitations at a time' using errcode = 'P0001';
  end if;

  for item in select value from jsonb_array_elements(p_invitations) loop
    v_email := lower(btrim(coalesce(item ->> 'email', '')));
    v_role := item ->> 'role';
    begin
      if v_email = any (seen) then
        raise exception 'listed more than once' using errcode = 'P0001';
      end if;
      seen := seen || v_email;
      if v_role is null or not (v_role = any (enum_range(null::public.org_role)::text[])) then
        raise exception 'unknown role' using errcode = 'P0001';
      end if;
      results := results || jsonb_build_object(
        'email', v_email, 'role', v_role,
        'token', private.issue_invitation(p_org_id, v_email, v_role::public.org_role, caller)
      );
    exception when sqlstate 'P0001' then
      -- The failed row is rolled back on its own; the others keep their invitations.
      results := results || jsonb_build_object('email', v_email, 'role', v_role, 'error', sqlerrm);
    end;
  end loop;

  return results;
end;
$$;

revoke all on function public.create_invitations(uuid, jsonb) from public, anon;
grant execute on function public.create_invitations(uuid, jsonb) to authenticated;

-- Accepting checks the domain again: the list may have changed since the invitation.
create or replace function public.accept_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  caller_email text;
  invitation public.invitations;
begin
  if caller is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;

  select i.* into invitation
  from public.invitations i
  where i.token_hash = private.invitation_token_hash(coalesce(p_token, ''))
  for update;

  if not found or invitation.accepted_at is not null or invitation.expires_at <= now() then
    raise exception 'this invitation is not valid or has expired' using errcode = 'P0001';
  end if;

  -- The account's own email, not anything the caller can type in.
  select lower(u.email) into caller_email from auth.users u where u.id = caller;
  if caller_email is distinct from invitation.email then
    raise exception 'this invitation was sent to a different email address' using errcode = '42501';
  end if;
  if not private.email_domain_allowed(invitation.org_id, caller_email) then
    raise exception 'your email domain is no longer allowed in this organization' using errcode = '42501';
  end if;

  insert into public.memberships (org_id, user_id, role)
  values (invitation.org_id, caller, invitation.role)
  on conflict (org_id, user_id) do nothing;

  update public.invitations set accepted_at = now() where id = invitation.id;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (invitation.org_id, caller, 'invitation.accepted', 'invitation', invitation.email,
          jsonb_build_object('role', invitation.role));

  return invitation.org_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- The restriction needs at least one domain, both when it is turned on and when
-- domains are removed later.
-- ---------------------------------------------------------------------------

create function private.restriction_needs_a_domain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.restrict_to_verified_domains
     and not exists (select 1 from public.verified_domains d where d.org_id = new.id) then
    raise exception 'add at least one domain before restricting the organization to its domains' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger organizations_restriction_needs_a_domain
before update of restrict_to_verified_domains on public.organizations
for each row execute function private.restriction_needs_a_domain();

create function private.keep_last_allowed_domain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- When the organization itself is being deleted its row is already gone here.
  if exists (select 1 from public.organizations o where o.id = old.org_id and o.restrict_to_verified_domains)
     and not exists (select 1 from public.verified_domains d where d.org_id = old.org_id and d.id <> old.id) then
    raise exception 'turn off the domain restriction before removing the last domain' using errcode = 'P0001';
  end if;
  return old;
end;
$$;

create trigger verified_domains_keep_last_allowed_domain
before delete on public.verified_domains
for each row execute function private.keep_last_allowed_domain();

create function private.audit_domain_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id)
    values (new.org_id, (select auth.uid()), 'domain.added', 'domain', new.domain);
    return new;
  end if;
  -- Skip when the whole organization is being deleted.
  if exists (select 1 from public.organizations o where o.id = old.org_id) then
    insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id)
    values (old.org_id, (select auth.uid()), 'domain.removed', 'domain', old.domain);
  end if;
  return old;
end;
$$;

create trigger verified_domains_audit
after insert or delete on public.verified_domains
for each row execute function private.audit_domain_change();
