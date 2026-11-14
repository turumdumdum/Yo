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

const submit = (requestId: string) =>
  asService((c) =>
    c.query(`select (public.submit_request($1, $2, 'High', 7, '["Data classification: Confidential (+3)"]')).status`, [
      requestId,
      answers,
    ]),
  );

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
  await asUser(admin, (c) =>
    c.query(
      `insert into public.memberships (org_id, user_id, role)
       values ($1, $2, 'process_manager'), ($1, $3, 'requester'), ($1, $4, 'requester'), ($1, $5, 'auditor')`,
      [org, manager, requester, colleague, auditor],
    ),
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
      asUser(requester, (c) => c.query(`select public.submit_request($1, '{}', 'Low', 0, '[]')`, [draft])),
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
    expect(rows[0]).toEqual({ status: 'submitted', request_type: 'New vendor', risk_tier: 'High', risk_score: 7, stamped: true });
    const audit = await pool.query(
      `select actor_id, metadata from public.audit_log where action = 'request.submitted' and entity_id = $1`,
      [draft],
    );
    expect(audit.rows).toEqual([{ actor_id: requester, metadata: { risk_tier: 'High', risk_score: 7 } }]);
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
