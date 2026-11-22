import { DEFAULT_AI_CHECK_SETTINGS, parseAiCheckSettings, type AiCheckSettings, type AiStatus } from '@app/shared';
import { Hono, type Context } from 'hono';
import { formOf, UnauthorizedError, type DraftRecord, type RequestStore } from '../requests';
import { answerCheckTask, remarksFromResult, suggestionsFromResult, vendorLookupTask } from './assist';
import { HANDLE_TTL_SECONDS, signHandle, tokenSubject, verifyHandle, type AiRunKind } from './handle';
import { AiProviderError, type AiProvider, type AiTask, type AiTaskResult } from './provider';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One AI call per request at a time, and not more often than this. Per process only. */
const MIN_INTERVAL_MS = 10_000;
/** How long one poll may wait for the provider before answering "still running". */
const POLL_WAIT_SECONDS = 20;
/** Handles are at most this long; anything longer is not ours. */
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{1,1500}\.[0-9a-f]{64}$/;

/**
 * AI assistance for drafts. The provider comes from the organization's settings when
 * `providerFor` is given (Admin → Integrations), else from the environment.
 */
export function aiRoutes(
  store: RequestStore,
  provider: AiProvider | undefined,
  perOrg?: { providerFor(orgId: string): Promise<AiProvider | undefined>; orgOf(token: string): Promise<string | null> },
  options: { runSecret?: string; now?: () => number } = {},
) {
  // Signs run handles. Set from INTEGRATION_ENCRYPTION_KEY so handles survive across
  // Workers isolates; otherwise a per-process secret (fine for one Node process).
  const runSecret = options.runSecret ?? [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const now = options.now ?? Date.now;
  const routes = new Hono();
  const providerFor = async (orgId: string) => (perOrg ? perOrg.providerFor(orgId) : provider);
  const lastCall = new Map<string, number>();

  /** The organization's settings for the check; stored settings that fail validation are ignored. */
  async function checkSettings(orgId: string): Promise<AiCheckSettings> {
    const stored = store.getAiSettings ? await store.getAiSettings(orgId) : null;
    if (stored === null || stored === undefined) return DEFAULT_AI_CHECK_SETTINGS;
    const parsed = parseAiCheckSettings(stored);
    if ('settings' in parsed) return parsed.settings;
    console.warn(`Ignoring the stored AI settings of organization ${orgId}: ${parsed.error}`);
    return DEFAULT_AI_CHECK_SETTINGS;
  }

  routes.get('/ai', async (c) => {
    let current = provider;
    if (perOrg) {
      const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
      const orgId = token ? await perOrg.orgOf(token).catch(() => null) : null;
      current = orgId ? await perOrg.providerFor(orgId) : undefined;
    }
    return c.json({ enabled: current !== undefined, provider: current?.name ?? null } satisfies AiStatus);
  });

  /** Loads the caller's own draft, or answers with the right error. */
  async function draft(c: Context): Promise<{ request: DraftRecord; ai: AiProvider } | Response> {
    if (!perOrg && !provider) return c.json({ error: 'AI assistance is not enabled' }, 404);
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
    const ai = await providerFor(request.org_id);
    if (!ai) return c.json({ error: 'AI assistance is not enabled' }, 404);
    return { request, ai };
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

  const failed = (c: Context, provider: AiProvider, error: unknown) => {
    if (error instanceof AiProviderError) {
      // Shown in the API terminal so a failure can be diagnosed. Never contains the key or answers.
      console.warn(`AI ${c.req.path.split('/').slice(-2).join('/')} via ${provider.name} failed: ${error.message}`);
      return c.json({ error: error.message }, 502);
    }
    throw error;
  };

  /**
   * Starts the job. Providers that can run in the background answer 202 with a signed
   * handle the browser polls; others answer when done, as before.
   */
  async function begin<T>(c: Context, provider: AiProvider, task: AiTask, kind: AiRunKind, requestId: string, parse: (result: AiTaskResult) => T) {
    if (!provider.start || !provider.result) return run(c, provider, task, parse);
    try {
      const { runId } = await provider.start(task);
      const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? '';
      const handle = await signHandle(runSecret, {
        runId,
        requestId,
        kind,
        subject: tokenSubject(token),
        expires: Math.floor(now() / 1000) + HANDLE_TTL_SECONDS,
      });
      return c.json({ status: 'running', handle }, 202);
    } catch (error) {
      return failed(c, provider, error);
    }
  }

  async function run<T>(c: Context, provider: AiProvider, task: AiTask, parse: (result: AiTaskResult) => T) {
    try {
      const started = Date.now();
      const result = parse(await provider.run(task));
      console.info(`AI ${c.req.path.split('/').pop()} via ${provider.name}: done in ${Math.round((Date.now() - started) / 1000)}s`);
      return c.json(result);
    } catch (error) {
      return failed(c, provider, error);
    }
  }

  routes.post('/requests/:id/ai/suggestions', async (c) => {
    const found = await draft(c);
    if (found instanceof Response) return found;
    const { request, ai } = found;
    const task = vendorLookupTask(request.answers);
    if (!task) return c.json({ error: 'Enter the service name or the vendor first' }, 422);
    const limited = throttled(c, request.id);
    if (limited) return limited;
    return begin(c, ai, task, 'suggestions', request.id, (result) => ({ suggestions: suggestionsFromResult(result, request.answers, formOf(request)) }));
  });

  routes.post('/requests/:id/ai/check', async (c) => {
    const found = await draft(c);
    if (found instanceof Response) return found;
    const { request, ai } = found;
    const limited = throttled(c, request.id);
    if (limited) return limited;
    const form = formOf(request);
    const settings = await checkSettings(request.org_id);
    return begin(c, ai, answerCheckTask(request.answers, form, settings), 'check', request.id, (result) => ({
      remarks: remarksFromResult(result, form, request.answers, settings),
    }));
  });

  /** Polls a job started above. Access to the draft is checked again on every call. */
  routes.get('/requests/:id/ai/runs/:handle', async (c) => {
    const found = await draft(c);
    if (found instanceof Response) return found;
    const { request, ai } = found;
    const handle = c.req.param('handle') ?? '';
    const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1] ?? '';
    const claims = HANDLE_PATTERN.test(handle)
      ? await verifyHandle(runSecret, handle, { requestId: request.id, subject: tokenSubject(token) }, now())
      : null;
    if (!claims || !ai.result) return c.json({ error: 'This AI check has expired. Start it again.' }, 404);
    let result: AiTaskResult | null;
    try {
      result = await ai.result(claims.runId, POLL_WAIT_SECONDS);
    } catch (error) {
      return failed(c, ai, error);
    }
    if (!result) return c.json({ status: 'running' }, 202);
    const form = formOf(request);
    if (claims.kind === 'suggestions') {
      return c.json({ suggestions: suggestionsFromResult(result, request.answers, form) });
    }
    const settings = await checkSettings(request.org_id);
    return c.json({ remarks: remarksFromResult(result, form, request.answers, settings) });
  });

  return routes;
}
