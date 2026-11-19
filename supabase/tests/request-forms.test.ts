import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asService, asUser, createUser, pool, resetDatabase } from './db';

// Request form templates: who can see them, and how a draft gets its form.

let admin: string;
let manager: string;
let requester: string;
let org: string;

const form = (title: string) => ({ steps: [{ title, fields: [] }] });
const newDraft = (userId: string) =>
  asUser(userId, async (c) => (await c.query<{ id: string }>(`insert into public.requests (org_id) values ($1) returning id`, [org])).rows[0]!.id);
const formOf = async (requestId: string) => (await pool.query('select form from public.requests where id = $1', [requestId])).rows[0].form;

beforeAll(async () => {
  await resetDatabase();
  admin = await createUser('admin@a.example');
  manager = await createUser('manager@a.example');
  requester = await createUser('requester@a.example');
  org = await asUser(admin, async (c) => (await c.query<{ id: string }>(`select public.create_organization('Org A') as id`)).rows[0]!.id);
  await pool.query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'process_manager'), ($1, $3, 'requester')`, [
    org,
    manager,
    requester,
  ]);
});

afterAll(async () => {
  await pool.end();
});

describe('request form templates', () => {
  it('give drafts the standard form (null) while none is active', async () => {
    await asService((c) =>
      c.query(`insert into public.request_form_templates (org_id, name, definition) values ($1, 'Short form', $2)`, [org, form('Short')]),
    );
    expect(await formOf(await newDraft(requester))).toBeNull();
  });

  it('copy the active form into each new draft, which keeps it when the template changes', async () => {
    await asService((c) => c.query(`update public.request_form_templates set is_active = true where name = 'Short form'`));
    const draft = await newDraft(requester);
    expect(await formOf(draft)).toEqual(form('Short'));
    await asService((c) => c.query(`update public.request_form_templates set definition = $1 where name = 'Short form'`, [form('Changed')]));
    expect(await formOf(draft)).toEqual(form('Short'));
    expect(await formOf(await newDraft(requester))).toEqual(form('Changed'));
  });

  it('cannot be chosen or changed by the requester', async () => {
    const draft = await newDraft(requester);
    await expect(
      asUser(requester, (c) => c.query(`update public.requests set form = '{"steps": []}' where id = $1`, [draft])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asUser(requester, (c) => c.query(`insert into public.requests (org_id, form) values ($1, '{"steps": []}')`, [org])),
    ).rejects.toThrow(/permission denied/);
  });

  it('allow only one active form per organization', async () => {
    await asService((c) =>
      c.query(`insert into public.request_form_templates (org_id, name, definition) values ($1, 'Long form', $2)`, [org, form('Long')]),
    );
    await expect(asService((c) => c.query(`update public.request_form_templates set is_active = true where name = 'Long form'`))).rejects.toThrow(
      /duplicate key/,
    );
  });

  it('switch the active form in one step, also back to the standard form', async () => {
    const active = async () =>
      (await pool.query<{ name: string }>('select name from public.request_form_templates where is_active')).rows.map((r) => r.name);
    const longId = (await pool.query(`select id from public.request_form_templates where name = 'Long form'`)).rows[0].id;
    const activate = (id: string | null, orgId = org) =>
      asService(async (c) => (await c.query<{ ok: boolean }>('select public.activate_request_form($1, $2) as ok', [orgId, id])).rows[0]!.ok);
    expect(await activate(longId)).toBe(true);
    expect(await active()).toEqual(['Long form']);
    expect(await activate(null)).toBe(true);
    expect(await active()).toEqual([]);
    // A form of another organization is not found.
    expect(await activate(longId, '00000000-0000-4000-8000-000000000000')).toBe(false);
    await expect(asUser(admin, (c) => c.query('select public.activate_request_form($1, $2)', [org, longId]))).rejects.toThrow(/permission denied/);
    await activate(longId);
  });

  it('name the request after the question the form chooses', async () => {
    const title = async (id: string) => (await pool.query('select service_name from public.requests where id = $1', [id])).rows[0].service_name;
    const save = (id: string, answers: object) =>
      asUser(requester, (c) => c.query('update public.requests set answers = $1 where id = $2', [answers, id]));
    await asService((c) =>
      c.query(`update public.request_form_templates set definition = $1 where name = 'Short form'`, [{ ...form('Titled'), titleField: 'tool' }]),
    );
    const shortId = (await pool.query(`select id from public.request_form_templates where name = 'Short form'`)).rows[0].id;
    await asService((c) => c.query('select public.activate_request_form($1, $2)', [org, shortId]));
    const custom = await newDraft(requester);
    await save(custom, { tool: '  Acme Board  ', serviceName: 'ignored' });
    expect(await title(custom)).toBe('Acme Board');
    await save(custom, { tool: '' });
    expect(await title(custom)).toBeNull();
    // Without titleField (the standard form and forms saved earlier) serviceName names it.
    await asService((c) => c.query('select public.activate_request_form($1, null)', [org]));
    const standard = await newDraft(requester);
    await save(standard, { serviceName: 'Figma' });
    expect(await title(standard)).toBe('Figma');
    await expect(
      asUser(requester, (c) => c.query(`update public.requests set service_name = 'Forged' where id = $1`, [standard])),
    ).rejects.toThrow(/permission denied/);
  });

  it('are visible to org admins and process managers only', async () => {
    const names = (userId: string) =>
      asUser(userId, async (c) => (await c.query<{ name: string }>('select name from public.request_form_templates order by name')).rows.map((r) => r.name));
    expect(await names(admin)).toEqual(['Long form', 'Short form']);
    expect(await names(manager)).toEqual(['Long form', 'Short form']);
    expect(await names(requester)).toEqual([]);
  });

  it('cannot be written from the browser', async () => {
    await expect(
      asUser(admin, (c) => c.query(`insert into public.request_form_templates (org_id, name, definition) values ($1, 'X', '{"steps": []}')`, [org])),
    ).rejects.toThrow(/permission denied/);
    await expect(asUser(admin, (c) => c.query(`update public.request_form_templates set is_active = false`))).rejects.toThrow(/permission denied/);
  });
});
