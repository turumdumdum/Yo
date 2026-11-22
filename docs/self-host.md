# Self-host guide

One company per installation, everything in Docker on one machine. Tested with Docker
Engine 29 and Docker Compose v2/v5 on Linux; Docker Desktop on Windows and macOS works the
same way.

## 1. Requirements

- Docker with Docker Compose.
- Node.js 22 or later, only to run `deploy/init.mjs` once (no packages needed).
- For real use: a domain, a TLS reverse proxy (Caddy, Traefik, nginx, a load balancer) and an
  SMTP server for sign-up confirmations and invitations.

## 2. First start

From the repository root:

```sh
node deploy/init.mjs                     # local trial on http://localhost:8080
# or: node deploy/init.mjs https://vendors.example.com
docker compose -f deploy/docker-compose.yml up -d --build
```

On Windows PowerShell the commands are the same.

What happens on start:

1. Postgres starts; the auth and storage services create their schemas.
2. `migrate` applies `supabase/migrations/*.sql` that have not run yet and exits.
3. The API and the gateway start. Open `PUBLIC_URL`.

The first person who signs up creates the organization and becomes its admin. Everyone
else joins by invitation (Admin → People) or a verified email domain.

For a local trial, `init.mjs` turns on a mail catcher: confirmation and invitation emails
appear at http://localhost:8025 and are never delivered anywhere.

## 3. Production settings (`deploy/.env`)

| Setting | What to do |
| --- | --- |
| `PUBLIC_URL` | The HTTPS address people open, for example `https://vendors.example.com`. |
| `APP_BIND`, `APP_PORT` | Where the gateway listens. Keep `127.0.0.1` and point your TLS proxy at it, or `0.0.0.0` if the proxy is on another machine. |
| `ENABLE_HSTS` | `true` once the site is served over HTTPS only. |
| `SMTP_*`, `SMTP_URL` | Your SMTP server. `SMTP_HOST`/`PORT`/`USER`/`PASS` are used by sign-up emails, `SMTP_URL` by invitations. Remove `COMPOSE_PROFILES=local-mail`. |
| `SMTP_SENDER_EMAIL` | The sender address; it must be allowed by your SMTP provider. |
| `GOOGLE_*` | Optional Sign in with Google. Register `PUBLIC_URL/auth/v1/callback` as the redirect URI in Google Cloud. |

Email, AI, Slack, UpGuard and review services can also be set by an org admin in
Admin → Integrations; those settings are stored encrypted with `INTEGRATION_ENCRYPTION_KEY`.

After changing `deploy/.env`: `docker compose -f deploy/docker-compose.yml up -d`.

## 4. Security notes

- The browser only talks to `PUBLIC_URL`. The service role key, the JWT secret and the
  database are never exposed; only the gateway publishes a port.
- MFA (TOTP) is mandatory for everyone and enforced by the database policies.
- Files are stored in a private bucket on the `storage-data` volume and downloaded through
  short-lived signed links. **Uploads are not scanned for malware** (open gap).
- Never change `JWT_SECRET` or `INTEGRATION_ENCRYPTION_KEY` on a running installation:
  sessions and saved integration secrets depend on them.

## 5. Backups and upgrades

- Back up `deploy/.env` and the volumes `vendor-intake_db-data` and
  `vendor-intake_storage-data`. A database dump:
  `docker compose -f deploy/docker-compose.yml exec db pg_dump -U postgres postgres > backup.sql`
- Upgrade: `git pull`, then `docker compose -f deploy/docker-compose.yml up -d --build`.
  New migrations run automatically.
- Start from scratch (deletes all data): `docker compose -f deploy/docker-compose.yml down -v`.

## 6. Not available in self-host

- The hosted multi-tenant version and its add-ons (`ee/`).
- Cloudflare Workers: self-host runs the Node API.
- Supabase Studio and Realtime are not included; nothing in the app needs them.
