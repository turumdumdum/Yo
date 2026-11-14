import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asSession, asUser, createUser, PASSWORD_ONLY, pool, resetDatabase } from './db';

// Stage reviews: who may assign, tick the checklist and decide, and how the request
// gets its final decision.

let admin: string;
let manager: string;
let reviewer: string;
let otherReviewer: string;
let requester: string;
let auditor: string;
let org: string;

const STAGES = JSON.stringify([
  { name: 'License check', status: 'In review', sla_business_days: 5, sla_due_at: '2026-11-20T15:30:00Z', checklist: ['Terms allow our use', 'Seats cover the users'] },
  { name: 'Security review', status: 'In review', sla_business_days: 5, sla_due_at: '2026-11-20T15:30:00Z', checklist: ['Security report reviewed'] },
  { name: 'Finance review', status: 'Not required', note: 'Not required: Paid or free is Free' },
]);

/** Creates and submits a request; returns its id and stage ids by name. */
async function submittedRequest(by: string) {
  const id = await asUser(by, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into public.requests (org_id, answers) values ($1, '{"serviceName": "Tool"}') returning id`,
      [org],
    );
    return rows[0]!.id;
  });
  await asService((c) => c.query(`select public.submit_request($1, '{"serviceName": "Tool"}', 'Medium', 3, '[]', $2)`, [id, STAGES]));
  const { rows } = await pool.query<{ id: string; name: string }>('select id, name from public.request_stages where request_id = $1', [id]);
  const stages = Object.fromEntries(rows.map((r) => [r.name, r.id]));
  return { id, license: stages['License check']!, security: stages['Security review']!, finance: stages['Finance review']! };
}

const decide = (userId: string, stageId: string, decision: string, comment: string | null = null, conditions: string | null = null) =>
  asUser(userId, (c) => c.query('select public.decide_stage($1, $2, $3, $4)', [stageId, decision, comment, conditions]));
const tick = (userId: string, stageId: string, index: number, checked = true) =>
  asUser(userId, (c) => c.query('select public.set_stage_checklist_item($1, $2, $3)', [stageId, index, checked]));
const assign = (userId: string, stageId: string, reviewerId: string | null) =>
  asUser(userId, (c) => c.query('select public.assign_stage_reviewer($1, $2)', [stageId, reviewerId]));
const requestStatus = async (id: string) =>
  (await pool.query('select status from public.requests where id = $1', [id])).rows[0].status as string;
const stageRow = async (id: string) => (await pool.query('select * from public.request_stages where id = $1', [id])).rows[0];

beforeAll(async () => {
  await resetDatabase();
  admin = await createUser('admin@a.example');
  manager = await createUser('manager@a.example');
  reviewer = await createUser('reviewer@a.example');
  otherReviewer = await createUser('other-reviewer@a.example');
  requester = await createUser('requester@a.example');
  auditor = await createUser('auditor@a.example');
  org = await asUser(admin, async (c) => {
    const { rows } = await c.query<{ id: string }>(`select public.create_organization('Org A') as id`);
    return rows[0]!.id;
  });
  await pool.query(
    `insert into public.memberships (org_id, user_id, role) values
     ($1, $2, 'process_manager'), ($1, $3, 'reviewer'), ($1, $4, 'reviewer'), ($1, $5, 'requester'), ($1, $6, 'auditor')`,
    [org, manager, reviewer, otherReviewer, requester, auditor],
  );
});

afterAll(async () => {
  await pool.end();
});

describe('members', () => {
  it('carry the email of the account so colleagues can tell who is who', async () => {
    const rows = await asUser(requester, async (c) => (await c.query('select email from public.memberships order by email')).rows);
    expect(rows.map((r) => r.email)).toEqual([
      'admin@a.example',
      'auditor@a.example',
      'manager@a.example',
      'other-reviewer@a.example',
      'requester@a.example',
      'reviewer@a.example',
    ]);
  });
});

describe('reviewer assignment', () => {
  let request: Awaited<ReturnType<typeof submittedRequest>>;
  beforeAll(async () => {
    request = await submittedRequest(requester);
  });

  it('stores the checklist of each stage unticked', async () => {
    expect((await stageRow(request.license)).checklist).toEqual([
      { label: 'Terms allow our use', checked: false },
      { label: 'Seats cover the users', checked: false },
    ]);
    expect((await stageRow(request.finance)).checklist).toEqual([]);
  });

  it('hides the request from reviewers until they are assigned to one of its stages', async () => {
    const visible = (userId: string) =>
      asUser(userId, async (c) => ({
        requests: (await c.query('select 1 from public.requests')).rowCount,
        stages: (await c.query('select 1 from public.request_stages')).rowCount,
      }));
    expect(await visible(reviewer)).toEqual({ requests: 0, stages: 0 });
    await assign(manager, request.license, reviewer);
    // Being assigned to one stage shows the whole request, including its other stages.
    expect(await visible(reviewer)).toEqual({ requests: 1, stages: 3 });
    expect(await visible(otherReviewer)).toEqual({ requests: 0, stages: 0 });
  });

  it('is limited to org admins and process managers', async () => {
    for (const userId of [reviewer, requester, auditor]) {
      await expect(assign(userId, request.security, reviewer)).rejects.toThrow(/only an org admin or process manager|stage not found/);
    }
    await assign(admin, request.security, otherReviewer);
    await assign(admin, request.security, null);
    expect((await stageRow(request.security)).reviewer_id).toBeNull();
  });

  it('accepts only members with a reviewing role', async () => {
    const stranger = await createUser('stranger@c.example');
    for (const candidate of [requester, auditor, stranger]) {
      await expect(assign(admin, request.security, candidate)).rejects.toThrow(/must be a member/);
    }
  });

  it('is recorded in the audit log', async () => {
    const { rows } = await pool.query(
      `select actor_id, metadata ->> 'stage' as stage, metadata ->> 'reviewer_id' as reviewer
       from public.audit_log where action = 'stage.reviewer_assigned' order by id limit 1`,
    );
    expect(rows[0]).toEqual({ actor_id: manager, stage: 'License check', reviewer });
  });
});

describe('checklist and decisions', () => {
  let request: Awaited<ReturnType<typeof submittedRequest>>;
  beforeAll(async () => {
    request = await submittedRequest(requester);
    await assign(manager, request.license, reviewer);
  });

  it('lets only the assigned reviewer, org admin or process manager act on a stage', async () => {
    for (const userId of [otherReviewer, requester, auditor]) {
      await expect(tick(userId, request.license, 0)).rejects.toThrow(/not a reviewer of this stage|stage not found/);
      await expect(decide(userId, request.license, 'Rejected', 'No')).rejects.toThrow(/not a reviewer of this stage|stage not found/);
    }
    // The reviewer of the license check is not a reviewer of the security review.
    await expect(decide(reviewer, request.security, 'Rejected', 'No')).rejects.toThrow(/not a reviewer of this stage/);
  });

  it('requires a second factor', async () => {
    await expect(
      asSession(reviewer, PASSWORD_ONLY, (c) => c.query(`select public.decide_stage($1, 'Rejected', 'No', null)`, [request.license])),
    ).rejects.toThrow(/multi-factor authentication required/);
  });

  it('does not approve with an incomplete checklist', async () => {
    await tick(reviewer, request.license, 0);
    await expect(decide(reviewer, request.license, 'Approved')).rejects.toThrow(/complete the checklist/);
    await expect(tick(reviewer, request.license, 2)).rejects.toThrow(/unknown checklist item/);
  });

  it('validates the decision', async () => {
    await expect(decide(reviewer, request.license, 'Maybe')).rejects.toThrow(/unknown decision/);
    await expect(decide(reviewer, request.license, 'Approved with conditions', 'ok', '  ')).rejects.toThrow(/describe the conditions/);
    await expect(decide(reviewer, request.license, 'Rejected', ' ')).rejects.toThrow(/explain why/);
    await expect(decide(reviewer, request.license, 'Rejected', 'x'.repeat(2001))).rejects.toThrow(/check constraint/);
  });

  it('approves once the checklist is complete and records who decided', async () => {
    await tick(reviewer, request.license, 1);
    await decide(reviewer, request.license, 'Approved', 'Looks fine');
    const stage = await stageRow(request.license);
    expect(stage).toMatchObject({ status: 'Approved', decision_comment: 'Looks fine', conditions: null, decided_by: reviewer });
    expect(stage.decided_at).toBeInstanceOf(Date);
    expect(await requestStatus(request.id)).toBe('in_review');
  });

  it('closes a decided stage', async () => {
    await expect(decide(admin, request.license, 'Rejected', 'Changed my mind')).rejects.toThrow(/not open for review/);
    await expect(tick(reviewer, request.license, 0, false)).rejects.toThrow(/not open for review/);
    await expect(assign(admin, request.license, otherReviewer)).rejects.toThrow(/not open for review/);
    await expect(decide(admin, request.finance, 'Approved')).rejects.toThrow(/not open for review/);
  });

  it('approves the request when the last open stage is approved, conditions included', async () => {
    await decide(manager, request.security, 'Approved with conditions', null, 'Enable SSO within 30 days');
    expect(await stageRow(request.security)).toMatchObject({ status: 'Approved with conditions', conditions: 'Enable SSO within 30 days' });
    expect(await requestStatus(request.id)).toBe('approved');
    const { rows } = await pool.query(
      `select action, actor_id from public.audit_log where entity_id = $1 and action like 'request.%' order by id`,
      [request.id],
    );
    expect(rows).toEqual([
      { action: 'request.submitted', actor_id: requester },
      { action: 'request.approved', actor_id: manager },
    ]);
  });

  it('rejects the request when any stage was rejected, once all stages are decided', async () => {
    const second = await submittedRequest(requester);
    await decide(admin, second.license, 'Rejected', 'License forbids commercial use');
    expect(await requestStatus(second.id)).toBe('in_review');
    await decide(admin, second.security, 'Approved with conditions', null, 'n/a');
    expect(await requestStatus(second.id)).toBe('rejected');
  });

  it('shows decisions to the requester but gives them no way to change them', async () => {
    const rows = await asUser(requester, async (c) =>
      (await c.query('select status, decision_comment from public.request_stages where id = $1', [request.license])).rows,
    );
    expect(rows).toEqual([{ status: 'Approved', decision_comment: 'Looks fine' }]);
    await expect(
      asUser(requester, (c) => c.query(`update public.request_stages set status = 'In review' where id = $1`, [request.license])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('reviewing your own request', () => {
  let own: Awaited<ReturnType<typeof submittedRequest>>;
  beforeAll(async () => {
    own = await submittedRequest(admin);
  });

  it('is refused by default, also for the org admin', async () => {
    await expect(decide(admin, own.license, 'Rejected', 'No')).rejects.toThrow(/cannot review your own request/);
    await expect(tick(admin, own.license, 0)).rejects.toThrow(/cannot review your own request/);
    // A colleague can still review it.
    await decide(manager, own.license, 'Rejected', 'No');
  });

  it('can be allowed by the org admin only, and the change is audited', async () => {
    const byManager = await asUser(manager, (c) => c.query('update public.organizations set allow_self_review = true where id = $1', [org]));
    expect(byManager.rowCount).toBe(0);
    await asUser(admin, (c) => c.query('update public.organizations set allow_self_review = true where id = $1', [org]));
    await decide(admin, own.security, 'Approved with conditions', null, 'Small team');
    const { rows } = await pool.query(
      `select actor_id, metadata from public.audit_log where action = 'organization.settings_changed'`,
    );
    expect(rows).toEqual([{ actor_id: admin, metadata: { allow_self_review: true } }]);
  });
});
