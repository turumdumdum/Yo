import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createUser, pool, resetDatabase } from './db';

// Confidential requests: who sees them, in the tables and through functions.

let admin: string;
let manager: string;
let auditor: string;
let reviewer: string;
let requester: string;
let owner: string;
let colleague: string;
let org: string;
let secret: string;
let open: string;
let secretStage: string;

const visible = (userId: string) =>
  asUser(userId, async (c) => (await c.query<{ id: string }>('select id from public.requests order by created_at')).rows.map((r) => r.id));
const stagesSeen = (userId: string, requestId: string) =>
  asUser(userId, async (c) => (await c.query('select id from public.request_stages where request_id = $1', [requestId])).rowCount);

async function submitted(confidential: boolean, ownerEmail: string | null): Promise<string> {
  const id = await asUser(requester, async (c) =>
    (await c.query<{ id: string }>(`insert into public.requests (org_id, answers) values ($1, '{"serviceName": "X"}') returning id`, [org])).rows[0]!.id,
  );
  await asService((c) => c.query('select public.set_request_confidentiality($1, $2, $3)', [id, confidential, ownerEmail]));
  const stages = [{ name: 'Security review', status: 'In review', sla_business_days: 5, sla_due_at: '2026-12-01T00:00:00Z', checklist: [] }];
  await asService((c) => c.query(`select public.submit_request($1, '{}', 'High', 7, '[]', $2)`, [id, JSON.stringify(stages)]));
  return id;
}

beforeAll(async () => {
  await resetDatabase();
  admin = await createUser('admin@a.example');
  manager = await createUser('manager@a.example');
  auditor = await createUser('auditor@a.example');
  reviewer = await createUser('reviewer@a.example');
  requester = await createUser('requester@a.example');
  owner = await createUser('owner@a.example');
  colleague = await createUser('colleague@a.example');
  org = await asUser(admin, async (c) => (await c.query<{ id: string }>(`select public.create_organization('Org A') as id`)).rows[0]!.id);
  await pool.query(
    `insert into public.memberships (org_id, user_id, role) values
       ($1, $2, 'process_manager'), ($1, $3, 'auditor'), ($1, $4, 'reviewer'), ($1, $5, 'requester'), ($1, $6, 'owner'), ($1, $7, 'requester')`,
    [org, manager, auditor, reviewer, requester, owner, colleague],
  );
  secret = await submitted(true, ' Owner@A.example ');
  open = await submitted(false, null);
  secretStage = (await pool.query('select id from public.request_stages where request_id = $1', [secret])).rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe('a confidential request', () => {
  it('is visible to the requester, org admins and the business owner only', async () => {
    expect(await visible(requester)).toEqual([secret, open]);
    expect(await visible(admin)).toEqual([secret, open]);
    expect(await visible(owner)).toEqual([secret]);
    expect(await visible(manager)).toEqual([open]);
    expect(await visible(auditor)).toEqual([open]);
    expect(await visible(reviewer)).toEqual([]);
    expect(await visible(colleague)).toEqual([]);
    // Stages, questions and files follow the request.
    expect(await stagesSeen(manager, secret)).toBe(0);
    expect(await stagesSeen(owner, secret)).toBe(1);
  });

  it('cannot be reached by a process manager through functions', async () => {
    await expect(asUser(manager, (c) => c.query('select public.assign_stage_reviewer($1, $2)', [secretStage, reviewer]))).rejects.toThrow(
      /only an org admin or process manager/,
    );
    await expect(asUser(manager, (c) => c.query('select public.ask_requester($1, $2)', [secretStage, 'Why?']))).rejects.toThrow(
      /not a reviewer of this stage/,
    );
    expect((await asUser(manager, (c) => c.query('select public.request_review_answers($1) as a', [secret]))).rows[0].a).toEqual({});
    expect((await asUser(auditor, (c) => c.query('select public.request_review_answers($1) as a', [secret]))).rows[0].a).toEqual({});
    await expect(
      asUser(manager, (c) => c.query(`select public.register_attachment($1, 'a.pdf', 'application/pdf', 10, 'Quote')`, [secret])),
    ).rejects.toThrow(/cannot attach/);
    // Not confidential: the manager still works as before.
    const openStage = (await pool.query('select id from public.request_stages where request_id = $1', [open])).rows[0].id;
    await asUser(manager, (c) => c.query('select public.assign_stage_reviewer($1, $2)', [openStage, reviewer]));
  });

  it('opens to a reviewer once an org admin assigns them', async () => {
    await asUser(admin, (c) => c.query('select public.assign_stage_reviewer($1, $2)', [secretStage, reviewer]));
    expect(await visible(reviewer)).toEqual([secret, open]);
  });

  it('lets an org admin add and remove viewers, with an audit trail', async () => {
    await expect(asUser(manager, (c) => c.query('select public.add_request_viewer($1, $2)', [secret, colleague]))).rejects.toThrow(/only an org admin/);
    await expect(asUser(owner, (c) => c.query('select public.add_request_viewer($1, $2)', [secret, colleague]))).rejects.toThrow(/only an org admin/);
    const outsider = await createUser('outsider@b.example');
    await expect(asUser(admin, (c) => c.query('select public.add_request_viewer($1, $2)', [secret, outsider]))).rejects.toThrow(/only members/);

    await asUser(admin, (c) => c.query('select public.add_request_viewer($1, $2)', [secret, colleague]));
    expect(await visible(colleague)).toEqual([secret]);
    const viewers = await asUser(admin, async (c) =>
      (await c.query('select user_id, reason from public.request_viewers where request_id = $1 order by reason', [secret])).rows,
    );
    expect(viewers).toEqual([
      { user_id: colleague, reason: 'added' },
      { user_id: owner, reason: 'business_owner' },
    ]);
    // A viewer sees only their own row; the requester sees the list.
    expect((await asUser(colleague, (c) => c.query('select user_id from public.request_viewers'))).rows).toEqual([{ user_id: colleague }]);
    expect((await asUser(requester, (c) => c.query('select user_id from public.request_viewers where request_id = $1', [secret]))).rowCount).toBe(2);

    await asUser(admin, (c) => c.query('select public.remove_request_viewer($1, $2)', [secret, colleague]));
    expect(await visible(colleague)).toEqual([]);
    const actions = (await pool.query(`select action from public.audit_log where entity_id = $1 order by id`, [secret])).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['request.viewer_added', 'request.viewer_removed']));
  });

  it('can be made public again, or confidential later, by an org admin only', async () => {
    await expect(asUser(manager, (c) => c.query('select public.set_request_confidential($1, false)', [secret]))).rejects.toThrow();
    await asUser(admin, (c) => c.query('select public.set_request_confidential($1, false)', [secret]));
    expect(await visible(manager)).toEqual([secret, open]);
    await asUser(admin, (c) => c.query('select public.set_request_confidential($1, true)', [open]));
    expect(await visible(manager)).toEqual([secret]);
  });

  it('cannot be changed from the browser directly', async () => {
    await expect(asUser(requester, (c) => c.query('update public.requests set is_confidential = false where id = $1', [secret]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asUser(admin, (c) => c.query(`insert into public.request_viewers (org_id, request_id, user_id, reason) values ($1, $2, $3, 'added')`, [org, secret, colleague])),
    ).rejects.toThrow(/permission denied/);
    await expect(asUser(requester, (c) => c.query('select public.set_request_confidentiality($1, false, null)', [secret]))).rejects.toThrow(
      /permission denied/,
    );
  });
});
