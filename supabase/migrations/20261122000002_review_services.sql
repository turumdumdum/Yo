-- Several external review services: each external stage records which service
-- (Admin → Integrations → Review services) handles it, so status updates are verified
-- with that service's own signing secret.

alter table public.request_stages
  add column external_service text check (char_length(external_service) between 1 and 40);

grant select (external_service) on public.request_stages to authenticated;

-- Submission stores the service of each external stage.
create or replace function public.submit_request(
  p_request_id uuid,
  p_answers jsonb,
  p_risk_tier text,
  p_risk_score integer,
  p_risk_reasons jsonb,
  -- [{"name", "status", "note", "sla_business_days", "sla_due_at", "checklist": [text],
  --   "review_fields": [...], "review_rules": [...]}] in display order
  p_stages jsonb
)
returns public.requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  submitted public.requests;
begin
  if jsonb_typeof(p_stages) <> 'array' or jsonb_array_length(p_stages) = 0 then
    raise exception 'a submitted request needs at least one stage' using errcode = 'P0001';
  end if;

  update public.requests r
  set status = 'in_review',
      answers = p_answers,
      request_type = p_answers ->> 'requestType',
      risk_tier = p_risk_tier,
      risk_score = p_risk_score,
      risk_reasons = p_risk_reasons,
      submitted_at = now()
  where r.id = p_request_id
    and r.status = 'draft'
  returning r.* into submitted;

  if not found then
    raise exception 'request is not a draft' using errcode = 'P0001';
  end if;

  insert into public.request_stages
    (org_id, request_id, position, name, status, note, sla_business_days, sla_due_at, checklist, review_fields, review_rules, external, external_service)
  select submitted.org_id, submitted.id, s.ordinality::integer, s.stage ->> 'name', s.stage ->> 'status',
         s.stage ->> 'note', (s.stage ->> 'sla_business_days')::integer, (s.stage ->> 'sla_due_at')::timestamptz,
         coalesce(
           (select jsonb_agg(jsonb_build_object('label', item, 'checked', false))
            from jsonb_array_elements_text(
              case when jsonb_typeof(s.stage -> 'checklist') = 'array' then s.stage -> 'checklist' else '[]'::jsonb end
            ) item),
           '[]'::jsonb
         ),
         case when jsonb_typeof(s.stage -> 'review_fields') = 'array' then s.stage -> 'review_fields' else '[]'::jsonb end,
         case when jsonb_typeof(s.stage -> 'review_rules') = 'array' then s.stage -> 'review_rules' else '[]'::jsonb end,
         coalesce((s.stage ->> 'external')::boolean, false),
         nullif(s.stage ->> 'external_service', '')
  from jsonb_array_elements(p_stages) with ordinality as s(stage, ordinality);

  insert into public.audit_log (org_id, actor_id, action, entity_type, entity_id, metadata)
  values (submitted.org_id, submitted.requester_id, 'request.submitted', 'request', submitted.id::text,
          jsonb_build_object(
            'risk_tier', p_risk_tier,
            'risk_score', p_risk_score,
            'stages', (select jsonb_agg(s ->> 'name') from jsonb_array_elements(p_stages) s
                       where s ->> 'status' <> 'Not required')
          ));

  return submitted;
end;
$$;
