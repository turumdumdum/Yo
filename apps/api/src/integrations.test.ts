import { defaultWorkflowSettings, type WorkflowSettings } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { Caller } from './admin';
import { decrypt, encrypt, importEncryptionKey, signatureHeader, verifySignature, type EncryptionKey } from './crypto';
import { backoffMs, deliverDue, pullPayload, flushNotifications, MAX_ATTEMPTS, queueExternalStages, slackText, stageStartedPayload, type DispatcherDeps } from './dispatcher';
import type { AuditRow, IntegrationRecord, IntegrationStore, OutboundRow, RequestInfo, StageInfo } from './integrationStore';
import { envSettings, settingsResolver } from './orgSettings';
import type { DraftRecord, RequestStore } from './requests';
import { hostnameOf, parseUpGuardVendor } from './upguard';

const ORG = '11111111-1111-4111-8111-111111111111';
const REQ = '22222222-2222-4222-8222-222222222222';
const STAGE = '33333333-3333-4333-8333-333333333333';
const KEY_B64 = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const admin: Caller = { userId: 'u1', orgId: ORG, role: 'org_admin', email: 'admin@acme.example' };

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
    stage: { id: STAGE, org_id: ORG, request_id: REQ, name: 'Security review', status: 'In review', sla_due_at: '2026-11-27T10:00:00.000Z', external: true, external_service: null } as StageInfo,
    workflow: null as WorkflowSettings | null,
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
    async deliveries(org, serviceId, limit) {
      return s.queue
        .filter((q) => q.org_id === org && q.kind === 'external' && ((q.payload.service as { id?: string } | undefined)?.id ?? 'default') === serviceId)
        .slice(-limit)
        .reverse()
        .map((q) => ({
          id: q.id,
          type: (q.payload.type as string) ?? null,
          created_at: 'now',
          attempts: q.attempts,
          delivered_at: q.delivered ? 'now' : null,
          failed_at: q.failed ? 'now' : null,
          last_error: q.error ?? null,
          next_attempt_at: q.next?.toISOString() ?? 'now',
        }));
    },
    async saveVendorRisk(row) {
      s.risks.push(row);
      return { id: 'r1', request_id: row.request_id, source: 'upguard', hostname: row.hostname, data: row.data, fetched_at: 'now' };
    },
  };
  return { s, store };
}

function setup(
  options: {
    caller?: Caller | null;
    withKey?: boolean;
    fetchImpl?: typeof fetch;
    rateLimits?: { prefix: string; limit: number; windowMs: number }[];
    env?: Record<string, string>;
    smtp?: boolean;
    allowLocal?: boolean;
  } = {},
) {
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
    async getWorkflowSettings() {
      return s.workflow;
    },
    async submit() {
      throw new Error('unused');
    },
  };
  const mails: { to: string; subject: string; via: string }[] = [];
  const settings = settingsResolver({
    store,
    key,
    env: envSettings(options.env ?? {}),
    fetchImpl: options.fetchImpl,
    smtpFactory: options.smtp ? (url) => ({ send: async (m) => void mails.push({ to: m.to, subject: m.subject, via: `smtp:${url}` }) }) : undefined,
  });
  const getCaller = async () => (options.caller === undefined ? admin : options.caller);
  const app = createApp({
    webOrigin: 'https://app.example',
    requests,
    admin: { getCaller } as never,
    invitations: {
      getCaller,
      createInvitations: async (_t: string, _o: string, rows: { email: string; role: string }[]) => rows.map((r) => ({ ...r, token: 'tok' })),
      organizationName: async () => 'Acme',
    } as never,
    integrations: {
      store,
      key,
      publicApiUrl: 'https://api.example',
      upguardBaseUrl: 'https://upguard.example/api',
      fetchImpl: options.fetchImpl,
      settings,
      smtpSupported: !!options.smtp,
      allowLocalServiceUrls: !!options.allowLocal,
    },
    settings,
    rateLimits: options.rateLimits,
  });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { authorization: 'Bearer t', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  const deps: DispatcherDeps = { store, key, webOrigin: 'https://app.example', publicApiUrl: 'https://api.example', fetchImpl: options.fetchImpl };
  return { s, store, app, call, key, deps, mails, settings };
}

const SERVICE = { name: 'SecTool', url: 'https://sec.example/hook', dataMode: 'push', sendAllAnswers: false, enabled: true };

/** Adds a review service and returns its id and one-time secret. */
async function addService(call: ReturnType<typeof setup>['call'], body: Record<string, unknown> = {}) {
  const res = await call('POST', '/v1/integrations/review-services', { ...SERVICE, ...body });
  expect(res.status).toBe(201);
  const json = (await res.json()) as { service: { id: string }; secret: string };
  return { id: json.service.id, secret: json.secret };
}

/** Workflow settings with Security review handled by the given service. */
function workflowUsing(serviceId: string): WorkflowSettings {
  const w = defaultWorkflowSettings();
  w['Security review'] = { ...w['Security review']!, handledBy: 'external', serviceId };
  return w;
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

  it('hand out a review service secret once, and again only when rotated', async () => {
    const { call, s } = setup();
    expect((await call('POST', '/v1/integrations/review-services', { ...SERVICE, url: 'ftp://sec.example' })).status).toBe(422);
    const { id, secret } = await addService(call);
    expect(id).toBe('sectool');
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const view = await (await call('GET', '/v1/integrations')).text();
    expect(view).not.toContain(secret);
    expect(JSON.parse(view).reviewServices).toEqual([{ id, ...SERVICE, hasSecret: true, usedBy: [] }]);
    expect(JSON.stringify(s.saved)).not.toContain(secret);
    const rotated = (await (await call('POST', `/v1/integrations/review-services/${id}/rotate-secret`)).json()) as { secret: string };
    expect(rotated.secret).not.toBe(secret);
    expect(s.saved.at(-1)).toEqual({ action: 'integration.review_service_secret_rotated', metadata: { id } });
    expect((await call('POST', '/v1/integrations/review-services/nope/rotate-secret')).status).toBe(404);
    // A second service with the same name gets its own id.
    expect((await addService(call)).id).toBe('sectool-2');
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
    const { id, secret } = await addService(call);
    s.stage.external_service = id;
    expect(await queueExternalStages(deps, REQ)).toBe(1);
    const payload = s.queue[0]!.payload as unknown as ReturnType<typeof stageStartedPayload> & { data_mode: string; service: { id: string } };
    expect(payload).toMatchObject({
      type: 'stage.started',
      data_mode: 'push',
      service: { id },
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
    const headers = req.init.headers as Record<string, string>;
    expect(headers['x-service-id']).toBe(id);
    expect(headers['x-event-id']).toBe(payload.event_id);
    expect(await verifySignature(secret, headers['x-signature'], req.init.body as string)).toBe('ok');
    expect(req.init.redirect).toBe('manual');
  });

  it('sends no answers in pull mode', async () => {
    const sent: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent.push(init);
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const { s, deps, call } = setup({ fetchImpl });
    const { id } = await addService(call, { name: 'Pull tool', dataMode: 'pull', sendAllAnswers: true });
    s.stage.external_service = id;
    await queueExternalStages(deps, REQ);
    await deliverDue(deps);
    const body = JSON.parse(sent[0]!.body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['callback', 'created_at', 'data_mode', 'event_id', 'organization', 'request', 'service', 'stage', 'type'].filter((k) => k in body).sort());
    expect(body).toMatchObject({ type: 'stage.started', data_mode: 'pull', request: { id: REQ, confidential: false } });
    expect(Object.keys(body.request as object).sort()).toEqual(['confidential', 'id']);
    expect(JSON.stringify(body)).not.toMatch(/Acme|Planning|SSO|Ann Lee|risk/);
    expect(pullPayload(s.request, s.stage, id, { publicApiUrl: 'https://api.example' })).not.toHaveProperty('request.answers');
  });

  it('marks events failed with a clear reason when the service is missing or off', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const { s, deps, call } = setup({ fetchImpl });
    const { id } = await addService(call);
    s.stage.external_service = 'gone';
    await queueExternalStages(deps, REQ);
    await deliverDue(deps);
    expect(s.queue[0]).toMatchObject({ failed: true });
    expect(s.queue[0]!.error).toMatch(/does not exist/);
    await call('PUT', `/v1/integrations/review-services/${id}`, { ...SERVICE, enabled: false });
    s.stage.external_service = id;
    await queueExternalStages(deps, REQ);
    await deliverDue(deps);
    expect(s.queue[1]!.error).toMatch(/turned off/);
    const log = (await (await call('GET', `/v1/integrations/review-services/${id}/deliveries`)).json()) as { last_error: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]!.last_error).toMatch(/turned off/);
  });
});

describe('external review service endpoints', () => {
  async function signedSetup() {
    const ctx = setup();
    const { id, secret } = await addService(ctx.call);
    ctx.s.stage.external_service = id;
    const post = async (body: Record<string, unknown>, sign = secret) => {
      const raw = JSON.stringify(body);
      return ctx.app.request(`/v1/external/stages/${STAGE}/status`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': await signatureHeader(sign, raw) }, body: raw });
    };
    return { ...ctx, id, secret, post };
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
  it("verify with the secret of the stage's own service", async () => {
    const { app, call, s, secret } = await signedSetup();
    const other = await addService(call, { name: 'Legal tool' });
    const raw = JSON.stringify({ event_id: 'x1', org_id: ORG, status: 'in_review' });
    const send = async (sign: string) =>
      app.request(`/v1/external/stages/${STAGE}/status`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': await signatureHeader(sign, raw) }, body: raw });
    // Another service's valid secret does not open this stage.
    expect((await send(other.secret)).status).toBe(401);
    expect((await send(secret)).status).toBe(200);
    // A stage of the legacy single service uses the "default" service.
    s.stage.external_service = null;
    expect((await send(secret)).status).toBe(401);
  });

  it('read the legacy single service as "default" and convert it on the next save', async () => {
    const { s, call, key, app } = setup();
    const legacySecret = 'a'.repeat(64);
    s.integration = {
      config: { external: { enabled: true, name: 'Old tool', outboundUrl: 'https://old.example/hook', sendAllAnswers: true } },
      secrets: await encrypt((await key)!, JSON.stringify({ externalSecret: legacySecret })),
    };
    const view = (await (await call('GET', '/v1/integrations')).json()) as { reviewServices: unknown[] };
    expect(view.reviewServices).toEqual([{ id: 'default', name: 'Old tool', url: 'https://old.example/hook', dataMode: 'push', sendAllAnswers: true, enabled: true, hasSecret: true, usedBy: [] }]);
    const raw = JSON.stringify({ event_id: 'l1', org_id: ORG, status: 'in_review' });
    const res = await app.request(`/v1/external/stages/${STAGE}/status`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': await signatureHeader(legacySecret, raw) }, body: raw });
    expect(res.status).toBe(200);
    await addService(call, { name: 'New tool' });
    expect(s.integration!.config.external).toBeUndefined();
    expect(s.integration!.config.reviewServices!.map((x) => x.id)).toEqual(['default', 'new-tool']);
    const secrets = JSON.parse(await decrypt((await key)!, s.integration!.secrets!)) as { externalSecret?: string; serviceSecrets: Record<string, string> };
    expect(secrets.externalSecret).toBeUndefined();
    expect(secrets.serviceSecrets.default).toBe(legacySecret);
  });

  it('give a pull-mode service the full data on a signed GET', async () => {
    const ctx = setup();
    const { id, secret } = await addService(ctx.call, { dataMode: 'pull' });
    ctx.s.stage.external_service = id;
    const res = await ctx.app.request(`/v1/external/stages/${STAGE}?org_id=${ORG}`, { headers: { 'x-signature': await signatureHeader(secret, '') } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data_mode: 'pull', service: { id }, request: { title: 'Acme Board', answers: { signInMethod: {} } } });
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

describe('settings in the UI, with the environment as fallback', () => {
  it('saves the public API address and uses it over the environment', async () => {
    const { call, s, settings } = setup({ env: { PUBLIC_API_URL: 'https://env.example' } });
    expect(((await (await call('GET', '/v1/integrations')).json()) as { server: unknown }).server).toEqual({ publicApiUrl: 'https://env.example', source: 'env' });
    expect((await call('PUT', '/v1/integrations/server', { publicApiUrl: 'http://api.example' })).status).toBe(422);
    expect((await call('PUT', '/v1/integrations/server', { publicApiUrl: 'https://user:pw@api.example' })).status).toBe(422);
    expect((await call('PUT', '/v1/integrations/server', { publicApiUrl: 'http://localhost:8787' })).status).toBe(200);
    expect((await call('PUT', '/v1/integrations/server', { publicApiUrl: 'https://ui.example/' })).status).toBe(200);
    expect(s.saved.at(-1)).toEqual({ action: 'integration.server_updated', metadata: { public_api_url: 'https://ui.example' } });
    expect((await settings.forOrg(ORG)).publicApiUrl).toBe('https://ui.example');
    expect(((await (await call('GET', '/v1/integrations')).json()) as { server: unknown }).server).toEqual({ publicApiUrl: 'https://ui.example', source: 'settings' });
  });

  it('saves email without returning or auditing the key, keeps a stored key when omitted, and sends a test', async () => {
    const sent: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: init.body as string });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const { call, s, key } = setup({ fetchImpl, env: { EMAIL_PROVIDER: 'log' } });
    expect(((await (await call('GET', '/v1/integrations')).json()) as { email: unknown }).email).toEqual({ provider: 'log', from: '', configured: true, source: 'env' });
    expect((await call('PUT', '/v1/integrations/email', { provider: 'carrier-pigeon', from: '' })).status).toBe(422);
    expect((await call('PUT', '/v1/integrations/email', { provider: 'resend', from: 'Acme <invites@acme.example>' })).status).toBe(422);
    expect((await call('PUT', '/v1/integrations/email', { provider: 'resend', from: 'not an address', resendApiKey: 're_123456789' })).status).toBe(422);
    expect((await call('PUT', '/v1/integrations/email', { provider: 'smtp', from: 'a@acme.example', smtpUrl: 'smtps://u:p@smtp.acme.example:465' })).status).toBe(422);
    expect((await call('PUT', '/v1/integrations/email', { provider: 'resend', from: 'Acme <invites@acme.example>', resendApiKey: 're_123456789' })).status).toBe(200);
    expect((await call('PUT', '/v1/integrations/email', { provider: 'resend', from: 'Acme <hello@acme.example>' })).status).toBe(200);
    expect(JSON.parse(await decrypt((await key)!, s.integration!.secrets!)).resendApiKey).toBe('re_123456789');
    expect(JSON.stringify(s.saved)).not.toContain('re_123456789');
    const view = await (await call('GET', '/v1/integrations')).text();
    expect(view).not.toContain('re_123456789');
    expect(JSON.parse(view).email).toEqual({ provider: 'resend', from: 'Acme <hello@acme.example>', configured: true, source: 'settings' });
    // The test mail goes to the admin through the saved provider (Resend here).
    const res = await call('POST', '/v1/integrations/email/test', {});
    expect(res.status).toBe(200);
    expect(sent[0]!.url).toBe('https://api.resend.com/emails');
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ from: 'Acme <hello@acme.example>', to: ['admin@acme.example'] });
  });

  it('reports a failed test email as 502 without details', async () => {
    const fetchImpl = (async () => new Response('{"secret":"x"}', { status: 403 })) as unknown as typeof fetch;
    const { call } = setup({ fetchImpl });
    expect((await call('POST', '/v1/integrations/email/test', {})).status).toBe(422);
    await call('PUT', '/v1/integrations/email', { provider: 'resend', from: 'a@acme.example', resendApiKey: 're_123456789' });
    const res = await call('POST', '/v1/integrations/email/test', {});
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'The email service rejected the API key or sender' });
  });

  it('uses SMTP only on the Node API, and the saved mailer for invitations', async () => {
    const { call, mails, app } = setup({ smtp: true });
    expect((await call('PUT', '/v1/integrations/email', { provider: 'smtp', from: 'a@acme.example', smtpUrl: 'smtps://u:p@smtp.acme.example:465' })).status).toBe(200);
    expect(await (await app.request('/v1/invitations/email-status', { headers: { authorization: 'Bearer t' } })).json()).toEqual({ enabled: true });
    const res = await call('POST', '/v1/invitations', { invitations: [{ email: 'bob@acme.example', role: 'reviewer' }] });
    expect(((await res.json()) as { results: { emailed: boolean }[] }).results[0]!.emailed).toBe(true);
    expect(mails).toEqual([{ to: 'bob@acme.example', subject: 'Join Acme on [Product name]', via: 'smtp:smtps://u:p@smtp.acme.example:465' }]);
    // Without a token the status says nothing about an organization.
    expect(await (await app.request('/v1/invitations/email-status')).json()).toEqual({ enabled: false });
  });

  it('saves the AI provider and uses it for that organization only', async () => {
    const { call, app, s, key } = setup();
    expect(await (await app.request('/v1/ai', { headers: { authorization: 'Bearer t' } })).json()).toEqual({ enabled: false, provider: null });
    expect((await call('PUT', '/v1/integrations/ai', { provider: 'parallel' })).status).toBe(422);
    expect((await call('PUT', '/v1/integrations/ai', { provider: 'parallel', processor: 'ultra', apiKey: 'par-123456789' })).status).toBe(422);
    expect((await call('PUT', '/v1/integrations/ai', { provider: 'parallel', processor: 'lite', apiKey: 'par-123456789' })).status).toBe(200);
    expect(JSON.stringify(s.saved)).not.toContain('par-123456789');
    expect(JSON.parse(await decrypt((await key)!, s.integration!.secrets!)).parallelApiKey).toBe('par-123456789');
    const view = (await (await call('GET', '/v1/integrations')).json()) as { ai: unknown };
    expect(view.ai).toEqual({ provider: 'parallel', processor: 'lite', configured: true, source: 'settings' });
    expect(await (await app.request('/v1/ai', { headers: { authorization: 'Bearer t' } })).json()).toMatchObject({ enabled: true });
    expect(await (await app.request('/v1/ai')).json()).toMatchObject({ enabled: false });
    expect((await setup({ caller: { ...admin, role: 'reviewer' } }).call('PUT', '/v1/integrations/ai', { provider: 'off' })).status).toBe(403);
  });

  it('caches per organization for a short time and drops the cache on save', async () => {
    let t = 0;
    const { store } = memoryStore();
    const key = importEncryptionKey(KEY_B64);
    const resolver = settingsResolver({ store, key, env: envSettings({ PUBLIC_API_URL: 'https://env.example' }), now: () => t });
    expect((await resolver.forOrg(ORG)).publicApiUrl).toBe('https://env.example');
    await store.saveIntegration(ORG, { config: { server: { publicApiUrl: 'https://ui.example' } }, secrets: null }, 'u1', 'x', {});
    expect((await resolver.forOrg(ORG)).publicApiUrl).toBe('https://env.example');
    t = 31_000;
    expect((await resolver.forOrg(ORG)).publicApiUrl).toBe('https://ui.example');
    await store.saveIntegration(ORG, { config: {}, secrets: null }, 'u1', 'x', {});
    resolver.invalidate(ORG);
    expect((await resolver.forOrg(ORG)).publicApiUrl).toBe('https://env.example');
  });
});

describe('review services', () => {
  it('are managed by org admins only; members see names only', async () => {
    const reviewer = setup({ caller: { ...admin, role: 'reviewer' } });
    expect((await reviewer.call('POST', '/v1/integrations/review-services', SERVICE)).status).toBe(403);
    expect((await reviewer.call('GET', '/v1/integrations/review-services/x/deliveries')).status).toBe(403);
    expect((await setup({ caller: null }).call('GET', '/v1/review-services')).status).toBe(403);
    const { call, s } = setup();
    await addService(call);
    s.integration = { ...s.integration!, config: s.integration!.config };
    expect(await (await call('GET', '/v1/review-services')).json()).toEqual([{ id: 'sectool', name: 'SecTool' }]);
    // Any member may list them, also with the shared memory of this setup.
    const requester = setup({ caller: { ...admin, role: 'requester' } });
    await requester.store.saveIntegration(ORG, s.integration!, 'u1', 'x', {});
    expect(await (await requester.call('GET', '/v1/review-services')).json()).toEqual([{ id: 'sectool', name: 'SecTool' }]);
    expect((await setup({ withKey: false }).call('POST', '/v1/integrations/review-services', SERVICE)).status).toBe(503);
  });

  it('refuse local and private addresses unless allowed', async () => {
    const { call } = setup();
    for (const url of ['http://localhost:9000/hook', 'https://127.0.0.1/hook', 'https://10.1.2.3/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://intranet/x']) {
      expect((await call('POST', '/v1/integrations/review-services', { ...SERVICE, url })).status, url).toBe(422);
    }
    const local = setup({ allowLocal: true });
    expect((await local.call('POST', '/v1/integrations/review-services', { ...SERVICE, url: 'http://localhost:9000/hook' })).status).toBe(201);
  });

  it('update, and refuse to delete a service a review still uses', async () => {
    const { call, s } = setup();
    const { id } = await addService(call);
    const put = await call('PUT', `/v1/integrations/review-services/${id}`, { ...SERVICE, name: 'SecTool 2', dataMode: 'pull' });
    expect(await put.json()).toEqual({ service: { id, ...SERVICE, name: 'SecTool 2', dataMode: 'pull' } });
    expect((await call('PUT', '/v1/integrations/review-services/nope', SERVICE)).status).toBe(404);
    s.workflow = workflowUsing(id);
    expect(((await (await call('GET', '/v1/integrations')).json()) as { reviewServices: { usedBy: string[] }[] }).reviewServices[0]!.usedBy).toEqual(['Security review']);
    const busy = await call('DELETE', `/v1/integrations/review-services/${id}`);
    expect(busy.status).toBe(409);
    expect(((await busy.json()) as { error: string }).error).toMatch(/Security review/);
    s.workflow = null;
    expect((await call('DELETE', `/v1/integrations/review-services/${id}`)).status).toBe(204);
    expect(s.saved.at(-1)).toEqual({ action: 'integration.review_service_removed', metadata: { id } });
    expect(((await (await call('GET', '/v1/integrations')).json()) as { reviewServices: unknown[] }).reviewServices).toEqual([]);
    expect((await call('DELETE', `/v1/integrations/review-services/${id}`)).status).toBe(404);
  });

  it('send a signed ping and report only status and time', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    let answer: () => Promise<Response> = async () => new Response('secret body from service', { status: 200 });
    const fetchImpl = (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return answer();
    }) as unknown as typeof fetch;
    const { call } = setup({ fetchImpl });
    const { id, secret } = await addService(call);
    const ok = (await (await call('POST', `/v1/integrations/review-services/${id}/test`)).json()) as Record<string, unknown>;
    expect(ok).toMatchObject({ ok: true, status: 200 });
    expect(typeof ok.ms).toBe('number');
    expect(JSON.stringify(ok)).not.toContain('secret body');
    const body = JSON.parse(sent[0]!.init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ type: 'ping', organization: { id: ORG }, service: { id } });
    expect(String(body.event_id)).toMatch(/^ping:/);
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(await verifySignature(secret, headers['x-signature'], sent[0]!.init.body as string)).toBe('ok');
    expect(headers['x-service-id']).toBe(id);
    answer = async () => new Response('nope', { status: 500 });
    expect(await (await call('POST', `/v1/integrations/review-services/${id}/test`)).json()).toMatchObject({ ok: false, status: 500, error: 'The service answered 500' });
    answer = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await (await call('POST', `/v1/integrations/review-services/${id}/test`)).json()).toMatchObject({ ok: false, status: null, error: 'The service could not be reached' });
  });

  it('list recent deliveries of one service', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    const { call, s, deps } = setup({ fetchImpl });
    const a = await addService(call);
    const b = await addService(call, { name: 'Other' });
    s.stage.external_service = a.id;
    await queueExternalStages(deps, REQ);
    await deliverDue(deps);
    const log = (await (await call('GET', `/v1/integrations/review-services/${a.id}/deliveries`)).json()) as Record<string, unknown>[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ type: 'stage.started', attempts: 0, last_error: null });
    expect(log[0]!.delivered_at).toBeTruthy();
    expect(Object.keys(log[0]!).sort()).toEqual(['attempts', 'created_at', 'delivered_at', 'failed_at', 'id', 'last_error', 'next_attempt_at', 'type']);
    expect(await (await call('GET', `/v1/integrations/review-services/${b.id}/deliveries`)).json()).toEqual([]);
    expect((await call('GET', '/v1/integrations/review-services/nope/deliveries')).status).toBe(404);
  });
});

describe('exchange spec', () => {
  it('is public, cacheable and describes both directions', async () => {
    const { app } = setup({ caller: null });
    const res = await app.request('/v1/external/spec');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown>; webhooks: Record<string, unknown>; components: { schemas: Record<string, { properties?: Record<string, { enum?: string[] }> }> } };
    expect(spec.openapi).toBe('3.1.0');
    expect(Object.keys(spec.paths)).toEqual(['/external/stages/{stageId}/status', '/external/stages/{stageId}']);
    expect(Object.keys(spec.webhooks)).toEqual(['ping', 'stage.started (push)', 'stage.started (pull)']);
    expect(spec.components.schemas.StatusUpdate!.properties!.status!.enum).toContain('approved_with_conditions');
    expect(JSON.stringify(spec)).toContain('X-Signature');
  });
});

describe('without the encryption key', () => {
  it('saves the server address but keeps stored secrets untouched', async () => {
    const { call, s } = setup({ withKey: false });
    s.integration = { config: {}, secrets: 'iv.ciphertext' };
    expect((await call('PUT', '/v1/integrations/server', { publicApiUrl: 'https://ui.example' })).status).toBe(200);
    expect(s.integration).toEqual({ config: { server: { publicApiUrl: 'https://ui.example' } }, secrets: 'iv.ciphertext' });
    expect((await call('PUT', '/v1/integrations/email', { provider: 'log', from: '' })).status).toBe(503);
  });
});
