import { AiProviderError, type AiProvider, type AiTask, type AiTaskResult } from './provider';

// Parallel (parallel.ai) Task API. Contract taken from the official `parallel-web`
// SDK 1.3.7: POST /v1/tasks/runs, then GET /v1/tasks/runs/{run_id}/result, x-api-key auth.

export interface ParallelConfig {
  apiKey: string;
  /** Processor tier, for example "lite", "base" or "core". Higher tiers are slower and cost more. */
  processor?: string;
  baseUrl?: string;
  /** Give up after this long. */
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

const TOO_SLOW = 'The AI provider took too long to answer. Try again, or use a faster processor (PARALLEL_PROCESSOR=lite).';

export function parallelProvider(config: ParallelConfig, fetchImpl: typeof fetch = fetch): AiProvider {
  const baseUrl = (config.baseUrl ?? 'https://api.parallel.ai').replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? 110_000;
  const headers = { 'x-api-key': config.apiKey, 'content-type': 'application/json' };

  /** Every call is bounded: a stalled connection must never keep the user waiting forever. */
  async function call(url: string, init: RequestInit, limitMs: number): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(Math.max(1, limitMs)) });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new AiProviderError(TOO_SLOW);
      }
      throw new AiProviderError('Could not reach the AI provider');
    }
  }

  return {
    name: 'Parallel',

    async run(task: AiTask): Promise<AiTaskResult> {
      const deadline = Date.now() + timeoutMs;
      const remaining = () => deadline - Date.now();

      const created = await call(
        `${baseUrl}/v1/tasks/runs`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            // The Task API takes free text or an object; instructions and data travel together.
            input: `${task.instructions}\n\nInput data (JSON):\n${JSON.stringify(task.input)}`,
            processor: config.processor ?? 'base',
            task_spec: { output_schema: { type: 'json', json_schema: task.outputSchema } },
          }),
        },
        Math.min(remaining(), 30_000),
      );
      if (created.status === 401 || created.status === 403) {
        throw new AiProviderError('The AI provider rejected the API key');
      }
      if (!created.ok) throw new AiProviderError(`The AI provider responded with an error (${created.status})`);
      const run = (await created.json()) as TaskRun;

      while (remaining() > 1_000) {
        // Never ask the server to wait longer than we are still willing to.
        const wait = Math.max(1, Math.min(POLL_SECONDS, Math.floor(remaining() / 1000)));
        const res = await call(
          `${baseUrl}/v1/tasks/runs/${encodeURIComponent(run.run_id)}/result?timeout=${wait}`,
          { headers },
          Math.min(remaining(), wait * 1000 + REQUEST_SLACK_MS),
        );
        // 408: the run is still in progress; ask again until our own deadline.
        if (res.status === 408) continue;
        if (!res.ok) throw new AiProviderError(`The AI provider responded with an error (${res.status})`);
        const result = (await res.json()) as TaskRunResult;
        if (result.run.status !== 'completed') {
          throw new AiProviderError('The AI provider could not complete the task');
        }
        if (result.output.type !== 'json' || !result.output.content || typeof result.output.content !== 'object') {
          throw new AiProviderError('The AI provider returned an unexpected answer');
        }
        return {
          content: result.output.content as Record<string, unknown>,
          basis: (result.output.basis ?? []).map((b) => ({
            field: b.field,
            reasoning: b.reasoning ?? '',
            sources: (b.citations ?? []).map((c) => ({ url: c.url, title: c.title ?? null })),
          })),
        };
      }
      throw new AiProviderError(TOO_SLOW);
    },
  };
}
