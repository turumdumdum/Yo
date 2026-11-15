-- Attachments (CLAUDE.md §4, §5 step 7, §8 Files). Files live in a private storage
-- bucket that has no access policies at all: only the backend, with the service role,
-- can create signed upload and download URLs, after the checks below. The browser
-- never talks to storage on its own authority.
--
-- Open gap, stated on purpose: uploaded files are not scanned for malware.
--
-- Keep the limits in sync with packages/shared/src/attachments.ts.

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  request_id uuid not null references public.requests (id) on delete cascade,
  kind text not null check (
    kind in ('Quote', 'Contract draft', 'DPA', 'SOC 2 / ISO report', 'Security questionnaire', 'Other')
  ),
  filename text not null check (char_length(filename) between 1 and 200),
  content_type text not null,
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  -- org_id/request_id/attachment_id: never contains anything the user typed.
  storage_path text not null unique,
  -- 'pending' until the backend has seen the file in storage.
  status text not null default 'pending' check (status in ('pending', 'uploaded')),
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  uploaded_at timestamptz
);
create index attachments_request_id_idx on public.attachments (request_id, created_at);

revoke all on public.attachments from anon, authenticated;
grant select on public.attachments to authenticated;
grant all on public.attachments to service_role;

alter table public.attachments enable row level security;

create policy attachments_require_strong_session on public.attachments
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

-- Whoever may see the request may see what is attached to it.
create policy attachments_select_with_request on public.attachments
  for select to authenticated
  using (exists (select 1 from public.requests r where r.id = request_id and r.org_id = attachments.org_id));

-- ---------------------------------------------------------------------------
-- RPC: register a file before uploading it. Called by the API with the user's own
-- token, so every check here runs as that user.
-- ---------------------------------------------------------------------------

create function public.register_attachment(
  p_request_id uuid,
  p_filename text,
  p_content_type text,
  p_size bigint,
  p_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  request public.requests;
  -- Last path segment, without control characters.
  v_filename text := btrim(regexp_replace(regexp_replace(coalesce(p_filename, ''), '^.*[/\\]', ''), '[\x01-\x1f\x7f]', '', 'g'));
  new_id uuid := gen_random_uuid();
  v_path text;
begin
  if caller is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;

  select r.* into request from public.requests r where r.id = p_request_id for update;
  if not found or not private.is_org_member(request.org_id) then
    raise exception 'request not found' using errcode = 'P0002';
  end if;

  -- The requester while the request is a draft or in review; reviewers and managers
  -- while it is in review. Nothing is added to a decided request.
  if not (
    (request.requester_id = caller and request.status in ('draft', 'submitted', 'in_review'))
    or (
      request.status in ('submitted', 'in_review')
      and (
        private.has_org_role(request.org_id, array['org_admin', 'process_manager']::public.org_role[])
        or private.is_stage_reviewer(request.id)
      )
    )
  ) then
    raise exception 'you cannot attach files to this request' using errcode = '42501';
  end if;

  if v_filename = '' or char_length(v_filename) > 200 then
    raise exception 'the file needs a name of at most 200 characters' using errcode = 'P0001';
  end if;
  if p_content_type is null or p_content_type not in (
    'application/pdf', 'image/png', 'image/jpeg', 'text/csv', 'text/plain',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ) then
    raise exception 'this file type is not allowed' using errcode = 'P0001';
  end if;
  if p_size is null or p_size < 1 or p_size > 26214400 then
    raise exception 'the file must be between 1 byte and 25 MB' using errcode = 'P0001';
  end if;
  if p_kind is null or p_kind not in ('Quote', 'Contract draft', 'DPA', 'SOC 2 / ISO report', 'Security questionnaire', 'Other') then
    raise exception 'choose what kind of document this is' using errcode = 'P0001';
  end if;

  -- Uploads abandoned more than an hour ago do not count.
  if (
    select count(*) from public.attachments a
    where a.request_id = request.id
      and (a.status = 'uploaded' or a.created_at > now() - interval '1 hour')
  ) >= 20 then
    raise exception 'a request can have at most 20 files' using errcode = 'P0001';
  end if;

  v_path := request.org_id::text || '/' || request.id::text || '/' || new_id::text;

  insert into public.attachments (id, org_id, request_id, kind, filename, content_type, size_bytes, storage_path, uploaded_by)
  values (new_id, request.org_id, request.id, p_kind, v_filename, p_content_type, p_size, v_path, caller);

  return jsonb_build_object('id', new_id, 'path', v_path);
end;
$$;

-- ---------------------------------------------------------------------------
-- Backend only: the file has arrived in storage.
-- ---------------------------------------------------------------------------

create function public.complete_attachment(p_attachment_id uuid, p_actual_size bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  attachment public.attachments;
begin
  update public.attachments a
  set status = 'uploaded', size_bytes = p_actual_size, uploaded_at = now()
  where a.id = p_attachment_id and a.status = 'pending'
  returning a.* into attachment;

  if not found then
    raise exception 'attachment is not pending' using errcode = 'P0001';
  end if;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (attachment.org_id, attachment.uploaded_by, 'attachment.uploaded', 'attachment', attachment.id::text,
          jsonb_build_object('request_id', attachment.request_id, 'filename', attachment.filename, 'kind', attachment.kind,
                             'size_bytes', attachment.size_bytes));
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: remove a file. The person who added it can remove it while the request is
-- still a draft, or while the upload never finished. Returns the storage path so
-- the backend can delete the object.
-- ---------------------------------------------------------------------------

create function public.delete_attachment(p_attachment_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  attachment public.attachments;
  request_status public.request_status;
begin
  if caller is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;

  select a.* into attachment from public.attachments a where a.id = p_attachment_id for update;
  if not found or not private.is_org_member(attachment.org_id) then
    raise exception 'attachment not found' using errcode = 'P0002';
  end if;
  if attachment.uploaded_by is distinct from caller then
    raise exception 'only the person who added a file can remove it' using errcode = '42501';
  end if;

  select r.status into request_status from public.requests r where r.id = attachment.request_id;
  if attachment.status = 'uploaded' and request_status <> 'draft' then
    raise exception 'files cannot be removed after the request was submitted' using errcode = 'P0001';
  end if;

  delete from public.attachments where id = attachment.id;

  if attachment.status = 'uploaded' then
    insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
    values (attachment.org_id, caller, 'attachment.deleted', 'attachment', attachment.id::text,
            jsonb_build_object('request_id', attachment.request_id, 'filename', attachment.filename));
  end if;

  return attachment.storage_path;
end;
$$;

revoke all on function public.register_attachment(uuid, text, text, bigint, text) from public, anon;
revoke all on function public.delete_attachment(uuid) from public, anon;
revoke all on function public.complete_attachment(uuid, bigint) from public, anon, authenticated;
grant execute on function public.register_attachment(uuid, text, text, bigint, text) to authenticated;
grant execute on function public.delete_attachment(uuid) to authenticated;
grant execute on function public.complete_attachment(uuid, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- The private bucket, where Supabase Storage is present (it is not in the plain
-- Postgres used by the tests). No policies on storage.objects: service role only.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'attachments', 'attachments', false, 26214400,
      array[
        'application/pdf', 'image/png', 'image/jpeg', 'text/csv', 'text/plain',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      ]
    )
    on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;
  end if;
end
$$;
