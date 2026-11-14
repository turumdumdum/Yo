import { serve } from '@hono/node-server';
import { createApp } from './app';
import { optionsFromEnv } from './config';

// Node entrypoint (self-host container and local development).
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: createApp(optionsFromEnv(process.env)).fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
