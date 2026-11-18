import { DEFAULT_REQUEST_FORM, DEFAULT_REVIEW_TEMPLATES, type ReviewTemplate } from '@app/shared';
import { describe, expect, it } from 'vitest';
import type { AdminStore, Caller, SavedFormInput } from './admin';
import { createApp } from './app';
import { UnauthorizedError } from './requests';

const security = DEFAULT_REVIEW_TEMPLATES['Security review']!;

function setup(caller: Caller | null | Error) {
  const saved: { orgId: string; stage: string; template: ReviewTemplate | null; actorId: string }[] = [];
  const forms: { op: string; orgId: string; id?: string | null; input?: SavedFormInput }[] = [];
  const admin: AdminStore = {
    async createRequestForm(orgId, input) {
      if (input.name === 'Taken') return 'name-taken';
      forms.push({ op: 'create', orgId, input });
      return { id: FORM_ID };
    },
    async updateRequestForm(orgId, id, input) {
      if (id !== FORM_ID) return 'not-found';
      forms.push({ op: 'update', orgId, id, input });
      return 'ok';
    },
    async deleteRequestForm(orgId, id) {
      if (id !== FORM_ID) return 'not-found';
      forms.push({ op: 'delete', orgId, id });
      return 'ok';
    },
    async activateRequestForm(orgId, id) {
      if (id !== null && id !== FORM_ID) return 'not-found';
      forms.push({ op: 'activate', orgId, id });
      return 'ok';
    },
    async getCaller() {
      if (caller instanceof Error) throw caller;
      return caller;
    },
    async saveReviewTemplate(orgId, stage, template, actorId) {
      saved.push({ orgId, stage, template, actorId });
    },
  };
  const app = createApp({ admin, webOrigin: 'http://localhost:5173' });
  const call = (method: string, stage: string, body?: unknown, headers: Record<string, string> = { authorization: 'Bearer t' }) =>
    app.request(`/v1/review-forms/${encodeURIComponent(stage)}`, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  const formCall = (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: 'Bearer t' }) =>
    app.request(`/v1/request-forms${path}`, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  return { app, call, saved, forms, formCall };
}

const orgAdmin: Caller = { userId: 'u1', orgId: 'o1', role: 'org_admin' };
const FORM_ID = '33333333-2222-4333-8444-555555555555';

describe('review forms API', () => {
  it('saves a valid form for the caller\'s organization', async () => {
    const { call, saved } = setup(orgAdmin);
    const res = await call('PUT', 'Security review', security);
    expect(res.status).toBe(200);
    expect(saved).toEqual([{ orgId: 'o1', stage: 'Security review', template: security, actorId: 'u1' }]);
  });

  it('lets process managers change forms too', async () => {
    const { call, saved } = setup({ ...orgAdmin, role: 'process_manager' });
    expect((await call('PUT', 'IT review', { fields: [], rules: [] })).status).toBe(200);
    expect(saved).toHaveLength(1);
  });

  it.each(['reviewer', 'requester', 'owner', 'auditor'] as const)('refuses a %s', async (role) => {
    const { call, saved } = setup({ ...orgAdmin, role });
    expect((await call('PUT', 'Security review', security)).status).toBe(403);
    expect((await call('DELETE', 'Security review')).status).toBe(403);
    expect(saved).toEqual([]);
  });

  it('requires a session and a membership', async () => {
    expect((await setup(orgAdmin).call('PUT', 'Security review', security, {})).status).toBe(401);
    expect((await setup(new UnauthorizedError()).call('PUT', 'Security review', security)).status).toBe(401);
    expect((await setup(null).call('PUT', 'Security review', security)).status).toBe(403);
  });

  it('rejects invalid forms with the first problem, and unknown stages', async () => {
    const { call, saved } = setup(orgAdmin);
    const bad = await call('PUT', 'Security review', { fields: [{ key: 'q', label: 'Q', type: 'select', required: true, options: ['Only one'] }], rules: [] });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toEqual({ error: '"Q" needs at least 2 options' });
    expect((await call('PUT', 'Security review', '{not json')).status).toBe(400);
    expect((await call('PUT', 'Made-up stage', security)).status).toBe(404);
    expect((await call('PUT', 'Security review', 'x'.repeat(200_001))).status).toBe(413);
    expect(saved).toEqual([]);
  });

  it('resets a form to the default', async () => {
    const { call, saved } = setup(orgAdmin);
    expect((await call('DELETE', 'Security review')).status).toBe(204);
    expect(saved).toEqual([{ orgId: 'o1', stage: 'Security review', template: null, actorId: 'u1' }]);
  });

  it('allows PUT and DELETE from the web origin', async () => {
    const { app } = setup(orgAdmin);
    const res = await app.request('/v1/review-forms/Security%20review', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'PUT' },
    });
    expect(res.headers.get('access-control-allow-methods')).toContain('PUT');
  });
});

describe('request forms API', () => {
  const valid = { name: '  Short form ', description: '', definition: DEFAULT_REQUEST_FORM };

  it('creates a form for the caller\'s organization, with a trimmed name', async () => {
    const { formCall, forms } = setup(orgAdmin);
    const res = await formCall('POST', '', valid);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: FORM_ID });
    expect(forms).toEqual([{ op: 'create', orgId: 'o1', input: { name: 'Short form', description: null, definition: DEFAULT_REQUEST_FORM } }]);
  });

  it('explains what is wrong with a form and stores nothing', async () => {
    const { formCall, forms } = setup(orgAdmin);
    const broken = { ...valid, definition: { steps: [{ title: 'Only', fields: [{ key: 'q', label: 'Q', type: 'text' }] }] } };
    const res = await formCall('POST', '', broken);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/must keep “Service name”/);
    expect((await formCall('POST', '', { ...valid, name: ' ' })).status).toBe(422);
    expect((await formCall('POST', '', '{oops')).status).toBe(400);
    expect(forms).toEqual([]);
  });

  it('reports a name that is already used', async () => {
    const res = await setup(orgAdmin).formCall('POST', '', { ...valid, name: 'Taken' });
    expect(res.status).toBe(409);
  });

  it('updates, activates, returns to the standard form and deletes', async () => {
    const { formCall, forms } = setup({ ...orgAdmin, role: 'process_manager' });
    expect((await formCall('PUT', `/${FORM_ID}`, valid)).status).toBe(200);
    expect((await formCall('POST', `/${FORM_ID}/activate`)).status).toBe(200);
    expect(await (await formCall('POST', '/standard/activate')).json()).toEqual({ active: 'standard' });
    expect((await formCall('DELETE', `/${FORM_ID}`)).status).toBe(204);
    expect(forms.map((f) => [f.op, f.id])).toEqual([
      ['update', FORM_ID],
      ['activate', FORM_ID],
      ['activate', null],
      ['delete', FORM_ID],
    ]);
  });

  it('does not reach forms of other organizations or malformed ids', async () => {
    const { formCall } = setup(orgAdmin);
    const other = '44444444-2222-4333-8444-555555555555';
    expect((await formCall('PUT', `/${other}`, valid)).status).toBe(404);
    expect((await formCall('DELETE', `/${other}`)).status).toBe(404);
    expect((await formCall('POST', `/${other}/activate`)).status).toBe(404);
    expect((await formCall('DELETE', '/not-a-uuid')).status).toBe(404);
  });

  it.each(['reviewer', 'requester', 'auditor'] as const)('refuses a %s', async (role) => {
    const { formCall, forms } = setup({ ...orgAdmin, role });
    const res = await formCall('POST', '', valid);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Only an org admin or process manager can change request forms' });
    expect(forms).toEqual([]);
  });
});
