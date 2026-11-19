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

## Request forms

- The standard form is `DEFAULT_REQUEST_FORM` in `packages/shared/src/requestForm.ts`. Every function that renders or validates answers takes the form as a parameter, so a custom form drives the UI, the server-side validation, the summary and the AI assistant alike.
- Organizations keep saved forms in `request_form_templates` and mark at most one as active. A trigger copies the active form into `requests.form` when a draft is created (null means the standard form); the browser cannot set or change that column. Editing or deleting a saved form therefore never changes a request already started.
- Saved forms are written through `POST/PUT/DELETE /v1/request-forms` and `POST /v1/request-forms/:id/activate` (`standard` returns to the built-in form). The API checks that the caller is an org admin or process manager and validates the form with `parseRequestForm`; every change is audited.
- **Every question can be changed or removed**, including the standard ones. What the product needs from answers is configured in the form instead of being tied to fixed questions:
  - *Risk:* a choice of a one-choice or several-choices question can add risk points and/or set a minimum tier; a number or amount can add points from a threshold (the highest reached counts). The form's `riskLevels` turn the total into Low / Medium / High / Critical. The standard form carries the default weights. Forms saved before this keep the standard weights for questions with standard keys (see `choiceRisk` / `numberRiskBands` in `packages/shared/src/risk.ts`).
  - *Request name:* `titleField` names a required, always-shown short-text question; a trigger copies its answer into `requests.service_name` (serviceName when unset).
  - *Stage conditions:* a stage rule that depends on a question the form does not ask (for example Finance review on "Paid or free") is not applied, so the stage runs.
- The editor keeps a form consistent while it is edited (`repairRequestForm`): removing a question or one of its choices drops conditions and risk settings that pointed at it. The preview shows the risk level the current answers would get.
- A question can be shown only when an earlier one-choice question has certain answers. Conditions may only point backwards, which rules out cycles.
- Keys of questions added in the editor are derived from their labels when the form is saved; keys of existing questions never change, because stored answers refer to them.
- Reviewers' "relevant answers" are chosen by field key (`focusFields` in the workflow), so they keep working when a custom form moves questions between steps.
- If a stored form somehow fails validation, the API falls back to the standard form for that request and logs a warning.

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
- Invitations are created through `POST /v1/invitations`: the API calls `create_invitations` with the admin's own token (so the database still checks the role, MFA and domains) and emails each link through the `Mailer` adapter (`apps/api/src/email.ts`): Resend over HTTP (Workers and Node), any SMTP server through nodemailer (Node only, `apps/api/src/smtp.ts`), or `log` for development. Without `EMAIL_PROVIDER`, or when a send fails, the link is returned to the admin to share by hand; a link that was emailed is not returned. "Send again" issues a new invitation, which replaces the old one. The web app moves the token from the URL into local storage and exchanges it after sign-in and two-step verification.
- `memberships.email` is copied from the account at insert time so that colleagues can be shown by email.

## Bulk invitations and allowed domains

- `create_invitations` takes up to 500 `{email, role}` rows; each row succeeds or fails on its own (invalid email, unknown role, listed twice, already a member, domain not allowed) and the result lists a token or an error per row. The web app parses CSV (comma or semicolon, with or without a header) and JSON with `parseInviteImport` in `packages/shared/src/inviteImport.ts`, shows skipped rows with their line, and sends them through the same API; links that could not be emailed are offered as a CSV download.
- `verified_domains` holds the organization's email domains. With `restrict_to_verified_domains` on, invitations to other domains are refused and accepting an older invitation to another domain fails. The restriction cannot be turned on without a domain, and the last domain cannot be removed while it is on. Subdomains are separate domains. Domain changes and the switch are audited.
- Restricting needs no proof of ownership because it only narrows who can join. Joining automatically by domain is not built; it will require `verified_at`, set by the backend after a DNS check.

## Review forms

- A review form is a list of questions (one or several choices, date, short or long text) with optional sections, help text, "required to approve", values flagged as a concern, and for dates a maximum age. Rules flag a concern when a request answer (for example data classification) calls for at least one of some values (for example SOC 2 Type II or ISO/IEC 27001). Defined in `packages/shared/src/reviewForms.ts`; the default security review form lives there too.
- Organizations override a stage's form in `review_templates`. Writes go through `PUT/DELETE /v1/review-forms/:stage`, which checks that the caller is an org admin or process manager and validates the form with the shared schema; the change is audited. A stored form that fails validation is ignored at submission and the default applies.
- At submission the form is copied into `request_stages.review_fields` and `review_rules`, so editing a form never changes reviews already started.
- Reviewers save answers with `save_stage_review_answers` (unknown fields dropped, types checked). `decide_stage` refuses Approved and Approved with conditions until the required answers are complete; Rejected is always possible. `private.review_answers_error` is the authoritative check; `validateReviewAnswers` mirrors it for the UI.
- `review_answers` is not readable through the table: the requester cannot see the security assessment. `request_review_answers` returns the answers to org admins, process managers, auditors and the request's reviewers.
- Concerns (flagged values, old reports, unmet rules) are shown to the reviewer and never block a decision.

## Questions to the requester

- `ask_requester` (whoever may review the stage) stores a question, moves the stage to `Waiting for requester` and stops its SLA clock (`sla_paused`, `sla_paused_at`). A second question keeps the original pause start.
- `answer_info_request` (the requester only) stores the answer. When the stage has no open question left it returns to `In review` and its due date moves out by the length of the pause, rolled forward off a weekend. A stage decided while waiting stays decided; a late answer is kept.
- Questions and answers are visible to everyone who can see the request. Internal reviewer notes are not built.
- Nobody is notified by email yet; the requester sees "Action required from you" in the app.

## Attachments

- Files live in the private Supabase Storage bucket `attachments`, which has no access policies: only the service role can reach it. The browser never has standing access to storage.
- Upload: the API checks the file (type from the extension, size, kind) and calls `register_attachment` with the caller's token, so the database decides whether that person may attach to that request. The API then signs a one-time upload URL for the path `org_id/request_id/attachment_id`; the browser uploads straight to storage; the API confirms the object exists, checks its real size and marks the attachment uploaded. The bucket itself also enforces 25 MB and the allowed MIME types.
- Download: the API reads the attachment with the caller's token (RLS: whoever may see the request), writes `attachment.downloaded` to the audit log and only then returns a signed URL valid for 60 seconds.
- Who may attach: the requester on a draft or a request in review; org admins, process managers and assigned reviewers on a request in review. Nothing is added to a decided request. The person who added a file can remove it while the request is a draft.
- Allowed: PDF, PNG, JPG, DOCX, XLSX, PPTX, CSV, TXT; 20 files per request. Archives and executables are not accepted.
- **Open gap: files are not scanned for malware.** The UI says so next to every file list.
- Not built: evidence expiry dates and reminders (CLAUDE.md §7), clean-up of uploads that were registered but never finished (they stop counting after an hour, the rows remain), attachments on the answer to a question.

## AI plugin (optional)

CLAUDE.md §2 applies: the core works without AI, the plugin is off by default and uses the operator's own key. The roadmap lists it under stage 5; the owner asked for it earlier.

- `apps/api/src/ai/provider.ts` defines the only thing a provider must do: run a task (instructions, input, JSON schema) and return JSON. `parallel.ts` implements it for Parallel's Task API. Another model or API is added by implementing the same interface and naming it in `config.ts`.
- `AI_PROVIDER` unset means no provider: `GET /v1/ai` answers `enabled: false`, the AI endpoints answer 404 and the web app shows no AI buttons.
- Vendor lookup sends only the service name, vendor name and website. The answer check sends the form answers with owner names replaced by "Named" / "Not required". Attachments are never sent to the AI provider.
- Model output is untrusted. Each suggested value passes the same validation as a typed answer, only a fixed list of fields can be suggested, and the backend never writes suggestions to the request: the requester applies them one by one. Remarks are advice and never block submission.
- One AI call per request every 10 seconds, counted per API process. This is not a substitute for real rate limiting.
- Not done: a per-organization switch and per-organization keys (needed for the hosted version), audit log entries for AI use, cost limits.

## Risk tier

`computeRisk` (`packages/shared/src/risk.ts`) adds up the risk points the request form assigns to the answers and applies minimum tiers; see "Request forms". The default weights are a proposal and have not been approved as policy.

## Confidential requests

- A form names a one-choice question (`confidential`) whose answers make a request confidential, and a person question for the business owner (`businessOwnerField`). The standard form asks "Keep this request confidential?".
- At submit the API first records `requests.is_confidential` and the business owner (`set_request_confidentiality`, service role, draft only), then submits, so a confidential request is never visible without its restriction. The business owner is matched to a member by email; a name that is not a member's email grants nothing, and the admin is told.
- A confidential request is visible to the requester, org admins, the rows in `request_viewers` (business owner, people an org admin added) and reviewers assigned to its stages. Process managers and auditors do not see it: the `requests` policies check `is_confidential`, and functions that let managers act on any request (`reviewable_stage`, `assign_stage_reviewer`, `request_review_answers`, `register_attachment`) use `private.oversees_request`. Stages, questions and attachments follow the request's own visibility. Only org admins can therefore assign reviewers to a confidential request.
- Org admins switch confidentiality and manage viewers with `set_request_confidential`, `add_request_viewer` and `remove_request_viewer`; each change is audited. The business owner is recorded on every request, so they can follow non-confidential requests too.

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
