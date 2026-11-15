import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asSession, asUser, createUser, PASSWORD_ONLY, pool, resetDatabase } from './db';

// Attachments: who may add, see and remove files, and the limits on them.

let admin: string;
let reviewer: string;
let otherReviewer: string;
let requester: string;
let colleague: string;
let auditor: string;
let org: string;
let draft: string;

const PDF = 'application/pdf';

const register = (userId: string, requestId: string, over: Partial<{ filename: string; type: string; size: number; kind: string }> = {}) =>
  asUser(userId, async (c) => {
    const { rows } = await c.query<{ r: { id: string; path: string } }>('select public.register_attachment($1, $2, $3, $4, $5) as r', [
      requestId,
      over.filename ?? 'quote.pdf',
      over.type ?? PDF,
      over.size ?? 1000,
      over.kind ?? 'Quote',
    ]);
    return rows[0]!.r;
  });
const complete = (id: string, size = 1000) => asService((c) => c.query('select public.complete_attachment($1, $2)', [id, size]));
const remove = (userId: string, id: string) =>
  asUser(userId, async (c) => (await c.query<{ p: string }>('select public.delete_attachment($1) as p', [id])).rows[0]!.p);
const visible = (userId: string) =>
  asUser(userId, async (c) => (await c.query<{ filename: string }>(`select filename from public.attachments where status = 'uploaded' order by created_at`)).rows.map((r) => r.filename));

beforeAll(async () => {
  await resetDatabase();
  admin = await createUser('admin@a.example');
  reviewer = await createUser('reviewer@a.example');
  otherReviewer = await createUser('other@a.example');
  requester = await createUser('requester@a.example');
  colleague = await createUser('colleague@a.example');
  auditor = await createUser('auditor@a.example');
  org = await asUser(admin, async (c) => (await c.query<{ id: string }>(`select public.create_organization('Org A') as id`)).rows[0]!.id);
  await pool.query(
    `insert into public.memberships (org_id, user_id, role) values
     ($1, $2, 'reviewer'), ($1, $3, 'reviewer'), ($1, $4, 'requester'), ($1, $5, 'requester'), ($1, $6, 'auditor')`,
    [org, reviewer, otherReviewer, requester, colleague, auditor],
  );
  draft = await asUser(requester, async (c) =>
    (await c.query<{ id: string }>(`insert into public.requests (org_id) values ($1) returning id`, [org])).rows[0]!.id,
  );
});

afterAll(async () => {
  await pool.end();
});

describe('on a draft', () => {
  let first: { id: string; path: string };

  it('only the requester can attach files', async () => {
    for (const userId of [admin, reviewer, colleague, auditor]) {
      await expect(register(userId, draft)).rejects.toThrow(/cannot attach files|request not found/);
    }
    await expect(
      asSession(requester, PASSWORD_ONLY, (c) => c.query(`select public.register_attachment($1, 'a.pdf', $2, 10, 'Quote')`, [draft, PDF])),
    ).rejects.toThrow(/multi-factor/);
  });

  it('stores the file under a path made of ids only, with a cleaned name', async () => {
    first = await register(requester, draft, { filename: '..\\..\\evil/Quote 2026.pdf' });
    expect(first.path).toBe(`${org}/${draft}/${first.id}`);
    const { rows } = await pool.query('select filename, status, uploaded_by, storage_path from public.attachments where id = $1', [first.id]);
    expect(rows[0]).toEqual({ filename: 'Quote 2026.pdf', status: 'pending', uploaded_by: requester, storage_path: first.path });
  });

  it('enforces type, size and kind', async () => {
    await expect(register(requester, draft, { type: 'application/x-msdownload' })).rejects.toThrow(/file type is not allowed/);
    await expect(register(requester, draft, { type: 'text/html' })).rejects.toThrow(/file type is not allowed/);
    await expect(register(requester, draft, { size: 0 })).rejects.toThrow(/between 1 byte and 25 MB/);
    await expect(register(requester, draft, { size: 26214401 })).rejects.toThrow(/between 1 byte and 25 MB/);
    await expect(register(requester, draft, { kind: 'Invoice' })).rejects.toThrow(/what kind of document/);
    await expect(register(requester, draft, { filename: '   ' })).rejects.toThrow(/needs a name/);
  });

  it('becomes visible once the backend confirms the upload, which the browser cannot do', async () => {
    await expect(asUser(requester, (c) => c.query('select public.complete_attachment($1, 10)', [first.id]))).rejects.toThrow(
      /permission denied/,
    );
    expect(await visible(requester)).toEqual([]);
    await complete(first.id, 2048);
    expect(await visible(requester)).toEqual(['Quote 2026.pdf']);
    await expect(complete(first.id)).rejects.toThrow(/not pending/);
    const { rows } = await pool.query(`select actor_id, metadata ->> 'size_bytes' as size from public.audit_log where action = 'attachment.uploaded'`);
    expect(rows).toEqual([{ actor_id: requester, size: '2048' }]);
  });

  it('is hidden from everyone else while the request is a draft', async () => {
    for (const userId of [admin, reviewer, colleague, auditor]) expect(await visible(userId)).toEqual([]);
  });

  it('cannot be written directly from the browser', async () => {
    await expect(asUser(requester, (c) => c.query(`update public.attachments set status = 'uploaded'`))).rejects.toThrow(/permission denied/);
    await expect(asUser(requester, (c) => c.query(`delete from public.attachments`))).rejects.toThrow(/permission denied/);
  });

  it('allows at most 20 files, not counting abandoned uploads', async () => {
    const extra = await asUser(requester, async (c) =>
      (await c.query<{ id: string }>(`insert into public.requests (org_id) values ($1) returning id`, [org])).rows[0]!.id,
    );
    for (let i = 0; i < 20; i++) await register(requester, extra, { filename: `f${i}.pdf` });
    await expect(register(requester, extra)).rejects.toThrow(/at most 20 files/);
    await pool.query(`update public.attachments set created_at = now() - interval '2 hours' where request_id = $1`, [extra]);
    await register(requester, extra);
    await pool.query('delete from public.requests where id = $1', [extra]);
  });

  it('can be removed by the person who added it, and by nobody else', async () => {
    const second = await register(requester, draft, { filename: 'draft-contract.pdf', kind: 'Contract draft' });
    await complete(second.id);
    await expect(remove(admin, second.id)).rejects.toThrow(/only the person who added|attachment not found/);
    expect(await remove(requester, second.id)).toBe(second.path);
    expect(await visible(requester)).toEqual(['Quote 2026.pdf']);
    const { rows } = await pool.query(`select actor_id from public.audit_log where action = 'attachment.deleted'`);
    expect(rows).toEqual([{ actor_id: requester }]);
  });
});

describe('after submission', () => {
  let securityStage: string;
  let uploadedByReviewer: string;

  beforeAll(async () => {
    const stages = [{ name: 'Security review', status: 'In review', sla_business_days: 5, sla_due_at: '2026-11-20T00:00:00Z', checklist: [] }];
    await asService((c) => c.query(`select public.submit_request($1, '{}', 'High', 7, '[]', $2)`, [draft, JSON.stringify(stages)]));
    securityStage = (await pool.query('select id from public.request_stages where request_id = $1', [draft])).rows[0].id;
    await asUser(admin, (c) => c.query('select public.assign_stage_reviewer($1, $2)', [securityStage, reviewer]));
  });

  it('files are visible to everyone who can see the request', async () => {
    for (const userId of [requester, admin, reviewer, auditor]) expect(await visible(userId)).toEqual(['Quote 2026.pdf']);
    for (const userId of [colleague, otherReviewer]) expect(await visible(userId)).toEqual([]);
  });

  it('the requester, managers and the assigned reviewer can add files', async () => {
    const a = await register(requester, draft, { filename: 'dpa.pdf', kind: 'DPA' });
    const b = await register(admin, draft, { filename: 'notes.txt', type: 'text/plain', kind: 'Other' });
    const c = await register(reviewer, draft, { filename: 'soc2.pdf', kind: 'SOC 2 / ISO report' });
    for (const x of [a, b, c]) await complete(x.id);
    uploadedByReviewer = c.id;
    expect(await visible(requester)).toEqual(['Quote 2026.pdf', 'dpa.pdf', 'notes.txt', 'soc2.pdf']);
    for (const userId of [otherReviewer, colleague, auditor]) {
      await expect(register(userId, draft)).rejects.toThrow(/cannot attach files|request not found/);
    }
  });

  it('uploaded files can no longer be removed, only an unfinished upload', async () => {
    await expect(remove(reviewer, uploadedByReviewer)).rejects.toThrow(/cannot be removed after the request was submitted/);
    const unfinished = await register(reviewer, draft, { filename: 'half.pdf' });
    expect(await remove(reviewer, unfinished.id)).toBe(unfinished.path);
  });

  it('nothing is added once the request is decided', async () => {
    await asUser(reviewer, (c) => c.query(`select public.decide_stage($1, 'Rejected', 'No', null)`, [securityStage]));
    for (const userId of [requester, admin, reviewer]) {
      await expect(register(userId, draft)).rejects.toThrow(/cannot attach files/);
    }
    expect(await visible(requester)).toHaveLength(4);
  });
});
