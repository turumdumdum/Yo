import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  throw new Error(
    'TEST_DATABASE_URL is not set. Point it at a disposable Postgres database (see .env.example); it is wiped on every run.',
  );
}

export const pool = new pg.Pool({ connectionString: url, max: 4 });

/** Drops everything and re-applies the Supabase shim and all migrations. */
export async function resetDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`
      drop schema if exists public cascade;
      drop schema if exists private cascade;
      drop schema if exists auth cascade;
      create schema public;
    `);
    await client.query(readFileSync(join(here, 'supabase-shim.sql'), 'utf8'));
    for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
      await client.query(readFileSync(join(migrationsDir, file), 'utf8'));
    }
  } finally {
    client.release();
  }
}

type Run<T> = (client: pg.PoolClient) => Promise<T>;

/** The parts of a Supabase access token that policies look at. */
export interface SessionClaims {
  aal: 'aal1' | 'aal2';
  amr: { method: string }[];
}

/** Email + password followed by TOTP: the normal signed-in state. */
export const PASSWORD_WITH_TOTP: SessionClaims = { aal: 'aal2', amr: [{ method: 'totp' }, { method: 'password' }] };
/** Email + password without the second factor. */
export const PASSWORD_ONLY: SessionClaims = { aal: 'aal1', amr: [{ method: 'password' }] };
/** Sign in with Google. */
export const GOOGLE: SessionClaims = { aal: 'aal1', amr: [{ method: 'oauth' }] };

async function inRole<T>(role: 'anon' | 'authenticated', claims: object | null, fn: Run<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      claims ? JSON.stringify({ ...claims, role }) : '',
    ]);
    await client.query(`set local role ${role}`);
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/** Runs queries the way the browser does: as `authenticated` with the user's JWT (MFA passed). */
export const asUser = <T>(userId: string, fn: Run<T>) => asSession(userId, PASSWORD_WITH_TOTP, fn);

/** Like asUser, with explicit control over how the session was authenticated. */
export const asSession = <T>(userId: string, session: SessionClaims, fn: Run<T>) =>
  inRole('authenticated', { sub: userId, ...session }, fn);

/** Runs queries as a visitor without a session. */
export const asAnon = <T>(fn: Run<T>) => inRole('anon', null, fn);

export async function createUser(email: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'insert into auth.users (email) values ($1) returning id',
    [email],
  );
  return rows[0]!.id;
}
