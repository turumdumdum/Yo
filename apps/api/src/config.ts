import { AI_PROVIDER_NAMES, buildAiProvider } from './ai/factory';
import type { AiProvider } from './ai/provider';
import type { AppOptions } from './app';
import { logMailer, resendMailer, type Mailer } from './email';
import { supabaseAttachmentStore } from './supabaseAttachments';
import { supabaseRequestStore } from './supabaseStore';
import { importEncryptionKey } from './crypto';
import { queueExternalStages, runOutbox, type DispatcherDeps } from './dispatcher';
import { supabaseIntegrationStore } from './integrationStore';
import { envSettings, settingsResolver, type SmtpFactory } from './orgSettings';

type Env = Record<string, string | undefined>;

/**
 * Builds the app options from environment values (process.env on Node, bindings on Workers).
 * Fails at start-up rather than on the first request when something is missing.
 */
export function optionsFromEnv(env: Env, platform: { smtpFactory?: SmtpFactory } = {}): AppOptions & { outbox: DispatcherDeps } {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing environment variable ${name}. Set it in apps/api/.env (see apps/api/.env.example).`);
    return value;
  };
  // The AI plugin is off unless a provider is named (Admin → Integrations overrides this).
  const aiEnv = envSettings(env).ai;
  if (!(AI_PROVIDER_NAMES as readonly string[]).includes(aiEnv.provider)) {
    throw new Error(`Unknown AI_PROVIDER "${env.AI_PROVIDER}". Supported: ${AI_PROVIDER_NAMES.filter((p) => p !== 'off').join(', ')}.`);
  }
  const ai: AiProvider | undefined = buildAiProvider(aiEnv);
  if (aiEnv.provider !== 'off' && !ai) {
    console.warn(`AI_PROVIDER=${aiEnv.provider} is incomplete (key, AI_MODEL or AI_BASE_URL missing): AI assistance is off until it is set here or in Admin → Integrations.`);
  }

  // Outgoing email is off unless a provider is named. SMTP needs Node (see node.ts).
  let mailer: Mailer | undefined;
  const emailProvider = env.EMAIL_PROVIDER?.trim().toLowerCase();
  if (emailProvider === 'resend') {
    mailer = resendMailer({ apiKey: required('RESEND_API_KEY'), from: required('EMAIL_FROM') });
  } else if (emailProvider === 'log') {
    mailer = logMailer();
  } else if (emailProvider && emailProvider !== 'smtp') {
    throw new Error(`Unknown EMAIL_PROVIDER "${env.EMAIL_PROVIDER}". Supported: resend, smtp (Node only), log.`);
  }

  const supabase = {
    url: required('SUPABASE_URL'),
    publishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    publicUrl: env.SUPABASE_PUBLIC_URL || undefined,
  };
  const store = supabaseRequestStore(supabase);

  const webOrigin = required('WEB_ORIGIN');
  const integrationStore = supabaseIntegrationStore(supabase);
  // Without the key, integrations that keep secrets are unavailable (the API says so).
  const key = env.INTEGRATION_ENCRYPTION_KEY ? importEncryptionKey(env.INTEGRATION_ENCRYPTION_KEY) : Promise.resolve(null);
  key.catch(() => undefined);
  const publicApiUrl = env.PUBLIC_API_URL || undefined;
  const outbox: DispatcherDeps = { store: integrationStore, key, webOrigin, publicApiUrl, log: (l) => console.info(l) };
  // What an org admin saves in Admin → Integrations wins over the values above.
  const settings = settingsResolver({ store: integrationStore, key, env: envSettings(env), smtpFactory: platform.smtpFactory });
  const allowLocal = env.ALLOW_LOCAL_SERVICE_URLS === 'true';

  return {
    ai,
    // A separate secret from the same key, so AI run handles are valid on every instance.
    aiRunSecret: env.INTEGRATION_ENCRYPTION_KEY ? `ai-run-handles:${env.INTEGRATION_ENCRYPTION_KEY.trim()}` : undefined,
    webOrigin,
    outbox,
    integrations: {
      store: integrationStore,
      key,
      publicApiUrl,
      upguardBaseUrl: env.UPGUARD_BASE_URL || 'https://cyber-risk.upguard.com/api/public',
      settings,
      smtpSupported: !!platform.smtpFactory,
      allowLocalServiceUrls: allowLocal,
    },
    settings,
    afterSubmit: async (requestId, orgId) => {
      await queueExternalStages(outbox, requestId);
      await runOutbox(outbox, orgId);
    },
    requests: store,
    admin: store,
    invitations: store,
    mailer,
    attachments: supabaseAttachmentStore(supabase),
  };
}
