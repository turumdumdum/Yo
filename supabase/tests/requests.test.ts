import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createUser, pool, resetDatabase } from './db';

// Request rules inside one organization: drafts are private, submission is backend-only.

let admin: string;
let manager: string;
let requester: string;
let colleague: string; // another requester
let auditor: string;
let org: string;
let draft: string;

const answers = JSON.stringify({ serviceName: 'Acme Analytics', requestType: 'New vendor' });

const visibleIds = (userId: string) =>
  asUser(userId, async (c) => (await c.query<{ id: string }>('select id from public.requests')).rows.map((r) => r.id));

const STAGES = JSON.stringify([
  { name: 'License check', status: 'In review', note: null, sla_business_days: 5, sla_due_at: '2026-11-20T15:30:00Z' },
  { name: 'Security review', status: 'In review', note: null, sla_business_days: 5, sla_due_at: '2026-11-20T15:30:00Z' },
  { name: 'Finance review', status: 'Not required', note: 'Not required: Paid or free is Free', sla_business_days: null, sla_due_at: null },
]);

const submit = (requestId: string, stages = STAGES) =>
  asService((c) =>
    c.query(
      `select (public.submit_request($1, $2, 'High', 7, '["Data classification: Confidential (+3)"]', $3)).status`,
      [requestId, answers, stages],
    ),
  );

const visibleStages = (userId: string) =>
  asUser(userId, async (c) => (await c.query('select name, status from public.request_stages order by position')).rows);

beforeAll(async () => {
  await resetDatabase();
  admin = await createUser('admin@a.example');
  manager = await createUser('manager@a.example');
  requester = await createUser('requester@a.example');
  colleague = await createUser('colleague@a.example');
  auditor = await createUser('auditor@a.example');
  org = await asUser(admin, async (c) => {
    const { rows } = await c.query<{ id: string }>(`select public.create_organization('Org A') as id`);
    return rows[0]!.id;
  });
  await pool.query(
    `insert into public.memberships (org_id, user_id, role)
     values ($1, $2, 'process_manager'), ($1, $3, 'requester'), ($1, $4, 'requester'), ($1, $5, 'auditor')`,
    [org, manager, requester, colleague, auditor],
  );
  draft = await asUser(requester, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into public.requests (org_id, answers) values ($1, $2) returning id`,
      [org, answers],
    );
    return rows[0]!.id;
  });
});

afterAll(async () => {
  await pool.end();
});

describe('drafts', () => {
  it('belong to the signed-in user and start as a draft', async () => {
    const { rows } = await pool.query('select requester_id, status, service_name from public.requests where id = $1', [draft]);
    expect(rows[0]).toEqual({ requester_id: requester, status: 'draft', service_name: 'Acme Analytics' });
  });

  it('are visible only to their requester', async () => {
    expect(await visibleIds(requester)).toEqual([draft]);
    for (const other of [admin, manager, colleague, auditor]) {
      expect(await visibleIds(other)).toEqual([]);
    }
  });

  it('can be autosaved by the requester and by nobody else', async () => {
    const save = (userId: string) =>
      asUser(userId, (c) =>
        c.query(`update public.requests set answers = answers || '{"vendorName": "Acme Inc."}' where id = $1`, [draft]),
      );
    expect((await save(requester)).rowCount).toBe(1);
    for (const other of [admin, colleague]) {
      expect((await save(other)).rowCount).toBe(0);
    }
  });

  it('cannot be created for someone else or with a chosen status or risk tier', async () => {
    for (const columns of [
      `(org_id, requester_id) values ('${org}', '${admin}')`,
      `(org_id, status) values ('${org}', 'submitted')`,
      `(org_id, risk_tier) values ('${org}', 'Low')`,
    ]) {
      await expect(asUser(requester, (c) => c.query(`insert into public.requests ${columns}`))).rejects.toThrow(
        /permission denied/,
      );
    }
  });

  it('cannot be submitted or re-scored from the browser', async () => {
    for (const change of [`status = 'submitted'`, `risk_tier = 'Low'`, `risk_score = 0`, `requester_id = '${admin}'`]) {
      await expect(
        asUser(requester, (c) => c.query(`update public.requests set ${change} where id = $1`, [draft])),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      asUser(requester, (c) => c.query(`select public.submit_request($1, '{}', 'Low', 0, '[]', '[]')`, [draft])),
    ).rejects.toThrow(/permission denied/);
  });

  it('cannot be started by the read-only auditor', async () => {
    await expect(
      asUser(auditor, (c) => c.query(`insert into public.requests (org_id) values ($1)`, [org])),
    ).rejects.toThrow(/row-level security/);
  });

  it('reject answers that are not an object or are too large', async () => {
    await expect(
      asUser(requester, (c) => c.query(`update public.requests set answers = '[]' where id = $1`, [draft])),
    ).rejects.toThrow(/check constraint/);
    // Random text so that compression cannot shrink it below the limit.
    await expect(
      asUser(requester, (c) =>
        c.query(
          `update public.requests
           set answers = jsonb_build_object('purpose', (select string_agg(md5(i::text), '') from generate_series(1, 4000) i))
           where id = $1`,
          [draft],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('can be deleted by the requester only', async () => {
    const extra = await asUser(colleague, async (c) => {
      const { rows } = await c.query<{ id: string }>(`insert into public.requests (org_id) values ($1) returning id`, [org]);
      return rows[0]!.id;
    });
    const byAdmin = await asUser(admin, (c) => c.query('delete from public.requests where id = $1', [extra]));
    const byOwner = await asUser(colleague, (c) => c.query('delete from public.requests where id = $1', [extra]));
    expect(byAdmin.rowCount).toBe(0);
    expect(byOwner.rowCount).toBe(1);
  });
});

describe('submitted requests', () => {
  beforeAll(async () => {
    await submit(draft);
  });

  it('carry the triage result and are recorded in the audit log', async () => {
    const { rows } = await pool.query(
      'select status, request_type, risk_tier, risk_score, submitted_at is not null as stamped from public.requests where id = $1',
      [draft],
    );
    expect(rows[0]).toEqual({ status: 'in_review', request_type: 'New vendor', risk_tier: 'High', risk_score: 7, stamped: true });
    const audit = await pool.query(
      `select actor_id, metadata from public.audit_log where action = 'request.submitted' and entity_id = $1`,
      [draft],
    );
    expect(audit.rows).toEqual([
      {
        actor_id: requester,
        metadata: { risk_tier: 'High', risk_score: 7, stages: ['License check', 'Security review'] },
      },
    ]);
  });

  it('start their review stages in the same step, in order', async () => {
    const { rows } = await pool.query(
      `select position, name, status, note, sla_business_days, sla_due_at, org_id = $2 as same_org
       from public.request_stages where request_id = $1 order by position`,
      [draft, org],
    );
    expect(rows).toEqual([
      { position: 1, name: 'License check', status: 'In review', note: null, sla_business_days: 5, sla_due_at: new Date('2026-11-20T15:30:00Z'), same_org: true },
      { position: 2, name: 'Security review', status: 'In review', note: null, sla_business_days: 5, sla_due_at: new Date('2026-11-20T15:30:00Z'), same_org: true },
      { position: 3, name: 'Finance review', status: 'Not required', note: 'Not required: Paid or free is Free', sla_business_days: null, sla_due_at: null, same_org: true },
    ]);
  });

  it('show their stages to exactly the people who can see the request', async () => {
    for (const viewer of [requester, admin, manager, auditor]) {
      expect((await visibleStages(viewer)).map((s) => s.name)).toEqual(['License check', 'Security review', 'Finance review']);
    }
    expect(await visibleStages(colleague)).toEqual([]);
  });

  it('are not submitted at all when the stages are missing or invalid', async () => {
    const another = await asUser(colleague, async (c) => {
      const { rows } = await c.query<{ id: string }>(`insert into public.requests (org_id, answers) values ($1, $2) returning id`, [org, answers]);
      return rows[0]!.id;
    });
    await expect(submit(another, '[]')).rejects.toThrow(/at least one stage/);
    await expect(submit(another, JSON.stringify([{ name: 'X', status: 'Done' }]))).rejects.toThrow(/check constraint/);
    await expect(
      submit(another, JSON.stringify([{ name: 'X', status: 'In review' }, { name: 'X', status: 'In review' }])),
    ).rejects.toThrow(/duplicate key/);
    const { rows } = await pool.query(
      `select status, (select count(*)::int from public.request_stages s where s.request_id = r.id) as stages
       from public.requests r where id = $1`,
      [another],
    );
    expect(rows[0]).toEqual({ status: 'draft', stages: 0 });
    await pool.query('delete from public.requests where id = $1', [another]);
  });

  it('cannot be submitted twice', async () => {
    await expect(submit(draft)).rejects.toThrow(/not a draft/);
  });

  it('are visible to the requester, org admin, process manager and auditor, not to other requesters', async () => {
    for (const viewer of [requester, admin, manager, auditor]) {
      expect(await visibleIds(viewer)).toEqual([draft]);
    }
    expect(await visibleIds(colleague)).toEqual([]);
  });

  it('can no longer be edited or deleted from the browser, even by the requester', async () => {
    for (const userId of [requester, admin]) {
      const update = await asUser(userId, (c) =>
        c.query(`update public.requests set answers = '{"serviceName": "Changed"}' where id = $1`, [draft]),
      );
      const del = await asUser(userId, (c) => c.query('delete from public.requests where id = $1', [draft]));
      expect(update.rowCount).toBe(0);
      expect(del.rowCount).toBe(0);
    }
  });
});
