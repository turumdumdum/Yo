import { createApp } from './app';
import { optionsFromEnv } from './config';

// Cloudflare Workers entrypoint (hosted version). Bindings arrive per request.
export default {
  fetch(request: Request, env: Record<string, string | undefined>) {
    return createApp(optionsFromEnv(env)).fetch(request);
  },
};
