import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createUser, pool, resetDatabase } from './db';

// Bulk invitations and the allowed-domains restriction.

let admin: string;
let manager: string;
let org: string;

type Result = { email: string; role: string; token?: string; error?: string };

const bulk = (userId: string, rows: unknown) =>
  asUser(userId, async (c) => {
    const { rows: out } = await c.query<{ r: Result[] }>('select public.create_invitations($1, $2) as r', [org, JSON.stringify(rows)]);
    return out[0]!.r;
  });
const invite = (email: string) => asUser(admin, (c) => c.query(`select public.create_invitation($1, $2, 'requester')`, [org, email]));
const setRestricted = (on: boolean) =>
  asUser(admin, (c) => c.query('update public.organizations set restrict_to_verified_domains = $2 where id = $1', [org, on]));
const addDomain = (domain: string) =>
  asUser(admin, (c) => c.query('insert into public.verified_domains (org_id, domain) values ($1, $2)', [org, domain]));
const removeDomain = (domain: string) =>
  asUser(admin, (c) => c.query('delete from public.verified_domains where org_id = $1 and domain = $2', [org, domain]));
const pending = async () =>
  (await pool.query('select email, role from public.invitations where accepted_at is null order by email')).rows;

beforeAll(async () => {
  await resetDatabase();
  admin = await createUser('admin@a.example');
  manager = await createUser('manager@a.example');
  org = await asUser(admin, async (c) => {
    const { rows } = await c.query<{ id: string }>(`select public.create_organization('Org A') as id`);
    return rows[0]!.id;
  });
  await pool.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'process_manager')`, [org, manager]);
});

afterAll(async () => {
  await pool.end();
});

describe('bulk invitations', () => {
  it('are for org admins only', async () => {
    await expect(bulk(manager, [{ email: 'x@a.example', role: 'requester' }])).rejects.toThrow(/only an org admin/);
  });

  it('create every valid row and report the others, in order', async () => {
    const results = await bulk(admin, [
      { email: 'Ann@A.example', role: 'reviewer' },
      { email: 'bo@a.example', role: 'requester' },
      { email: 'ann@a.example', role: 'auditor' },
      { email: 'not-an-email', role: 'requester' },
      { email: 'cy@a.example', role: 'superuser' },
      { email: 'manager@a.example', role: 'requester' },
      { email: 'di@a.example' },
    ]);
    expect(results.map((r) => [r.email, r.error ?? 'ok'])).toEqual([
      ['ann@a.example', 'ok'],
      ['bo@a.example', 'ok'],
      ['ann@a.example', 'listed more than once'],
      ['not-an-email', 'enter a valid email address'],
      ['cy@a.example', 'unknown role'],
      ['manager@a.example', 'this person is already a member'],
      ['di@a.example', 'unknown role'],
    ]);
    expect(results[0]!.token).toMatch(/^[0-9a-f]{64}$/);
    expect(results[0]!.token).not.toBe(results[1]!.token);
    expect(await pending()).toEqual([
      { email: 'ann@a.example', role: 'reviewer' },
      { email: 'bo@a.example', role: 'requester' },
    ]);
  });

  it('give working tokens', async () => {
    const [result] = await bulk(admin, [{ email: 'eve@a.example', role: 'reviewer' }]);
    const eve = await createUser('eve@a.example');
    await asUser(eve, (c) => c.query('select public.accept_invitation($1)', [result!.token]));
    const { rows } = await pool.query('select role from public.memberships where user_id = $1', [eve]);
    expect(rows).toEqual([{ role: 'reviewer' }]);
  });

  it('refuse malformed and oversized lists', async () => {
    await expect(bulk(admin, { email: 'x@a.example' })).rejects.toThrow(/expected a list/);
    const many = Array.from({ length: 501 }, (_, i) => ({ email: `u${i}@a.example`, role: 'requester' }));
    await expect(bulk(admin, many)).rejects.toThrow(/at most 500/);
  });

  it('are recorded in the audit log one by one', async () => {
    const { rows } = await pool.query(
      `select count(*)::int as n from public.audit_log where action = 'invitation.created' and actor_id = $1`,
      [admin],
    );
    expect(rows[0].n).toBe(3);
  });
});

describe('allowed domains', () => {
  it('cannot restrict an organization without domains', async () => {
    await expect(setRestricted(true)).rejects.toThrow(/add at least one domain/);
  });

  it('are managed by org admins only', async () => {
    await expect(
      asUser(manager, (c) => c.query(`insert into public.verified_domains (org_id, domain) values ($1, 'x.example')`, [org])),
    ).rejects.toThrow(/row-level security/);
    await addDomain('a.example');
    await addDomain('b.example');
    const byManager = await asUser(manager, (c) => c.query(`delete from public.verified_domains where domain = 'b.example'`));
    expect(byManager.rowCount).toBe(0);
  });

  it('reject malformed domains', async () => {
    for (const bad of ['A.example', 'nodot', '@a.example', 'a..example']) {
      await expect(addDomain(bad)).rejects.toThrow(/check constraint/);
    }
  });

  it('limit single and bulk invitations once the restriction is on', async () => {
    await setRestricted(true);
    await expect(invite('someone@gmail.example')).rejects.toThrow(/domain gmail.example is not allowed/);
    // A subdomain is a different domain.
    await expect(invite('someone@sub.a.example')).rejects.toThrow(/domain sub.a.example is not allowed/);
    await invite('fine@b.example');
    const results = await bulk(admin, [
      { email: 'ok@a.example', role: 'requester' },
      { email: 'out@c.example', role: 'requester' },
    ]);
    expect(results.map((r) => r.error ?? 'ok')).toEqual(['ok', 'the domain c.example is not allowed in this organization']);
  });

  it('are checked again when an invitation is accepted', async () => {
    const [result] = await bulk(admin, [{ email: 'late@b.example', role: 'requester' }]);
    await removeDomain('b.example');
    const late = await createUser('late@b.example');
    await expect(asUser(late, (c) => c.query('select public.accept_invitation($1)', [result!.token]))).rejects.toThrow(
      /no longer allowed/,
    );
  });

  it('keep at least one domain while the restriction is on', async () => {
    await expect(removeDomain('a.example')).rejects.toThrow(/turn off the domain restriction/);
    await setRestricted(false);
    await removeDomain('a.example');
    await invite('anyone@gmail.example');
  });

  it('record changes in the audit log', async () => {
    const { rows } = await pool.query(
      `select action, entity_id from public.audit_log where action like 'domain.%' order by id`,
    );
    expect(rows).toEqual([
      { action: 'domain.added', entity_id: 'a.example' },
      { action: 'domain.added', entity_id: 'b.example' },
      { action: 'domain.removed', entity_id: 'b.example' },
      { action: 'domain.removed', entity_id: 'a.example' },
    ]);
    const settings = await pool.query(
      `select metadata from public.audit_log where action = 'organization.settings_changed' order by id`,
    );
    expect(settings.rows.map((r) => r.metadata)).toEqual([
      { restrict_to_verified_domains: true },
      { restrict_to_verified_domains: false },
    ]);
  });
});
