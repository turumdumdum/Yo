-- Sets the passwords of the roles the Supabase services log in with. Runs once, when
-- the database volume is created. Adapted from supabase/supabase docker (Apache-2.0).
\set pgpass `echo "$POSTGRES_PASSWORD"`

alter user authenticator with password :'pgpass';
alter user supabase_auth_admin with password :'pgpass';
alter user supabase_storage_admin with password :'pgpass';
