import { createApp } from './app';
import { optionsFromEnv } from './config';

// Cloudflare Workers entrypoint (hosted version). Bindings arrive per request.
export default {
  fetch(request: Request, env: Record<string, string | undefined>) {
    if (env.EMAIL_PROVIDER?.trim().toLowerCase() === 'smtp') {
      throw new Error('SMTP is not available on Cloudflare Workers. Use EMAIL_PROVIDER=resend.');
    }
    return createApp(optionsFromEnv(env)).fetch(request);
  },
};
