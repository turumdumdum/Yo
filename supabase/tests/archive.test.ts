import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createUser, pool, resetDatabase } from './db';

// Archive and trash: org admins only, decided requests only; the trash is admin-only.

let admin: string;
let manager: string;
let requester: string;
let org: string;
let approved: string;
let inReview: string;

const visible = (userId: string) =>
  asUser(userId, async (c) => (await c.query<{ id: string }>('select id from public.requests order by created_at')).rows.map((r) => r.id));

async function submitted(status: 'approved' | 'in_review'): Promise<string> {
  const id = await asUser(requester, async (c) =>
    (await c.query<{ id: string }>(`insert into public.requests (org_id, answers) values ($1, '{"serviceName": "Tool"}') returning id`, [org])).rows[0]!.id,
  );
  const stages = [{ name: 'License check', status: 'In review', sla_business_days: 5, sla_due_at: '2026-12-01T00:00:00Z', checklist: [] }];
  await asService((c) => c.query(`select public.submit_request($1, '{"serviceName": "Tool"}', 'Low', 0, '[]', $2)`, [id, JSON.stringify(stages)]));
  if (status === 'approved') await pool.query(`update public.requests set status = 'approved' where id = $1`, [id]);
  await pool.query(
    `insert into public.attachments (org_id, request_id, kind, filename, content_type, size_bytes, storage_path, status)
     values ($1, $2, 'Quote', 'q.pdf', 'application/pdf', 10, $3, 'uploaded')`,
    [org, id, `${org}/${id}/q`],
  );
  return id;
}

beforeAll(async () => {
  await resetDatabase();
  admin = await createUser('admin@a.example');
  manager = await createUser('manager@a.example');
  requester = await createUser('requester@a.example');
  org = await asUser(admin, async (c) => (await c.query<{ id: string }>(`select public.create_organization('Org A') as id`)).rows[0]!.id);
  await pool.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'process_manager'), ($1, $3, 'requester')`, [
    org,
    manager,
    requester,
  ]);
  approved = await submitted('approved');
  inReview = await submitted('in_review');
});

afterAll(async () => {
  await pool.end();
});

describe('archive and trash', () => {
  const archive = (userId: string, id: string, on: boolean) => asUser(userId, (c) => c.query('select public.set_request_archived($1, $2)', [id, on]));
  const trash = (userId: string, id: string, on: boolean) => asUser(userId, (c) => c.query('select public.set_request_trashed($1, $2)', [id, on]));

  it('is for org admins and decided requests only', async () => {
    await expect(archive(manager, approved, true)).rejects.toThrow(/only an org admin/);
    await expect(archive(requester, approved, true)).rejects.toThrow(/request not found|only an org admin/);
    await expect(trash(manager, approved, true)).rejects.toThrow(/only an org admin/);
    await expect(archive(admin, inReview, true)).rejects.toThrow(/only approved or rejected/);
    await expect(trash(admin, inReview, true)).rejects.toThrow(/only approved or rejected/);
  });

  it('archives without hiding, and restores', async () => {
    await archive(admin, approved, true);
    const row = (await pool.query('select archived_at, archived_by from public.requests where id = $1', [approved])).rows[0];
    expect(row.archived_at).not.toBeNull();
    expect(row.archived_by).toBe(admin);
    expect(await visible(requester)).toContain(approved);
    await archive(admin, approved, false);
    expect((await pool.query('select archived_at from public.requests where id = $1', [approved])).rows[0].archived_at).toBeNull();
  });

  it('hides the trash, with everything attached, from everyone but org admins', async () => {
    await trash(admin, approved, true);
    expect(await visible(requester)).toEqual([inReview]);
    expect(await visible(manager)).toEqual([inReview]);
    expect(await visible(admin)).toEqual([approved, inReview]);
    for (const table of ['request_stages', 'attachments']) {
      const seen = await asUser(manager, async (c) => (await c.query(`select 1 from public.${table} where request_id = $1`, [approved])).rowCount);
      expect(seen).toBe(0);
    }
    await expect(archive(admin, approved, true)).rejects.toThrow(/restore the request from the trash first/);
    await trash(admin, approved, false);
    expect(await visible(requester)).toEqual([approved, inReview]);
  });

  it('deletes for good only from the trash, by an org admin, and returns the files to remove', async () => {
    const purge = (actor: string) => asService(async (c) => (await c.query<{ paths: string[] }>('select public.purge_request($1, $2) as paths', [approved, actor])).rows[0]!.paths);
    await expect(purge(admin)).rejects.toThrow(/move the request to the trash first/);
    await trash(admin, approved, true);
    await expect(purge(manager)).rejects.toThrow(/only an org admin/);
    expect(await purge(admin)).toEqual([`${org}/${approved}/q`]);
    expect((await pool.query('select 1 from public.requests where id = $1', [approved])).rowCount).toBe(0);
    expect((await pool.query('select 1 from public.attachments where request_id = $1', [approved])).rowCount).toBe(0);
    const actions = (await pool.query('select action from public.audit_log where entity_id = $1 order by id', [approved])).rows.map((r) => r.action);
    expect(actions).toEqual(['request.submitted', 'request.archived', 'request.unarchived', 'request.trashed', 'request.restored', 'request.trashed', 'request.deleted_permanently']);
    await expect(asUser(admin, (c) => c.query('select public.purge_request($1, $2)', [inReview, admin]))).rejects.toThrow(/permission denied/);
  });

  it('keeps workflow settings readable by members and writable by the backend only', async () => {
    await asService((c) => c.query(`insert into public.workflow_settings (org_id, stages) values ($1, '{"x": 1}')`, [org]));
    expect((await asUser(requester, (c) => c.query('select stages from public.workflow_settings'))).rows).toEqual([{ stages: { x: 1 } }]);
    await expect(asUser(admin, (c) => c.query(`update public.workflow_settings set stages = '{}'`))).rejects.toThrow(/permission denied/);
  });

  it('keeps AI settings to org admins and process managers, written by the backend only', async () => {
    await asService((c) => c.query(`insert into public.ai_settings (org_id, check_settings) values ($1, '{"instructions": "x"}')`, [org]));
    expect((await asUser(manager, (c) => c.query('select check_settings from public.ai_settings'))).rowCount).toBe(1);
    expect((await asUser(admin, (c) => c.query('select check_settings from public.ai_settings'))).rowCount).toBe(1);
    expect((await asUser(requester, (c) => c.query('select check_settings from public.ai_settings'))).rowCount).toBe(0);
    await expect(asUser(admin, (c) => c.query(`update public.ai_settings set check_settings = '{}'`))).rejects.toThrow(/permission denied/);
  });
});
