import { defaultWorkflowSettings, DEFAULT_REQUEST_FORM, DEFAULT_SECURITY_BASELINE, DEFAULT_REVIEW_TEMPLATES, type ReviewTemplate, type WorkflowSettings } from '@app/shared';
import { describe, expect, it } from 'vitest';
import type { AdminStore, Caller, SavedFormInput } from './admin';
import { createApp } from './app';
import { UnauthorizedError } from './requests';

const security = DEFAULT_REVIEW_TEMPLATES['Security review']!;

function setup(caller: Caller | null | Error, failFiles = false) {
  const saved: { orgId: string; stage: string; template: ReviewTemplate | null; actorId: string }[] = [];
  const forms: { op: string; orgId: string; id?: string | null; input?: SavedFormInput }[] = [];
  const workflows: { orgId: string; settings: WorkflowSettings | null; actorId: string }[] = [];
  const purged: { id: string; actorId: string }[] = [];
  const removed: string[] = [];
  const aiSaved: { orgId: string; settings: unknown; actorId: string }[] = [];
  const baselines: { orgId: string; baseline: unknown; actorId: string }[] = [];
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
    async saveWorkflowSettings(orgId, settings, actorId) {
      workflows.push({ orgId, settings, actorId });
    },
    async purgeRequest(id, actorId) {
      purged.push({ id, actorId });
      if (id === FORM_ID) return ['o1/r/a.pdf'];
      if (id === NOT_IN_TRASH) return 'not-in-trash';
      return 'not-found';
    },
    async saveAiSettings(orgId, settings, actorId) {
      aiSaved.push({ orgId, settings, actorId });
    },
    async saveSecurityBaseline(orgId, baseline, actorId) {
      baselines.push({ orgId, baseline, actorId });
    },
    async removeAttachmentFiles(paths) {
      if (failFiles) throw new Error('storage down');
      removed.push(...paths);
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
  return { app, call, saved, forms, formCall, workflows, purged, removed, aiSaved, baselines };
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
    const broken = { ...valid, definition: { steps: [{ title: 'Only', fields: [{ key: 'q', label: 'Q', type: 'text', optional: true }] }], titleField: 'q' } };
    const res = await formCall('POST', '', broken);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/names the request, so it must be required/);
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

describe('review settings API', () => {
  const put = (app: ReturnType<typeof setup>['app'], body: unknown) =>
    app.request('/v1/workflow', { method: 'PUT', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('stores validated settings and resets to the defaults', async () => {
    const { app, workflows } = setup(orgAdmin);
    const stages = defaultWorkflowSettings();
    stages['Legal review'] = { ...stages['Legal review']!, requirement: 'never', checklist: ['  Read the terms  '] };
    const res = await put(app, { stages });
    expect(res.status).toBe(200);
    expect(workflows[0]!.settings!['Legal review']).toMatchObject({ requirement: 'never', checklist: ['Read the terms'] });
    expect(workflows[0]!.actorId).toBe('u1');
    expect((await app.request('/v1/workflow', { method: 'DELETE', headers: { authorization: 'Bearer t' } })).status).toBe(204);
    expect(workflows[1]!.settings).toBeNull();
  });

  it('explains broken settings and refuses requesters', async () => {
    const { app, workflows } = setup(orgAdmin);
    const stages = defaultWorkflowSettings();
    for (const s of Object.values(stages)) s.requirement = 'never';
    const res = await put(app, { stages });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/At least one review must always be needed/);
    expect(workflows).toEqual([]);
    expect((await put(setup({ ...orgAdmin, role: 'requester' }).app, { stages: defaultWorkflowSettings() })).status).toBe(403);
  });
});

const NOT_IN_TRASH = '44444444-2222-4333-8444-555555555555';

describe('deleting a request for good', () => {
  const del = (app: ReturnType<typeof setup>['app'], id: string) => app.request(`/v1/requests/${id}`, { method: 'DELETE', headers: { authorization: 'Bearer t' } });

  it('deletes from the trash and removes the files', async () => {
    const { app, purged, removed } = setup(orgAdmin);
    const res = await del(app, FORM_ID);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, filesRemoved: true });
    expect(purged).toEqual([{ id: FORM_ID, actorId: 'u1' }]);
    expect(removed).toEqual(['o1/r/a.pdf']);
    expect(await (await del(setup(orgAdmin, true).app, FORM_ID)).json()).toEqual({ deleted: true, filesRemoved: false });
  });

  it('is for org admins, for requests in the trash', async () => {
    expect((await del(setup({ ...orgAdmin, role: 'process_manager' }).app, FORM_ID)).status).toBe(403);
    expect((await del(setup({ ...orgAdmin, role: 'requester' }).app, FORM_ID)).status).toBe(403);
    expect((await del(setup(orgAdmin).app, NOT_IN_TRASH)).status).toBe(409);
    expect((await del(setup(orgAdmin).app, '55555555-2222-4333-8444-555555555555')).status).toBe(404);
    expect((await del(setup(orgAdmin).app, 'nope')).status).toBe(404);
  });
});

describe('AI settings API', () => {
  const put = (app: ReturnType<typeof setup>['app'], body: unknown) =>
    app.request('/v1/ai-settings', { method: 'PUT', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('stores validated settings and resets them', async () => {
    const { app, aiSaved } = setup(orgAdmin);
    const res = await put(app, { instructions: '  Flag tools without SSO.  ', fields: ['signInMethod', 'signInMethod', 'purpose'], proposeFixes: true });
    expect(res.status).toBe(200);
    expect(aiSaved[0]!.settings).toEqual({ instructions: 'Flag tools without SSO.', fields: ['signInMethod', 'purpose'], proposeFixes: true });
    expect((await app.request('/v1/ai-settings', { method: 'DELETE', headers: { authorization: 'Bearer t' } })).status).toBe(204);
    expect(aiSaved[1]!.settings).toBeNull();
  });

  it('refuses bad settings and requesters', async () => {
    const { app, aiSaved } = setup(orgAdmin);
    expect((await put(app, { instructions: 'x'.repeat(4001), fields: [], proposeFixes: true })).status).toBe(422);
    expect((await put(app, { instructions: '', fields: ['1bad'], proposeFixes: true })).status).toBe(422);
    expect((await put(app, { instructions: '', fields: [], proposeFixes: 'yes' })).status).toBe(422);
    expect((await put(app, { instructions: '', fields: [], proposeFixes: true, model: 'x' })).status).toBe(422);
    expect(aiSaved).toEqual([]);
    expect((await put(setup({ ...orgAdmin, role: 'requester' }).app, { instructions: '', fields: [], proposeFixes: true })).status).toBe(403);
  });
});

describe('security baseline API', () => {
  const put = (app: ReturnType<typeof setup>['app'], body: unknown) =>
    app.request('/v1/security-baseline', { method: 'PUT', headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('stores a validated baseline and resets it', async () => {
    const { app, baselines } = setup(orgAdmin);
    const controls = [...DEFAULT_SECURITY_BASELINE.controls, { id: 'vpn', title: ' Only from the office network ', requirement: 'IP allow-list set.', verification: '', category: 'Identity & access', level: 'recommended', minTier: 'High', when: null }];
    const res = await put(app, { controls });
    expect(res.status).toBe(200);
    expect((baselines[0]!.baseline as { controls: { title: string }[] }).controls.at(-1)!.title).toBe('Only from the office network');
    expect((await app.request('/v1/security-baseline', { method: 'DELETE', headers: { authorization: 'Bearer t' } })).status).toBe(204);
    expect(baselines[1]!.baseline).toBeNull();
  });

  it('explains a broken baseline and refuses requesters', async () => {
    const { app, baselines } = setup(orgAdmin);
    const res = await put(app, { controls: [{ ...DEFAULT_SECURITY_BASELINE.controls[0]!, id: 'Bad Key' }] });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid key/);
    expect(baselines).toEqual([]);
    expect((await put(setup({ ...orgAdmin, role: 'reviewer' }).app, DEFAULT_SECURITY_BASELINE)).status).toBe(403);
  });
});
