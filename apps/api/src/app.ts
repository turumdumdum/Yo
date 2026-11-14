import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { requestRoutes, type RequestStore } from './requests';

// Platform-neutral application. Only Web-standard APIs here: anything specific to
// Cloudflare Workers or Node goes behind an adapter passed in by the entrypoint.

export interface AppOptions {
  /** Origin of the web app, the only one allowed to call the API from a browser. */
  webOrigin?: string;
  requests?: RequestStore;
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono();

  app.use(
    '*',
    secureHeaders({
      // The API serves JSON only, so nothing may be loaded or framed from its responses.
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      strictTransportSecurity: 'max-age=63072000; includeSubDomains',
    }),
  );

  if (options.webOrigin) {
    app.use(
      '/v1/*',
      cors({ origin: options.webOrigin, allowMethods: ['GET', 'POST'], allowHeaders: ['authorization', 'content-type'] }),
    );
  }

  app.get('/health', (c) => c.json({ status: 'ok' }));

  if (options.requests) app.route('/v1/requests', requestRoutes(options.requests));

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
