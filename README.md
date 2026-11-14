# [Product name]

Open-source vendor intake and due-diligence service. A requester submits a request for a new vendor or service through a guided form; the request is triaged, goes through configurable review stages and ends in a decision. Approved vendors land in a vendor registry with renewal and re-review reminders.

> **Status: early scaffold.** Nothing here is usable by end users yet. See the [roadmap](CLAUDE.md#11-roadmap).

## What exists today

| Area | State |
| --- | --- |
| Sign-in | Email + password with mandatory TOTP, enforced in the database. Google sign-in is not configured yet |
| Organizations | Create an organization, roles, one organization per self-hosted installation |
| Request form | 7 steps with autosave, conditional fields, server-side validation and automatic risk tier. No file attachments yet |
| `packages/shared` | Product vocabulary, form definition and validation, triage risk-tier engine |
| `supabase/` | Migrations with Row Level Security on every table, tenant-isolation tests |
| `apps/api` | Hono API (request submission) with Node and Cloudflare Workers entrypoints |
| `apps/web` | React + Vite app |
| `deploy/`, `ee/` | Placeholders |

Not built yet: review stages, tracker, invitations, notifications, password recovery, rate limiting, self-host Docker Compose.

## Repository layout

```
apps/web/          React SPA
apps/api/          TypeScript API (Workers + Node entrypoints)
packages/shared/   types, validation schemas, rule engine
supabase/          migrations, RLS policies, tests
ee/                commercial add-ons (empty for now, own LICENSE)
deploy/            self-host deployment (placeholder)
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
