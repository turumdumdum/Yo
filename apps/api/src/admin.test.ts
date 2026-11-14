import { DEFAULT_REVIEW_TEMPLATES, type ReviewTemplate } from '@app/shared';
import { describe, expect, it } from 'vitest';
import type { AdminStore, Caller } from './admin';
import { createApp } from './app';
import { UnauthorizedError } from './requests';

const security = DEFAULT_REVIEW_TEMPLATES['Security review']!;

function setup(caller: Caller | null | Error) {
  const saved: { orgId: string; stage: string; template: ReviewTemplate | null; actorId: string }[] = [];
  const admin: AdminStore = {
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
  return { app, call, saved };
}

const orgAdmin: Caller = { userId: 'u1', orgId: 'o1', role: 'org_admin' };

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
