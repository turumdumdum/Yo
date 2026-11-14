# Contributing

Thank you for your interest. The project is at an early stage; please open an issue to discuss a change before sending a large pull request.

## Ground rules

- Read [CLAUDE.md](CLAUDE.md): it is the project guide for humans and coding agents alike.
- Work on a feature branch and open a pull request; nothing is pushed directly to `main`.
- Keep commits small and reviewable.
- Every schema change is a migration in `supabase/migrations/` with RLS policies and tenant-isolation tests in the same change.
- Validate all input on the server with the shared schemas in `packages/shared`.
- The core must work without any paid AI service. Do not add a hard dependency on an LLM API.
- Before adding a dependency, check that its license is compatible with AGPL-3.0.
- Never commit secrets, tokens or real customer data. This repository is public.
- Do not copy the text of standards (ISO, SOC 2 criteria and others) into the product; reference the clause and use your own wording.

## Before you open a pull request

```bash
pnpm typecheck
pnpm test
pnpm test:db   # needs TEST_DATABASE_URL, see README.md
```

## Contributor License Agreement

Contributions are accepted under a Contributor License Agreement so that the project can be offered under both the AGPL and a commercial license. See [CLA.md](CLA.md). The CLA text is a draft and the signing process is not set up yet; until it is, external code contributions cannot be merged.

## Security issues

Do not file public issues for vulnerabilities. See [SECURITY.md](SECURITY.md).
