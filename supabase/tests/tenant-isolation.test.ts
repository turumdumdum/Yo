import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asAnon, asUser, createUser, pool, resetDatabase } from './db';

// Proves that org A cannot read or write org B's data (CLAUDE.md §8).
// Every new tenant table must be added to TENANT_TABLES and get its own cases here.

/** The organization column of a table, readable by every signed-in member. */
const column = (table: string) => (table === 'organizations' ? 'id' : 'org_id');

const TENANT_TABLES = ['organizations', 'memberships', 'invitations', 'verified_domains', 'audit_log', 'requests', 'request_stages', 'review_templates', 'info_requests', 'attachments', 'request_form_templates', 'request_viewers', 'workflow_settings', 'ai_settings'];

let adminA: string; // org admin of org A
let requesterA: string; // requester in org A
let auditorA: string; // auditor in org A
let adminB: string; // org admin of org B
let outsider: string; // signed in, member of nothing
let orgA: string;
let orgB: string;

beforeAll(async () => {
  await resetDatabase();
  // Isolation needs two organizations: run as the hosted, multi-tenant deployment.
  await pool.query('update private.installation_settings set single_organization = false');

  adminA = await createUser('admin@a.example');
  requesterA = await createUser('requester@a.example');
  auditorA = await createUser('auditor@a.example');
  adminB = await createUser('admin@b.example');
  outsider = await createUser('outsider@c.example');

  const create = (userId: string, name: string) =>
    asUser(userId, async (c) => {
      const { rows } = await c.query<{ id: string }>('select public.create_organization($1) as id', [name]);
      return rows[0]!.id;
    });
  orgA = await create(adminA, 'Org A');
  orgB = await create(adminB, 'Org B');

  // Members normally join through an invitation (see admin.test.ts).
  await pool.query(
    `insert into public.memberships (org_id, user_id, role) values ($1, $2, 'requester'), ($1, $3, 'auditor')`,
    [orgA, requesterA, auditorA],
  );

  // Rows that only the backend can create.
  await pool.query(
    `insert into public.invitations (org_id, email, role, token_hash, expires_at)
     values ($1, 'new@a.example', 'requester', 'hash-a', now() + interval '7 days'),
            ($2, 'new@b.example', 'requester', 'hash-b', now() + interval '7 days')`,
    [orgA, orgB],
  );
  await pool.query(
    `insert into public.verified_domains (org_id, domain, verified_at)
     values ($1, 'a.example', now()), ($2, 'b.example', now())`,
    [orgA, orgB],
  );
  // One submitted request per organization; request rules are covered in requests.test.ts.
  await pool.query(
    `insert into public.requests (org_id, requester_id, status, answers, risk_tier, risk_score, submitted_at)
     values ($1, $2, 'submitted', '{"serviceName": "Tool A"}', 'Low', 0, now()),
            ($3, $4, 'submitted', '{"serviceName": "Tool B"}', 'Low', 0, now())`,
    [orgA, adminA, orgB, adminB],
  );
  await pool.query(
    `insert into public.request_stages (org_id, request_id, position, name, status)
     select r.org_id, r.id, 1, 'License check', 'In review' from public.requests r`,
  );
  await pool.query(
    `insert into public.info_requests (org_id, request_id, stage_id, question)
     select s.org_id, s.request_id, s.id, 'Which plan?' from public.request_stages s`,
  );
  await pool.query(
    `insert into public.request_form_templates (org_id, name, definition) values ($1, 'Form', '{"steps": []}'), ($2, 'Form', '{"steps": []}')`,
    [orgA, orgB],
  );
  await pool.query(
    `insert into public.attachments (org_id, request_id, kind, filename, content_type, size_bytes, storage_path, status)
     select r.org_id, r.id, 'Quote', 'quote.pdf', 'application/pdf', 10, r.org_id || '/' || r.id || '/seed', 'uploaded'
     from public.requests r`,
  );
  await pool.query(
    `insert into public.review_templates (org_id, stage_name, fields) values ($1, 'Security review', '[]'), ($2, 'Security review', '[]')`,
    [orgA, orgB],
  );
  await pool.query(
    `insert into public.request_viewers (org_id, request_id, user_id, reason) select r.org_id, r.id, r.requester_id, 'added' from public.requests r`,
  );
  await pool.query(`insert into public.workflow_settings (org_id, stages) values ($1, '{}'), ($2, '{}')`, [orgA, orgB]);
  await pool.query(`insert into public.ai_settings (org_id, check_settings) values ($1, '{}'), ($2, '{}')`, [orgA, orgB]);
});

afterAll(async () => {
  await pool.end();
});

describe('schema guard', () => {
  it('has RLS enabled on every table in the public schema', async () => {
    const { rows } = await pool.query<{ relname: string }>(
      `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it('lists every public table in TENANT_TABLES so each one gets isolation cases', async () => {
    const { rows } = await pool.query<{ relname: string }>(
      `select c.relname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`,
    );
    expect(rows.map((r) => r.relname)).toEqual([...TENANT_TABLES].sort());
  });
});

describe('reads', () => {
  it.each(TENANT_TABLES)('org A admin sees only org A rows in %s', async (table) => {
    const rows = await asUser(adminA, async (c) => (await c.query(`select ${column(table)} as org from public.${table}`)).rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.org))).toEqual(new Set([orgA]));
  });

  it.each(TENANT_TABLES)('a signed-in user without a membership sees nothing in %s', async (table) => {
    const rows = await asUser(outsider, async (c) => (await c.query(`select ${column(table)} from public.${table}`)).rows);
    expect(rows).toEqual([]);
  });

  it.each(TENANT_TABLES)('a visitor without a session cannot read %s', async (table) => {
    await expect(asAnon((c) => c.query(`select ${column(table)} from public.${table}`))).rejects.toThrow(/permission denied/);
  });

  it('cannot create an organization without a session', async () => {
    await expect(asAnon((c) => c.query(`select public.create_organization('Nope')`))).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('cross-tenant writes', () => {
  it('org A admin cannot rename org B', async () => {
    const result = await asUser(adminA, (c) =>
      c.query(`update public.organizations set name = 'Hacked' where id = $1`, [orgB]),
    );
    expect(result.rowCount).toBe(0);
    const { rows } = await pool.query('select name from public.organizations where id = $1', [orgB]);
    expect(rows[0].name).toBe('Org B');
  });

  it('org A admin cannot add themselves or anyone else to org B', async () => {
    for (const userId of [adminA, outsider]) {
      await expect(
        asUser(adminA, (c) =>
          c.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'org_admin')`, [
            orgB,
            userId,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it('org A admin cannot change or remove org B memberships', async () => {
    const update = await asUser(adminA, (c) =>
      c.query(`update public.memberships set role = 'requester' where org_id = $1`, [orgB]),
    );
    const del = await asUser(adminA, (c) => c.query(`delete from public.memberships where org_id = $1`, [orgB]));
    expect(update.rowCount).toBe(0);
    expect(del.rowCount).toBe(0);
  });

  it('org A admin cannot move a membership into org B', async () => {
    await expect(
      asUser(adminA, (c) =>
        c.query(`update public.memberships set org_id = $1 where org_id = $2 and user_id = $3`, [
          orgB,
          orgA,
          requesterA,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('org A admin cannot add or remove verified domains of org B', async () => {
    await expect(
      asUser(adminA, (c) =>
        c.query(`insert into public.verified_domains (org_id, domain) values ($1, 'evil.example')`, [orgB]),
      ),
    ).rejects.toThrow(/row-level security/);
    const del = await asUser(adminA, (c) => c.query(`delete from public.verified_domains where org_id = $1`, [orgB]));
    expect(del.rowCount).toBe(0);
  });

  it('org A admin cannot create, change or delete requests in org B', async () => {
    await expect(
      asUser(adminA, (c) => c.query(`insert into public.requests (org_id, answers) values ($1, '{}')`, [orgB])),
    ).rejects.toThrow(/row-level security/);
    const update = await asUser(adminA, (c) =>
      c.query(`update public.requests set answers = '{"serviceName": "Hacked"}' where org_id = $1`, [orgB]),
    );
    const del = await asUser(adminA, (c) => c.query(`delete from public.requests where org_id = $1`, [orgB]));
    expect(update.rowCount).toBe(0);
    expect(del.rowCount).toBe(0);
  });

  it('nobody can write request stages from the browser', async () => {
    for (const sql of [
      `insert into public.request_stages (org_id, request_id, position, name, status)
       select org_id, id, 2, 'Fake', 'Approved' from public.requests`,
      `update public.request_stages set status = 'Approved'`,
      `delete from public.request_stages`,
    ]) {
      await expect(asUser(adminA, (c) => c.query(sql))).rejects.toThrow(/permission denied/);
    }
  });

  it('org A admin cannot revoke org B invitations', async () => {
    const del = await asUser(adminA, (c) => c.query(`delete from public.invitations where org_id = $1`, [orgB]));
    expect(del.rowCount).toBe(0);
  });
});

describe('least privilege inside one organization', () => {
  it('a requester cannot change the organization, memberships or domains', async () => {
    const rename = await asUser(requesterA, (c) =>
      c.query(`update public.organizations set name = 'Mine now' where id = $1`, [orgA]),
    );
    expect(rename.rowCount).toBe(0);

    const promote = await asUser(requesterA, (c) =>
      c.query(`update public.memberships set role = 'org_admin' where org_id = $1 and user_id = $2`, [
        orgA,
        requesterA,
      ]),
    );
    expect(promote.rowCount).toBe(0);

    // Nobody adds members directly, not even the org admin: people join by invitation.
    for (const userId of [requesterA, adminA]) {
      await expect(
        asUser(userId, (c) =>
          c.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'reviewer')`, [
            orgA,
            outsider,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
    }

    await expect(
      asUser(requesterA, (c) =>
        c.query(`insert into public.verified_domains (org_id, domain) values ($1, 'x.example')`, [orgA]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('a requester sees colleagues but not invitations or the audit log', async () => {
    const counts = await asUser(requesterA, async (c) => ({
      memberships: (await c.query('select 1 from public.memberships')).rowCount,
      invitations: (await c.query('select 1 from public.invitations')).rowCount,
      audit: (await c.query('select 1 from public.audit_log')).rowCount,
    }));
    expect(counts).toEqual({ memberships: 3, invitations: 0, audit: 0 });
  });

  it('an auditor can read the audit log of their own organization only', async () => {
    const rows = await asUser(auditorA, async (c) => (await c.query('select org_id from public.audit_log')).rows);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.org_id))).toEqual(new Set([orgA]));
  });

  it('nobody can create invitations or mark a domain verified from the browser', async () => {
    await expect(
      asUser(adminA, (c) =>
        c.query(
          `insert into public.invitations (org_id, email, role, token_hash, expires_at)
           values ($1, 'x@a.example', 'requester', 'h', now() + interval '1 day')`,
          [orgA],
        ),
      ),
    ).rejects.toThrow(/permission denied/);

    await expect(
      asUser(adminA, (c) =>
        c.query(`insert into public.verified_domains (org_id, domain, verified_at) values ($1, 'x.example', now())`, [
          orgA,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);

    await expect(
      asUser(adminA, (c) => c.query(`update public.verified_domains set verified_at = now() where org_id = $1`, [orgA])),
    ).rejects.toThrow(/permission denied/);
  });

  it('an org admin can add an unverified domain to their own organization', async () => {
    await asUser(adminA, (c) =>
      c.query(`insert into public.verified_domains (org_id, domain) values ($1, 'pending.a.example')`, [orgA]),
    );
    const { rows } = await pool.query(
      `select verified_at from public.verified_domains where domain = 'pending.a.example'`,
    );
    expect(rows).toEqual([{ verified_at: null }]);
  });

  it('keeps at least one org admin', async () => {
    await expect(
      asUser(adminA, (c) =>
        c.query(`update public.memberships set role = 'requester' where org_id = $1 and user_id = $2`, [orgA, adminA]),
      ),
    ).rejects.toThrow(/at least one org admin/);
    await expect(
      asUser(adminA, (c) => c.query(`delete from public.memberships where org_id = $1 and user_id = $2`, [orgA, adminA])),
    ).rejects.toThrow(/at least one org admin/);
  });
});

describe('audit log', () => {
  it('records organization creation and role changes with the acting user', async () => {
    await asUser(adminA, (c) =>
      c.query(`update public.memberships set role = 'reviewer' where org_id = $1 and user_id = $2`, [orgA, requesterA]),
    );
    const { rows } = await pool.query(
      `select action, actor_id, metadata from public.audit_log
       where org_id = $1 and (action like 'organization.%' or action like 'membership.%') order by id`,
      [orgA],
    );
    expect(rows.map((r) => r.action)).toEqual([
      'organization.created',
      'membership.created',
      'membership.created',
      'membership.created',
      'membership.role_changed',
    ]);
    // The two members were added by the test set-up, outside any session.
    expect(rows.map((r) => r.actor_id)).toEqual([adminA, adminA, null, null, adminA]);
    expect(rows.at(-1)!.metadata).toEqual({ from: 'requester', to: 'reviewer' });
  });

  it('cannot be written from the browser', async () => {
    await expect(
      asUser(adminA, (c) =>
        c.query(`insert into public.audit_log (org_id, action, entity_type) values ($1, 'fake', 'x')`, [orgA]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('is append-only even for the table owner', async () => {
    await expect(pool.query(`update public.audit_log set action = 'edited'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`delete from public.audit_log`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`truncate public.audit_log`)).rejects.toThrow(/append-only/);
  });
});
