# [Product name]

Open-source vendor intake and due-diligence service. A requester submits a request for a new vendor or service through a guided form; the request is triaged, goes through configurable review stages and ends in a decision. Approved vendors land in a vendor registry with renewal and re-review reminders.

> **Status: early scaffold.** Nothing here is usable by end users yet. See the [roadmap](CLAUDE.md#11-roadmap).

**What it can do and how it is organized:** [docs/FEATURES.md](docs/FEATURES.md). Running a check in another tool: [docs/external-review.md](docs/external-review.md).

## What exists today

| Area | State |
| --- | --- |
| Sign-in | Email + password with mandatory TOTP, enforced in the database. Google sign-in is not configured yet |
| Organizations | Create an organization, roles, one organization per self-hosted installation |
| Request form | The standard 7-step form or the organization's own forms (built in Admin, every question editable including how answers affect the risk; several can be saved, one is in use); autosave, conditional questions, server-side validation, attachments and automatic risk tier |
| Triage and stages | Submission starts the default review stages required by the risk tier, each with an SLA due date |
| Reviews | Reviewer assignment, per-stage checklist and relevant answers, configurable review forms (a full security review form by default, with certification rules), approve / approve with conditions / reject, automatic final decision, review queue |
| Questions | A reviewer asks the requester inside a stage; the stage waits and its SLA clock pauses until the answer |
| Start screen | Four views with counts: my requests, being checked, approved vendors, rejected; search by service or vendor |
| Confidential requests | A requester can keep a request confidential: only the requester, org admins, the business owner, people an admin adds and assigned reviewers see it, enforced in the database |
| Review settings | Per review: always / from a risk level / off, optional condition on an answer, time to review, checklist and its own review form |
| Security baseline and exceptions | Editable catalog of required configuration (SSO, MFA, audit logs, …) applied by risk and answers; the security reviewer decides on each control; time-limited exceptions with compensating measures, accepted by a different org admin; exception register; configuration tasks after approval |
| Archive and trash | Org admins archive decided vendors, move them to the trash (visible to admins only), restore them or delete them for good with their files |
| Attachments | Private storage, upload and download only through short-lived signed links issued by the API, downloads audited. Not scanned for malware |
| Admin | Sections for people (search, roles, invitations by email one by one or in bulk from CSV/JSON), email domains, request form editor with preview, review form editor, settings |
| AI plugin (optional) | Off by default. With your own key for Anthropic (Claude), OpenAI, any OpenAI-compatible server (Ollama, LM Studio, OpenRouter…) or Parallel: vendor lookup with suggestions under each field, and a check of the answers that proposes corrected answers the requester can accept. Admins set instructions and the questions to check |
| Integrations | Slack notifications, UpGuard vendor rating (endpoint to be verified against UpGuard's docs), link to VirusTotal, external review service with signed JSON both ways; secrets encrypted on the server |
| Review guides | Per check, written by the organization, shown to reviewers in a Guide tab |
| `packages/shared` | Product vocabulary, form definition and validation, triage risk-tier engine |
| `supabase/` | Migrations with Row Level Security on every table, tenant-isolation tests |
| `apps/api` | Hono API (request submission) with Node and Cloudflare Workers entrypoints |
| `apps/web` | React + Vite app |
| `deploy/`, `ee/` | Placeholders |

Not built yet: email notifications about requests (invitations are emailed; Slack notifications exist), password recovery, Google sign-in, vendor registry, evidence expiry, malware scanning of uploads.

## Repository layout

```
apps/web/          React SPA
apps/api/          TypeScript API (Workers + Node entrypoints)
packages/shared/   types, validation schemas, rule engine
supabase/          migrations, RLS policies, tests
ee/                commercial add-ons (empty for now, own LICENSE)
deploy/            self-host with Docker Compose (see docs/self-host.md)
docs/              architecture notes, self-host guide
```

## Development

Requires Node 22+, pnpm 10+ and a Supabase project with the migrations from `supabase/migrations/` applied.

```bash
pnpm install
cp apps/web/.env.example apps/web/.env   # then fill in the values
cp apps/api/.env.example apps/api/.env   # then fill in the values
pnpm dev           # web on http://localhost:5173, API on http://localhost:8787
pnpm typecheck
pnpm test          # unit tests (shared, api, web)
```

The web app only ever receives the publishable key. The secret (service role) key belongs in `apps/api/.env` and must never be committed or given a `VITE_` name.

#### Environment: only what is needed to start

| Variable | Where | Required |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` | `apps/api/.env` (and the `VITE_` versions in `apps/web/.env`) | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | `apps/api/.env` only | Yes |
| `WEB_ORIGIN` | `apps/api/.env` | Yes |
| `INTEGRATION_ENCRYPTION_KEY` | `apps/api/.env` | Created by the Node API on first start. **Back it up**: without it the stored integration secrets cannot be read. On Cloudflare Workers set it as a secret yourself |

Everything else (server address, email, AI, Slack, UpGuard, review services) is entered in **Admin → Integrations**. The older variables (`EMAIL_PROVIDER`, `AI_PROVIDER`, `PUBLIC_API_URL`, …) still work as defaults when nothing is set in the UI.

See [docs/FEATURES.md](docs/FEATURES.md) for what the product does and [docs/external-review.md](docs/external-review.md) to connect a review service.

### Database tests

The tenant-isolation tests run against any disposable Postgres 15+ database (a small shim stands in for Supabase's `auth` schema and roles). **The database is wiped on every run.**

```bash
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/app_test   # wiped on every run
pnpm test:db
```

Every new table needs RLS policies and isolation cases in `supabase/tests/` in the same change; the test suite fails if a table in `public` has RLS disabled or is missing from the test list.

## License

The core is licensed under the [GNU Affero General Public License v3.0](LICENSE). Everything under [`ee/`](ee/) is excluded from the AGPL and is covered by its own commercial license. See also [CLA.md](CLA.md) and [TRADEMARK.md](TRADEMARK.md) (both are drafts pending legal review).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
