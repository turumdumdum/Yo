import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSession, asUser, createUser, GOOGLE, PASSWORD_ONLY, PASSWORD_WITH_TOTP, pool, resetDatabase } from './db';

// Mandatory MFA is enforced by RLS: email + password without TOTP gets nothing (CLAUDE.md §8).

const TABLES = ['organizations', 'memberships', 'invitations', 'verified_domains', 'audit_log'];

let admin: string;
let newcomer: string;
let org: string;

beforeAll(async () => {
  await resetDatabase();
  await pool.query('update private.installation_settings set single_organization = false');
  admin = await createUser('admin@a.example');
  newcomer = await createUser('newcomer@a.example');
  org = await asUser(admin, async (c) => {
    const { rows } = await c.query<{ id: string }>(`select public.create_organization('Org A') as id`);
    return rows[0]!.id;
  });
  await pool.query(
    `insert into public.invitations (org_id, email, role, token_hash, expires_at)
     values ($1, 'x@a.example', 'requester', 'h', now() + interval '1 day')`,
    [org],
  );
  await pool.query(`insert into public.verified_domains (org_id, domain) values ($1, 'a.example')`, [org]);
});

afterAll(async () => {
  await pool.end();
});

describe('schema guard', () => {
  it('has a restrictive strong-session policy on every public table', async () => {
    const { rows } = await pool.query<{ relname: string }>(
      `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
         and not exists (
           select 1 from pg_policy p
           where p.polrelid = c.oid and not p.polpermissive and p.polcmd = '*'
             and pg_get_expr(p.polqual, p.polrelid) like '%session_is_strong()%'
         )`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });
});

describe('email + password without TOTP', () => {
  it.each(TABLES)('sees no rows in %s, even as the org admin', async (table) => {
    const rows = await asSession(admin, PASSWORD_ONLY, async (c) => (await c.query(`select * from public.${table}`)).rows);
    expect(rows).toEqual([]);
  });

  it('cannot change anything', async () => {
    const rename = await asSession(admin, PASSWORD_ONLY, (c) =>
      c.query(`update public.organizations set name = 'Renamed' where id = $1`, [org]),
    );
    expect(rename.rowCount).toBe(0);

    await expect(
      asSession(admin, PASSWORD_ONLY, (c) =>
        c.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'requester')`, [org, newcomer]),
      ),
    ).rejects.toThrow(/row-level security/);

    await expect(
      asSession(admin, PASSWORD_ONLY, (c) =>
        c.query(`insert into public.verified_domains (org_id, domain) values ($1, 'b.example')`, [org]),
      ),
    ).rejects.toThrow(/row-level security/);

    const del = await asSession(admin, PASSWORD_ONLY, (c) => c.query(`delete from public.invitations where org_id = $1`, [org]));
    expect(del.rowCount).toBe(0);
  });

  it('cannot create an organization', async () => {
    await expect(
      asSession(newcomer, PASSWORD_ONLY, (c) => c.query(`select public.create_organization('Org B')`)),
    ).rejects.toThrow(/multi-factor authentication required/);
  });

  it.each([
    ['a token without aal and amr claims', {}],
    ['an aal1 session with other first factors', { aal: 'aal1', amr: [{ method: 'otp' }, { method: 'recovery' }] }],
  ])('treats %s as weak', async (_label, claims) => {
    const rows = await asSession(admin, claims as never, async (c) => (await c.query('select 1 from public.organizations')).rows);
    expect(rows).toEqual([]);
  });
});

describe('strong sessions', () => {
  it.each([
    ['password + TOTP', PASSWORD_WITH_TOTP],
    ['Google sign-in', GOOGLE],
  ])('%s can read and write its own organization', async (_label, session) => {
    const result = await asSession(admin, session, async (c) => ({
      orgs: (await c.query('select id from public.organizations')).rows,
      rename: (await c.query(`update public.organizations set name = 'Org A' where id = $1`, [org])).rowCount,
    }));
    expect(result.orgs).toEqual([{ id: org }]);
    expect(result.rename).toBe(1);
  });

  it('Google sign-in can create an organization', async () => {
    await asSession(newcomer, GOOGLE, (c) => c.query(`select public.create_organization('Org B')`));
    const { rows } = await pool.query('select count(*)::int as n from public.organizations');
    expect(rows[0].n).toBe(2);
  });
});
