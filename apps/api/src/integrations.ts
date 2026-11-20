import { parseExternalStatusUpdate } from '@app/shared';
import { Hono, type Context } from 'hono';
import type { Caller } from './admin';
import { decrypt, encrypt, randomSecret, verifySignature, type EncryptionKey } from './crypto';
import { readSecrets, runOutbox, stageStartedPayload, type DispatcherDeps } from './dispatcher';
import { ExternalUpdateRejected, SLACK_EVENTS, type IntegrationConfig, type IntegrationSecrets, type IntegrationStore, type SlackEvent } from './integrationStore';
import { UnauthorizedError, type RequestStore } from './requests';
import { hostnameOf, lookupUpGuard, UpGuardError } from './upguard';

// Integrations: admin settings (Slack, UpGuard, an external review service), the signed
// endpoints the external service calls, and the UpGuard lookup for reviewers.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEWER_ROLES = new Set(['org_admin', 'process_manager', 'reviewer']);

export interface IntegrationRouteOptions {
  store: IntegrationStore;
  requests: RequestStore;
  getCaller: (token: string) => Promise<Caller | null>;
  key: Promise<EncryptionKey | null>;
  webOrigin: string;
  publicApiUrl?: string;
  upguardBaseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function integrationRoutes(o: IntegrationRouteOptions) {
  const routes = new Hono();
  const deps: DispatcherDeps = { store: o.store, key: o.key, webOrigin: o.webOrigin, publicApiUrl: o.publicApiUrl, fetchImpl: o.fetchImpl };
  const now = o.now ?? Date.now;

  async function caller(c: Context, roles: Set<string>): Promise<Caller | Response> {
    const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return c.json({ error: 'Sign in to continue' }, 401);
    try {
      const who = await o.getCaller(token);
      if (!who || !roles.has(who.role)) return c.json({ error: 'You do not have access to this' }, 403);
      return who;
    } catch (error) {
      if (error instanceof UnauthorizedError) return c.json({ error: 'Sign in to continue' }, 401);
      throw error;
    }
  }
  const admin = (c: Context) => caller(c, new Set(['org_admin']));

  async function load(orgId: string): Promise<{ config: IntegrationConfig; secrets: IntegrationSecrets }> {
    const record = await o.store.getIntegration(orgId);
    const key = await o.key;
    return { config: record?.config ?? {}, secrets: key && record?.secrets ? (JSON.parse(await decrypt(key, record.secrets)) as IntegrationSecrets) : {} };
  }
  async function save(orgId: string, config: IntegrationConfig, secrets: IntegrationSecrets, actorId: string, action: string, metadata: Record<string, unknown>) {
    const key = await o.key;
    if (!key) throw new Error('encryption key missing');
    const hasSecrets = Object.values(secrets).some(Boolean);
    await o.store.saveIntegration(orgId, { config, secrets: hasSecrets ? await encrypt(key, JSON.stringify(secrets)) : null }, actorId, action, metadata);
  }
  async function body(c: Context): Promise<Record<string, unknown> | Response> {
    try {
      const b = (await c.req.json()) as unknown;
      if (!b || typeof b !== 'object' || Array.isArray(b)) return c.json({ error: 'Expected a JSON object' }, 400);
      return b as Record<string, unknown>;
    } catch {
      return c.json({ error: 'Expected JSON' }, 400);
    }
  }
  const needKey = async (c: Context) =>
    (await o.key) ? null : c.json({ error: 'Integrations need INTEGRATION_ENCRYPTION_KEY on the API server (see apps/api/.env.example)' }, 503);

  // ---------------------------------------------------------------------------
  // Admin settings
  // ---------------------------------------------------------------------------

  routes.get('/integrations', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const encryptionReady = (await o.key) !== null;
    const { config, secrets } = encryptionReady ? await load(who.orgId) : { config: (await o.store.getIntegration(who.orgId))?.config ?? {}, secrets: {} as IntegrationSecrets };
    return c.json({
      encryptionReady,
      slack: { enabled: !!config.slack?.enabled, configured: !!secrets.slackWebhookUrl, events: config.slack?.events ?? [...SLACK_EVENTS] },
      upguard: { enabled: !!config.upguard?.enabled, configured: !!secrets.upguardApiKey },
      external: {
        enabled: !!config.external?.enabled,
        name: config.external?.name ?? '',
        outboundUrl: config.external?.outboundUrl ?? '',
        configured: !!secrets.externalSecret,
        sendAllAnswers: !!config.external?.sendAllAnswers,
      },
    });
  });

  routes.put('/integrations/slack', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const missing = await needKey(c);
    if (missing) return missing;
    const b = await body(c);
    if (b instanceof Response) return b;
    if (typeof b.enabled !== 'boolean') return c.json({ error: 'Choose whether Slack is on' }, 422);
    if (!Array.isArray(b.events) || b.events.some((e) => !(SLACK_EVENTS as readonly unknown[]).includes(e))) return c.json({ error: 'Choose known events' }, 422);
    if (b.webhookUrl !== undefined && (typeof b.webhookUrl !== 'string' || !/^https:\/\/hooks\.slack\.com\/\S+$/.test(b.webhookUrl) || b.webhookUrl.length > 500)) {
      return c.json({ error: 'The webhook URL must start with https://hooks.slack.com/' }, 422);
    }
    const { config, secrets } = await load(who.orgId);
    const nextSecrets = { ...secrets, ...(typeof b.webhookUrl === 'string' ? { slackWebhookUrl: b.webhookUrl } : {}) };
    if (b.enabled && !nextSecrets.slackWebhookUrl) return c.json({ error: 'Enter the Slack webhook URL' }, 422);
    const wasOn = !!config.slack?.enabled;
    await save(who.orgId, { ...config, slack: { enabled: b.enabled, events: [...new Set(b.events as SlackEvent[])] } }, nextSecrets, who.userId, 'integration.slack_updated', {
      enabled: b.enabled,
      events: b.events,
      webhook_changed: typeof b.webhookUrl === 'string',
    });
    if (b.enabled && !wasOn) await o.store.resetCursor(who.orgId);
    return c.json({ ok: true });
  });

  routes.post('/integrations/slack/test', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const missing = await needKey(c);
    if (missing) return missing;
    const { secrets } = await load(who.orgId);
    if (!secrets.slackWebhookUrl) return c.json({ error: 'Save a Slack webhook URL first' }, 422);
    try {
      const res = await (o.fetchImpl ?? fetch)(secrets.slackWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `Test message from [Product name]. Notifications will arrive in this channel. <${o.webOrigin}|Open>` }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return c.json({ error: `Slack answered ${res.status}. Check the webhook URL.` }, 502);
    } catch {
      return c.json({ error: 'Slack could not be reached' }, 502);
    }
    return c.json({ ok: true });
  });

  routes.put('/integrations/upguard', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const missing = await needKey(c);
    if (missing) return missing;
    const b = await body(c);
    if (b instanceof Response) return b;
    if (typeof b.enabled !== 'boolean') return c.json({ error: 'Choose whether UpGuard is on' }, 422);
    if (b.apiKey !== undefined && (typeof b.apiKey !== 'string' || b.apiKey.trim().length < 8 || b.apiKey.length > 500)) return c.json({ error: 'Enter a valid UpGuard API key' }, 422);
    const { config, secrets } = await load(who.orgId);
    const nextSecrets = { ...secrets, ...(typeof b.apiKey === 'string' ? { upguardApiKey: b.apiKey.trim() } : {}) };
    if (b.enabled && !nextSecrets.upguardApiKey) return c.json({ error: 'Enter the UpGuard API key' }, 422);
    await save(who.orgId, { ...config, upguard: { enabled: b.enabled } }, nextSecrets, who.userId, 'integration.upguard_updated', { enabled: b.enabled, key_changed: typeof b.apiKey === 'string' });
    return c.json({ ok: true });
  });

  routes.put('/integrations/external', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const missing = await needKey(c);
    if (missing) return missing;
    const b = await body(c);
    if (b instanceof Response) return b;
    if (typeof b.enabled !== 'boolean' || typeof b.sendAllAnswers !== 'boolean') return c.json({ error: 'Choose whether the service is on and which answers it gets' }, 422);
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 1 || name.length > 60) return c.json({ error: 'Name the service (1 to 60 characters)' }, 422);
    if (typeof b.outboundUrl !== 'string' || !/^https:\/\/\S+$/.test(b.outboundUrl) || b.outboundUrl.length > 500) return c.json({ error: 'The service URL must start with https://' }, 422);
    const { config, secrets } = await load(who.orgId);
    const generate = b.rotateSecret === true || !secrets.externalSecret;
    const nextSecrets = generate ? { ...secrets, externalSecret: randomSecret() } : secrets;
    await save(
      who.orgId,
      { ...config, external: { enabled: b.enabled, name, outboundUrl: b.outboundUrl, sendAllAnswers: b.sendAllAnswers } },
      nextSecrets,
      who.userId,
      'integration.external_updated',
      { enabled: b.enabled, name, send_all_answers: b.sendAllAnswers, secret_rotated: generate },
    );
    // The secret is shown once, when it is created.
    return c.json(generate ? { ok: true, secret: nextSecrets.externalSecret } : { ok: true });
  });

  // ---------------------------------------------------------------------------
  // Called by the external review service, signed with the shared secret
  // ---------------------------------------------------------------------------

  async function externalSecret(orgId: string): Promise<string | null> {
    if (!UUID.test(orgId)) return null;
    const record = await o.store.getIntegration(orgId);
    if (!record?.config.external?.enabled) return null;
    return (await readSecrets(await o.key, record.secrets).catch(() => ({}) as IntegrationSecrets)).externalSecret ?? null;
  }
  const unauthorized = (c: Context) => c.json({ error: 'Invalid or missing signature' }, 401);

  routes.post('/external/stages/:stageId/status', async (c) => {
    const stageId = c.req.param('stageId');
    if (!UUID.test(stageId)) return c.json({ error: 'Not found' }, 404);
    const raw = await c.req.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ error: 'Expected JSON' }, 400);
    }
    const orgId = (json as { org_id?: unknown } | null)?.org_id;
    const secret = typeof orgId === 'string' ? await externalSecret(orgId) : null;
    // Same answer for an unknown organization and a wrong signature.
    if (!secret || (await verifySignature(secret, c.req.header('x-signature'), raw, now())) !== 'ok') return unauthorized(c);
    const parsed = parseExternalStatusUpdate(json);
    if ('error' in parsed) return c.json({ error: parsed.error }, 422);
    const u = parsed.update;
    if (!(await o.store.recordInbound(u.org_id, u.event_id))) return c.json({ ok: true, duplicate: true });
    let result: 'ok' | 'not_found' | 'closed';
    try {
      result = await o.store.applyExternalStatus(u.org_id, stageId, u);
    } catch (error) {
      if (error instanceof ExternalUpdateRejected) return c.json({ error: error.message }, 422);
      throw error;
    }
    if (result === 'not_found') return c.json({ error: 'No external stage with this id in your organization' }, 404);
    if (result === 'closed') return c.json({ error: 'This stage is already decided' }, 409);
    void runOutbox(deps, u.org_id);
    return c.json({ ok: true });
  });

  routes.get('/external/stages/:stageId', async (c) => {
    const stageId = c.req.param('stageId');
    const orgId = c.req.query('org_id') ?? '';
    if (!UUID.test(stageId)) return c.json({ error: 'Not found' }, 404);
    const secret = await externalSecret(orgId);
    if (!secret || (await verifySignature(secret, c.req.header('x-signature'), '', now())) !== 'ok') return unauthorized(c);
    const stage = await o.store.stage(orgId, stageId);
    if (!stage?.external) return c.json({ error: 'Not found' }, 404);
    const [request] = await o.store.requests([stage.request_id]);
    if (!request) return c.json({ error: 'Not found' }, 404);
    const record = await o.store.getIntegration(orgId);
    return c.json({
      ...stageStartedPayload(request, stage, { sendAllAnswers: !!record?.config.external?.sendAllAnswers, publicApiUrl: o.publicApiUrl }),
      stage_status: stage.status,
    });
  });

  // ---------------------------------------------------------------------------
  // UpGuard lookup for reviewers
  // ---------------------------------------------------------------------------

  routes.post('/requests/:id/vendor-risk/upguard', async (c) => {
    const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    const who = await caller(c, REVIEWER_ROLES);
    if (who instanceof Response) return who;
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json({ error: 'Not found' }, 404);
    // Read with the caller's token: only a request they can see.
    const request = await o.requests.getAsUser(token!, id);
    if (!request) return c.json({ error: 'Not found' }, 404);
    const { config, secrets } = await load(who.orgId);
    if (!config.upguard?.enabled || !secrets.upguardApiKey) return c.json({ error: 'UpGuard is not set up. An org admin can turn it on in Admin → Integrations.' }, 409);
    const hostname = hostnameOf(request.answers.vendorWebsite);
    if (!hostname) return c.json({ error: 'The request has no vendor website to look up' }, 422);
    try {
      const rating = await lookupUpGuard({ baseUrl: o.upguardBaseUrl, apiKey: secrets.upguardApiKey, hostname, fetchImpl: o.fetchImpl });
      const row = await o.store.saveVendorRisk({ org_id: who.orgId, request_id: id, hostname, data: rating as unknown as Record<string, unknown>, fetched_by: who.userId });
      return c.json(row);
    } catch (error) {
      if (error instanceof UpGuardError) return c.json({ error: error.message }, 502);
      throw error;
    }
  });

  return routes;
}
