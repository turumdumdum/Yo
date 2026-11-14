import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

// Platform-neutral application. Only Web-standard APIs here: anything specific to
// Cloudflare Workers or Node goes behind an adapter passed in by the entrypoint.

export function createApp() {
  const app = new Hono();

  app.use(
    '*',
    secureHeaders({
      // The API serves JSON only, so nothing may be loaded or framed from its responses.
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      strictTransportSecurity: 'max-age=63072000; includeSubDomains',
    }),
  );

  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
