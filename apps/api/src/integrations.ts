import { AiProviderError } from './ai/provider';
import { ORG_ROLES, parseExternalStatusUpdate, parseReviewServiceInput, parseWorkflowSettings, reviewServiceId, type ReviewService } from '@app/shared';
import { Hono, type Context } from 'hono';
import type { Caller } from './admin';
import { decrypt, encrypt, randomSecretB64url, verifySignature, type EncryptionKey } from './crypto';
import { runOutbox, sendSigned, stageStartedPayload, type DispatcherDeps } from './dispatcher';
import { externalReviewSpec } from './externalSpec';
import {
  AI_PROCESSORS,
  AI_PROVIDERS,
  EMAIL_PROVIDERS,
  ExternalUpdateRejected,
  SLACK_EVENTS,
  type AiProcessor,
  type AiProviderName,
  type EmailProviderName,
  type IntegrationConfig,
  type IntegrationSecrets,
  type IntegrationStore,
  type SlackEvent,
} from './integrationStore';
import { reviewServicesOf, type SettingsResolver } from './orgSettings';
import { UnauthorizedError, type RequestStore } from './requests';
import { hostnameOf, lookupUpGuard, UpGuardError } from './upguard';

// Integrations: admin settings (Slack, UpGuard, an external review service), the signed
// endpoints the external service calls, and the UpGuard lookup for reviewers.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEWER_ROLES = new Set(['org_admin', 'process_manager', 'reviewer']);
const ALL_ROLES = new Set<string>(ORG_ROLES);

/** https://, or http:// on this machine for testing. */
export function isPublicApiUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password || url.length > 300) return false;
    return u.protocol === 'https:' || (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

/** Loopback, private, link-local and internal names: refused for review services unless allowed. */
export function isLocalAddress(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !host.includes(':')) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:');
  return false;
}

export interface IntegrationRouteOptions {
  store: IntegrationStore;
  requests: RequestStore;
  getCaller: (token: string) => Promise<Caller | null>;
  key: Promise<EncryptionKey | null>;
  webOrigin: string;
  /** Environment fallback for the public API address. */
  publicApiUrl?: string;
  upguardBaseUrl: string;
  /** Per-organization settings (UI first, environment as fallback). */
  settings: SettingsResolver;
  /** SMTP needs the Node API. */
  smtpSupported?: boolean;
  /** Allow localhost and private addresses for review services (local testing only). */
  allowLocalServiceUrls?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const AI_KEY_FIELD = { parallel: 'parallelApiKey', anthropic: 'anthropicApiKey', openai: 'openaiApiKey', openai_compatible: 'openaiCompatibleApiKey' } as const;

/** Rejects values that cannot be a key for this provider, before anything is stored. */
export function aiKeyProblem(provider: string, value: unknown): string | null {
  if (typeof value !== 'string') return 'Enter a valid API key';
  const key = value.trim();
  if (key.length < 8 || key.length > 500) return 'Enter a valid API key';
  if (!/^[\x21-\x7e]+$/.test(key)) return 'An API key has no spaces or special characters; paste it again';
  if (provider === 'anthropic' && !key.startsWith('sk-ant-')) return 'An Anthropic API key starts with sk-ant-';
  if (provider === 'openai' && !key.startsWith('sk-')) return 'An OpenAI API key starts with sk-';
  return null;
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
  /** Save and drop the cached settings so the change applies at once. */
  async function saveAll(orgId: string, config: IntegrationConfig, secrets: IntegrationSecrets, actorId: string, action: string, metadata: Record<string, unknown>) {
    if (await o.key) await save(orgId, config, secrets, actorId, action, metadata);
    else {
      // Without the key (only non-secret settings get here): keep stored secrets as they are.
      const record = await o.store.getIntegration(orgId);
      await o.store.saveIntegration(orgId, { config, secrets: record?.secrets ?? null }, actorId, action, metadata);
    }
    o.settings.invalidate(orgId);
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
    const r = await o.settings.forOrg(who.orgId);
    const { config, secrets } = r;
    const { serviceSecrets } = reviewServicesOf(config, secrets);
    const reviewServices = await Promise.all(
      r.services.map(async (s) => ({ ...s, hasSecret: !!serviceSecrets[s.id], usedBy: await usedBy(who.orgId, s.id) })),
    );
    // Never any secret: only whether one is saved.
    return c.json({
      encryptionReady,
      server: { publicApiUrl: r.publicApiUrl ?? '', source: r.publicApiSource },
      email: { provider: r.email.provider, from: r.email.from, configured: r.email.configured, source: r.email.source },
      ai: {
        provider: r.aiInfo.provider,
        processor: r.aiInfo.processor,
        model: r.aiInfo.model,
        baseUrl: r.aiInfo.baseUrl,
        configured: r.aiInfo.configured,
        source: r.aiInfo.source,
        // Which providers have a saved key; the keys themselves never leave the server.
        savedKeys: r.aiInfo.savedKeys,
        timeoutSeconds: r.aiInfo.timeoutSeconds,
      },
      slack: { enabled: !!config.slack?.enabled, configured: !!secrets.slackWebhookUrl, events: config.slack?.events ?? [...SLACK_EVENTS] },
      upguard: { enabled: !!config.upguard?.enabled, configured: !!secrets.upguardApiKey },
      reviewServices,
      smtpSupported: !!o.smtpSupported,
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
    await saveAll(who.orgId, { ...config, slack: { enabled: b.enabled, events: [...new Set(b.events as SlackEvent[])] } }, nextSecrets, who.userId, 'integration.slack_updated', {
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
    await saveAll(who.orgId, { ...config, upguard: { enabled: b.enabled } }, nextSecrets, who.userId, 'integration.upguard_updated', { enabled: b.enabled, key_changed: typeof b.apiKey === 'string' });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Server address, email and AI, set in the UI (the environment is the fallback)
  // ---------------------------------------------------------------------------

  routes.put('/integrations/server', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const b = await body(c);
    if (b instanceof Response) return b;
    const url = typeof b.publicApiUrl === 'string' ? b.publicApiUrl.trim().replace(/\/+$/, '') : '';
    if (url !== '' && !isPublicApiUrl(url)) return c.json({ error: 'The address must start with https:// (http://localhost is allowed for testing)' }, 422);
    const { config, secrets } = await load(who.orgId);
    const next: IntegrationConfig = { ...config };
    if (url) next.server = { publicApiUrl: url };
    else delete next.server;
    await saveAll(who.orgId, next, secrets, who.userId, 'integration.server_updated', { public_api_url: url || null });
    return c.json({ ok: true });
  });

  routes.put('/integrations/email', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const missing = await needKey(c);
    if (missing) return missing;
    const b = await body(c);
    if (b instanceof Response) return b;
    if (!(EMAIL_PROVIDERS as readonly unknown[]).includes(b.provider)) return c.json({ error: 'Choose how email is sent' }, 422);
    const provider = b.provider as EmailProviderName;
    const from = typeof b.from === 'string' ? b.from.trim() : '';
    if (from.length > 200 || /[\r\n]/.test(from)) return c.json({ error: 'The sender is too long or not on one line' }, 422);
    if ((provider === 'resend' || provider === 'smtp') && !/^(?:[^<>@\r\n]{0,100}<[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+>|[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+)$/.test(from)) {
      return c.json({ error: 'Enter the sender, for example "[Product name] <invites@your-domain.com>"' }, 422);
    }
    if (b.resendApiKey !== undefined && (typeof b.resendApiKey !== 'string' || b.resendApiKey.trim().length < 8 || b.resendApiKey.length > 500)) {
      return c.json({ error: 'Enter a valid Resend API key' }, 422);
    }
    if (b.smtpUrl !== undefined && (typeof b.smtpUrl !== 'string' || !/^smtps?:\/\/\S+$/.test(b.smtpUrl.trim()) || b.smtpUrl.length > 500)) {
      return c.json({ error: 'The SMTP address must look like smtps://user:password@smtp.example.com:465' }, 422);
    }
    if (provider === 'smtp' && !o.smtpSupported) {
      return c.json({ error: 'SMTP works only when the API runs on Node (self-host). Use Resend on this server.' }, 422);
    }
    const { config, secrets } = await load(who.orgId);
    const next: IntegrationSecrets = {
      ...secrets,
      ...(typeof b.resendApiKey === 'string' ? { resendApiKey: b.resendApiKey.trim() } : {}),
      ...(typeof b.smtpUrl === 'string' ? { smtpUrl: b.smtpUrl.trim() } : {}),
    };
    if (provider === 'resend' && !next.resendApiKey) return c.json({ error: 'Enter the Resend API key' }, 422);
    if (provider === 'smtp' && !next.smtpUrl) return c.json({ error: 'Enter the SMTP address' }, 422);
    await saveAll(who.orgId, { ...config, email: { provider, from } }, next, who.userId, 'integration.email_updated', {
      provider,
      from,
      key_changed: typeof b.resendApiKey === 'string',
      smtp_changed: typeof b.smtpUrl === 'string',
    });
    return c.json({ ok: true });
  });

  routes.post('/integrations/email/test', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    if (!who.email) return c.json({ error: 'Your account has no email address to send the test to' }, 422);
    const resolved = await o.settings.forOrg(who.orgId);
    if (!resolved.mailer) return c.json({ error: 'Email is off or not complete. Save the settings first.' }, 422);
    try {
      await resolved.mailer.send({
        to: who.email,
        subject: 'Test email from [Product name]',
        text: 'Email works. Invitations will be sent from this address.',
        html: '<p>Email works. Invitations will be sent from this address.</p>',
      });
    } catch (error) {
      return c.json({ error: error instanceof Error && error.name === 'EmailError' ? error.message : 'The email could not be sent' }, 502);
    }
    return c.json({ ok: true });
  });

  routes.put('/integrations/ai', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const missing = await needKey(c);
    if (missing) return missing;
    const b = await body(c);
    if (b instanceof Response) return b;
    if (!(AI_PROVIDERS as readonly unknown[]).includes(b.provider)) return c.json({ error: 'Choose the AI provider, or off' }, 422);
    const provider = b.provider as AiProviderName;
    const processor = b.processor === undefined ? 'base' : b.processor;
    if (!(AI_PROCESSORS as readonly unknown[]).includes(processor)) return c.json({ error: 'Choose lite, base or core' }, 422);
    if (b.apiKey !== undefined) {
      const problem = aiKeyProblem(provider, b.apiKey);
      if (problem) return c.json({ error: problem }, 422);
    }
    if (b.timeoutSeconds !== undefined && b.timeoutSeconds !== null && (!Number.isInteger(b.timeoutSeconds) || (b.timeoutSeconds as number) < 10 || (b.timeoutSeconds as number) > 300)) {
      return c.json({ error: 'The time limit must be a whole number of seconds from 10 to 300' }, 422);
    }
    const timeoutSeconds = typeof b.timeoutSeconds === 'number' ? b.timeoutSeconds : undefined;
    if (b.model !== undefined && (typeof b.model !== 'string' || b.model.length > 120 || !/^[\w.:/@-]*$/.test(b.model.trim()))) {
      return c.json({ error: 'Enter the model name, for example claude-opus-5-5' }, 422);
    }
    const model = typeof b.model === 'string' ? b.model.trim() : '';
    let baseUrl = '';
    if (provider === 'openai_compatible') {
      if (typeof b.baseUrl !== 'string' || !/^https?:\/\/[^\s]+$/i.test(b.baseUrl.trim()) || b.baseUrl.length > 500) {
        return c.json({ error: 'Enter the server address, for example https://openrouter.ai/api/v1 or http://localhost:11434/v1' }, 422);
      }
      baseUrl = b.baseUrl.trim().replace(/\/+$/, '');
      const local = isLocalAddress(baseUrl);
      if (local && !o.allowLocalServiceUrls) {
        return c.json({ error: 'Local and private addresses are refused. For a model on this machine or network set ALLOW_LOCAL_SERVICE_URLS=true on the API server.' }, 422);
      }
      if (!local && !baseUrl.toLowerCase().startsWith('https://')) return c.json({ error: 'The address must start with https:// (plain http only for local servers)' }, 422);
      if (!model) return c.json({ error: 'Enter the model name your server uses' }, 422);
    }
    if (provider === 'openai' && !model) return c.json({ error: 'Enter the model name, for example the one your OpenAI account uses' }, 422);
    const { config, secrets } = await load(who.orgId);
    const keyField = ({ parallel: 'parallelApiKey', anthropic: 'anthropicApiKey', openai: 'openaiApiKey', openai_compatible: 'openaiCompatibleApiKey' } as const)[provider as Exclude<AiProviderName, 'off'>];
    const next: IntegrationSecrets = { ...secrets, ...(keyField && typeof b.apiKey === 'string' ? { [keyField]: b.apiKey.trim() } : {}) };
    if ((provider === 'parallel' || provider === 'anthropic' || provider === 'openai') && keyField && !next[keyField]) {
      return c.json({ error: `Enter the ${provider === 'parallel' ? 'Parallel' : provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API key` }, 422);
    }
    const ai = { provider, processor: processor as AiProcessor, ...(model ? { model } : {}), ...(baseUrl ? { baseUrl } : {}), ...(timeoutSeconds ? { timeoutSeconds } : {}) };
    await saveAll(who.orgId, { ...config, ai }, next, who.userId, 'integration.ai_updated', {
      provider,
      processor,
      model: model || null,
      base_url: baseUrl || null,
      key_changed: typeof b.apiKey === 'string',
      timeout_seconds: timeoutSeconds ?? null,
    });
    return c.json({ ok: true });
  });

  /** Deletes one provider's saved key. If that provider is in use, AI is turned off. */
  routes.delete('/integrations/ai/keys/:provider', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const missing = await needKey(c);
    if (missing) return missing;
    const provider = c.req.param('provider');
    const keyField = AI_KEY_FIELD[provider as keyof typeof AI_KEY_FIELD];
    if (!keyField) return c.json({ error: 'Unknown provider' }, 404);
    const { config, secrets } = await load(who.orgId);
    const next: IntegrationSecrets = { ...secrets };
    delete next[keyField];
    const inUse = config.ai?.provider === provider;
    const nextConfig: IntegrationConfig = inUse ? { ...config, ai: { ...config.ai!, provider: 'off' } } : config;
    await saveAll(who.orgId, nextConfig, next, who.userId, 'integration.ai_key_removed', { provider, ai_turned_off: inUse });
    return c.json({ ok: true, aiTurnedOff: inUse });
  });

  /**
   * Sends a tiny fixed question to the saved provider: proves the key, model and address
   * work. No request data is sent. At most one test per organization every 10 seconds.
   */
  const lastAiTest = new Map<string, number>();
  routes.post('/integrations/ai/test', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const t = now();
    if (t - (lastAiTest.get(who.orgId) ?? 0) < 10_000) return c.json({ error: 'Wait a few seconds before testing again' }, 429);
    if (lastAiTest.size > 10_000) lastAiTest.clear();
    lastAiTest.set(who.orgId, t);
    const resolved = await o.settings.forOrg(who.orgId);
    if (!resolved.ai) return c.json({ error: 'Save a provider with its key (and model) first' }, 422);
    const started = now();
    try {
      const result = await resolved.ai.run({
        instructions: 'This is a connection test. Answer with ok set to true.',
        input: { test: true },
        outputSchema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } },
        processor: 'lite',
      });
      if (result.content.ok !== true) return c.json({ error: 'The provider answered, but not in the expected format. Check the model name.' }, 502);
    } catch (error) {
      const message = error instanceof AiProviderError ? error.message : 'The provider could not be reached';
      return c.json({ error: message }, 502);
    }
    return c.json({ ok: true, provider: resolved.ai.name, seconds: Math.max(1, Math.round((now() - started) / 1000)) });
  });

  // ---------------------------------------------------------------------------
  // Review services: one microservice per review, if wanted
  // ---------------------------------------------------------------------------

  /** Services and their secrets, with the legacy single service converted. */
  async function services(orgId: string) {
    const { config, secrets } = await load(orgId);
    const { services: list, serviceSecrets } = reviewServicesOf(config, secrets);
    return { config, secrets, list: [...list], serviceSecrets: { ...serviceSecrets } };
  }
  async function saveServices(
    orgId: string,
    s: { config: IntegrationConfig; secrets: IntegrationSecrets; list: ReviewService[]; serviceSecrets: Record<string, string> },
    actorId: string,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    const config: IntegrationConfig = { ...s.config, reviewServices: s.list };
    delete config.external;
    const secrets: IntegrationSecrets = { ...s.secrets, serviceSecrets: s.serviceSecrets };
    delete secrets.externalSecret;
    await saveAll(orgId, config, secrets, actorId, action, metadata);
  }
  function checkServiceUrl(c: Context, url: string): Response | null {
    if (isLocalAddress(url) && !o.allowLocalServiceUrls) {
      return c.json({ error: 'Local and private addresses are refused. For local testing set ALLOW_LOCAL_SERVICE_URLS=true on the API server.' }, 422);
    }
    return null;
  }
  async function usedBy(orgId: string, serviceId: string): Promise<string[]> {
    const stored = o.requests.getWorkflowSettings ? await o.requests.getWorkflowSettings(orgId) : null;
    if (!stored) return [];
    const parsed = parseWorkflowSettings(stored);
    if ('error' in parsed) return [];
    return Object.entries(parsed.settings)
      .filter(([, st]) => st.handledBy === 'external' && (st.serviceId ?? 'default') === serviceId)
      .map(([name]) => name);
  }

  routes.post('/integrations/review-services', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const missing = await needKey(c);
    if (missing) return missing;
    const b = await body(c);
    if (b instanceof Response) return b;
    const parsed = parseReviewServiceInput(b);
    if ('error' in parsed) return c.json({ error: parsed.error }, 422);
    const bad = checkServiceUrl(c, parsed.service.url);
    if (bad) return bad;
    const s = await services(who.orgId);
    if (s.list.length >= 20) return c.json({ error: 'Use at most 20 review services' }, 422);
    const service: ReviewService = { id: reviewServiceId(parsed.service.name, new Set(s.list.map((x) => x.id))), ...parsed.service };
    const secret = randomSecretB64url();
    s.list.push(service);
    s.serviceSecrets[service.id] = secret;
    await saveServices(who.orgId, s, who.userId, 'integration.review_service_added', { id: service.id, name: service.name, url: service.url, data_mode: service.dataMode });
    // The secret is shown once.
    return c.json({ service, secret }, 201);
  });

  routes.put('/integrations/review-services/:id', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const missing = await needKey(c);
    if (missing) return missing;
    const b = await body(c);
    if (b instanceof Response) return b;
    const parsed = parseReviewServiceInput(b);
    if ('error' in parsed) return c.json({ error: parsed.error }, 422);
    const bad = checkServiceUrl(c, parsed.service.url);
    if (bad) return bad;
    const s = await services(who.orgId);
    const index = s.list.findIndex((x) => x.id === c.req.param('id'));
    if (index < 0) return c.json({ error: 'Not found' }, 404);
    const service: ReviewService = { id: s.list[index]!.id, ...parsed.service };
    s.list[index] = service;
    await saveServices(who.orgId, s, who.userId, 'integration.review_service_updated', { id: service.id, name: service.name, url: service.url, data_mode: service.dataMode, enabled: service.enabled });
    return c.json({ service });
  });

  routes.post('/integrations/review-services/:id/rotate-secret', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const missing = await needKey(c);
    if (missing) return missing;
    const s = await services(who.orgId);
    const service = s.list.find((x) => x.id === c.req.param('id'));
    if (!service) return c.json({ error: 'Not found' }, 404);
    const secret = randomSecretB64url();
    s.serviceSecrets[service.id] = secret;
    await saveServices(who.orgId, s, who.userId, 'integration.review_service_secret_rotated', { id: service.id });
    return c.json({ secret });
  });

  routes.delete('/integrations/review-services/:id', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const missing = await needKey(c);
    if (missing) return missing;
    const s = await services(who.orgId);
    const id = c.req.param('id');
    if (!s.list.some((x) => x.id === id)) return c.json({ error: 'Not found' }, 404);
    const stages = await usedBy(who.orgId, id);
    if (stages.length > 0) return c.json({ error: `Still used by: ${stages.join(', ')}. Choose another service for them in Admin → Reviews first.` }, 409);
    s.list = s.list.filter((x) => x.id !== id);
    delete s.serviceSecrets[id];
    await saveServices(who.orgId, s, who.userId, 'integration.review_service_removed', { id });
    return c.body(null, 204);
  });

  routes.post('/integrations/review-services/:id/test', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const missing = await needKey(c);
    if (missing) return missing;
    const s = await services(who.orgId);
    const service = s.list.find((x) => x.id === c.req.param('id'));
    if (!service) return c.json({ error: 'Not found' }, 404);
    const secret = s.serviceSecrets[service.id];
    if (!secret) return c.json({ error: 'This service has no signing secret. Create a new one first.' }, 422);
    const ping = { type: 'ping', event_id: `ping:${crypto.randomUUID()}`, created_at: new Date(now()).toISOString(), organization: { id: who.orgId }, service: { id: service.id } };
    const started = Date.now();
    try {
      const res = await sendSigned(o.fetchImpl ?? fetch, service, secret, ping, now(), 10_000);
      // The response body is never passed on.
      return c.json({ ok: res.ok, status: res.status, ms: Date.now() - started, ...(res.ok ? {} : { error: `The service answered ${res.status}` }) });
    } catch (error) {
      const timeout = error instanceof Error && error.name === 'TimeoutError';
      return c.json({ ok: false, status: null, ms: Date.now() - started, error: timeout ? 'The service did not answer within 10 seconds' : 'The service could not be reached' });
    }
  });

  routes.get('/integrations/review-services/:id/deliveries', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const s = await services(who.orgId);
    const id = c.req.param('id');
    if (!s.list.some((x) => x.id === id)) return c.json({ error: 'Not found' }, 404);
    return c.json(await o.store.deliveries(who.orgId, id, 20));
  });

  // Names only, for everyone who sees reviews (no addresses, no secrets).
  routes.get('/review-services', async (c) => {
    const who = await caller(c, ALL_ROLES);
    if (who instanceof Response) return who;
    const { services: list } = await o.settings.forOrg(who.orgId);
    return c.json(list.map((x) => ({ id: x.id, name: x.name })));
  });

  // ---------------------------------------------------------------------------
  // Called by review services, signed with the service's own secret
  // ---------------------------------------------------------------------------

  /** The stage and the secret of its service, or null for anything unknown. */
  async function stageSecret(orgId: unknown, stageId: string) {
    if (typeof orgId !== 'string' || !UUID.test(orgId)) return null;
    const stage = await o.store.stage(orgId, stageId);
    if (!stage?.external) return null;
    const resolved = await o.settings.forOrg(orgId);
    const serviceId = stage.external_service ?? 'default';
    const secret = resolved.serviceSecret(serviceId);
    return secret ? { stage, secret, resolved, serviceId } : null;
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
    const found = await stageSecret((json as { org_id?: unknown } | null)?.org_id, stageId);
    // The same answer for an unknown organization or stage and a wrong signature.
    if (!found || (await verifySignature(found.secret, c.req.header('x-signature'), raw, now())) !== 'ok') return unauthorized(c);
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
    if (!UUID.test(stageId)) return c.json({ error: 'Not found' }, 404);
    const orgId = c.req.query('org_id') ?? '';
    const found = await stageSecret(orgId, stageId);
    if (!found || (await verifySignature(found.secret, c.req.header('x-signature'), '', now())) !== 'ok') return unauthorized(c);
    const [request] = await o.store.requests([found.stage.request_id]);
    if (!request) return c.json({ error: 'Not found' }, 404);
    const service = found.resolved.services.find((x) => x.id === found.serviceId);
    // The full data, also for services in pull mode: this is how they read it.
    return c.json({
      ...stageStartedPayload(request, found.stage, { sendAllAnswers: !!service?.sendAllAnswers, publicApiUrl: found.resolved.publicApiUrl ?? o.publicApiUrl }),
      data_mode: service?.dataMode ?? 'push',
      service: { id: found.serviceId },
      stage_status: found.stage.status,
    });
  });

  // Machine-readable description of the whole exchange.
  routes.get('/external/spec', (c) => {
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(externalReviewSpec(o.publicApiUrl));
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
