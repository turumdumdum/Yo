/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  /** Public by design: it only identifies the project. Row Level Security protects the data. */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Address of apps/api, for example http://localhost:8787 */
  readonly VITE_API_URL?: string;
}
