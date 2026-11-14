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
- The browser can only read `request_stages`; whoever may see the request may see its stages.
- The default workflow lives in code as a configuration object. The `workflow_templates` and `stage_definitions` tables from CLAUDE.md §4 arrive with the workflow builder; each stage row already stores its own name, order and SLA, so later template changes will not alter requests in flight.
- Not implemented yet: rate limiting on the API (required by CLAUDE.md §8), file attachments, per-organization catalogs (categories, legal entities and cost centers are a starter list or free text).

## Reviews

- Stage writes go through three security-definer functions: `assign_stage_reviewer` (org admin or process manager), `set_stage_checklist_item` and `decide_stage` (the assigned reviewer, or an org admin or process manager). The browser has no direct write access to `request_stages`.
- `decide_stage` locks the request row first, so two reviewers deciding at the same moment cannot both miss that they were the last. When no stage is open any more, the request becomes `rejected` if any stage was rejected and `approved` otherwise.
- Approving needs the whole checklist ticked; approving with conditions needs the conditions; rejecting needs a comment.
- A person cannot review their own request unless the org admin turns on `organizations.allow_self_review`. The change is audited.
- An assigned reviewer can open the whole request (policy `requests_select_stage_reviewer`), not only their stage.
- Default checklists and the form steps each stage focuses on are part of the workflow configuration in `packages/shared/src/workflow.ts`. The checklist is copied into the stage at submission.

## Members and invitations

- Nobody inserts memberships directly. `create_invitation` (org admin) returns a one-time token and stores only its SHA-256 hash; `accept_invitation` makes the signed-in account a member if its email matches, the invitation is unused and not older than 7 days.
- Email is not sent yet: the admin copies the link. The web app moves the token from the URL into local storage and exchanges it after sign-in and two-step verification.
- `memberships.email` is copied from the account at insert time so that colleagues can be shown by email.

## AI plugin (optional)

CLAUDE.md §2 applies: the core works without AI, the plugin is off by default and uses the operator's own key. The roadmap lists it under stage 5; the owner asked for it earlier.

- `apps/api/src/ai/provider.ts` defines the only thing a provider must do: run a task (instructions, input, JSON schema) and return JSON. `parallel.ts` implements it for Parallel's Task API. Another model or API is added by implementing the same interface and naming it in `config.ts`.
- `AI_PROVIDER` unset means no provider: `GET /v1/ai` answers `enabled: false`, the AI endpoints answer 404 and the web app shows no AI buttons.
- Vendor lookup sends only the service name, vendor name and website. The answer check sends the form answers with owner names replaced by "Named" / "Not required". Attachments are never sent (there are none yet).
- Model output is untrusted. Each suggested value passes the same validation as a typed answer, only a fixed list of fields can be suggested, and the backend never writes suggestions to the request: the requester applies them one by one. Remarks are advice and never block submission.
- One AI call per request every 10 seconds, counted per API process. This is not a substitute for real rate limiting.
- Not done: a per-organization switch and per-organization keys (needed for the hosted version), audit log entries for AI use, cost limits.

## Risk tier

`computeRiskTier` scores a request from data classification, business criticality, production access and annual cost, then applies minimum-tier floors. The scoring configuration is a plain object so it can later be stored per organization and edited in the workflow builder. The default weights are a proposal and have not been approved as policy.

## Decisions recorded on 2026-11-14

- **One organization per self-hosted installation.** `private.installation_settings.single_organization` is on by default and `create_organization` refuses a second organization. The hosted deployment turns it off with SQL; the browser cannot read or change the setting.
- **Reviewer and Owner roles.** The organization-level role in `memberships` stays as the base role. Reviewers are assigned per stage. Owners (budget, business, access, technical) are still free text on the request, not linked to accounts.
- **Organization deletion: anonymize the audit log.** When an organization is deleted on request, its audit entries are kept but anonymized (no user identifiers or personal data in them) instead of being deleted. Not implemented yet: today `audit_log.org_id` still blocks deleting an organization, and the append-only triggers block any change to existing entries. The deletion procedure must be a single audited server-side operation and needs its own tests.
- **Frontend framework:** React, confirmed.

## Open design points

- **Cost and currency.** The risk engine takes the annual cost as a plain number in the organization's base currency; currency conversion is not designed yet.
- **Malware scanning of uploads** is an open gap (see SECURITY.md).
- **Default risk weights and stage rules** are proposals and have not been approved as policy. Stage rules and checklists today are in `workflow.ts`: License check and IT review always; Finance review only for Paid services; Security and Legal review from Medium risk; 5 business days each.
- **Business days** skip weekends only (UTC). Public holidays and time zones need per-organization calendars.
