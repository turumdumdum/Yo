import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createUser, pool, resetDatabase } from './db';

// Review scope (which reviews a member may work on) and the admin's "view as" preview.

let admin: string;
let admin2: string;
let manager: string;
let auditor: string;
let reviewer: string;
let requester: string;
let viewer: string;
let adminB: string;
let org: string;
let open: string;
let secret: string;
let draft: string;
let trashed: string;
let securityStage: string;
let licenseStage: string;

const STAGES = (names: string[]) =>
  JSON.stringify(names.map((name) => ({ name, status: 'In review', sla_business_days: 5, sla_due_at: '2026-12-01T00:00:00Z', checklist: ['Read the terms'] })));

async function newRequest(confidential = false): Promise<string> {
  const id = await asUser(requester, async (c) =>
    (await c.query<{ id: string }>(`insert into public.requests (org_id, answers) values ($1, '{"serviceName": "X"}') returning id`, [org])).rows[0]!.id,
  );
  await asService((c) => c.query('select public.set_request_confidentiality($1, $2, null)', [id, confidential]));
  await asService((c) => c.query(`select public.submit_request($1, '{}', 'High', 7, '[]', $2)`, [id, STAGES(['License check', 'Security review'])]));
  return id;
}

const scope = (userId: string, target: string, stages: string[] | null) =>
  asUser(userId, (c) => c.query('select public.set_member_review_scope($1, $2, $3)', [org, target, stages]));
const scopeOf = async (userId: string) =>
  (await pool.query('select review_scope from public.memberships where org_id = $1 and user_id = $2', [org, userId])).rows[0].review_scope;
const visible = (userId: string) =>
  asUser(userId, async (c) => (await c.query<{ id: string }>('select id from public.requests')).rows.map((r) => r.id).sort());
const preview = (userId: string, target: string) =>
  asUser(userId, async (c) => (await c.query<{ request_id: string }>('select request_id from public.preview_visible_requests($1)', [target])).rows.map((r) => r.request_id).sort());

beforeAll(async () => {
  await resetDatabase();
  await pool.query('update private.installation_settings set single_organization = false');
  admin = await createUser('admin@a.example');
  admin2 = await createUser('admin2@a.example');
  manager = await createUser('manager@a.example');
  auditor = await createUser('auditor@a.example');
  reviewer = await createUser('reviewer@a.example');
  requester = await createUser('requester@a.example');
  viewer = await createUser('viewer@a.example');
  adminB = await createUser('admin@b.example');
  org = await asUser(admin, async (c) => (await c.query<{ id: string }>(`select public.create_organization('Org A') as id`)).rows[0]!.id);
  await asUser(adminB, (c) => c.query(`select public.create_organization('Org B')`));
  await pool.query(
    `insert into public.memberships (org_id, user_id, role) values
       ($1, $2, 'org_admin'), ($1, $3, 'process_manager'), ($1, $4, 'auditor'), ($1, $5, 'reviewer'), ($1, $6, 'requester'), ($1, $7, 'requester')`,
    [org, admin2, manager, auditor, reviewer, requester, viewer],
  );
  open = await newRequest();
  secret = await newRequest(true);
  await asUser(admin, (c) => c.query('select public.add_request_viewer($1, $2)', [secret, viewer]));
  draft = await asUser(requester, async (c) =>
    (await c.query<{ id: string }>(`insert into public.requests (org_id) values ($1) returning id`, [org])).rows[0]!.id,
  );
  trashed = await newRequest();
  await pool.query(`update public.requests set status = 'approved' where id = $1`, [trashed]);
  await asUser(admin, (c) => c.query('select public.set_request_trashed($1, true)', [trashed]));
  const stages = (await pool.query<{ id: string; name: string }>('select id, name from public.request_stages where request_id = $1', [open])).rows;
  securityStage = stages.find((s) => s.name === 'Security review')!.id;
  licenseStage = stages.find((s) => s.name === 'License check')!.id;
});

afterAll(async () => {
  await pool.end();
});

describe('review scope', () => {
  it('is set and cleared by org admins only, through the RPC, and audited', async () => {
    await expect(scope(manager, reviewer, ['Security review'])).rejects.toThrow(/only an org admin/);
    await expect(scope(reviewer, reviewer, ['Security review'])).rejects.toThrow(/only an org admin/);
    await expect(asUser(admin, (c) => c.query(`update public.memberships set review_scope = '{"Security review"}' where user_id = $1`, [reviewer]))).rejects.toThrow(
      /permission denied/,
    );
    await expect(scope(admin, reviewer, ['Security review', 'Security review'])).rejects.toThrow(/each once/);
    await expect(scope(admin, reviewer, ['Marketing review'])).rejects.toThrow(/each once/);
    await expect(scope(admin, adminB, ['Security review'])).rejects.toThrow(/member not found/);

    await scope(admin, admin2, ['Security review']); // admins may be limited too
    expect(await scopeOf(admin2)).toEqual(['Security review']);
    await scope(admin, admin2, []);
    expect(await scopeOf(admin2)).toBeNull();
    await scope(admin, reviewer, ['Security review']);
    expect(await scopeOf(reviewer)).toEqual(['Security review']);
    // Members still read the column like the rest of memberships.
    const seen = await asUser(requester, async (c) => (await c.query('select review_scope from public.memberships where user_id = $1', [reviewer])).rows[0].review_scope);
    expect(seen).toEqual(['Security review']);
    const audit = (await pool.query(`select metadata from public.audit_log where action = 'member.review_scope_changed' order by id`)).rows;
    expect(audit.at(-1).metadata).toEqual({ user_id: reviewer, stages: ['Security review'] });
    expect(audit.some((r) => r.metadata.stages === null)).toBe(true);
  });

  it('decides which reviewers can be assigned', async () => {
    await expect(asUser(admin, (c) => c.query('select public.assign_stage_reviewer($1, $2)', [licenseStage, reviewer]))).rejects.toThrow(
      /the reviewer cannot work on this review/,
    );
    await asUser(admin, (c) => c.query('select public.assign_stage_reviewer($1, $2)', [securityStage, reviewer]));
  });

  it('limits what a reviewer or manager can do', async () => {
    await asUser(reviewer, (c) => c.query('select public.set_stage_checklist_item($1, 0, true)', [securityStage]));
    await scope(admin, manager, ['Security review']);
    await expect(asUser(manager, (c) => c.query('select public.set_stage_checklist_item($1, 0, true)', [licenseStage]))).rejects.toThrow(
      /outside your review scope/,
    );
    await expect(asUser(manager, (c) => c.query(`select public.decide_stage($1, 'Approved', null, null)`, [licenseStage]))).rejects.toThrow(
      /outside your review scope/,
    );
    await asUser(manager, (c) => c.query('select public.set_stage_checklist_item($1, 0, true)', [securityStage]));
    await scope(admin, manager, null);
    await asUser(manager, (c) => c.query('select public.set_stage_checklist_item($1, 0, true)', [licenseStage]));
  });
});

describe('view as', () => {
  it('shows each member exactly what the database lets them see', async () => {
    for (const member of [requester, reviewer, manager, auditor, viewer, admin2]) {
      expect(await preview(admin, member)).toEqual(await visible(member));
    }
    // Spot checks of the cases the comparison covers.
    expect(await preview(admin, requester)).toEqual([open, secret, draft].sort());
    expect(await preview(admin, viewer)).toEqual([secret]);
    expect(await preview(admin, manager)).toEqual([open]);
    expect(await preview(admin, admin2)).toEqual([open, secret, trashed].sort());
    expect(await preview(admin, reviewer)).toEqual([open]);
  });

  it('is for org admins of the member’s organization, and audited', async () => {
    await expect(preview(manager, requester)).rejects.toThrow(/only an org admin/);
    await expect(preview(requester, requester)).rejects.toThrow(/only an org admin/);
    await expect(preview(adminB, requester)).rejects.toThrow(/only an org admin/);
    await expect(asUser(admin, (c) => c.query('select * from public.preview_visible_requests($1)', [adminB]))).rejects.toThrow(/only an org admin/);
    const n = (await pool.query(`select count(*)::int as n from public.audit_log where action = 'member.previewed'`)).rows[0].n;
    expect(n).toBeGreaterThanOrEqual(11);
  });
});
