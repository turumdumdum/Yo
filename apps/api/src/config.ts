import { parallelProvider } from './ai/parallel';
import type { AiProvider } from './ai/provider';
import type { AppOptions } from './app';
import { logMailer, resendMailer, type Mailer } from './email';
import { supabaseAttachmentStore } from './supabaseAttachments';
import { supabaseRequestStore } from './supabaseStore';

type Env = Record<string, string | undefined>;

/**
 * Builds the app options from environment values (process.env on Node, bindings on Workers).
 * Fails at start-up rather than on the first request when something is missing.
 */
export function optionsFromEnv(env: Env): AppOptions {
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

  return {
    ai,
    webOrigin: required('WEB_ORIGIN'),
    requests: store,
    admin: store,
    invitations: store,
    mailer,
    attachments: supabaseAttachmentStore(supabase),
  };
}
