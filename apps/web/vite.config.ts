import react from '@vitejs/plugin-react';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { readEnvDir, REQUIRED_ENV } from './envFile';

// Always read apps/web/.env, wherever the dev server is started from.
const here = dirname(fileURLToPath(import.meta.url));
const env = readEnvDir(here);

/** Prints which .env was read and which values are missing, once, when the server starts. */
function envReport(): Plugin {
  return {
    name: 'env-report',
    configResolved(config) {
      if (config.command !== 'serve') return;
      for (const line of env.lines) config.logger.info(`[env] ${line}`);
    },
  };
}

export default defineConfig({
  envDir: here,
  plugins: [react(), envReport()],
  // Vite would miss these in a file with a byte-order mark; pass them explicitly.
  define: Object.fromEntries(
    REQUIRED_ENV.filter((key) => env.values[key]).map((key) => [`import.meta.env.${key}`, JSON.stringify(env.values[key])]),
  ),
});
