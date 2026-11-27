import Anthropic from '@anthropic-ai/sdk';
import { AiProviderError, type AiProvider, type AiTask, type AiTaskResult } from './provider';

// Claude through the official Anthropic SDK. One Messages request per task, with the
// answer constrained to the task's JSON schema (structured outputs). Bring your own key.

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';

/** Models that accept server-side refusal fallbacks ("default" routing). */
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  /** Give up after this long. */
  timeoutMs?: number;
  /** For tests. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const SYSTEM =
  'You help a company review requests for new software vendors. Answer only with the JSON the schema asks for. ' +
  'You have no web access: use what you know, and leave a value empty rather than guessing.';

export function anthropicProvider(config: AnthropicConfig): AiProvider {
  const model = config.model?.trim() || ANTHROPIC_DEFAULT_MODEL;
  const client = new Anthropic({
    apiKey: config.apiKey,
    timeout: config.timeoutMs ?? 90_000,
    maxRetries: 1,
    // Explicit, so ANTHROPIC_BASE_URL in the server's environment cannot send the key elsewhere.
    baseURL: config.baseUrl ?? 'https://api.anthropic.com',
    ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
  });
  const withFallback = FALLBACK_MODELS.has(model);

  return {
    name: 'Anthropic',
    async run(task: AiTask): Promise<AiTaskResult> {
      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await client.beta.messages.create({
          model,
          max_tokens: 16000,
          system: SYSTEM,
          // A short, well-specified check: low effort keeps it quick and cheap.
          output_config: { effort: 'low', format: { type: 'json_schema', schema: task.outputSchema } },
          messages: [{ role: 'user', content: `${task.instructions}\n\nInput data (JSON):\n${JSON.stringify(task.input)}` }],
          ...(withFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        });
      } catch (error) {
        throw mapError(error);
      }
      if (response.stop_reason === 'refusal') throw new AiProviderError('The AI declined to answer this request');
      if (response.stop_reason === 'max_tokens') throw new AiProviderError('The AI answer was cut off; try again');
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      return { content: parseObject(text), basis: [] };
    },
  };
}

function mapError(error: unknown): AiProviderError {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AiProviderError('The AI provider rejected the API key');
  }
  if (error instanceof Anthropic.RateLimitError) return new AiProviderError('The AI provider is busy (rate limit). Try again in a minute');
  if (error instanceof Anthropic.NotFoundError) return new AiProviderError('The AI provider does not know this model. Check the model name in Admin → Integrations');
  if (error instanceof Anthropic.BadRequestError) return new AiProviderError('The AI provider refused the request (check the model name)');
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new AiProviderError('The AI provider took too long to answer. Try again');
  if (error instanceof Anthropic.APIConnectionError) return new AiProviderError('Could not reach the AI provider');
  if (error instanceof Anthropic.APIError) return new AiProviderError(`The AI provider responded with an error (${error.status ?? 'unknown'})`);
  return new AiProviderError('The AI provider could not complete the task');
}

/** Model output is untrusted: accept only a JSON object. */
export function parseObject(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new AiProviderError('The AI provider returned an unexpected answer');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiProviderError('The AI provider returned an unexpected answer');
  return value as Record<string, unknown>;
}
