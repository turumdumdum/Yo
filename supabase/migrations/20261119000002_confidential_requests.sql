-- Confidential requests. A requester can ask to keep a request confidential (a form
-- setting decides which answer means that). A confidential request is visible only to:
--   - its requester;
--   - org admins;
--   - its business owner, when the answer matches a member's email (recorded at submit);
--   - members an org admin adds as viewers;
--   - reviewers assigned to one of its stages (only an org admin can assign them now).
-- Process managers and auditors no longer see it, in the tables or through functions.
-- Child tables (stages, questions, attachments) follow the request's own policies.

alter table public.requests add column is_confidential boolean not null default false;

create table public.request_viewers (
  org_id uuid not null references public.organizations (id) on delete cascade,
  request_id uuid not null references public.requests (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- business_owner: matched from the answers at submit; added: by an org admin.
  reason text not null check (reason in ('business_owner', 'added')),
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (request_id, user_id)
);
create index request_viewers_user_id_idx on public.request_viewers (user_id);
create index request_viewers_org_id_idx on public.request_viewers (org_id);

revoke all on public.request_viewers from anon, authenticated;
grant select on public.request_viewers to authenticated;
grant all on public.request_viewers to service_role;

alter table public.request_viewers enable row level security;

create policy request_viewers_require_strong_session on public.request_viewers
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

-- Org admins, the viewer themselves and the requester see who has access.
create policy request_viewers_select on public.request_viewers
  for select to authenticated
  using (
    private.is_org_member(org_id)
    and (
      private.has_org_role(org_id, array['org_admin']::public.org_role[])
      or user_id = (select auth.uid())
      or exists (select 1 from public.requests r where r.id = request_id and r.requester_id = (select auth.uid()))
    )
  );

-- Security definer: a policy on requests that read request_viewers under RLS would recurse.
create function private.is_request_viewer(target_request uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.request_viewers v
    where v.request_id = target_request and v.user_id = (select auth.uid())
  );
$$;

revoke all on function private.is_request_viewer(uuid) from public;
grant execute on function private.is_request_viewer(uuid) to authenticated, service_role;

-- True when the caller has one of the roles for this request: org admins always, other
-- roles only while the request is not confidential.
create function private.oversees_request(target_request uuid, allowed public.org_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.requests r
    where r.id = target_request
      and (
        private.has_org_role(r.org_id, array['org_admin']::public.org_role[])
        or (not r.is_confidential and private.has_org_role(r.org_id, allowed))
      )
  );
$$;

revoke all on function private.oversees_request(uuid, public.org_role[]) from public;
grant execute on function private.oversees_request(uuid, public.org_role[]) to authenticated, service_role;

drop policy requests_select_submitted_managers on public.requests;

create policy requests_select_submitted_managers on public.requests
  for select to authenticated
  using (
    status <> 'draft'
    and (
      private.has_org_role(org_id, array['org_admin']::public.org_role[])
      or (not is_confidential and private.has_org_role(org_id, array['process_manager', 'auditor']::public.org_role[]))
    )
  );

create policy requests_select_viewer on public.requests
  for select to authenticated
  using (status <> 'draft' and private.is_request_viewer(id) and private.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- Backend only: record confidentiality and the business owner while the request is a
-- draft, right before it is submitted, so it is never visible without them.
-- ---------------------------------------------------------------------------

create function public.set_request_confidentiality(p_request_id uuid, p_confidential boolean, p_business_owner_email text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.requests;
begin
  select r.* into request from public.requests r where r.id = p_request_id and r.status = 'draft' for update;
  if not found then
    raise exception 'request is not a draft' using errcode = 'P0001';
  end if;

  update public.requests set is_confidential = coalesce(p_confidential, false) where id = request.id;

  delete from public.request_viewers where request_id = request.id and reason = 'business_owner';
  insert into public.request_viewers (org_id, request_id, user_id, reason)
  select request.org_id, request.id, m.user_id, 'business_owner'
  from public.memberships m
  where m.org_id = request.org_id
    and m.user_id <> request.requester_id
    and lower(m.email) = lower(btrim(p_business_owner_email))
  on conflict (request_id, user_id) do nothing;
end;
$$;

revoke all on function public.set_request_confidentiality(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.set_request_confidentiality(uuid, boolean, text) to service_role;

-- ---------------------------------------------------------------------------
-- Org admins: change confidentiality and who may see a confidential request.
-- ---------------------------------------------------------------------------

create function private.admin_request(p_request_id uuid)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.requests;
begin
  if (select auth.uid()) is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  select r.* into request from public.requests r where r.id = p_request_id for update;
  if not found or not private.is_org_member(request.org_id) or request.status = 'draft' then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if not private.has_org_role(request.org_id, array['org_admin']::public.org_role[]) then
    raise exception 'only an org admin can change who sees a request' using errcode = '42501';
  end if;
  return request;
end;
$$;

revoke all on function private.admin_request(uuid) from public;

create function public.set_request_confidential(p_request_id uuid, p_confidential boolean)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.requests := private.admin_request(p_request_id);
begin
  if p_confidential is null then
    raise exception 'choose confidential or not' using errcode = 'P0001';
  end if;
  update public.requests set is_confidential = p_confidential where id = request.id;
  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (request.org_id, (select auth.uid()), 'request.visibility_changed', 'request', request.id::text,
          jsonb_build_object('confidential', p_confidential));
end;
$$;

create function public.add_request_viewer(p_request_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.requests := private.admin_request(p_request_id);
begin
  if not exists (select 1 from public.memberships m where m.org_id = request.org_id and m.user_id = p_user_id) then
    raise exception 'only members of the organization can be added' using errcode = 'P0001';
  end if;
  insert into public.request_viewers (org_id, request_id, user_id, reason, added_by)
  values (request.org_id, request.id, p_user_id, 'added', (select auth.uid()))
  on conflict (request_id, user_id) do nothing;
  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (request.org_id, (select auth.uid()), 'request.viewer_added', 'request', request.id::text,
          jsonb_build_object('user_id', p_user_id));
end;
$$;

create function public.remove_request_viewer(p_request_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  request public.requests := private.admin_request(p_request_id);
begin
  delete from public.request_viewers where request_id = request.id and user_id = p_user_id;
  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (request.org_id, (select auth.uid()), 'request.viewer_removed', 'request', request.id::text,
          jsonb_build_object('user_id', p_user_id));
end;
$$;

revoke all on function public.set_request_confidential(uuid, boolean) from public, anon;
revoke all on function public.add_request_viewer(uuid, uuid) from public, anon;
revoke all on function public.remove_request_viewer(uuid, uuid) from public, anon;
grant execute on function public.set_request_confidential(uuid, boolean) to authenticated;
grant execute on function public.add_request_viewer(uuid, uuid) to authenticated;
grant execute on function public.remove_request_viewer(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Functions that let managers act on any request now respect confidentiality.
-- ---------------------------------------------------------------------------

-- From 20261114000006_stage_reviews.sql; a manager role no longer reaches a confidential request.
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

-- From 20261114000006_stage_reviews.sql; a manager role no longer reaches a confidential request.
create or replace function public.assign_stage_reviewer(p_stage_id uuid, p_reviewer_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  stage public.request_stages;
begin
  if (select auth.uid()) is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;

  select s.* into stage from public.request_stages s where s.id = p_stage_id for update;
  if not found or not private.is_org_member(stage.org_id) then
    raise exception 'stage not found' using errcode = 'P0002';
  end if;
  if not private.oversees_request(stage.request_id, array['org_admin', 'process_manager']::public.org_role[]) then
    raise exception 'only an org admin or process manager can assign reviewers' using errcode = '42501';
  end if;
  if stage.status not in ('Not started', 'In review', 'Waiting for requester') then
    raise exception 'this stage is not open for review' using errcode = 'P0001';
  end if;
  if p_reviewer_id is not null and not exists (
    select 1 from public.memberships m
    where m.org_id = stage.org_id
      and m.user_id = p_reviewer_id
      and m.role in ('org_admin', 'process_manager', 'reviewer')
  ) then
    raise exception 'the reviewer must be a member with the Reviewer, Process manager or Org admin role'
      using errcode = 'P0001';
  end if;

  update public.request_stages set reviewer_id = p_reviewer_id where id = p_stage_id;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (stage.org_id, (select auth.uid()), 'stage.reviewer_assigned', 'request_stage', stage.id::text,
          jsonb_build_object('request_id', stage.request_id, 'stage', stage.name, 'reviewer_id', p_reviewer_id));
end;
$$;

-- From 20261114000009_review_forms.sql; a manager role no longer reaches a confidential request.
create or replace function public.request_review_answers(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if (select auth.uid()) is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  select r.org_id into v_org from public.requests r where r.id = p_request_id;
  if v_org is null or not private.is_org_member(v_org) then
    return '{}'::jsonb;
  end if;
  if not (
    private.oversees_request(p_request_id, array['org_admin', 'process_manager', 'auditor']::public.org_role[])
    or private.is_stage_reviewer(p_request_id)
  ) then
    return '{}'::jsonb;
  end if;
  return coalesce(
    (select jsonb_object_agg(s.id::text, s.review_answers) from public.request_stages s where s.request_id = p_request_id),
    '{}'::jsonb
  );
end;
$$;

-- From 20261115000002_attachments.sql; a manager role no longer reaches a confidential request.
create or replace function public.register_attachment(
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
        private.oversees_request(request.id, array['org_admin', 'process_manager']::public.org_role[])
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
