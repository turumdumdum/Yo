# CLAUDE.md — Vendor Management (working title)

Project guide for Claude Code. Read this fully before writing code. Decisions marked **Decided** were approved by the project owner on 2026-11-14; do not change them without asking.

## 1. What we are building

An open-source vendor intake and due-diligence service. A requester submits a request for a new vendor or service through a guided form; the request is triaged, goes through configurable review stages, and ends in a decision. Approved vendors land in a vendor registry with renewal and re-review reminders. Everyone sees the status at every step.

- **Decided:** custom code, built by the owner (solo developer) with Claude Code.
- **Decided:** open source now; a paid subscription (hosted version + add-ons) comes later, when customers appear.
- **Decided:** product UI is in English. All field names, statuses, stage names and copy are English.
- Target customer is not defined yet. Product name and domain are not chosen: use the placeholder `[Product name]` in UI and docs.

## 2. Open core vs subscription

**Decided.** License: AGPL-3.0 for the core. Paid add-ons live in a separate top-level folder (`ee/`) under a commercial license. Contributors sign a CLA.

| Open core (this repo, AGPL-3.0) | Subscription (later, `ee/`) |
| --- | --- |
| Request form, stages, workflow builder, tracker, vendor registry | Hosted multi-tenant cloud version |
| Jira and Asana integrations | SAML SSO and SCIM |
| Google sign-in, email + password with mandatory MFA | Managed AI suggestions |
| Audit log, roles | Advanced reports, SLA and support |
| Compliance engine, custom policies, base framework templates | Maintained template updates, auditor portal |

**AI rule (Decided):** the core must work fully without any paid AI. Form suggestions come from the catalog, the vendor registry, request history and rules. An AI plugin is optional (bring-your-own API key or a local model) and is off by default. Never add a hard dependency on an LLM API to the core. Never send attachments to a model.

## 3. Architecture

One codebase, two deployment modes:

- **Self-host:** one company per installation, Docker Compose (self-hosted Supabase + API container + static frontend).
- **Hosted:** our multi-tenant cloud on Supabase + Cloudflare.

Stack (**Decided** at the platform level; libraries below are defaults, ask before swapping):

- **Database, auth, files:** Supabase — Postgres with Row Level Security, Supabase Auth, Supabase Storage.
- **Frontend:** static SPA (React + TypeScript + Vite), deployed to Cloudflare Pages. No server-side rendering: the Workers free plan has a small CPU budget per request.
- **Backend:** TypeScript API (Hono suggested) that runs both on Cloudflare Workers and in a Node container. No Workers-only APIs in shared code; put platform bindings behind small adapters.
- **Jobs:** Postgres-based queue and cron (retries, SLA timers, reminders, integration sync).
- **Email:** any SMTP through an adapter (Resend for the hosted version).
- **Do not use Vercel's free Hobby plan** (non-commercial use only).

Rules:

- The browser talks only to our frontend/API and Supabase with the user's JWT. Third-party APIs (Jira, Asana, email, optional LLM) are called only from the backend; their keys never reach the browser.
- Workflow definitions, custom fields, rules and compliance frameworks are **data, not code**. One customer's configuration must never require a code change.
- Free-tier limits quoted in the plan came from web search, not official pricing pages. Verify on the providers' sites before relying on a number.

Suggested repo layout:

```
apps/web/          React SPA
apps/api/          TypeScript API (Workers + Node entrypoints)
packages/shared/   types, validation schemas, rule engine
supabase/          migrations, RLS policies, seed data, tests
ee/                commercial add-ons (empty for now, own LICENSE)
deploy/            docker-compose for self-host
docs/              self-host guide, architecture notes
LICENSE  README.md  SECURITY.md  CONTRIBUTING.md  CLA.md  TRADEMARK.md
```

## 4. Domain model (outline)

Every tenant-owned table has `org_id` and RLS policies.

- `organizations`, `memberships` (user, org, role), `invitations`, `verified_domains`
- `legal_entities`, `countries`, `categories`, `integration_catalog`, `cost_centers` (per-org catalogs)
- `vendors`, `services` (vendor registry: owners, data classification, contract dates, approval conditions)
- `requests` (type, status, risk tier, form answers), `request_field_values` (custom fields), `attachments`
- `workflow_templates` (versioned), `stage_definitions`, `field_definitions`, `conditions`, `checklist_items`
- `request_stages` (per request: status, reviewer, SLA due, paused flag, decision, conditions text)
- `info_requests`, `comments` (visibility: requester-visible or internal note)
- `frameworks` (versioned), `requirements`, `requirement_mappings`, `applicability_rules`, `evidence` (with expiry), `exceptions`
- `integration_connections` (encrypted tokens), `external_links` (request stage <-> Jira issue / Asana task), `job_queue`
- `notifications`, `audit_log` (append-only)

## 5. Request form (7 steps)

Autosave drafts. Each owner role has a "Not required" option. Conditional fields: personal-data questions only when classification is Internal or higher; cost fields only when Paid.

1. **What do you need?** Service name, Vendor, Vendor website, Request type (New vendor / New service / Renewal / Change of scope), Category, Purpose of use, Needed by, Alternatives considered (optional)
2. **Entities & geography:** Country of use, Our legal entity, Vendor legal entity, Vendor country of registration
3. **Access & platform:** Sign-in method (SSO / Email + password / API key / Shared account), Planned platform (Web, Desktop, Mobile, Browser extension, API, On-prem), Integrations (catalog + Other), Expected number of users, Does the vendor use AI on our data?
4. **Data:** Data classification (Public / Internal / Confidential / Restricted), Personal data involved?, Data location, Access to production systems?
5. **Commercials:** Paid or free (Free / Trial / Paid), Estimated annual cost + currency, Contract term, Auto-renewal, Cost center
6. **Ownership:** Budget owner, Business owner, Access administrator, Technical owner
7. **Attachments & review:** files (quote, contract draft, DPA, SOC 2 / ISO report, security questionnaire), Business criticality, rule-based completeness hints, answer summary

Non-AI suggestions: autocomplete from catalog and registry, "vendor already approved" shortcut to New service, prefilled vendor legal entity, owners suggested from the team's past requests. Every suggestion is labelled "Suggested" and needs confirmation.

## 6. Default workflow

Submitted -> Triage -> parallel reviews -> Final decision -> Vendor registry.

- **Triage:** automatic risk tier (Low / Medium / High / Critical) from data classification, cost, production access and criticality. The tier decides which stages are required.
- **Default stages (parallel):** License check, Security review, Legal review, Finance review, IT review.
- **Stage statuses:** Not started, In review, Waiting for requester, Approved, Approved with conditions, Rejected, Not required.
- **Info request:** a reviewer asks the requester a question inside the stage; the stage moves to Waiting for requester and its SLA clock pauses until the reply.
- **After approval:** vendor record with owners, contract dates, conditions, documents; renewal reminders; periodic re-review (yearly for High and Critical).

Workflow builder (roadmap stage 3): create/rename/disable stages, parallel or sequential, owner group, SLA in business days, decision options, custom fields (text, number, date, single/multi select, user, yes/no, file), conditions, checklists, risk scoring weights, routing rules, multiple versioned templates, notification templates, per-stage Jira/Asana mapping.

## 7. Compliance engine

**Decided.** Compliance is a configurable layer over stages.

- **Framework:** a standard or a company policy (SOC 2, ISO/IEC 27001, GDPR, PCI DSS, HIPAA, custom "Company policy"). Versioned; completed reviews stay tied to the version they used.
- **Requirement:** clause reference + our own wording. Never copy standard text into the product (ISO and others are copyrighted).
- **Mapping:** requirement -> form fields, stage checklist items, required evidence. One check can satisfy several frameworks.
- **Applicability rule:** by data classification, personal data, country, legal entity, amount, risk tier. Example: "Restricted data -> vendor must have SOC 2 Type II or ISO 27001".
- **Evidence:** vendor document with an expiry date; reminders before expiry open a re-review.
- **Exception:** approval with a deviation: who accepted the risk, why, compensating measures, review date.
- **Outputs:** "Required by" labels next to fields and checklist items, Compliance coverage report, audit export, read-only Auditor role.

Clause numbers in the plan's template table were written from memory. Verify each against the actual standard before shipping a template. Templates are a starting point, not a certification guarantee.

## 8. Security requirements (non-negotiable)

- **Auth:** Sign in with Google (OIDC) and email + password with mandatory TOTP MFA. Org admins can enforce Google-only and restrict to verified domains. Users join an org only by invitation or verified domain.
- **Roles:** Org admin, Process manager, Reviewer (per stage), Requester, Owner (budget/business/access/technical), Auditor (read-only). Least privilege; restricted fields and files visible only to roles that need them.
- **Tenant isolation:** `org_id` on every tenant table, RLS on every table, no service-role key in the browser. Automated tests must prove org A cannot read or write org B's data. A new table without RLS policies and an isolation test is not done.
- **Files:** private bucket, path prefixed by `org_id`, short-lived signed URLs, type and size limits. Malware scanning of uploads is an open gap; flag it, do not silently ignore it.
- **Secrets:** only in platform secret stores and local `.env` files that are git-ignored. The repo is public: never commit secrets, real customer data or tokens. Integration OAuth tokens are encrypted at the application level.
- **Audit log:** append-only; sign-ins, decisions, role and settings changes, file downloads, exports.
- **API:** rate limiting, webhook signature verification, idempotent webhook handling, security headers (CSP, HSTS).
- **Data:** EU region for hosted data, configurable retention, full export and deletion on request.
- **Repo hygiene:** branch protection on `main`, required review, secret scanning, Dependabot, separate dev and prod projects.

## 9. Integrations (roadmap stage 4)

Our service is the source of truth; Jira and Asana are where reviewer teams do their work. Two-way sync.

- Org admin connects via OAuth and maps each stage to a Jira project/issue type or an Asana project/section.
- Stage start creates an issue/task with request fields and a back-link.
- Status changes and comments arrive by webhook; a decision in our service closes the external item.
- A periodic reconciliation job catches missed events; all outbound calls go through the queue with retries.
- Jira Cloud: OAuth 2.0 (3LO) via `api.atlassian.com` with the customer's cloudId. Asana: OAuth 2.0 and webhooks. Check current docs for scopes, webhook lifetime and rate limits before implementing.

## 10. UI direction

Prototype screens exist (request form, request tracker, reviewer queue). Match them:

- Neutral light theme, one blue accent. Ground `#F5F6F8`, surface `#FFFFFF`, border `#DDE1E7`, ink `#14181F`, secondary text `#3D4654` / `#566070`, accent `#2F4BD8` (dark `#1E34A8`, tint `#EEF1FC`).
- Status colours: approved `#DDF3E6` / `#14532D`; waiting `#FDF0D5` / `#7A4A00`; in review `#E1E7FB` / `#1E34A8`; not started `#ECEEF2` / `#3D4654`. Status is always text plus colour, never colour alone.
- Fonts: Inter for body, Space Grotesk for headings.
- Tracker page: "Action required from you" banner, progress line, stage list with reviewer and SLA, conversation thread, request details, activity.
- Accessibility: WCAG 2.1 AA, real buttons/links/labels, 44px touch targets, keyboard navigation, works at phone width.

## 11. Roadmap

| Stage | Scope | Done when |
| --- | --- | --- |
| 0. Agreement | Plan and prototype | Done |
| 1. Core MVP | Orgs and roles, Google + email/MFA, form without AI, default 5 stages, tracker, info requests, email notifications, audit log; public repo, license, self-host guide | A request goes from form to decision; tenant isolation tests pass |
| 2. Pilot | 1-2 companies, free, under a pilot agreement | Feedback on fields and stages collected |
| 3. Builder + compliance | Workflow builder, custom fields, conditions, risk scoring, vendor registry and renewals, frameworks, evidence, exceptions | A customer changes the process without our help |
| 4. Integrations | Jira and Asana two-way sync, public API | Status and comments match in both systems |
| 5. Reports + AI plugin | SLA reports, optional AI plugin | Core works with the plugin off |
| 6. Commercial launch | Hosted subscription: company, legal documents, billing, paid infrastructure tiers, `ee/` add-ons, pentest, trust page | First payment received |

Stage 1 build order: (1) sign-in and organizations, (2) the 7-step form with autosave, (3) triage and the five default stages, (4) requester tracker and info requests, (5) reviewer queue and stage decisions, (6) email notifications and audit log.

## 12. How to work in this repo

- Small, reviewable commits on feature branches; never push directly to `main`.
- Every schema change is a migration in `supabase/` with RLS policies and tests in the same change.
- Validate all input on the server with shared schemas from `packages/shared`.
- Write tests for the rule engine (risk tier, conditions, applicability rules) and for tenant isolation first; these are the parts that must not regress.
- Keep the self-host path working: anything added for the hosted version needs a self-host equivalent or a clear "not available in self-host" note.
- Before adding a dependency, check its license is compatible with AGPL-3.0.
- If a requirement here conflicts with something the owner asks for in the session, point out the conflict and ask.
- Legal documents (Terms, Privacy Policy, DPA) are drafted later and need a lawyer's review; do not present generated legal text as final.

## 13. Open questions (ask the owner)

- Product name and domain.
- Vendor-facing portal (vendor fills in questionnaires by link): in the MVP or later?
- Frontend framework is assumed to be React; confirm.
- Company jurisdiction (default suggestion: Estonian OÜ) — only needed before the subscription launch.
