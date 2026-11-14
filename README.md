# [Product name]

Open-source vendor intake and due-diligence service. A requester submits a request for a new vendor or service through a guided form; the request is triaged, goes through configurable review stages and ends in a decision. Approved vendors land in a vendor registry with renewal and re-review reminders.

> **Status: early scaffold.** Nothing here is usable by end users yet. See the [roadmap](CLAUDE.md#11-roadmap).

## What exists today

| Area | State |
| --- | --- |
| `packages/shared` | Product vocabulary, input schemas, triage risk-tier engine (tested) |
| `supabase/` | First migration: organizations, memberships, invitations, verified domains, append-only audit log, all with Row Level Security; tenant-isolation tests |
| `apps/api` | Hono skeleton (health check, security headers) with Node and Cloudflare Workers entrypoints |
| `apps/web` | React + Vite shell with the design tokens |
| `deploy/`, `ee/` | Placeholders |

Not built yet: sign-in, the request form, stages, tracker, notifications, self-host Docker Compose.

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

Requires Node 22+ and pnpm 10+.

```bash
pnpm install
pnpm typecheck
pnpm test          # unit tests (shared, api, web)
pnpm dev:web       # http://localhost:5173
pnpm dev:api       # http://localhost:8787/health
```

### Database tests

The tenant-isolation tests run against any disposable Postgres 15+ database (a small shim stands in for Supabase's `auth` schema and roles). **The database is wiped on every run.**

```bash
export TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/app_test
pnpm test:db
```

Every new table needs RLS policies and isolation cases in `supabase/tests/` in the same change; the test suite fails if a table in `public` has RLS disabled or is missing from the test list.

## License

The core is licensed under the [GNU Affero General Public License v3.0](LICENSE). Everything under [`ee/`](ee/) is excluded from the AGPL and is covered by its own commercial license. See also [CLA.md](CLA.md) and [TRADEMARK.md](TRADEMARK.md) (both are drafts pending legal review).

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md).
