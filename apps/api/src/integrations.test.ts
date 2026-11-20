import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { Caller } from './admin';
import { decrypt, encrypt, importEncryptionKey, signatureHeader, verifySignature, type EncryptionKey } from './crypto';
import { backoffMs, deliverDue, flushNotifications, MAX_ATTEMPTS, queueExternalStages, slackText, stageStartedPayload, type DispatcherDeps } from './dispatcher';
import type { AuditRow, IntegrationRecord, IntegrationStore, OutboundRow, RequestInfo, StageInfo } from './integrationStore';
import type { DraftRecord, RequestStore } from './requests';
import { hostnameOf, parseUpGuardVendor } from './upguard';

const ORG = '11111111-1111-4111-8111-111111111111';
const REQ = '22222222-2222-4222-8222-222222222222';
const STAGE = '33333333-3333-4333-8333-333333333333';
const KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const admin: Caller = { userId: 'u1', orgId: ORG, role: 'org_admin' };

function memoryStore() {
  const s = {
    integration: null as IntegrationRecord | null,
    audit: [] as AuditRow[],
    cursor: 0,
    queue: [] as (OutboundRow & { delivered?: boolean; failed?: boolean; next?: Date; error?: string })[],
    inbound: new Set<string>(),
    saved: [] as { action: string; metadata: Record<string, unknown> }[],
    applied: [] as unknown[],
    applyResult: 'ok' as 'ok' | 'not_found' | 'closed',
    risks: [] as unknown[],
    request: {
      id: REQ,
      org_id: ORG,
      service_name: 'Acme Board',
      is_confidential: false,
      risk_tier: 'High',
      risk_score: 7,
      risk_reasons: ['Data classification: Confidential (+3)'],
      request_type: 'New vendor',
      submitted_at: '2026-11-20T10:00:00.000Z',
      answers: { serviceName: 'Acme Board', vendorName: 'Acme', vendorWebsite: 'https://www.acme.example/x', signInMethod: 'SSO', purpose: 'Planning', budgetOwner: { name: 'Ann Lee' } },
      form: null,
      config_requirements: [{ id: 'sso' }],
    } as RequestInfo,
    stage: { id: STAGE, org_id: ORG, request_id: REQ, name: 'Security review', status: 'In review', sla_due_at: '2026-11-27T10:00:00.000Z', external: true } as StageInfo,
  };
  let id = 0;
  const store: IntegrationStore = {
    async getIntegration(org) {
      return org === ORG ? s.integration : null;
    },
    async saveIntegration(_org, record, _actor, action, metadata) {
      s.integration = record;
      s.saved.push({ action, metadata });
    },
    async resetCursor() {
      s.cursor = s.audit.at(-1)?.id ?? 0;
    },
    async orgsWithSlack() {
      return s.integration?.config.slack?.enabled ? [ORG] : [];
    },
    async getCursor() {
      return s.cursor;
    },
    async setCursor(_o, v) {
      s.cursor = v;
    },
    async auditAfter(_o, after) {
      return s.audit.filter((a) => a.id > after);
    },
    async requests(ids) {
      return ids.includes(REQ) ? [s.request] : [];
    },
    async enqueue(org, kind, payloads) {
      for (const payload of payloads) s.queue.push({ id: ++id, org_id: org, kind, payload, attempts: 0 });
    },
    async dueEvents() {
      return s.queue.filter((q) => !q.delivered && !q.failed && (!q.next || q.next <= new Date()));
    },
    async claim() {
      return true;
    },
    async markDelivered(qid) {
      s.queue.find((q) => q.id === qid)!.delivered = true;
    },
    async markRetry(qid, attempts, next, error) {
      Object.assign(s.queue.find((q) => q.id === qid)!, { attempts, next, error });
    },
    async markFailed(qid, attempts, error) {
      Object.assign(s.queue.find((q) => q.id === qid)!, { attempts, failed: true, error });
    },
    async recordInbound(org, eventId) {
      const k = `${org}|${eventId}`;
      if (s.inbound.has(k)) return false;
      s.inbound.add(k);
      return true;
    },
    async applyExternalStatus(org, stageId, u) {
      s.applied.push({ org, stageId, ...u });
      return s.applyResult;
    },
    async stage(org, stageId) {
      return org === ORG && stageId === STAGE ? s.stage : null;
    },
    async externalStages() {
      return [s.stage];
    },
    async saveVendorRisk(row) {
      s.risks.push(row);
      return { id: 'r1', request_id: row.request_id, source: 'upguard', hostname: row.hostname, data: row.data, fetched_at: 'now' };
    },
  };
  return { s, store };
}

function setup(options: { caller?: Caller | null; withKey?: boolean; fetchImpl?: typeof fetch; rateLimits?: { prefix: string; limit: number; windowMs: number }[] } = {}) {
  const { s, store } = memoryStore();
  const key: Promise<EncryptionKey | null> = options.withKey === false ? Promise.resolve(null) : importEncryptionKey(KEY_B64);
  const draft: DraftRecord = { id: REQ, org_id: ORG, status: 'in_review', answers: s.request.answers };
  const requests: RequestStore = {
    async getAsUser() {
      return draft;
    },
    async getReviewTemplates() {
      return {};
    },
    async submit() {
      throw new Error('unused');
    },
  };
  const app = createApp({
    webOrigin: 'https://app.example',
    requests,
    admin: {
      getCaller: async () => (options.caller === undefined ? admin : options.caller),
    } as never,
    integrations: { store, key, publicApiUrl: 'https://api.example', upguardBaseUrl: 'https://upguard.example/api', fetchImpl: options.fetchImpl },
    rateLimits: options.rateLimits,
  });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { authorization: 'Bearer t', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  const deps: DispatcherDeps = { store, key, webOrigin: 'https://app.example', publicApiUrl: 'https://api.example', fetchImpl: options.fetchImpl };
  return { s, store, app, call, key, deps };
}

describe('crypto', () => {
  it('encrypts secrets so only the key reads them', async () => {
    const key = await importEncryptionKey(KEY_B64);
    const box = await encrypt(key, '{"a":"secret"}');
    expect(box).not.toContain('secret');
    expect(await decrypt(key, box)).toBe('{"a":"secret"}');
    const other = await importEncryptionKey(btoa(String.fromCharCode(...new Uint8Array(32).fill(9))));
    await expect(decrypt(other, box)).rejects.toThrow();
    await expect(importEncryptionKey(btoa('short'))).rejects.toThrow(/32 bytes/);
  });

  it('verifies signatures: valid, wrong secret, stale, tampered, malformed', async () => {
    const now = Date.UTC(2026, 10, 20, 12);
    const header = await signatureHeader('s3cret', '{"x":1}', now);
    expect(await verifySignature('s3cret', header, '{"x":1}', now)).toBe('ok');
    expect(await verifySignature('other', header, '{"x":1}', now)).toBe('mismatch');
    expect(await verifySignature('s3cret', header, '{"x":2}', now)).toBe('mismatch');
    expect(await verifySignature('s3cret', header, '{"x":1}', now + 301_000)).toBe('stale');
    expect(await verifySignature('s3cret', 't=1,v1=zz', '{"x":1}', now)).toBe('malformed');
    expect(await verifySignature('s3cret', undefined, '{"x":1}', now)).toBe('missing');
  });
});

describe('integration settings', () => {
  it('never return secrets, and store them encrypted', async () => {
    const { call, s, key } = setup();
    expect((await call('PUT', '/v1/integrations/slack', { enabled: true, events: ['request.submitted'], webhookUrl: 'http://evil.example' })).status).toBe(422);
    expect((await call('PUT', '/v1/integrations/slack', { enabled: true, events: ['nope'] })).status).toBe(422);
    expect((await call('PUT', '/v1/integrations/slack', { enabled: true, events: ['request.submitted'] })).status).toBe(422);
    const res = await call('PUT', '/v1/integrations/slack', { enabled: true, events: ['request.submitted'], webhookUrl: 'https://hooks.slack.com/services/T/B/X' });
    expect(res.status).toBe(200);
    expect(s.integration!.secrets).not.toContain('hooks.slack.com');
    expect(JSON.parse(await decrypt((await key)!, s.integration!.secrets!)).slackWebhookUrl).toBe('https://hooks.slack.com/services/T/B/X');
    expect(JSON.stringify(s.saved)).not.toContain('hooks.slack.com');
    const view = await (await call('GET', '/v1/integrations')).text();
    expect(view).not.toContain('hooks.slack.com');
    expect(JSON.parse(view)).toMatchObject({ encryptionReady: true, slack: { enabled: true, configured: true, events: ['request.submitted'] } });
  });

  it('hand out the external signing secret once, and again only when rotated', async () => {
    const { call } = setup();
    const body = { enabled: true, name: 'SecTool', outboundUrl: 'https://sec.example/hook', sendAllAnswers: false };
    expect((await call('PUT', '/v1/integrations/external', { ...body, outboundUrl: 'http://sec.example' })).status).toBe(422);
    const first = (await (await call('PUT', '/v1/integrations/external', body)).json()) as { secret?: string };
    expect(first.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(((await (await call('PUT', '/v1/integrations/external', body)).json()) as { secret?: string }).secret).toBeUndefined();
    const rotated = (await (await call('PUT', '/v1/integrations/external', { ...body, rotateSecret: true })).json()) as { secret?: string };
    expect(rotated.secret).not.toBe(first.secret);
  });

  it('are for org admins, and need the encryption key', async () => {
    expect((await setup({ caller: { ...admin, role: 'process_manager' } }).call('GET', '/v1/integrations')).status).toBe(403);
    expect((await setup({ withKey: false }).call('PUT', '/v1/integrations/upguard', { enabled: true, apiKey: 'abcdefghij' })).status).toBe(503);
    expect(await (await setup({ withKey: false }).call('GET', '/v1/integrations')).json()).toMatchObject({ encryptionReady: false });
  });
});

describe('outbox', () => {
  it('turns chosen audit events into Slack messages without answers; confidential requests stay unnamed', async () => {
    const row = (id: number, action: string, metadata: Record<string, unknown> = {}): AuditRow => ({ id, org_id: ORG, action, entity_id: REQ, metadata });
    expect(slackText(row(1, 'request.submitted', { risk_tier: 'High' }), { service_name: 'A <b>', is_confidential: false, risk_tier: 'High' }, 'https://app.example')).toBe(
      'New: *A &lt;b&gt;* was submitted (High risk) and is being checked. <https://app.example|Open>'.replace('New: ', ''),
    );
    expect(slackText(row(2, 'request.approved'), { service_name: 'Secret M&A tool', is_confidential: true, risk_tier: 'High' }, 'x')).toBe('A confidential request was approved. <x|Open>');
    expect(slackText(row(3, 'stage.assigned'), undefined, 'x')).toBeNull();

    const { s, deps, call } = setup();
    await call('PUT', '/v1/integrations/slack', { enabled: true, events: ['request.submitted', 'stage.decided'], webhookUrl: 'https://hooks.slack.com/services/T/B/X' });
    s.audit.push(row(10, 'request.submitted', { risk_tier: 'High' }), row(11, 'request.trashed'), { ...row(12, 'stage.decided', { request_id: REQ, stage: 'Legal review', decision: 'Approved' }), entity_id: STAGE });
    expect(await flushNotifications(deps)).toBe(2);
    expect(s.cursor).toBe(12);
    expect(s.queue.map((q) => q.payload.text)).toEqual([
      '*Acme Board* was submitted (High risk) and is being checked. <https://app.example|Open>',
      '*Acme Board*: Legal review — Approved. <https://app.example|Open>',
    ]);
    expect(JSON.stringify(s.queue)).not.toContain('Planning');
    expect(await flushNotifications(deps)).toBe(0);
  });

  it('delivers, retries with backoff, gives up after the limit, and does not retry what the service refuses', async () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([30_000, 60_000, 120_000]);
    expect(backoffMs(30)).toBe(6 * 3_600_000);
    let status = 500;
    const sent: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response('', { status });
    }) as unknown as typeof fetch;
    const { s, deps, call } = setup({ fetchImpl });
    await call('PUT', '/v1/integrations/slack', { enabled: true, events: ['request.submitted'], webhookUrl: 'https://hooks.slack.com/services/T/B/X' });
    await deps.store.enqueue(ORG, 'slack', [{ text: 'hi' }]);
    expect(await deliverDue(deps)).toBe(0);
    expect(s.queue[0]).toMatchObject({ attempts: 1, error: 'The service answered 500' });
    s.queue[0]!.attempts = MAX_ATTEMPTS - 1;
    s.queue[0]!.next = undefined;
    await deliverDue(deps);
    expect(s.queue[0]!.failed).toBe(true);
    status = 400;
    await deps.store.enqueue(ORG, 'slack', [{ text: 'again' }]);
    await deliverDue(deps);
    expect(s.queue[1]!.failed).toBe(true);
    status = 200;
    await deps.store.enqueue(ORG, 'slack', [{ text: 'ok' }]);
    expect(await deliverDue(deps)).toBe(1);
    expect(sent.at(-1)!.url).toBe('https://hooks.slack.com/services/T/B/X');
    expect(JSON.parse(sent.at(-1)!.init.body as string)).toEqual({ text: 'ok' });
  });

  it('sends external stages signed, with the chosen answers and never answers about people', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response('', { status: 202 });
    }) as unknown as typeof fetch;
    const { s, deps, call } = setup({ fetchImpl });
    const { secret } = (await (await call('PUT', '/v1/integrations/external', { enabled: true, name: 'SecTool', outboundUrl: 'https://sec.example/hook', sendAllAnswers: false })).json()) as { secret: string };
    expect(await queueExternalStages(deps, REQ)).toBe(1);
    const payload = s.queue[0]!.payload as unknown as ReturnType<typeof stageStartedPayload>;
    expect(payload).toMatchObject({
      type: 'stage.started',
      organization: { id: ORG },
      request: { id: REQ, title: 'Acme Board', vendor: 'Acme', website: 'https://www.acme.example/x', risk_tier: 'High', confidential: false, config_requirements: [{ id: 'sso' }] },
      stage: { id: STAGE, name: 'Security review' },
      callback: { status_url: `https://api.example/v1/external/stages/${STAGE}/status`, stage_url: `https://api.example/v1/external/stages/${STAGE}?org_id=${ORG}` },
    });
    expect(Object.keys(payload.request.answers)).toEqual(['signInMethod']);
    expect(JSON.stringify(payload)).not.toContain('Ann Lee');
    const all = stageStartedPayload(s.request, s.stage, { sendAllAnswers: true });
    expect(Object.keys(all.request.answers)).toContain('purpose');
    expect(Object.keys(all.request.answers)).not.toContain('budgetOwner');
    await deliverDue(deps);
    const req = sent[0]!;
    expect(req.url).toBe('https://sec.example/hook');
    const header = (req.init.headers as Record<string, string>)['x-signature'];
    expect(await verifySignature(secret, header, req.init.body as string)).toBe('ok');
  });
});

describe('external review service endpoints', () => {
  async function signedSetup() {
    const ctx = setup();
    const { secret } = (await (await ctx.call('PUT', '/v1/integrations/external', { enabled: true, name: 'SecTool', outboundUrl: 'https://sec.example/hook', sendAllAnswers: false })).json()) as { secret: string };
    const post = async (body: Record<string, unknown>, sign = secret) => {
      const raw = JSON.stringify(body);
      return ctx.app.request(`/v1/external/stages/${STAGE}/status`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': await signatureHeader(sign, raw) }, body: raw });
    };
    return { ...ctx, secret, post };
  }

  it('accept a signed status update once, and refuse bad signatures', async () => {
    const { post, s } = await signedSetup();
    const update = { event_id: 'evt-1', org_id: ORG, status: 'approved_with_conditions', conditions: 'Enable SSO', external_url: 'https://sec.example/r/1' };
    expect((await post(update, 'wrong')).status).toBe(401);
    expect((await post({ ...update, org_id: '99999999-9999-4999-8999-999999999999' })).status).toBe(401);
    const ok = await post(update);
    expect(ok.status).toBe(200);
    expect(s.applied).toEqual([{ org: ORG, stageId: STAGE, ...update }]);
    expect(await (await post(update)).json()).toEqual({ ok: true, duplicate: true });
    expect(s.applied).toHaveLength(1);
    expect((await post({ ...update, event_id: 'evt-2', status: 'done' })).status).toBe(422);
    expect((await post({ ...update, event_id: 'evt-3', external_url: 'http://x' })).status).toBe(422);
  });

  it('map unknown and closed stages, and reject stale signatures', async () => {
    const { post, s, app, secret } = await signedSetup();
    s.applyResult = 'not_found';
    expect((await post({ event_id: 'a', org_id: ORG, status: 'in_review' })).status).toBe(404);
    s.applyResult = 'closed';
    expect((await post({ event_id: 'b', org_id: ORG, status: 'in_review' })).status).toBe(409);
    const raw = JSON.stringify({ event_id: 'c', org_id: ORG, status: 'in_review' });
    const stale = await signatureHeader(secret, raw, Date.now() - 10 * 60_000);
    expect((await app.request(`/v1/external/stages/${STAGE}/status`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': stale }, body: raw })).status).toBe(401);
  });

  it('return the stage payload to a signed GET', async () => {
    const { app, secret } = await signedSetup();
    const url = `/v1/external/stages/${STAGE}?org_id=${ORG}`;
    expect((await app.request(url)).status).toBe(401);
    const res = await app.request(url, { headers: { 'x-signature': await signatureHeader(secret, '') } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ type: 'stage.started', stage: { id: STAGE }, stage_status: 'In review' });
  });
});

describe('UpGuard', () => {
  it('parses the vendor defensively', () => {
    expect(parseUpGuardVendor({ name: 'Acme', primary_hostname: 'acme.example', score: '812', categoryScores: { emailSecurity: 900, bad: 'x' } }, 'acme.example', new Date(0))).toEqual({
      name: 'Acme',
      hostname: 'acme.example',
      score: 812,
      categories: [{ name: 'emailSecurity', score: 900 }],
      fetchedAt: '1970-01-01T00:00:00.000Z',
    });
    expect(parseUpGuardVendor({ automatedScore: 700 }, 'h.example').score).toBe(700);
    expect(parseUpGuardVendor(null, 'h.example')).toMatchObject({ name: null, score: null, categories: [] });
    expect(hostnameOf('https://www.Acme.example/path')).toBe('acme.example');
    expect(hostnameOf('not a site')).toBeNull();
  });

  it('looks up the vendor for reviewers and stores the snapshot', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ name: 'Acme', score: 750 }), { status: 200 });
    }) as unknown as typeof fetch;
    const { call, s } = setup({ fetchImpl });
    expect((await call('POST', `/v1/requests/${REQ}/vendor-risk/upguard`)).status).toBe(409);
    await call('PUT', '/v1/integrations/upguard', { enabled: true, apiKey: 'ug-key-123456' });
    const res = await call('POST', `/v1/requests/${REQ}/vendor-risk/upguard`);
    expect(res.status).toBe(200);
    expect(seen[0]!.url).toBe('https://upguard.example/api/vendor?hostname=acme.example');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('ug-key-123456');
    expect(s.risks).toHaveLength(1);
    expect((await setup({ caller: { ...admin, role: 'requester' } }).call('POST', `/v1/requests/${REQ}/vendor-risk/upguard`)).status).toBe(403);
  });
});

describe('hardening', () => {
  it('limits the rate per client', async () => {
    const { app } = setup({ rateLimits: [{ prefix: '/v1/', limit: 2, windowMs: 60_000 }] });
    const get = (ip: string) => app.request('/v1/integrations', { headers: { authorization: 'Bearer t', 'x-forwarded-for': `${ip}, 10.0.0.1` } });
    expect((await get('1.1.1.1')).status).toBe(200);
    expect((await get('1.1.1.1')).status).toBe(200);
    const limited = await get('1.1.1.1');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    expect((await get('2.2.2.2')).status).toBe(200);
  });

  it('requires JSON bodies, limits their size and forbids caching', async () => {
    const { app } = setup();
    const text = await app.request('/v1/integrations/slack', { method: 'PUT', headers: { authorization: 'Bearer t', 'content-type': 'text/plain' }, body: 'x' });
    expect(text.status).toBe(415);
    const big = 'x'.repeat(300 * 1024);
    const res = await app.request(`/v1/external/stages/${STAGE}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ big }) });
    expect(res.status).toBe(413);
    expect((await app.request('/v1/integrations', { headers: { authorization: 'Bearer t' } })).headers.get('cache-control')).toBe('no-store');
  });
});
