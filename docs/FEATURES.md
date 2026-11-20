# What [Product name] can do

This page explains what the product does and how it is organized. The first part is for everyone; the second part is for developers and operators.

Status: early, in active development. Nothing here is a certification guarantee or legal advice.

---

## Part 1 — For everyone

### In one sentence

People ask to start using a new vendor or service through a guided form; the request gets a risk level automatically, goes through the checks it needs (license, security, legal, finance, IT), and ends in a clear decision that everyone can follow.

### Who does what

| Role | What they do |
| --- | --- |
| Requester | Fills in the request form, answers reviewers' questions, confirms the configuration after approval |
| Reviewer | Reviews the checks assigned to them: form, checklist, questions, decision |
| Process manager | Assigns reviewers, can review any check, edits forms and review settings |
| Org admin | Everything above plus people, invitations, domains, security baseline, exceptions, integrations, archive and trash, confidential access |
| Owner (budget, business, access, technical) | Named in the request; the business owner can follow a confidential request |
| Auditor | Reads everything that is not confidential; changes nothing |

### The life of a request

| Step | What happens |
| --- | --- |
| 1. Form | A guided form (7 steps by default) with autosave, progress bar, help under each question and an optional AI check at the end |
| 2. Triage | The answers give a risk level: Low, Medium, High or Critical |
| 3. Checks | The checks the risk level needs start in parallel, each with a due date. A check can run here or in an external service |
| 4. Questions | A reviewer can ask the requester a question; the check's clock pauses until the answer |
| 5. Decision | Each check is approved, approved with conditions, or rejected. When all are done, the request is approved or rejected |
| 6. Afterwards | Required security configuration becomes a task list. Admins can archive a vendor, move it to the trash, restore it or delete it for good |

### The start screen

Four views with counts: **My requests**, **Being checked**, **Approved vendors**, **Rejected**, plus **Archived** and **Trash** (admins). Search by service or vendor. Requests that need you come first.

### Reviewing (the "To review" tab)

- Grouped: **Overdue**, **Your reviews**, **Waiting for the requester**, **No reviewer yet**; filter by kind of check.
- Each check opens in tabs: **Request** (the answers that matter), **Guide** (how to review), **Review form** (sections that fold and show progress), **Checklist**, **Configuration** (security), **Questions**, **Decision**.
- The **Decision** tab lists what is still open ("Before you decide") and explains why an option is not available yet.

### What admins can configure (Admin tab)

| Section | What you set |
| --- | --- |
| People | Members, roles, invitations by email (one by one or from CSV/JSON) |
| Email domains | Which domains may join |
| Request form | The standard form or your own: every question editable, types, help text, conditions, risk points, request name, confidentiality question |
| Reviews | Per check: always / from a risk level / off, an extra condition, time to review, checklist, review guide, review form, and whether it runs here or in an external service |
| Security baseline | The configuration every approved service must have (SSO, MFA, audit logs, encryption, …), by risk level and answers |
| Exceptions | The register of accepted risks: waiting, ending soon, expired |
| AI check | Optional: your instructions for the AI and which questions it may see |
| Integrations | Slack notifications, UpGuard vendor rating, external review service |
| Settings | For example whether people may review their own requests |

### Security configuration and exceptions

- Controls from the security baseline that apply to a request are copied into it at submission.
- The security reviewer decides on each required control: **must be configured**, **not applicable** (with a reason) or **exception**.
- An **exception** records what deviates, why, the compensating measures, the remaining risk and an end date (at most a year). Another org admin than the person who asked must accept it.
- After approval the required controls become tasks that the requester, the business owner or a manager confirm one by one.

### Confidential requests

When the requester chooses "keep confidential", only the requester, org admins, the business owner (if their email matches a member), people an admin adds and the assigned reviewers can see it. Process managers and auditors cannot. This is enforced by the database.

### Optional AI help

Off by default and never required. With your own API key: suggestions for vendor details, and a check of the answers at the end of the form that can propose corrected answers. Nothing changes until the requester clicks **Accept**. Attachments and owner names are never sent.

### Integrations

| Integration | What it does | Notes |
| --- | --- | --- |
| Email | Sends invitations | Resend, any SMTP server, or a log for testing |
| Slack | Posts notifications to a channel (submitted, decided, exceptions, …) | Incoming webhook; confidential requests are not named |
| UpGuard | Shows the vendor's external security rating on the request | The API endpoint and fields were written without access to UpGuard's documentation and **must be verified** before use |
| VirusTotal | A link to the vendor's domain report | No key needed; opens virustotal.com |
| External review service | Runs a check (for example the security review) in another tool; this app sends the data and receives the status | Signed JSON both ways; see [external-review.md](external-review.md) |

---

## Part 2 — For developers and operators

### Architecture in short

| Part | Technology | Path |
| --- | --- | --- |
| Web app | React + TypeScript + Vite, static SPA | `apps/web` |
| API | Hono (TypeScript) on Node or Cloudflare Workers | `apps/api` |
| Shared logic | Forms, validation, risk scoring, workflow, baseline, schemas | `packages/shared` |
| Database, auth, files | Supabase (Postgres + RLS, Auth, Storage) | `supabase/migrations`, `supabase/tests` |
| Docs | Architecture, self-host, this page | `docs/` |
| Commercial add-ons | Empty for now | `ee/` |

The browser talks only to the API and to Supabase with the user's own token. Third-party services (email, AI, Slack, UpGuard, external review) are called only from the API; their keys never reach the browser.

### Where each feature lives

| Feature | Shared logic | API | Web | Database |
| --- | --- | --- | --- | --- |
| Request form and editor | `requestForm.ts`, `requestFormEditor.ts` | `admin.ts` (`/v1/request-forms`) | `requests/RequestForm.tsx`, `org/RequestFormEditor.tsx` | `request_form_templates`, `requests.form` |
| Risk scoring | `risk.ts` | `requests.ts` (submit) | — | `requests.risk_*` |
| Reviews and settings | `workflow.ts`, `stageSettings.ts`, `reviewForms.ts` | `admin.ts` (`/v1/workflow`, `/v1/review-forms`) | `requests/StagePanel.tsx`, `requests/ReviewQueue.tsx`, `org/ReviewsSection.tsx` | `request_stages`, `workflow_settings`, `review_templates` |
| Security baseline, exceptions | `securityBaseline.ts` | `admin.ts` (`/v1/security-baseline`) | `requests/SecurityConfig.tsx`, `org/SecurityBaselineSection.tsx`, `org/ExceptionsSection.tsx` | `security_baselines`, `requests.config_requirements`, `review_exceptions` |
| Confidential requests | `requestForm.ts` (`isConfidential`) | `requests.ts` | `requests/Visibility.tsx` | `requests.is_confidential`, `request_viewers` |
| Archive and trash | — | `admin.ts` (`DELETE /v1/requests/:id`) | `requests/Lifecycle.tsx` | `requests.archived_at`, `deleted_at` |
| Questions | — | — | `requests/Questions.tsx` | `info_requests` |
| Attachments | `attachments.ts` | `attachments.ts` | `requests/Attachments.tsx` | `attachments`, private bucket |
| Invitations | `inviteImport.ts` | `invitations.ts`, `email.ts`, `smtp.ts` | `org/InviteSection.tsx` | `invitations` |
| AI plugin | `ai.ts` | `ai/*` (`/v1/ai-settings`) | `requests/AiAssist.tsx`, `org/AiSettingsSection.tsx` | `ai_settings` |
| Integrations | — | integration routes, dispatcher, crypto | Admin → Integrations | `integration_settings`, `outbound_events`, `inbound_events`, `notification_cursors`, `vendor_risk_checks`, `request_stages.external*` |
| Audit log | — | writes on admin changes | — | `audit_log` (append-only) |

Migrations are in `supabase/migrations`, named by date; each one comes with tests in `supabase/tests`.

### Security model

| Measure | How |
| --- | --- |
| Sign-in | Email + password with mandatory TOTP; a restrictive policy on every table requires a strong (MFA) session |
| Tenant isolation | `org_id` on every tenant table, RLS everywhere; tests prove org A cannot see org B, and that every public table is covered |
| Least privilege | Writes go through checked database functions or the API; browser roles have column-level grants only |
| Server secrets | The Supabase secret key lives only on the API server (`apps/api/.env`, git-ignored) |
| Integration secrets | Slack webhook, UpGuard key and external signing secrets are encrypted by the API (AES-256-GCM) before storage; the table is service-role only |
| Webhooks | Outgoing and incoming calls with the external review service are signed (HMAC-SHA256 with timestamp), replays rejected, idempotent by event id |
| API | Rate limits, body size limits, strict CORS, security headers (CSP, HSTS), generic error messages |
| Audit | Append-only log of sign-in-relevant, admin, review, exception, export and deletion events |
| Files | Private bucket, short-lived signed links, type and size limits. **Not scanned for malware** (known gap) |

### Background work

A Postgres-based queue (`outbound_events`) holds calls to other services. The API delivers them with retries and exponential backoff. The notifier reads new audit-log entries and turns them into Slack messages. On Node this runs on a timer; on Workers it needs a scheduled trigger.

### Self-host and hosted

| | Self-host | Hosted (later) |
| --- | --- | --- |
| Organizations | One per installation | Many |
| Runs on | Docker Compose: Supabase + API container + static web (compose file not finished yet) | Supabase + Cloudflare |
| Email | Any SMTP, or Resend | Resend |
| Background jobs | Node timer in the API | Workers scheduled trigger |

### Not built yet

- Vendor registry with renewal and re-review reminders; reminders for expiring exceptions.
- Email notifications about requests (only invitations are emailed).
- Google sign-in, password recovery, SAML/SCIM.
- Jira and Asana sync, public API beyond the external review endpoints.
- Malware scanning of uploads; self-host Docker Compose; external penetration test.
- UpGuard: verify endpoint and response fields against UpGuard's current documentation.
