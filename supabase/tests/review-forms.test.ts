import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createUser, pool, resetDatabase } from './db';

// Review forms: answers are saved by reviewers, hidden from the requester, and the
// required answers must be complete before approving.

let admin: string;
let reviewer: string;
let requester: string;
let auditor: string;
let org: string;
let requestId: string;
let securityStage: string;
let licenseStage: string;

const FIELDS = [
  { key: 'certifications', label: 'Certifications', type: 'multiselect', required: true, options: ['SOC 2 Type II', 'ISO/IEC 27001', 'None'] },
  { key: 'mfa', label: 'MFA', type: 'select', required: true, options: ['Enforced', 'Not available'] },
  { key: 'reportDate', label: 'Report date', type: 'date', required: false },
  { key: 'findings', label: 'Findings', type: 'textarea', required: false },
];

const save = (userId: string, stageId: string, answers: unknown) =>
  asUser(userId, async (c) => (await c.query('select public.save_stage_review_answers($1, $2) as a', [stageId, JSON.stringify(answers)])).rows[0].a);
const decide = (userId: string, stageId: string, decision: string, conditions: string | null = null) =>
  asUser(userId, (c) => c.query('select public.decide_stage($1, $2, $3, $4)', [stageId, decision, 'comment', conditions]));
const answersFor = (userId: string) =>
  asUser(userId, async (c) => (await c.query('select public.request_review_answers($1) as a', [requestId])).rows[0].a);

beforeAll(async () => {
  await resetDatabase();
  admin = await createUser('admin@a.example');
  reviewer = await createUser('reviewer@a.example');
  requester = await createUser('requester@a.example');
  auditor = await createUser('auditor@a.example');
  org = await asUser(admin, async (c) => {
    const { rows } = await c.query<{ id: string }>(`select public.create_organization('Org A') as id`);
    return rows[0]!.id;
  });
  await pool.query(
    `insert into public.memberships (org_id, user_id, role) values ($1, $2, 'reviewer'), ($1, $3, 'requester'), ($1, $4, 'auditor')`,
    [org, reviewer, requester, auditor],
  );
  requestId = await asUser(requester, async (c) => {
    const { rows } = await c.query<{ id: string }>(`insert into public.requests (org_id) values ($1) returning id`, [org]);
    return rows[0]!.id;
  });
  const stages = [
    { name: 'Security review', status: 'In review', sla_business_days: 5, sla_due_at: '2026-11-20T00:00:00Z', checklist: [], review_fields: FIELDS, review_rules: [] },
    { name: 'License check', status: 'In review', sla_business_days: 5, sla_due_at: '2026-11-20T00:00:00Z', checklist: [] },
  ];
  await asService((c) => c.query(`select public.submit_request($1, '{}', 'High', 7, '[]', $2)`, [requestId, JSON.stringify(stages)]));
  const { rows } = await pool.query<{ id: string; name: string }>('select id, name from public.request_stages where request_id = $1', [requestId]);
  securityStage = rows.find((r) => r.name === 'Security review')!.id;
  licenseStage = rows.find((r) => r.name === 'License check')!.id;
  await asUser(admin, (c) => c.query('select public.assign_stage_reviewer($1, $2)', [securityStage, reviewer]));
});

afterAll(async () => {
  await pool.end();
});

describe('review forms', () => {
  it('are copied into the stage at submission', async () => {
    const { rows } = await pool.query('select review_fields, review_answers from public.request_stages where id = $1', [securityStage]);
    expect(rows[0]).toEqual({ review_fields: FIELDS, review_answers: {} });
    const other = await pool.query('select review_fields from public.request_stages where id = $1', [licenseStage]);
    expect(other.rows[0].review_fields).toEqual([]);
  });

  it('are saved by the reviewer, keeping known fields only and allowing partial answers', async () => {
    const saved = await save(reviewer, securityStage, { certifications: ['SOC 2 Type II'], injected: 'x' });
    expect(saved).toEqual({ certifications: ['SOC 2 Type II'] });
  });

  it('reject values outside the options or malformed', async () => {
    await expect(save(reviewer, securityStage, { mfa: 'Sometimes' })).rejects.toThrow(/choose one of the options for "MFA"/);
    await expect(save(reviewer, securityStage, { certifications: ['SOC 3'] })).rejects.toThrow(/choose from the options/);
    await expect(save(reviewer, securityStage, { reportDate: '2026-02-30' })).rejects.toThrow(/valid date/);
    await expect(save(reviewer, securityStage, { findings: 'x'.repeat(2001) })).rejects.toThrow(/at most 2000/);
    await expect(save(reviewer, securityStage, ['not', 'an', 'object'])).rejects.toThrow(/expected answers by field/);
  });

  it('cannot be saved by people who may not review the stage', async () => {
    await expect(save(requester, securityStage, { mfa: 'Enforced' })).rejects.toThrow(/not a reviewer of this stage/);
    await expect(save(auditor, securityStage, { mfa: 'Enforced' })).rejects.toThrow(/not a reviewer of this stage/);
  });

  it('are hidden from the requester and visible to reviewers, admins and auditors', async () => {
    expect(await answersFor(requester)).toEqual({});
    for (const viewer of [reviewer, admin, auditor]) {
      expect((await answersFor(viewer))[securityStage]).toEqual({ certifications: ['SOC 2 Type II'] });
    }
    await expect(
      asUser(requester, (c) => c.query('select review_answers from public.request_stages')),
    ).rejects.toThrow(/permission denied/);
    // Everything else about the stage stays readable for the requester.
    const visible = await asUser(requester, async (c) => (await c.query('select name, review_fields from public.request_stages order by position')).rows);
    expect(visible.map((r) => r.name)).toEqual(['Security review', 'License check']);
  });

  it('must be complete before approving, also with conditions, but not to reject', async () => {
    await expect(decide(reviewer, securityStage, 'Approved')).rejects.toThrow(/complete the review form before approving: answer "MFA"/);
    await expect(decide(reviewer, securityStage, 'Approved with conditions', 'Fix MFA')).rejects.toThrow(/complete the review form/);
    await save(reviewer, securityStage, { certifications: ['SOC 2 Type II'], mfa: 'Enforced' });
    await decide(reviewer, securityStage, 'Approved');
    const { rows } = await pool.query('select status, review_answers from public.request_stages where id = $1', [securityStage]);
    expect(rows[0]).toEqual({ status: 'Approved', review_answers: { certifications: ['SOC 2 Type II'], mfa: 'Enforced' } });
  });

  it('are frozen once the stage is decided', async () => {
    await expect(save(reviewer, securityStage, { mfa: 'Not available' })).rejects.toThrow(/not open for review/);
  });

  it('do not hold up stages without a form', async () => {
    await decide(admin, licenseStage, 'Rejected');
    const { rows } = await pool.query('select status from public.requests where id = $1', [requestId]);
    expect(rows[0].status).toBe('rejected');
  });
});

describe('organization forms', () => {
  it('are readable by members and written by the backend only', async () => {
    await asService((c) =>
      c.query(`insert into public.review_templates (org_id, stage_name, fields, updated_by) values ($1, 'Security review', $2, $3)`, [
        org,
        JSON.stringify(FIELDS),
        admin,
      ]),
    );
    const rows = await asUser(requester, async (c) => (await c.query('select stage_name from public.review_templates')).rows);
    expect(rows).toEqual([{ stage_name: 'Security review' }]);
    await expect(
      asUser(admin, (c) => c.query(`update public.review_templates set fields = '[]'`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(admin, (c) => c.query(`insert into public.review_templates (org_id, stage_name, fields) values ($1, 'IT review', '[]')`, [org])),
    ).rejects.toThrow(/permission denied/);
  });
});
