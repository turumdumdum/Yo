-- 1. Per-organization review settings: when each review is needed, its time to review
--    and checklist (packages/shared/src/stageSettings.ts). Written by the API after
--    validation; read by members so the app can show them.
-- 2. Archive and trash for decided requests (approved or rejected), org admins only.
--    Archived requests stay visible to whoever could see them. Requests in the trash are
--    visible to org admins only, and can be deleted for good from there.

create table public.workflow_settings (
  org_id uuid primary key references public.organizations (id) on delete cascade,
  stages jsonb not null check (jsonb_typeof(stages) = 'object' and pg_column_size(stages) <= 65536),
  updated_by uuid references auth.users (id) on delete set null,
  updated_at timestamptz not null default now()
);

revoke all on public.workflow_settings from anon, authenticated;
grant select on public.workflow_settings to authenticated;
grant all on public.workflow_settings to service_role;

alter table public.workflow_settings enable row level security;

create policy workflow_settings_require_strong_session on public.workflow_settings
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

create policy workflow_settings_select_member on public.workflow_settings
  for select to authenticated
  using (private.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- Archive and trash
-- ---------------------------------------------------------------------------

alter table public.requests
  add column archived_at timestamptz,
  add column archived_by uuid references auth.users (id) on delete set null,
  add column deleted_at timestamptz,
  add column deleted_by uuid references auth.users (id) on delete set null;

-- Requests in the trash: org admins only. Stages, questions, files and viewers follow,
-- because their policies read requests under the caller's RLS.
create policy requests_hide_trash on public.requests
  as restrictive for select to authenticated
  using (deleted_at is null or private.has_org_role(org_id, array['org_admin']::public.org_role[]));

create function private.decided_request_for_admin(p_request_id uuid)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.requests := private.admin_request(p_request_id);
begin
  if request.status not in ('approved', 'rejected') then
    raise exception 'only approved or rejected requests can be archived or moved to the trash' using errcode = 'P0001';
  end if;
  return request;
end;
$$;

revoke all on function private.decided_request_for_admin(uuid) from public;

create function public.set_request_archived(p_request_id uuid, p_archived boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.requests := private.decided_request_for_admin(p_request_id);
begin
  if p_archived is null then
    raise exception 'choose archive or restore' using errcode = 'P0001';
  end if;
  if request.deleted_at is not null then
    raise exception 'restore the request from the trash first' using errcode = 'P0001';
  end if;
  update public.requests
  set archived_at = case when p_archived then now() end,
      archived_by = case when p_archived then (select auth.uid()) end
  where id = request.id;
  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (request.org_id, (select auth.uid()), case when p_archived then 'request.archived' else 'request.unarchived' end,
          'request', request.id::text, jsonb_build_object('service_name', request.service_name));
end;
$$;

create function public.set_request_trashed(p_request_id uuid, p_trashed boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.requests := private.decided_request_for_admin(p_request_id);
begin
  if p_trashed is null then
    raise exception 'choose move to trash or restore' using errcode = 'P0001';
  end if;
  update public.requests
  set deleted_at = case when p_trashed then now() end,
      deleted_by = case when p_trashed then (select auth.uid()) end
  where id = request.id;
  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (request.org_id, (select auth.uid()), case when p_trashed then 'request.trashed' else 'request.restored' end,
          'request', request.id::text, jsonb_build_object('service_name', request.service_name));
end;
$$;

revoke all on function public.set_request_archived(uuid, boolean) from public, anon;
revoke all on function public.set_request_trashed(uuid, boolean) from public, anon;
grant execute on function public.set_request_archived(uuid, boolean) to authenticated;
grant execute on function public.set_request_trashed(uuid, boolean) to authenticated;

-- Backend only: deletes a request in the trash for good, with its stages, questions,
-- viewers and attachment records. Returns the storage paths of its files, which the
-- backend then removes. The audit log keeps the fact and the name.
create function public.purge_request(p_request_id uuid, p_actor uuid)
returns text[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.requests;
  paths text[];
begin
  select r.* into request from public.requests r where r.id = p_request_id for update;
  if not found then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.memberships m where m.org_id = request.org_id and m.user_id = p_actor and m.role = 'org_admin'
  ) then
    raise exception 'only an org admin can delete a request' using errcode = '42501';
  end if;
  if request.deleted_at is null then
    raise exception 'move the request to the trash first' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(a.storage_path), array[]::text[]) into paths
  from public.attachments a where a.request_id = request.id;

  delete from public.requests where id = request.id;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (request.org_id, p_actor, 'request.deleted_permanently', 'request', request.id::text,
          jsonb_build_object('service_name', request.service_name, 'files', coalesce(array_length(paths, 1), 0)));
  return paths;
end;
$$;

revoke all on function public.purge_request(uuid, uuid) from public, anon, authenticated;
grant execute on function public.purge_request(uuid, uuid) to service_role;
