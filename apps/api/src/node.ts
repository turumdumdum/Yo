import { serve } from '@hono/node-server';
import { createApp } from './app';

// Node entrypoint (self-host container and local development).
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}`);
});
