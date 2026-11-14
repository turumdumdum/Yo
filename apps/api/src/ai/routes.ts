import type { AiStatus } from '@app/shared';
import { Hono, type Context } from 'hono';
import { UnauthorizedError, type DraftRecord, type RequestStore } from '../requests';
import { answerCheckTask, remarksFromResult, suggestionsFromResult, vendorLookupTask } from './assist';
import { AiProviderError, type AiProvider, type AiTask } from './provider';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One AI call per request at a time, and not more often than this. Per process only. */
const MIN_INTERVAL_MS = 10_000;

/** AI assistance for drafts. Mounted only when a provider is configured. */
export function aiRoutes(store: RequestStore, provider: AiProvider | undefined) {
  const routes = new Hono();
  const lastCall = new Map<string, number>();

  routes.get('/ai', (c) => c.json({ enabled: provider !== undefined, provider: provider?.name ?? null } satisfies AiStatus));

  /** Loads the caller's own draft, or answers with the right error. */
  async function draft(c: Context): Promise<DraftRecord | Response> {
    if (!provider) return c.json({ error: 'AI assistance is not enabled' }, 404);
    const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return c.json({ error: 'Sign in to continue' }, 401);
    const id = c.req.param('id') ?? '';
    if (!UUID.test(id)) return c.json({ error: 'Not found' }, 404);
    let request: DraftRecord | null;
    try {
      request = await store.getAsUser(token, id);
    } catch (error) {
      if (error instanceof UnauthorizedError) return c.json({ error: 'Sign in to continue' }, 401);
      throw error;
    }
    if (!request) return c.json({ error: 'Not found' }, 404);
    if (request.status !== 'draft') return c.json({ error: 'AI assistance is available for drafts only' }, 409);
    return request;
  }

  /** Returns a 429 response when this request asked too recently; otherwise records the call. */
  function throttled(c: Context, id: string): Response | null {
    const now = Date.now();
    if (now - (lastCall.get(id) ?? 0) < MIN_INTERVAL_MS) {
      return c.json({ error: 'Please wait a few seconds before asking the AI again' }, 429);
    }
    if (lastCall.size > 10_000) lastCall.clear();
    lastCall.set(id, now);
    return null;
  }

  async function run<T>(c: Context, task: AiTask, parse: (result: Awaited<ReturnType<AiProvider['run']>>) => T) {
    try {
      const started = Date.now();
      const result = parse(await provider!.run(task));
      console.info(`AI ${c.req.path.split('/').pop()} via ${provider!.name}: done in ${Math.round((Date.now() - started) / 1000)}s`);
      return c.json(result);
    } catch (error) {
      if (error instanceof AiProviderError) {
        // Shown in the API terminal so a failure can be diagnosed. Never contains the key or answers.
        console.warn(`AI ${c.req.path.split('/').pop()} via ${provider!.name} failed: ${error.message}`);
        return c.json({ error: error.message }, 502);
      }
      throw error;
    }
  }

  routes.post('/requests/:id/ai/suggestions', async (c) => {
    const request = await draft(c);
    if (request instanceof Response) return request;
    const task = vendorLookupTask(request.answers);
    if (!task) return c.json({ error: 'Enter the service name or the vendor first' }, 422);
    const limited = throttled(c, request.id);
    if (limited) return limited;
    return run(c, task, (result) => ({ suggestions: suggestionsFromResult(result, request.answers) }));
  });

  routes.post('/requests/:id/ai/check', async (c) => {
    const request = await draft(c);
    if (request instanceof Response) return request;
    const limited = throttled(c, request.id);
    if (limited) return limited;
    return run(c, answerCheckTask(request.answers), (result) => ({ remarks: remarksFromResult(result) }));
  });

  return routes;
}
