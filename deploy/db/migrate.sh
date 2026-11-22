#!/bin/sh
# Applies supabase/migrations/*.sql in order, each once, inside a transaction.
# Tracks what ran in supabase_migrations.schema_migrations, like the Supabase CLI,
# so a database can later be managed with either.
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD"
PSQL="psql -h db -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X"

# The auth and storage services create their schemas on first start; our migrations
# reference both, so wait for them.
for i in $(seq 1 60); do
  ready=$($PSQL -tA -c "select to_regclass('auth.users') is not null and to_regclass('storage.buckets') is not null" || echo f)
  [ "$ready" = "t" ] && break
  echo "Waiting for the auth and storage schemas ($i)..."
  sleep 2
done
[ "$ready" = "t" ] || { echo "auth.users or storage.buckets never appeared" >&2; exit 1; }

$PSQL -c "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[]);"

applied=0
for file in /migrations/*.sql; do
  name=$(basename "$file" .sql)
  version=${name%%_*}
  done_before=$($PSQL -tA -c "select 1 from supabase_migrations.schema_migrations where version = '$version'")
  [ "$done_before" = "1" ] && continue
  echo "Applying $name"
  $PSQL -1 -f "$file" -c "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '${name#*_}')"
  applied=$((applied + 1))
done
# PostgREST caches the schema; tell it to reload.
$PSQL -c "notify pgrst, 'reload schema'"
echo "Migrations up to date ($applied applied now)."
