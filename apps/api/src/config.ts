import type { AppOptions } from './app';
import { supabaseRequestStore } from './supabaseStore';

type Env = Record<string, string | undefined>;

/**
 * Builds the app options from environment values (process.env on Node, bindings on Workers).
 * Fails at start-up rather than on the first request when something is missing.
 */
export function optionsFromEnv(env: Env): AppOptions {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing environment variable ${name}. See .env.example.`);
    return value;
  };
  return {
    webOrigin: required('WEB_ORIGIN'),
    requests: supabaseRequestStore({
      url: required('SUPABASE_URL'),
      publishableKey: required('SUPABASE_PUBLISHABLE_KEY'),
      serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    }),
  };
}
