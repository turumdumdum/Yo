-- Every question of a request form can now be changed or removed, including "Service name".
-- The request name therefore comes from the question the form names in "titleField"
-- (serviceName when unset, which covers the standard form and forms saved earlier).
-- It was a generated column; it becomes a plain column kept up to date by a trigger.
-- The browser still cannot write it: authenticated only has column grants on answers
-- (and org_id on insert).

alter table public.requests alter column service_name drop expression;

create function private.set_request_title()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.service_name := nullif(
    left(btrim(new.answers ->> coalesce(new.form ->> 'titleField', 'serviceName')), 200),
    ''
  );
  return new;
end;
$$;

-- Runs after requests_set_form (triggers fire in name order), so a new draft uses the form
-- that was just copied into it.
create trigger requests_set_title
before insert or update of answers, form on public.requests
for each row execute function private.set_request_title();

update public.requests
set service_name = nullif(left(btrim(answers ->> coalesce(form ->> 'titleField', 'serviceName')), 200), '');
