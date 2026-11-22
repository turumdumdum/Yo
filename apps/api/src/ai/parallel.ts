import { AiProviderError, type AiProvider, type AiTask, type AiTaskResult } from './provider';

// Parallel (parallel.ai) Task API. Contract taken from the official `parallel-web`
// SDK 1.3.7: POST /v1/tasks/runs, then GET /v1/tasks/runs/{run_id}/result, x-api-key auth.

export interface ParallelConfig {
  apiKey: string;
  /** Processor tier, for example "lite", "base" or "core". Higher tiers are slower and cost more. */
  processor?: string;
  baseUrl?: string;
  /** Give up after this long (synchronous run() only). */
  timeoutMs?: number;
}

interface TaskRun {
  run_id: string;
  status: string;
  error?: { message?: string } | null;
}

interface TaskRunResult {
  run: TaskRun;
  output: {
    type: string;
    content: unknown;
    basis?: { field: string; reasoning?: string; citations?: { url: string; title?: string | null }[] }[];
  };
}

/** Seconds one result request may wait on the server before we ask again. */
const POLL_SECONDS = 25;
/** Extra time a request may take on top of the server-side wait (network, slow responses). */
const REQUEST_SLACK_MS = 10_000;

export const tooSlowMessage = (processor: string) =>
  `The AI provider (processor "${processor}") took too long to answer. Try again, or ask an admin to choose the faster "lite" processor in Admin → Integrations.`;

export function parallelProvider(config: ParallelConfig, fetchImpl: typeof fetch = fetch): AiProvider {
  const baseUrl = (config.baseUrl ?? 'https://api.parallel.ai').replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? 110_000;
  const headers = { 'x-api-key': config.apiKey, 'content-type': 'application/json' };
  const processorOf = (task: AiTask) => task.processor ?? config.processor ?? 'base';

  /** Every call is bounded: a stalled connection must never keep the user waiting forever. */
  async function call(url: string, init: RequestInit, limitMs: number, processor: string): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(Math.max(1, limitMs)) });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new AiProviderError(tooSlowMessage(processor));
      }
      throw new AiProviderError('Could not reach the AI provider');
    }
  }

  async function start(task: AiTask, limitMs = 30_000): Promise<{ runId: string }> {
    const processor = processorOf(task);
    const created = await call(
      `${baseUrl}/v1/tasks/runs`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          // The Task API takes free text or an object; instructions and data travel together.
          input: `${task.instructions}\n\nInput data (JSON):\n${JSON.stringify(task.input)}`,
          processor,
          task_spec: { output_schema: { type: 'json', json_schema: task.outputSchema } },
        }),
      },
      limitMs,
      processor,
    );
    if (created.status === 401 || created.status === 403) {
      throw new AiProviderError('The AI provider rejected the API key');
    }
    if (!created.ok) throw new AiProviderError(`The AI provider responded with an error (${created.status})`);
    const run = (await created.json()) as TaskRun;
    if (typeof run.run_id !== 'string' || !run.run_id) throw new AiProviderError('The AI provider returned an unexpected answer');
    return { runId: run.run_id };
  }

  /** One long poll. Null while the run is still in progress (408). */
  async function result(runId: string, waitSeconds: number, limitMs = waitSeconds * 1000 + REQUEST_SLACK_MS, processor = config.processor ?? 'base'): Promise<AiTaskResult | null> {
    const wait = Math.max(1, Math.floor(waitSeconds));
    const res = await call(
      `${baseUrl}/v1/tasks/runs/${encodeURIComponent(runId)}/result?timeout=${wait}`,
      { headers },
      limitMs,
      processor,
    );
    if (res.status === 408) return null;
    if (!res.ok) throw new AiProviderError(`The AI provider responded with an error (${res.status})`);
    const body = (await res.json()) as TaskRunResult;
    if (body.run.status !== 'completed') {
      throw new AiProviderError('The AI provider could not complete the task');
    }
    if (body.output.type !== 'json' || !body.output.content || typeof body.output.content !== 'object') {
      throw new AiProviderError('The AI provider returned an unexpected answer');
    }
    return {
      content: body.output.content as Record<string, unknown>,
      basis: (body.output.basis ?? []).map((b) => ({
        field: b.field,
        reasoning: b.reasoning ?? '',
        sources: (b.citations ?? []).map((c) => ({ url: c.url, title: c.title ?? null })),
      })),
    };
  }

  return {
    name: 'Parallel',

    start: (task) => start(task),
    result: (runId, waitSeconds) => result(runId, waitSeconds),

    /** Synchronous form: start, then wait until the deadline. */
    async run(task: AiTask): Promise<AiTaskResult> {
      const processor = processorOf(task);
      const deadline = Date.now() + timeoutMs;
      const remaining = () => deadline - Date.now();
      const { runId } = await start(task, Math.min(remaining(), 30_000));
      while (remaining() > 1_000) {
        // Never ask the server to wait longer than we are still willing to.
        const wait = Math.max(1, Math.min(POLL_SECONDS, Math.floor(remaining() / 1000)));
        const done = await result(runId, wait, Math.min(remaining(), wait * 1000 + REQUEST_SLACK_MS), processor);
        if (done) return done;
      }
      throw new AiProviderError(tooSlowMessage(processor));
    },
  };
}
