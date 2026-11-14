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

## Risk tier

`computeRiskTier` scores a request from data classification, business criticality, production access and annual cost, then applies minimum-tier floors. The scoring configuration is a plain object so it can later be stored per organization and edited in the workflow builder. The default weights are a proposal and have not been approved as policy.

## Open design points

- **Organization deletion vs the append-only audit log.** `audit_log.org_id` blocks deleting an organization that has audit entries. "Full export and deletion on request" needs an explicit, audited procedure; it is not designed yet.
- **Reviewer and Owner roles.** They are stored as organization-level roles for now. The guide describes Reviewer as per stage and Owner as per request (budget, business, access, technical), which will need per-stage and per-request assignments.
- **Self-host, one company per installation.** Nothing yet limits a self-hosted installation to a single organization.
- **Cost and currency.** The risk engine takes the annual cost as a plain number in the organization's base currency; currency conversion is not designed yet.
- **Malware scanning of uploads** is an open gap (see SECURITY.md).
