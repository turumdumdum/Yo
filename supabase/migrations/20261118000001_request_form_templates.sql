-- Request form templates (CLAUDE.md §3: forms are data, not code). An organization keeps
-- any number of saved forms and marks one as active; without an active one the standard
-- form applies. The active form is copied into each new draft, so editing a template
-- never changes requests already started.
--
-- Templates are written by the API, which validates them with the shared form validator.

create table public.request_form_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  description text check (char_length(description) <= 400),
  definition jsonb not null check (
    jsonb_typeof(definition) = 'object'
    and jsonb_typeof(definition -> 'steps') = 'array'
    and pg_column_size(definition) <= 262144
  ),
  is_active boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, name)
);
create unique index request_form_templates_one_active on public.request_form_templates (org_id) where is_active;

create trigger request_form_templates_set_updated_at
before update on public.request_form_templates
for each row execute function private.set_updated_at();

revoke all on public.request_form_templates from anon, authenticated;
grant select on public.request_form_templates to authenticated;
grant all on public.request_form_templates to service_role;

alter table public.request_form_templates enable row level security;

create policy request_form_templates_require_strong_session on public.request_form_templates
  as restrictive for all to authenticated
  using (private.session_is_strong()) with check (private.session_is_strong());

-- Only the people who manage the process see the saved forms. Requesters get the active
-- form through their draft.
create policy request_form_templates_select_managers on public.request_form_templates
  for select to authenticated
  using (private.has_org_role(org_id, array['org_admin', 'process_manager']::public.org_role[]));

-- ---------------------------------------------------------------------------
-- Each request carries the form it was started with (null = the standard form).
-- The browser can read it but never set it.
-- ---------------------------------------------------------------------------

alter table public.requests add column form jsonb check (form is null or jsonb_typeof(form) = 'object');

create function private.set_request_form()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.form := (
    select t.definition from public.request_form_templates t
    where t.org_id = new.org_id and t.is_active
  );
  return new;
end;
$$;

create trigger requests_set_form
before insert on public.requests
for each row execute function private.set_request_form();

-- Backend only: make one form active (or none, for the standard form) in one step.
create function public.activate_request_form(p_org_id uuid, p_template_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_template_id is not null and not exists (
    select 1 from public.request_form_templates t where t.id = p_template_id and t.org_id = p_org_id
  ) then
    return false;
  end if;
  update public.request_form_templates set is_active = false where org_id = p_org_id and is_active;
  if p_template_id is not null then
    update public.request_form_templates set is_active = true where id = p_template_id;
  end if;
  return true;
end;
$$;

revoke all on function public.activate_request_form(uuid, uuid) from public, anon, authenticated;
grant execute on function public.activate_request_form(uuid, uuid) to service_role;
