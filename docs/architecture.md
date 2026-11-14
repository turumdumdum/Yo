# Architecture notes

The decisions behind this layout are in [CLAUDE.md](../CLAUDE.md) §3 and §8. This page records how the code implements them so far.

## Packages

- `packages/shared` is imported as TypeScript source by the API, the frontend and tests. It holds the product vocabulary (`domain.ts`), input schemas (`schemas.ts`) and the rule engine (`risk.ts`). It must stay free of platform-specific APIs.
- `apps/api/src/app.ts` builds a platform-neutral Hono app. `node.ts` and `worker.ts` are thin entrypoints; anything specific to Node or Cloudflare Workers belongs behind an adapter passed in from there.
- `apps/web` is a static SPA. It may only receive `VITE_*` configuration; server keys never reach it.

## Database

- Tables live in `public`; helper functions used by policies and triggers live in `private`, which is not exposed through the Supabase API.
- Privileges are explicit: each migration revokes everything from `anon` and `authenticated` and grants only the columns and operations the browser needs. RLS policies then restrict rows by membership and role.
- Policies call `private.is_org_member` and `private.has_org_role`, which are security-definer functions so that policies on `memberships` do not recurse.
- An organization is created through the `public.create_organization` RPC, which also makes the caller the first org admin.
- `audit_log` is append-only: triggers reject update, delete and truncate for every role, and the browser has no insert privilege. Membership changes are written to it by a trigger.

## Requests

- The form is declared once in `packages/shared/src/requestForm.ts` as data (steps, fields, `showWhen` conditions). The web app renders it, and the API validates with the same definitions.
- A draft is a row in `requests` that only its requester can see. The browser may write the `answers` column of its own drafts and nothing else: status, risk tier and requester are not grantable columns.
- Submission goes through `POST /v1/requests/:id/submit`. The API reads the draft with the caller's own token (so RLS decides whether the caller may see it), validates and cleans the answers, computes the risk tier and calls the `submit_request` function with the service role. The function also writes the audit log entry.
- Triage happens at submission: `planStages` in `packages/shared/src/workflow.ts` decides from the risk tier and the answers which of the default stages start (`In review`, with an SLA due date in business days) and which are `Not required` (with the reason). `submit_request` stores the stages in the same transaction, so a request is never in review without stages.
- The browser can only read `request_stages`; whoever may see the request may see its stages. Reviewer assignment, decisions and info requests are not built yet.
- The default workflow lives in code as a configuration object. The `workflow_templates` and `stage_definitions` tables from CLAUDE.md §4 arrive with the workflow builder; each stage row already stores its own name, order and SLA, so later template changes will not alter requests in flight.
- Not implemented yet: rate limiting on the API (required by CLAUDE.md §8), file attachments, per-organization catalogs (categories, legal entities and cost centers are a starter list or free text).

## Risk tier

`computeRiskTier` scores a request from data classification, business criticality, production access and annual cost, then applies minimum-tier floors. The scoring configuration is a plain object so it can later be stored per organization and edited in the workflow builder. The default weights are a proposal and have not been approved as policy.

## Decisions recorded on 2026-11-14

- **One organization per self-hosted installation.** `private.installation_settings.single_organization` is on by default and `create_organization` refuses a second organization. The hosted deployment turns it off with SQL; the browser cannot read or change the setting.
- **Reviewer and Owner roles.** The organization-level role in `memberships` stays as the base role. Per-stage reviewer assignments and per-request owner assignments (budget, business, access, technical) are added when stages and requests are built.
- **Organization deletion: anonymize the audit log.** When an organization is deleted on request, its audit entries are kept but anonymized (no user identifiers or personal data in them) instead of being deleted. Not implemented yet: today `audit_log.org_id` still blocks deleting an organization, and the append-only triggers block any change to existing entries. The deletion procedure must be a single audited server-side operation and needs its own tests.
- **Frontend framework:** React, confirmed.

## Open design points

- **Cost and currency.** The risk engine takes the annual cost as a plain number in the organization's base currency; currency conversion is not designed yet.
- **Malware scanning of uploads** is an open gap (see SECURITY.md).
- **Default risk weights and stage rules** are proposals and have not been approved as policy. Stage rules today: License check and IT review always; Finance review only for Paid services; Security and Legal review from Medium risk; 5 business days each.
- **Business days** skip weekends only (UTC). Public holidays and time zones need per-organization calendars.
