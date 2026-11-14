-- Invitations (CLAUDE.md §8: users join an organization only by invitation or verified
-- domain). The org admin creates an invitation and gets a one-time link to pass on;
-- sending it by email arrives with notifications. Only a hash of the token is stored.

create function private.invitation_token_hash(p_token text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

create function public.create_invitation(p_org_id uuid, p_email text, p_role public.org_role)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  v_email text := lower(btrim(coalesce(p_email, '')));
  -- Two random UUIDs: 244 random bits.
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if caller is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if not private.has_org_role(p_org_id, array['org_admin']::public.org_role[]) then
    raise exception 'only an org admin can invite people' using errcode = '42501';
  end if;
  if p_role is null then
    raise exception 'choose a role' using errcode = 'P0001';
  end if;
  if char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'enter a valid email address' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.memberships m where m.org_id = p_org_id and lower(m.email) = v_email) then
    raise exception 'this person is already a member' using errcode = 'P0001';
  end if;

  -- Inviting the same address again replaces the earlier, unused invitation.
  delete from public.invitations i
  where i.org_id = p_org_id and i.email = v_email and i.accepted_at is null;

  insert into public.invitations (org_id, email, role, invited_by, token_hash, expires_at)
  values (p_org_id, v_email, p_role, caller, private.invitation_token_hash(v_token), now() + interval '7 days');

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_org_id, caller, 'invitation.created', 'invitation', v_email, jsonb_build_object('role', p_role));

  return v_token;
end;
$$;

create function public.accept_invitation(p_token text)
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

revoke all on function private.invitation_token_hash(text) from public;
revoke all on function public.create_invitation(uuid, text, public.org_role) from public, anon;
revoke all on function public.accept_invitation(text) from public, anon;
grant execute on function public.create_invitation(uuid, text, public.org_role) to authenticated;
grant execute on function public.accept_invitation(text) to authenticated;
