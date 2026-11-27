import { describe, expect, it } from 'vitest';
import type { Caller } from './admin';
import { asanaClient, asanaRoutes, AsanaError, ASANA_API } from './asana';
import { decrypt, importEncryptionKey } from './crypto';
import type { IntegrationRecord } from './integrationStore';
import { UnauthorizedError } from './requests';

const ORG = '11111111-1111-4111-8111-111111111111';
const ADMIN: Caller = { userId: '22222222-2222-4222-8222-222222222222', orgId: ORG, role: 'org_admin' };
const TOKEN = '2/1200000000000000/1200000000000001:abcdefabcdefabcdef';

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function fakeAsana(handler: Handler) {
  const calls: { url: URL; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const asanaHappy: Handler = (url) => {
  const p = url.pathname.replace('/api/1.0', '');
  if (p === '/users/me') return json({ data: { gid: '1', name: 'Ann', workspaces: [{ gid: '100', name: 'Acme' }] } });
  if (p === '/workspaces') return json({ data: [{ gid: '100', name: 'Acme' }], next_page: null });
  if (p === '/projects') {
    if (!url.searchParams.get('offset')) return json({ data: [{ gid: '200', name: 'Vendor intake' }], next_page: { offset: 'eyJ0', path: '/projects?offset=eyJ0' } });
    return json({ data: [{ gid: '201', name: 'Second page' }], next_page: null });
  }
  if (p === '/projects/200/custom_field_settings') {
    return json({
      data: [{ gid: '9', is_important: true, custom_field: { gid: '300', name: 'Priority', resource_subtype: 'enum', enum_options: [{ gid: '1', name: 'Low', enabled: true }, { gid: '2', name: 'High', enabled: true }] } }],
      next_page: null,
    });
  }
  return json({ errors: [{ message: 'Not found' }] }, 404);
};

async function setup(options: { caller?: Caller | null | 'expired'; handler?: Handler; record?: IntegrationRecord | null; noKey?: boolean } = {}) {
  const key = await importEncryptionKey(Buffer.from(new Uint8Array(32).fill(7)).toString('base64'));
  let record: IntegrationRecord | null = options.record ?? null;
  const audits: string[] = [];
  const store = {
    async getIntegration() {
      return record;
    },
    async saveIntegration(_org: string, next: IntegrationRecord, _actor: string, action: string) {
      record = next;
      audits.push(action);
    },
  };
  const asana = fakeAsana(options.handler ?? asanaHappy);
  const app = asanaRoutes({
    store: store as never,
    key: Promise.resolve(options.noKey ? null : key),
    getCaller: async () => {
      if (options.caller === 'expired') throw new UnauthorizedError();
      return options.caller === undefined ? ADMIN : options.caller;
    },
    fetchImpl: asana.fetchImpl,
  });
  const call = (method: string, path: string, body?: unknown, auth = true) =>
    app.request(`/integrations/asana${path}`, {
      method,
      headers: { ...(auth ? { authorization: 'Bearer user-token' } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, asana, audits, key, record: () => record };
}

describe('Asana routes', () => {
  it('requires a signed-in org admin', async () => {
    expect((await (await setup()).call('GET', '', undefined, false)).status).toBe(401);
    expect((await (await setup({ caller: 'expired' })).call('GET', '')).status).toBe(401);
    expect((await (await setup({ caller: { ...ADMIN, role: 'process_manager' } })).call('GET', '')).status).toBe(403);
    expect((await (await setup({ caller: null })).call('GET', '')).status).toBe(403);
  });

  it('checks the token, stores it encrypted and never returns it', async () => {
    const s = await setup();
    expect(await (await s.call('GET', '')).json()).toEqual({ encryptionReady: true, configured: false, workspaceGid: null, workspaceName: null });
    const saved = await s.call('PUT', '', { token: TOKEN, workspaceGid: '100' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ ok: true, user: 'Ann', workspaces: [{ gid: '100', name: 'Acme' }] });
    expect(s.asana.calls[0]!.url.origin + s.asana.calls[0]!.url.pathname).toBe(`${ASANA_API}/users/me`);
    expect((s.asana.calls[0]!.init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(s.asana.calls[0]!.init?.redirect).toBe('manual');

    const stored = s.record()!;
    expect(JSON.stringify(stored)).not.toContain(TOKEN);
    expect(JSON.parse(await decrypt(s.key, stored.secrets!))).toEqual({ asanaToken: TOKEN });
    expect(stored.config.asana).toEqual({ workspaceGid: '100', workspaceName: 'Acme' });
    const status = await (await s.call('GET', '')).text();
    expect(status).not.toContain(TOKEN);
    expect(JSON.parse(status)).toMatchObject({ configured: true, workspaceGid: '100' });
    expect(s.audits).toEqual(['integration.asana_updated']);

    expect((await s.call('DELETE', '')).status).toBe(200);
    expect(s.record()).toEqual({ config: {}, secrets: null });
  });

  it('refuses malformed input and a token Asana rejects', async () => {
    const s = await setup();
    expect((await s.call('PUT', '', { token: 'short' })).status).toBe(422);
    expect((await s.call('PUT', '', { token: TOKEN, workspaceGid: '../x' })).status).toBe(422);
    expect((await s.call('PUT', '', { token: TOKEN, workspaceGid: '999' })).status).toBe(422);
    const bad = await setup({ handler: () => json({ errors: [{ message: 'Not Authorized' }] }, 401) });
    const res = await bad.call('PUT', '', { token: TOKEN });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/did not accept the token/);
    expect(bad.record()).toBeNull();
  });

  it('needs a connection and the encryption key', async () => {
    expect((await (await setup()).call('GET', '/workspaces')).status).toBe(409);
    expect((await (await setup({ noKey: true })).call('PUT', '', { token: TOKEN })).status).toBe(503);
  });

  it('lists workspaces, projects over several pages, and a project’s fields', async () => {
    const s = await setup();
    await s.call('PUT', '', { token: TOKEN });
    expect(await (await s.call('GET', '/workspaces')).json()).toEqual({ workspaces: [{ gid: '100', name: 'Acme' }], selected: null });
    expect(await (await s.call('GET', '/workspaces/100/projects')).json()).toEqual({
      projects: [
        { gid: '200', name: 'Vendor intake' },
        { gid: '201', name: 'Second page' },
      ],
    });
    const projectCalls = s.asana.calls.filter((c) => c.url.pathname.endsWith('/projects'));
    expect(projectCalls.map((c) => c.url.searchParams.get('offset'))).toEqual([null, 'eyJ0']);
    expect(projectCalls[0]!.url.searchParams.get('workspace')).toBe('100');
    expect(projectCalls[0]!.url.searchParams.get('archived')).toBe('false');
    expect(projectCalls[0]!.url.searchParams.get('limit')).toBe('100');

    const fields = (await (await s.call('GET', '/projects/200/fields')).json()) as { fields: unknown[] };
    expect(fields.fields).toEqual([
      { gid: '300', name: 'Priority', description: '', subtype: 'enum', precision: null, important: true, options: [{ gid: '1', name: 'Low', enabled: true }, { gid: '2', name: 'High', enabled: true }] },
    ]);
    const fieldCall = s.asana.calls.find((c) => c.url.pathname.endsWith('/custom_field_settings'))!;
    expect(fieldCall.url.searchParams.get('opt_fields')).toContain('custom_field.enum_options.enabled');
  });

  it('validates ids before calling Asana', async () => {
    const s = await setup();
    await s.call('PUT', '', { token: TOKEN });
    const before = s.asana.calls.length;
    expect((await s.call('GET', '/workspaces/abc/projects')).status).toBe(400);
    expect((await s.call('GET', '/projects/1;drop/fields')).status).toBe(400);
    expect(s.asana.calls.length).toBe(before);
  });
});

describe('asanaClient errors', () => {
  const statusOf = async (handler: Handler): Promise<[number, string] | null> => {
    try {
      await asanaClient(TOKEN, fakeAsana(handler).fetchImpl).workspaces();
      return null;
    } catch (error) {
      if (error instanceof AsanaError) return [error.status, error.message];
      throw error;
    }
  };

  it('explains rate limits, missing access, paid features and outages', async () => {
    expect(await statusOf(() => json({}, 429, { 'retry-after': '30' }))).toEqual([429, 'Asana asks to slow down. Try again in 30 seconds.']);
    expect((await statusOf(() => json({}, 403)))?.[0]).toBe(403);
    expect((await statusOf(() => json({}, 402)))?.[1]).toMatch(/paid Asana plan/);
    expect((await statusOf(() => json({}, 500)))?.[0]).toBe(502);
    expect((await statusOf(() => json({ nope: 1 })))?.[0]).toBe(502);
    expect(
      await statusOf(() => {
        throw new TypeError('network');
      }),
    ).toEqual([502, 'Asana could not be reached. Try again in a moment.']);
  });

  it('stops paging after a fixed number of pages', async () => {
    const asana = fakeAsana(() => json({ data: [{ gid: '1', name: 'W' }], next_page: { offset: 'again' } }));
    const rows = await asanaClient(TOKEN, asana.fetchImpl).workspaces();
    expect(rows).toHaveLength(20);
    expect(asana.calls).toHaveLength(20);
  });
});
