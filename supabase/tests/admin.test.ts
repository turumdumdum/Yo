import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asSession, asUser, createUser, PASSWORD_ONLY, pool, resetDatabase } from './db';

// Organization administration: invitations, roles and removing members.

let admin: string;
let manager: string;
let invitee: string;
let impostor: string;
let org: string;

const invite = (userId: string, email: string, role = 'reviewer') =>
  asUser(userId, async (c) => {
    const { rows } = await c.query<{ token: string }>('select public.create_invitation($1, $2, $3) as token', [org, email, role]);
    return rows[0]!.token;
  });
const accept = (userId: string, token: string) => asUser(userId, (c) => c.query('select public.accept_invitation($1)', [token]));
const roleOf = async (userId: string) =>
  (await pool.query('select role from public.memberships where org_id = $1 and user_id = $2', [org, userId])).rows[0]?.role;

beforeAll(async () => {
  await resetDatabase();
  admin = await createUser('admin@a.example');
  manager = await createUser('manager@a.example');
  invitee = await createUser('new.person@a.example');
  impostor = await createUser('impostor@c.example');
  org = await asUser(admin, async (c) => {
    const { rows } = await c.query<{ id: string }>(`select public.create_organization('Org A') as id`);
    return rows[0]!.id;
  });
  await pool.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'process_manager')`, [org, manager]);
});

afterAll(async () => {
  await pool.end();
});

describe('invitations', () => {
  let token: string;

  it('can be created by the org admin only', async () => {
    await expect(invite(manager, 'x@a.example')).rejects.toThrow(/only an org admin/);
    await expect(invite(impostor, 'x@a.example')).rejects.toThrow(/only an org admin/);
    await expect(
      asSession(admin, PASSWORD_ONLY, (c) => c.query(`select public.create_invitation($1, 'x@a.example', 'reviewer')`, [org])),
    ).rejects.toThrow(/multi-factor/);
  });

  it('validate the email and refuse existing members', async () => {
    await expect(invite(admin, 'not-an-email')).rejects.toThrow(/valid email/);
    await expect(invite(admin, 'Manager@A.example')).rejects.toThrow(/already a member/);
  });

  it('store only a hash of the token and normalize the email', async () => {
    token = await invite(admin, '  New.Person@A.example ');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const { rows } = await pool.query('select email, role, token_hash, invited_by from public.invitations');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'new.person@a.example', role: 'reviewer', invited_by: admin });
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('are replaced when the same address is invited again', async () => {
    const replaced = token;
    token = await invite(admin, 'new.person@a.example', 'requester');
    await expect(accept(invitee, replaced)).rejects.toThrow(/not valid or has expired/);
    expect((await pool.query('select 1 from public.invitations')).rowCount).toBe(1);
  });

  it('cannot be used by another account or without a second factor', async () => {
    await expect(accept(impostor, token)).rejects.toThrow(/different email address/);
    await expect(
      asSession(invitee, PASSWORD_ONLY, (c) => c.query('select public.accept_invitation($1)', [token])),
    ).rejects.toThrow(/multi-factor/);
    await expect(accept(invitee, 'f'.repeat(64))).rejects.toThrow(/not valid or has expired/);
    expect(await roleOf(impostor)).toBeUndefined();
    expect(await roleOf(invitee)).toBeUndefined();
  });

  it('make the invited account a member with the invited role, once', async () => {
    await accept(invitee, token);
    expect(await roleOf(invitee)).toBe('requester');
    await expect(accept(invitee, token)).rejects.toThrow(/not valid or has expired/);
    const { rows } = await pool.query(
      `select action, actor_id from public.audit_log where action like 'invitation.%' order by id`,
    );
    expect(rows.map((r) => r.action)).toEqual(['invitation.created', 'invitation.created', 'invitation.accepted']);
    expect(rows.at(-1)!.actor_id).toBe(invitee);
  });

  it('expire and can be revoked', async () => {
    const late = await createUser('late@a.example');
    const expired = await invite(admin, 'late@a.example');
    await pool.query(`update public.invitations set expires_at = now() - interval '1 minute' where email = 'late@a.example'`);
    await expect(accept(late, expired)).rejects.toThrow(/not valid or has expired/);

    const revoked = await invite(admin, 'late@a.example');
    const byManager = await asUser(manager, (c) => c.query(`delete from public.invitations where email = 'late@a.example'`));
    expect(byManager.rowCount).toBe(0);
    const byAdmin = await asUser(admin, (c) => c.query(`delete from public.invitations where email = 'late@a.example'`));
    expect(byAdmin.rowCount).toBe(1);
    await expect(accept(late, revoked)).rejects.toThrow(/not valid or has expired/);
  });
});

describe('members', () => {
  it('get their role changed and are removed by the org admin only', async () => {
    const change = (userId: string) =>
      asUser(userId, (c) => c.query(`update public.memberships set role = 'reviewer' where org_id = $1 and user_id = $2`, [org, invitee]));
    expect((await change(manager)).rowCount).toBe(0);
    expect((await change(invitee)).rowCount).toBe(0);
    expect((await change(admin)).rowCount).toBe(1);
    expect(await roleOf(invitee)).toBe('reviewer');

    const remove = (userId: string) =>
      asUser(userId, (c) => c.query('delete from public.memberships where org_id = $1 and user_id = $2', [org, invitee]));
    expect((await remove(manager)).rowCount).toBe(0);
    expect((await remove(admin)).rowCount).toBe(1);
    expect(await roleOf(invitee)).toBeUndefined();
  });

  it('lose access as soon as they are removed', async () => {
    const rows = await asUser(invitee, async (c) => (await c.query('select 1 from public.organizations')).rows);
    expect(rows).toEqual([]);
  });
});
