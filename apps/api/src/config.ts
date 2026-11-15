import { parallelProvider } from './ai/parallel';
import type { AiProvider } from './ai/provider';
import type { AppOptions } from './app';
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
    attachments: supabaseAttachmentStore(supabase),
  };
}
