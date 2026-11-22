import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { adminRoutes, type AdminStore } from './admin';
import { secureHeaders } from 'hono/secure-headers';
import type { AiProvider } from './ai/provider';
import { aiRoutes } from './ai/routes';
import { attachmentRoutes, type AttachmentStore } from './attachments';
import type { Mailer } from './email';
import { invitationRoutes, type InvitationStore } from './invitations';
import { requestRoutes, type AfterSubmit, type RequestStore } from './requests';
import { integrationRoutes, type IntegrationRouteOptions } from './integrations';
import type { SettingsResolver } from './orgSettings';
import { bodyLimits, jsonOnly, noStore, rateLimit, type RateLimitRule } from './security';

// Platform-neutral application. Only Web-standard APIs here: anything specific to
// Cloudflare Workers or Node goes behind an adapter passed in by the entrypoint.

export interface AppOptions {
  /** Origin of the web app, the only one allowed to call the API from a browser. */
  webOrigin?: string;
  requests?: RequestStore;
  /** Optional AI plugin. Off unless configured; the core works without it. */
  ai?: AiProvider;
  admin?: AdminStore;
  attachments?: AttachmentStore;
  invitations?: InvitationStore;
  /** Outgoing email; without it invitation links are handed back to share by hand. */
  mailer?: Mailer;
  /** Per-organization settings from Admin → Integrations; the environment values above are the fallback. */
  settings?: SettingsResolver;
  /** Integrations (Slack, UpGuard, external review service). */
  integrations?: Omit<IntegrationRouteOptions, 'requests' | 'getCaller' | 'webOrigin'>;
  afterSubmit?: AfterSubmit;
  /** Override the rate limits (tests). */
  rateLimits?: RateLimitRule[];
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
      cors({
        origin: options.webOrigin,
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
        allowHeaders: ['authorization', 'content-type'],
      }),
    );
  }

  app.use('/v1/*', noStore());
  app.use('/v1/*', rateLimit(options.rateLimits));
  app.use('/v1/*', bodyLimits());
  app.use('/v1/*', jsonOnly());

  app.get('/health', (c) => c.json({ status: 'ok' }));

  if (options.requests) {
    app.route('/v1/requests', requestRoutes(options.requests, options.afterSubmit));
    const settings = options.settings;
    const admin = options.admin;
    app.route(
      '/v1',
      aiRoutes(
        options.requests,
        options.ai,
        settings && admin ? { providerFor: async (orgId) => (await settings.forOrg(orgId)).ai, orgOf: async (t) => (await admin.getCaller(t))?.orgId ?? null } : undefined,
      ),
    );
  }
  if (options.admin) app.route('/v1', adminRoutes(options.admin));
  if (options.attachments) app.route('/v1', attachmentRoutes(options.attachments));
  if (options.integrations && options.requests && options.admin && options.webOrigin) {
    const admin = options.admin;
    app.route('/v1', integrationRoutes({ ...options.integrations, requests: options.requests, getCaller: (t) => admin.getCaller(t), webOrigin: options.webOrigin }));
  }
  if (options.invitations && options.webOrigin) {
    const settings = options.settings;
    app.route(
      '/v1',
      invitationRoutes(options.invitations, {
        webOrigin: options.webOrigin,
        mailer: options.mailer,
        ...(settings ? { mailerFor: async (orgId: string) => (await settings.forOrg(orgId)).mailer } : {}),
      }),
    );
  }

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: 'Internal server error' }, 500);
  });

  return app;
}
