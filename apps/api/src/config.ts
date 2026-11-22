import { parallelProvider } from './ai/parallel';
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
  // The AI plugin is off unless a provider is named. Add other providers here.
  let ai: AiProvider | undefined;
  const provider = env.AI_PROVIDER?.trim().toLowerCase();
  if (provider === 'parallel') {
    ai = parallelProvider({
      apiKey: required('PARALLEL_API_KEY'),
      processor: env.PARALLEL_PROCESSOR || undefined,
      baseUrl: env.PARALLEL_BASE_URL || undefined,
    });
  } else if (provider) {
    throw new Error(`Unknown AI_PROVIDER "${env.AI_PROVIDER}". Supported: parallel.`);
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
