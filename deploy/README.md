# Self-host deployment

Docker Compose setup for one company per installation: self-hosted Supabase (Postgres,
Auth, REST, Storage), the API container and the static frontend behind one gateway.
The full guide is in [`docs/self-host.md`](../docs/self-host.md).

```sh
node deploy/init.mjs                                  # once: writes deploy/.env with fresh secrets
docker compose -f deploy/docker-compose.yml up -d --build
# open http://localhost:8080 — local emails land in http://localhost:8025
```

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | All services. Only the gateway (and the local mail catcher) publish ports, on 127.0.0.1 by default. |
| `init.mjs` | Generates `deploy/.env`: database password, JWT secret, anon and service keys, encryption key. Never overwrites an existing file. |
| `Dockerfile.api` | The Node API. |
| `Dockerfile.web` | Builds the frontend and serves it with nginx, which also routes `/auth/v1`, `/rest/v1`, `/storage/v1` and `/api`. |
| `gateway/` | nginx config with security headers (CSP, HSTS when HTTPS) and the script that writes the public address into the frontend at start. |
| `db/roles.sql` | Sets the passwords of the Supabase service roles on first start. |
| `db/migrate.sh` | Applies `supabase/migrations` once each, in order, on every start. |

`deploy/.env` is git-ignored. It holds every secret of the installation: keep it private and back it up.
