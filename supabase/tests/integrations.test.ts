import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createUser, pool, resetDatabase } from './db';

// External review stages: recorded at submission, closed to reviewers here, and updated
// only by the backend after it verified the external service's signature.

let admin: string;
let requester: string;
let org: string;
let otherOrg: string;
let requestId: string;
let external: string;
let internal: string;

const apply = (stageId: string, status: string, opts: { org?: string; comment?: string | null; conditions?: string | null; url?: string | null } = {}) =>
  asService(async (c) =>
    (
      await c.query<{ r: string }>('select public.apply_external_stage_status($1, $2, $3, $4, $5, $6, $7) as r', [
        opts.org ?? org,
        stageId,
        status,
        opts.comment ?? null,
        opts.conditions ?? null,
        'EXT-1',
        opts.url ?? null,
      ])
    ).rows[0]!.r,
  );
const stage = async (id: string) =>
  (await pool.query('select status, sla_paused, sla_paused_at, sla_due_at, external, external_id, external_url, decided_by, conditions from public.request_stages where id = $1', [id])).rows[0];
const requestStatus = async () => (await pool.query('select status from public.requests where id = $1', [requestId])).rows[0].status;

beforeAll(async () => {
  await resetDatabase();
  await pool.query('update private.installation_settings set single_organization = false');
  admin = await createUser('admin@a.example');
  requester = await createUser('requester@a.example');
  const otherAdmin = await createUser('admin@b.example');
  org = await asUser(admin, async (c) => (await c.query<{ id: string }>(`select public.create_organization('Org A') as id`)).rows[0]!.id);
  otherOrg = await asUser(otherAdmin, async (c) => (await c.query<{ id: string }>(`select public.create_organization('Org B') as id`)).rows[0]!.id);
  await pool.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'requester')`, [org, requester]);
  requestId = await asUser(requester, async (c) =>
    (await c.query<{ id: string }>(`insert into public.requests (org_id, answers) values ($1, '{"serviceName": "Tool"}') returning id`, [org])).rows[0]!.id,
  );
  const stages = [
    { name: 'Security review', status: 'In review', sla_business_days: 5, sla_due_at: '2026-12-01T00:00:00Z', checklist: [], external: true },
    { name: 'License check', status: 'In review', sla_business_days: 5, sla_due_at: '2026-12-01T00:00:00Z', checklist: ['Terms ok'] },
  ];
  await asService((c) => c.query(`select public.submit_request($1, '{"serviceName": "Tool"}', 'High', 7, '[]', $2)`, [requestId, JSON.stringify(stages)]));
  const rows = (await pool.query<{ id: string; name: string }>('select id, name from public.request_stages where request_id = $1', [requestId])).rows;
  external = rows.find((r) => r.name === 'Security review')!.id;
  internal = rows.find((r) => r.name === 'License check')!.id;
});

afterAll(async () => {
  await pool.end();
});

describe('external review stages', () => {
  it('are recorded at submission and visible to members', async () => {
    expect((await stage(external)).external).toBe(true);
    expect((await stage(internal)).external).toBe(false);
    const seen = await asUser(admin, async (c) => (await c.query('select external from public.request_stages where id = $1', [external])).rows[0]);
    expect(seen).toEqual({ external: true });
  });

  it('cannot be reviewed in this app', async () => {
    await expect(asUser(admin, (c) => c.query('select public.set_stage_checklist_item($1, 0, true)', [external]))).rejects.toThrow(/external service/);
    await expect(asUser(admin, (c) => c.query(`select public.decide_stage($1, 'Approved', null, null)`, [external]))).rejects.toThrow(/external service/);
  });

  it('can only be updated by the backend, for the right organization and an external stage', async () => {
    await expect(
      asUser(admin, (c) => c.query(`select public.apply_external_stage_status($1, $2, 'approved', null, null, null, null)`, [org, external])),
    ).rejects.toThrow(/permission denied/);
    expect(await apply(external, 'approved', { org: otherOrg })).toBe('not_found');
    expect(await apply(internal, 'approved')).toBe('not_found');
    await expect(apply(external, 'in_review', { url: 'http://insecure.example' })).rejects.toThrow(/https/);
    await expect(apply(external, 'done')).rejects.toThrow(/unknown status/);
  });

  it('pauses the clock while waiting for the requester and moves the due date when it resumes', async () => {
    const before = await stage(external);
    expect(await apply(external, 'waiting_for_requester', { url: 'https://grc.example/cases/1' })).toBe('ok');
    const waiting = await stage(external);
    expect(waiting).toMatchObject({ status: 'Waiting for requester', sla_paused: true, external_id: 'EXT-1', external_url: 'https://grc.example/cases/1' });
    await pool.query(`update public.request_stages set sla_paused_at = now() - interval '2 days' where id = $1`, [external]);
    expect(await apply(external, 'in_review')).toBe('ok');
    const resumed = await stage(external);
    expect(resumed.status).toBe('In review');
    expect(resumed.sla_paused).toBe(false);
    expect(resumed.sla_paused_at).toBeNull();
    const moved = new Date(resumed.sla_due_at).getTime() - new Date(before.sla_due_at).getTime();
    expect(moved).toBeGreaterThan(2 * 86_400_000 - 60_000);
  });

  it('requires conditions or a reason for those decisions', async () => {
    await expect(apply(external, 'approved_with_conditions')).rejects.toThrow(/conditions are required/);
    await expect(apply(external, 'rejected')).rejects.toThrow(/comment is required/);
  });

  it('decides the stage, and the request once its last open stage is decided', async () => {
    expect(await apply(external, 'approved_with_conditions', { conditions: 'Enable SSO before rollout' })).toBe('ok');
    expect(await stage(external)).toMatchObject({ status: 'Approved with conditions', decided_by: null, conditions: 'Enable SSO before rollout' });
    expect(await requestStatus()).toBe('in_review');
    await asUser(admin, (c) => c.query('select public.set_stage_checklist_item($1, 0, true)', [internal]));
    await asUser(admin, (c) => c.query(`select public.decide_stage($1, 'Approved', null, null)`, [internal]));
    expect(await requestStatus()).toBe('approved');
    expect(await apply(external, 'rejected', { comment: 'late' })).toBe('closed');
  });

  it('writes audit rows without a person as actor', async () => {
    const rows = (
      await pool.query(`select action, actor_id, metadata from public.audit_log where entity_id = $1 and action in ('stage.decided', 'stage.external_status') order by id`, [external])
    ).rows;
    expect(rows.map((r) => r.action)).toEqual(['stage.external_status', 'stage.external_status', 'stage.decided']);
    expect(rows.every((r) => r.actor_id === null)).toBe(true);
    expect(rows[2].metadata).toMatchObject({ external: true, decision: 'Approved with conditions' });
  });
});
