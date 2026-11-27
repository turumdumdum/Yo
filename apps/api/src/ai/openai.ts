import { parseObject } from './anthropic';
import { AiProviderError, type AiProvider, type AiTask, type AiTaskResult } from './provider';

// OpenAI and any server with an OpenAI-style /chat/completions endpoint (Ollama,
// LM Studio, vLLM, OpenRouter, Azure-compatible gateways). Plain fetch, no SDK.

export interface OpenAiConfig {
  /** Optional for local servers that need none. */
  apiKey?: string;
  /** Required: model names differ between servers. */
  model: string;
  /** For example https://api.openai.com/v1 or http://localhost:11434/v1. */
  baseUrl?: string;
  /** OpenAI itself supports strict JSON schemas; other servers get plain JSON mode. */
  strictSchema?: boolean;
  name?: string;
  timeoutMs?: number;
}

const SYSTEM =
  'You help a company review requests for new software vendors. Answer only with a JSON object that matches the schema given. ' +
  'You have no web access: use what you know, and leave a value empty rather than guessing.';

export function openAiProvider(config: OpenAiConfig, fetchImpl: typeof fetch = fetch): AiProvider {
  const base = (config.baseUrl?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = config.model.trim();
  const strict = config.strictSchema ?? true;
  return {
    name: config.name ?? 'OpenAI',
    async run(task: AiTask): Promise<AiTaskResult> {
      const prompt = `${task.instructions}\n\nInput data (JSON):\n${JSON.stringify(task.input)}`;
      const body = {
        model,
        messages: [
          // Without strict schemas the schema travels in the prompt.
          { role: 'system', content: strict ? SYSTEM : `${SYSTEM}\n\nJSON schema:\n${JSON.stringify(task.outputSchema)}` },
          { role: 'user', content: prompt },
        ],
        response_format: strict ? { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: task.outputSchema } } : { type: 'json_object' },
      };
      let res: Response;
      try {
        res = await fetchImpl(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
          body: JSON.stringify(body),
          // A configured address must not bounce the request (and the key) elsewhere.
          redirect: 'manual',
          signal: AbortSignal.timeout(config.timeoutMs ?? 90_000),
        });
      } catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          throw new AiProviderError('The AI provider took too long to answer. Try again');
        }
        throw new AiProviderError('Could not reach the AI provider');
      }
      if (res.status >= 300 && res.status < 400) throw new AiProviderError('The AI provider address redirects elsewhere; enter its final address');
      if (res.status === 401 || res.status === 403) throw new AiProviderError('The AI provider rejected the API key');
      if (res.status === 429) throw new AiProviderError('The AI provider is busy (rate limit). Try again in a minute');
      if (res.status === 404) throw new AiProviderError('The AI provider does not know this model or address. Check Admin → Integrations');
      if (!res.ok) throw new AiProviderError(`The AI provider responded with an error (${res.status})`);
      const data = (await res.json().catch(() => null)) as { choices?: { message?: { content?: unknown; refusal?: unknown }; finish_reason?: string }[] } | null;
      const choice = data?.choices?.[0];
      if (choice?.message?.refusal) throw new AiProviderError('The AI declined to answer this request');
      if (choice?.finish_reason === 'length') throw new AiProviderError('The AI answer was cut off; try again');
      if (typeof choice?.message?.content !== 'string') throw new AiProviderError('The AI provider returned an unexpected answer');
      return { content: parseObject(choice.message.content), basis: [] };
    },
  };
}
