import { createApp } from './app';
import { optionsFromEnv } from './config';
import { runOutbox } from './dispatcher';

// Cloudflare Workers entrypoint (hosted version). Bindings arrive per request.
export default {
  fetch(request: Request, env: Record<string, string | undefined>) {
    if (env.EMAIL_PROVIDER?.trim().toLowerCase() === 'smtp') {
      throw new Error('SMTP is not available on Cloudflare Workers. Use EMAIL_PROVIDER=resend.');
    }
    return createApp(optionsFromEnv(env)).fetch(request);
  },
  /** Cron trigger (configure one, for example every minute): runs the outbox. */
  async scheduled(_event: unknown, env: Record<string, string | undefined>, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(runOutbox(optionsFromEnv(env).outbox));
  },
};
