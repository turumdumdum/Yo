import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createUser, pool, resetDatabase } from './db';

// Security baseline controls and exceptions during the security review.

let admin: string;
let admin2: string;
let manager: string;
let reviewer: string;
let requester: string;
let org: string;
let requestId: string;
let securityStage: string;

const items = [
  { id: 'sso', title: 'SSO', requirement: 'r', verification: 'v', category: 'Identity & access', level: 'required', decision: null, note: null, configured: false, configured_by: null, configured_at: null },
  { id: 'mfa', title: 'MFA', requirement: 'r', verification: 'v', category: 'Identity & access', level: 'required', decision: null, note: null, configured: false, configured_by: null, configured_at: null },
  { id: 'export', title: 'Export', requirement: 'r', verification: 'v', category: 'Resilience & exit', level: 'recommended', decision: null, note: null, configured: false, configured_by: null, configured_at: null },
];
type Item = { id: string; decision: string | null; note: string | null; configured: boolean; configured_by: string | null };
const config = async (): Promise<Record<string, Item>> =>
  Object.fromEntries(
    ((await pool.query('select config_requirements from public.requests where id = $1', [requestId])).rows[0].config_requirements as Item[]).map(
      (i) => [i.id, i as Item],
    ),
  );
const decide = (userId: string, control: string | null, decision: string | null, note: string | null = null) =>
  asUser(userId, (c) => c.query('select public.set_config_decision($1, $2, $3, $4)', [requestId, control, decision, note]));
const ask = (userId: string, control: string, expires = 'current_date + 180') =>
  asUser(userId, async (c) =>
    (
      await c.query<{ id: string }>(
        `select public.request_exception($1, $2, 'SSO is only in the enterprise plan', 'Pilot for three months', 'Strong passwords and MFA; access review monthly', 'Medium', ${expires}) as id`,
        [requestId, control],
      )
    ).rows[0]!.id,
  );
const approveStage = (userId: string, decision = 'Approved with conditions') =>
  asUser(userId, (c) => c.query('select public.decide_stage($1, $2, null, $3)', [securityStage, decision, 'SSO exception until the enterprise plan']));

beforeAll(async () => {
  await resetDatabase();
  admin = await createUser('admin@a.example');
  admin2 = await createUser('admin2@a.example');
  manager = await createUser('manager@a.example');
  reviewer = await createUser('reviewer@a.example');
  requester = await createUser('requester@a.example');
  org = await asUser(admin, async (c) => (await c.query<{ id: string }>(`select public.create_organization('Org A') as id`)).rows[0]!.id);
  await pool.query(
    `insert into public.memberships (org_id, user_id, role) values ($1, $2, 'org_admin'), ($1, $3, 'process_manager'), ($1, $4, 'reviewer'), ($1, $5, 'requester')`,
    [org, admin2, manager, reviewer, requester],
  );
  requestId = await asUser(requester, async (c) =>
    (await c.query<{ id: string }>(`insert into public.requests (org_id, answers) values ($1, '{"serviceName": "Tool"}') returning id`, [org])).rows[0]!.id,
  );
  await asService((c) => c.query('select public.set_request_config_requirements($1, $2)', [requestId, JSON.stringify(items)]));
  const stages = [{ name: 'Security review', status: 'In review', sla_business_days: 5, sla_due_at: '2026-12-01T00:00:00Z', checklist: [] }];
  await asService((c) => c.query(`select public.submit_request($1, '{"serviceName": "Tool"}', 'High', 7, '[]', $2)`, [requestId, JSON.stringify(stages)]));
  securityStage = (await pool.query(`select id from public.request_stages where request_id = $1`, [requestId])).rows[0].id;
  await asUser(admin, (c) => c.query('select public.assign_stage_reviewer($1, $2)', [securityStage, reviewer]));
});

afterAll(async () => {
  await pool.end();
});

describe('configuration controls in the security review', () => {
  it('can only be set by the backend while the request is a draft', async () => {
    await expect(asService((c) => c.query('select public.set_request_config_requirements($1, $2)', [requestId, '[]']))).rejects.toThrow(/not a draft/);
    await expect(asUser(requester, (c) => c.query(`update public.requests set config_requirements = '[]' where id = $1`, [requestId]))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('are decided by the security reviewer; "not applicable" needs a reason', async () => {
    await expect(decide(requester, 'mfa', 'required')).rejects.toThrow(/not a reviewer|stage not found/);
    await expect(decide(reviewer, 'mfa', 'not_applicable')).rejects.toThrow(/explain why/);
    await expect(decide(reviewer, 'mfa', 'exception')).rejects.toThrow(/requested separately/);
    await decide(reviewer, 'export', 'not_applicable', 'We never store data there');
    expect((await config()).export).toMatchObject({ decision: 'not_applicable', note: 'We never store data there' });
  });

  it('block approval until every required control is decided', async () => {
    await expect(approveStage(reviewer, 'Approved')).rejects.toThrow(/decide on every required configuration control before approving, starting with “SSO”/);
  });
});

describe('exceptions', () => {
  let exceptionId: string;

  it('are requested by the reviewer with an end date within a year', async () => {
    await expect(ask(reviewer, 'sso', 'current_date + 400')).rejects.toThrow(/within a year/);
    await expect(ask(reviewer, 'sso', 'current_date')).rejects.toThrow(/within a year/);
    await expect(ask(requester, 'sso')).rejects.toThrow(/not a reviewer|stage not found/);
    exceptionId = await ask(reviewer, 'sso');
    expect((await config()).sso!.decision).toBe('exception');
    await expect(ask(reviewer, 'sso')).rejects.toThrow(/already has an open exception/);
    await expect(decide(reviewer, 'sso', 'required')).rejects.toThrow(/withdraw or revoke it first/);
  });

  it('keep the review open while one waits for a decision', async () => {
    await decide(reviewer, null, 'required');
    expect((await config()).mfa!.decision).toBe('required');
    await expect(approveStage(reviewer)).rejects.toThrow(/waiting for an org admin/);
  });

  it('are decided by an org admin other than the person who asked', async () => {
    const decideAs = (userId: string, approve: boolean, comment: string | null) =>
      asUser(userId, (c) => c.query('select public.decide_exception($1, $2, $3)', [exceptionId, approve, comment]));
    await expect(decideAs(manager, true, null)).rejects.toThrow(/only an org admin/);
    await expect(decideAs(reviewer, true, null)).rejects.toThrow(/only an org admin/);
    await expect(decideAs(admin, false, null)).rejects.toThrow(/explain why/);
    await decideAs(admin, true, 'Accepted for the pilot');
    const row = (await pool.query('select status, decided_by from public.review_exceptions where id = $1', [exceptionId])).rows[0];
    expect(row).toEqual({ status: 'approved', decided_by: admin });
    await expect(decideAs(admin2, true, null)).rejects.toThrow(/already decided/);
  });

  it('let the review pass only "with conditions"', async () => {
    await expect(approveStage(reviewer, 'Approved')).rejects.toThrow(/approve with conditions/);
    await approveStage(reviewer);
    expect((await pool.query('select status from public.requests where id = $1', [requestId])).rows[0].status).toBe('approved');
  });

  it('cannot be decided by the admin who asked for it', async () => {
    // An admin may review too; then a second admin has to accept the risk.
    await pool.query(`update public.request_stages set status = 'In review' where id = $1`, [securityStage]);
    await pool.query(`update public.requests set status = 'in_review' where id = $1`, [requestId]);
    await decide(admin, 'mfa', 'not_applicable', 'temporary');
    const mine = await asUser(admin, async (c) =>
      (
        await c.query<{ id: string }>(
          `select public.request_exception($1, 'mfa', 'd', 'j', 'c', 'High', current_date + 30) as id`,
          [requestId],
        )
      ).rows[0]!.id,
    );
    await expect(asUser(admin, (c) => c.query('select public.decide_exception($1, true, null)', [mine]))).rejects.toThrow(/someone other than/);
    await asUser(admin2, (c) => c.query('select public.decide_exception($1, false, $2)', [mine, 'Too risky']));
    expect((await config()).mfa!.decision).toBeNull();
    await decide(reviewer, 'mfa', 'required');
    await approveStage(reviewer);
  });

  it('are revoked by an org admin; the control must then be configured', async () => {
    await expect(asUser(reviewer, (c) => c.query('select public.revoke_exception($1, null)', [exceptionId]))).rejects.toThrow(/only an org admin/);
    await asUser(admin2, (c) => c.query('select public.revoke_exception($1, $2)', [exceptionId, 'Enterprise plan bought']));
    expect((await config()).sso!.decision).toBe('required');
    const actions = (await pool.query(`select action from public.audit_log where action like 'exception.%' order by id`)).rows.map((r) => r.action);
    expect(actions).toEqual(['exception.requested', 'exception.approved', 'exception.requested', 'exception.rejected', 'exception.revoked']);
  });
});

describe('confirming the configuration after approval', () => {
  const confirm = (userId: string, control: string, on = true) =>
    asUser(userId, (c) => c.query('select public.confirm_configuration($1, $2, $3)', [requestId, control, on]));

  it('is for the requester, the business owner or a manager, on required controls', async () => {
    await expect(confirm(reviewer, 'sso')).rejects.toThrow(/only the requester/);
    await expect(confirm(requester, 'export')).rejects.toThrow(/does not need to be configured/);
    await confirm(requester, 'sso');
    const sso = (await config()).sso!;
    expect(sso.configured).toBe(true);
    expect(sso.configured_by).toBe(requester);
    await confirm(manager, 'sso', false);
    expect((await config()).sso!.configured).toBe(false);
  });
});
