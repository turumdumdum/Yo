import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asSession, asUser, createUser, PASSWORD_ONLY, pool, resetDatabase } from './db';

// Questions to the requester: who may ask and answer, and how the SLA clock pauses.

let admin: string;
let reviewer: string;
let requester: string;
let colleague: string;
let org: string;
let requestId: string;
let stageId: string;
let otherStage: string;

const ask = (userId: string, stage: string, question: string) =>
  asUser(userId, async (c) => (await c.query<{ id: string }>('select public.ask_requester($1, $2) as id', [stage, question])).rows[0]!.id);
const answer = (userId: string, id: string, text: string) =>
  asUser(userId, (c) => c.query('select public.answer_info_request($1, $2)', [id, text]));
const stage = async (id: string) =>
  (await pool.query('select status, sla_paused, sla_paused_at, sla_due_at from public.request_stages where id = $1', [id])).rows[0];

beforeAll(async () => {
  await resetDatabase();
  admin = await createUser('admin@a.example');
  reviewer = await createUser('reviewer@a.example');
  requester = await createUser('requester@a.example');
  colleague = await createUser('colleague@a.example');
  org = await asUser(admin, async (c) => (await c.query<{ id: string }>(`select public.create_organization('Org A') as id`)).rows[0]!.id);
  await pool.query(
    `insert into public.memberships (org_id, user_id, role) values ($1, $2, 'reviewer'), ($1, $3, 'requester'), ($1, $4, 'requester')`,
    [org, reviewer, requester, colleague],
  );
  requestId = await asUser(requester, async (c) =>
    (await c.query<{ id: string }>(`insert into public.requests (org_id) values ($1) returning id`, [org])).rows[0]!.id,
  );
  const stages = [
    // Due on a Friday, so a short pause pushes the date into the weekend.
    { name: 'Security review', status: 'In review', sla_business_days: 5, sla_due_at: '2026-11-20T15:30:00Z', checklist: [] },
    { name: 'License check', status: 'In review', sla_business_days: 5, sla_due_at: '2026-11-20T15:30:00Z', checklist: [] },
  ];
  await asService((c) => c.query(`select public.submit_request($1, '{}', 'High', 7, '[]', $2)`, [requestId, JSON.stringify(stages)]));
  const { rows } = await pool.query<{ id: string; name: string }>('select id, name from public.request_stages where request_id = $1', [requestId]);
  stageId = rows.find((r) => r.name === 'Security review')!.id;
  otherStage = rows.find((r) => r.name === 'License check')!.id;
  await asUser(admin, (c) => c.query('select public.assign_stage_reviewer($1, $2)', [stageId, reviewer]));
});

afterAll(async () => {
  await pool.end();
});

describe('asking the requester', () => {
  let first: string;
  let second: string;

  it('is for people who may review the stage', async () => {
    for (const userId of [requester, colleague]) {
      await expect(ask(userId, stageId, 'Why?')).rejects.toThrow(/not a reviewer of this stage|stage not found/);
    }
    await expect(ask(reviewer, otherStage, 'Why?')).rejects.toThrow(/not a reviewer of this stage/);
    await expect(
      asSession(reviewer, PASSWORD_ONLY, (c) => c.query(`select public.ask_requester($1, 'Why?')`, [stageId])),
    ).rejects.toThrow(/multi-factor/);
  });

  it('needs a question of reasonable length', async () => {
    await expect(ask(reviewer, stageId, '   ')).rejects.toThrow(/write a question/);
    await expect(ask(reviewer, stageId, 'x'.repeat(2001))).rejects.toThrow(/at most 2000/);
  });

  it('moves the stage to Waiting for requester and stops its clock', async () => {
    first = await ask(reviewer, stageId, '  Which plan will you buy?  ');
    const row = await stage(stageId);
    expect(row).toMatchObject({ status: 'Waiting for requester', sla_paused: true });
    expect(row.sla_paused_at).toBeInstanceOf(Date);
    expect((await stage(otherStage)).status).toBe('In review');
    const { rows } = await pool.query('select question, asked_by, answer from public.info_requests where id = $1', [first]);
    expect(rows[0]).toEqual({ question: 'Which plan will you buy?', asked_by: reviewer, answer: null });
  });

  it('keeps the original pause start when a second question follows', async () => {
    await pool.query(`update public.request_stages set sla_paused_at = now() - interval '2 days' where id = $1`, [stageId]);
    const before = (await stage(stageId)).sla_paused_at;
    second = await ask(admin, stageId, 'Is SSO included?');
    expect((await stage(stageId)).sla_paused_at).toEqual(before);
  });

  it('shows questions to everyone who can see the request, and to nobody else', async () => {
    const visible = (userId: string) => asUser(userId, async (c) => (await c.query('select 1 from public.info_requests')).rowCount);
    for (const viewer of [requester, reviewer, admin]) expect(await visible(viewer)).toBe(2);
    expect(await visible(colleague)).toBe(0);
  });

  it('cannot be written directly from the browser', async () => {
    await expect(
      asUser(requester, (c) => c.query(`update public.info_requests set answer = 'x', answered_at = now()`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(reviewer, (c) =>
        c.query(`insert into public.info_requests (org_id, request_id, stage_id, question) values ($1, $2, $3, 'x')`, [org, requestId, stageId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  describe('answering', () => {
    it('is for the requester only', async () => {
      for (const userId of [reviewer, admin, colleague]) {
        await expect(answer(userId, first, 'Enterprise')).rejects.toThrow(/only the requester|question not found/);
      }
      await expect(answer(requester, first, '  ')).rejects.toThrow(/write an answer/);
    });

    it('keeps the stage waiting while another question is open', async () => {
      await answer(requester, first, ' Enterprise ');
      expect(await stage(stageId)).toMatchObject({ status: 'Waiting for requester', sla_paused: true });
      const { rows } = await pool.query('select answer, answered_by from public.info_requests where id = $1', [first]);
      expect(rows[0]).toEqual({ answer: 'Enterprise', answered_by: requester });
      await expect(answer(requester, first, 'Again')).rejects.toThrow(/already been answered/);
    });

    it('resumes the stage after the last answer and moves the due date out by the pause, never onto a weekend', async () => {
      await answer(requester, second, 'Yes');
      const row = await stage(stageId);
      expect(row).toMatchObject({ status: 'In review', sla_paused: false, sla_paused_at: null });
      // Friday 20 Nov + 2 days paused = Sunday 22 Nov, rolled forward to Monday 23 Nov.
      const due = row.sla_due_at as Date;
      expect(due.toISOString().slice(0, 10)).toBe('2026-11-23');
      // The other stage was never paused.
      expect(((await stage(otherStage)).sla_due_at as Date).toISOString()).toBe('2026-11-20T15:30:00.000Z');
    });

    it('is recorded in the audit log', async () => {
      const { rows } = await pool.query(
        `select action, actor_id from public.audit_log where action like 'info_request.%' order by id`,
      );
      expect(rows).toEqual([
        { action: 'info_request.asked', actor_id: reviewer },
        { action: 'info_request.asked', actor_id: admin },
        { action: 'info_request.answered', actor_id: requester },
        { action: 'info_request.answered', actor_id: requester },
      ]);
    });
  });

  describe('a stage decided while waiting', () => {
    it('can be decided, and a late answer is kept without reopening it', async () => {
      const late = await ask(reviewer, stageId, 'One more thing?');
      await asUser(reviewer, (c) => c.query(`select public.decide_stage($1, 'Rejected', 'No answer in time', null)`, [stageId]));
      expect(await stage(stageId)).toMatchObject({ status: 'Rejected', sla_paused: false });
      await answer(requester, late, 'Sorry, here it is');
      expect((await stage(stageId)).status).toBe('Rejected');
      await expect(ask(reviewer, stageId, 'Too late?')).rejects.toThrow(/not open for review/);
    });
  });
});
