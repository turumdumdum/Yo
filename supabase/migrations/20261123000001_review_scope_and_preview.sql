-- Review scope and "view as" preview.
--
-- memberships.review_scope: the reviews a member may work on. Null means every review.
-- Changed only through set_member_review_scope (org admins; audited). Enforced where
-- reviews happen (reviewable_stage) and when assigning reviewers.
--
-- preview_visible_requests: for an org admin's "view as" mode, the requests another member
-- of the organization would see. It mirrors the SELECT policies on public.requests; the
-- review-scope tests check that it matches what the member really sees.

create function private.distinct_elements(p text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select cardinality(p) = (select count(distinct s) from unnest(p) s);
$$;

alter table public.memberships
  add column review_scope text[]
    check (
      review_scope is null
      or (
        cardinality(review_scope) between 1 and 5
        and review_scope <@ array['License check', 'Security review', 'Legal review', 'Finance review', 'IT review']::text[]
        and private.distinct_elements(review_scope)
      )
    );

-- The browser may update only the role column of memberships (granted earlier), so
-- review_scope changes go through the RPC below.

create function private.has_scope(p_org uuid, p_user uuid, p_stage text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select m.review_scope is null or p_stage = any (m.review_scope)
     from public.memberships m where m.org_id = p_org and m.user_id = p_user),
    false
  );
$$;

revoke all on function private.has_scope(uuid, uuid, text) from public;
grant execute on function private.has_scope(uuid, uuid, text) to authenticated, service_role;

create function public.set_member_review_scope(p_org_id uuid, p_user_id uuid, p_stages text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  v_scope text[] := case when p_stages is null or cardinality(p_stages) = 0 then null else p_stages end;
begin
  if caller is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  if not private.has_org_role(p_org_id, array['org_admin']::public.org_role[]) then
    raise exception 'only an org admin can change review access' using errcode = '42501';
  end if;
  if not exists (select 1 from public.memberships m where m.org_id = p_org_id and m.user_id = p_user_id) then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if v_scope is not null and (
    exists (select 1 from unnest(v_scope) s where s is null or s not in ('License check', 'Security review', 'Legal review', 'Finance review', 'IT review'))
    or cardinality(v_scope) <> (select count(distinct s) from unnest(v_scope) s)
  ) then
    raise exception 'choose reviews from the list, each once' using errcode = 'P0001';
  end if;

  update public.memberships set review_scope = v_scope where org_id = p_org_id and user_id = p_user_id;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (p_org_id, caller, 'member.review_scope_changed', 'membership', p_user_id::text,
          jsonb_build_object('user_id', p_user_id, 'stages', to_jsonb(v_scope)));
end;
$$;

revoke all on function public.set_member_review_scope(uuid, uuid, text[]) from public, anon;
grant execute on function public.set_member_review_scope(uuid, uuid, text[]) to authenticated;

-- Requests the member would see. Mirrors, in one query, the SELECT policies on requests:
-- requests_select_own, requests_select_submitted_managers, requests_select_stage_reviewer,
-- requests_select_viewer, and the restrictive requests_hide_trash.
create function public.preview_visible_requests(p_user_id uuid)
returns table (request_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := (select auth.uid());
  target public.memberships;
begin
  if caller is null or not private.session_is_strong() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  select m.* into target from public.memberships m
  where m.user_id = p_user_id and private.has_org_role(m.org_id, array['org_admin']::public.org_role[])
  limit 1;
  if not found then
    raise exception 'only an org admin can view the app as a member of the organization' using errcode = '42501';
  end if;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (target.org_id, caller, 'member.previewed', 'membership', p_user_id::text, jsonb_build_object('user_id', p_user_id));

  return query
  select r.id
  from public.requests r
  where r.org_id = target.org_id
    and (r.deleted_at is null or target.role = 'org_admin')
    and (
      r.requester_id = p_user_id
      or (
        r.status <> 'draft'
        and (
          target.role = 'org_admin'
          or (not r.is_confidential and target.role in ('process_manager', 'auditor'))
          or exists (select 1 from public.request_stages s where s.request_id = r.id and s.reviewer_id = p_user_id)
          or exists (select 1 from public.request_viewers v where v.request_id = r.id and v.user_id = p_user_id)
        )
      )
    );
end;
$$;

revoke all on function public.preview_visible_requests(uuid) from public, anon;
grant execute on function public.preview_visible_requests(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Enforce the scope where reviews happen and when reviewers are assigned.
-- ---------------------------------------------------------------------------

-- From 20261122000001_integrations.sql
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

  if not private.has_scope(stage.org_id, caller, stage.name) then
    raise exception 'this review is outside your review scope' using errcode = '42501';
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

-- From 20261119000002_confidential_requests.sql
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

  if p_reviewer_id is not null and not private.has_scope(stage.org_id, p_reviewer_id, stage.name) then
    raise exception 'the reviewer cannot work on this review' using errcode = 'P0001';
  end if;

  update public.request_stages set reviewer_id = p_reviewer_id where id = p_stage_id;

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (stage.org_id, (select auth.uid()), 'stage.reviewer_assigned', 'request_stage', stage.id::text,
          jsonb_build_object('request_id', stage.request_id, 'stage', stage.name, 'reviewer_id', p_reviewer_id));
end;
$$;
