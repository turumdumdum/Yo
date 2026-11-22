import { type ReviewService } from '@app/shared';
import { parallelProvider } from './ai/parallel';
import type { AiProvider } from './ai/provider';
import { decrypt, type EncryptionKey } from './crypto';
import { logMailer, resendMailer, type Mailer } from './email';
import type { AiProcessor, AiProviderName, EmailProviderName, IntegrationConfig, IntegrationSecrets, IntegrationStore } from './integrationStore';

// Effective settings of one organization: what an admin saved in the UI (non-secret
// config plus encrypted secrets) wins; the environment is the fallback. Cached for 30 s
// per organization and dropped when the organization saves.

export type Source = 'settings' | 'env' | 'none';

/** Settings read from the environment (apps/api/.env or Worker bindings). */
export interface EnvSettings {
  publicApiUrl?: string;
  email: { provider: EmailProviderName; from?: string; resendApiKey?: string; smtpUrl?: string };
  ai: { provider: AiProviderName; apiKey?: string; processor?: string; baseUrl?: string };
}

type Env = Record<string, string | undefined>;

export function envSettings(env: Env): EnvSettings {
  const emailProvider = (env.EMAIL_PROVIDER?.trim().toLowerCase() || 'off') as EmailProviderName;
  const aiProvider = (env.AI_PROVIDER?.trim().toLowerCase() || 'off') as AiProviderName;
  return {
    publicApiUrl: env.PUBLIC_API_URL || undefined,
    email: { provider: emailProvider, from: env.EMAIL_FROM || undefined, resendApiKey: env.RESEND_API_KEY || undefined, smtpUrl: env.SMTP_URL || undefined },
    ai: { provider: aiProvider, apiKey: env.PARALLEL_API_KEY || undefined, processor: env.PARALLEL_PROCESSOR || undefined, baseUrl: env.PARALLEL_BASE_URL || undefined },
  };
}

/** SMTP needs Node; the Node entrypoint passes a factory, Workers do not. */
export type SmtpFactory = (url: string, from: string) => Mailer;

export interface ResolvedSettings {
  config: IntegrationConfig;
  secrets: IntegrationSecrets;
  publicApiUrl?: string;
  publicApiSource: Source;
  mailer?: Mailer;
  email: { provider: EmailProviderName; from: string; configured: boolean; source: Source };
  ai?: AiProvider;
  aiInfo: { provider: AiProviderName; processor: AiProcessor; configured: boolean; source: Source };
  services: ReviewService[];
  /** The signing secret of a review service, or null. */
  serviceSecret(id: string): string | null;
}

/** Review services, reading the legacy single "external" service as "default". */
export function reviewServicesOf(config: IntegrationConfig, secrets: IntegrationSecrets): { services: ReviewService[]; serviceSecrets: Record<string, string> } {
  const serviceSecrets = { ...(secrets.serviceSecrets ?? {}) };
  if (config.reviewServices) return { services: config.reviewServices, serviceSecrets };
  if (config.external) {
    if (secrets.externalSecret && !serviceSecrets.default) serviceSecrets.default = secrets.externalSecret;
    const e = config.external;
    return { services: [{ id: 'default', name: e.name, url: e.outboundUrl, dataMode: 'push', sendAllAnswers: e.sendAllAnswers, enabled: e.enabled }], serviceSecrets };
  }
  return { services: [], serviceSecrets };
}

export async function readSecrets(key: EncryptionKey | null, encrypted: string | null | undefined): Promise<IntegrationSecrets> {
  if (!key || !encrypted) return {};
  return JSON.parse(await decrypt(key, encrypted)) as IntegrationSecrets;
}

const PROCESSORS = new Set(['lite', 'base', 'core']);

export function buildResolved(config: IntegrationConfig, secrets: IntegrationSecrets, env: EnvSettings, smtpFactory?: SmtpFactory, fetchImpl?: typeof fetch): ResolvedSettings {
  // Public API address
  const publicApiUrl = config.server?.publicApiUrl || env.publicApiUrl;
  const publicApiSource: Source = config.server?.publicApiUrl ? 'settings' : env.publicApiUrl ? 'env' : 'none';

  // Email
  const fromSettings = !!config.email;
  const emailProvider = config.email?.provider ?? env.email.provider;
  const from = config.email?.from ?? env.email.from ?? '';
  const resendKey = fromSettings ? secrets.resendApiKey : env.email.resendApiKey;
  const smtpUrl = fromSettings ? secrets.smtpUrl : env.email.smtpUrl;
  let mailer: Mailer | undefined;
  if (emailProvider === 'resend' && resendKey && from) mailer = resendMailer({ apiKey: resendKey, from, fetchImpl });
  else if (emailProvider === 'smtp' && smtpUrl && from && smtpFactory) mailer = smtpFactory(smtpUrl, from);
  else if (emailProvider === 'log') mailer = logMailer();
  const emailConfigured = emailProvider === 'log' || (emailProvider === 'resend' && !!resendKey && !!from) || (emailProvider === 'smtp' && !!smtpUrl && !!from);

  // AI
  const aiFromSettings = !!config.ai;
  const aiProvider = config.ai?.provider ?? env.ai.provider;
  const aiKey = aiFromSettings ? secrets.parallelApiKey : env.ai.apiKey;
  const processor = (config.ai?.processor ?? (PROCESSORS.has(env.ai.processor ?? '') ? env.ai.processor : 'base')) as AiProcessor;
  const ai = aiProvider === 'parallel' && aiKey ? parallelProvider({ apiKey: aiKey, processor, baseUrl: env.ai.baseUrl }, fetchImpl ?? fetch) : undefined;

  const { services, serviceSecrets } = reviewServicesOf(config, secrets);
  return {
    config,
    secrets,
    publicApiUrl,
    publicApiSource,
    mailer,
    email: { provider: emailProvider, from, configured: emailConfigured, source: fromSettings ? 'settings' : env.email.provider !== 'off' ? 'env' : 'none' },
    ai,
    aiInfo: { provider: aiProvider, processor, configured: aiProvider === 'parallel' && !!aiKey, source: aiFromSettings ? 'settings' : env.ai.provider !== 'off' ? 'env' : 'none' },
    services,
    serviceSecret: (id) => serviceSecrets[id] ?? null,
  };
}

export interface SettingsResolver {
  forOrg(orgId: string): Promise<ResolvedSettings>;
  invalidate(orgId: string): void;
}

export function settingsResolver(o: {
  store: Pick<IntegrationStore, 'getIntegration'>;
  key: Promise<EncryptionKey | null>;
  env: EnvSettings;
  smtpFactory?: SmtpFactory;
  /** For tests. */
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}): SettingsResolver {
  const ttl = o.ttlMs ?? 30_000;
  const now = o.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<ResolvedSettings> }>();
  return {
    forOrg(orgId) {
      const hit = cache.get(orgId);
      if (hit && now() - hit.at < ttl) return hit.value;
      const value = (async () => {
        const record = await o.store.getIntegration(orgId);
        const secrets = await readSecrets(await o.key, record?.secrets).catch(() => ({}) as IntegrationSecrets);
        return buildResolved(record?.config ?? {}, secrets, o.env, o.smtpFactory, o.fetchImpl);
      })();
      value.catch(() => cache.delete(orgId));
      if (cache.size > 5_000) cache.clear();
      cache.set(orgId, { at: now(), value });
      return value;
    },
    invalidate(orgId) {
      cache.delete(orgId);
    },
  };
}
