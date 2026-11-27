import { beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createUser, pool, resetDatabase } from './db';

// When an organization turns every review off, a submitted request is approved at once.

let admin: string;
let requester: string;
let org: string;

async function draft(): Promise<string> {
  return asUser(requester, async (c) =>
    (await c.query<{ id: string }>(`insert into public.requests (org_id, answers) values ($1, '{"serviceName": "Tool"}') returning id`, [org])).rows[0]!.id,
  );
}
const submit = (id: string, stages: unknown[]) =>
  asService(async (c) => (await c.query<{ status: string }>(`select status from public.submit_request($1, '{"serviceName": "Tool"}', 'Low', 0, '[]', $2)`, [id, JSON.stringify(stages)])).rows[0]!.status);
const off = (name: string) => ({ name, status: 'Not required', note: 'Not required: turned off by your organization', checklist: [] });

beforeAll(async () => {
  await resetDatabase();
  admin = await createUser('admin@a.example');
  requester = await createUser('requester@a.example');
  org = await asUser(admin, async (c) => (await c.query<{ id: string }>(`select public.create_organization('Org A') as id`)).rows[0]!.id);
  await pool.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'requester')`, [org, requester]);
});

describe('submission without any review', () => {
  it('approves the request and says why in the audit log', async () => {
    const id = await draft();
    expect(await submit(id, [off('License check'), off('Security review')])).toBe('approved');
    const audit = await pool.query<{ metadata: { reason: string } }>(`select metadata from public.audit_log where entity_id = $1 and action = 'request.approved'`, [id]);
    expect(audit.rows[0]!.metadata.reason).toBe('no review needed');
  });

  it('keeps a request in review while any review applies', async () => {
    const id = await draft();
    expect(await submit(id, [off('License check'), { name: 'IT review', status: 'In review', sla_business_days: 5, sla_due_at: '2026-12-01T00:00:00Z', checklist: [] }])).toBe('in_review');
  });
});
