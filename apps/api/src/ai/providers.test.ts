import { describe, expect, it } from 'vitest';
import { anthropicProvider } from './anthropic';
import { aiConfigured, buildAiProvider } from './factory';
import { openAiProvider } from './openai';
import { AiProviderError, type AiTask } from './provider';

const task: AiTask = {
  instructions: 'Check the answers.',
  input: { serviceName: 'Acme' },
  outputSchema: { type: 'object', additionalProperties: false, required: ['remarks'], properties: { remarks: { type: 'array', items: { type: 'string' } } } },
};

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit; headers: Headers; body: Record<string, unknown> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const raw = init?.body ?? (input instanceof Request ? await input.text() : undefined);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    calls.push({ url, init: init ?? {}, headers, body: raw ? (JSON.parse(String(raw)) as Record<string, unknown>) : {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }) as typeof fetch;
  return { impl, calls };
}

const header = (call: { headers: Headers }, name: string) => call.headers.get(name);

const claudeMessage = (text: string, stop = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'text', text }],
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

describe('Anthropic provider', () => {
  it('sends one Messages request with the schema as structured output and parses the JSON', async () => {
    const { impl, calls } = fakeFetch(200, claudeMessage('{"remarks":["ok"]}'));
    const result = await anthropicProvider({ apiKey: 'sk-ant-test', fetchImpl: impl }).run(task);
    expect(result).toEqual({ content: { remarks: ['ok'] }, basis: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/v1\/messages/);
    // The SDK sends the key in x-api-key or as a bearer token, depending on its version.
    expect([header(calls[0]!, 'x-api-key'), header(calls[0]!, 'authorization')]).toContainEqual(expect.stringMatching(/^(Bearer )?sk-ant-test$/));
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.body).toMatchObject({ model: 'claude-opus-5-5', output_config: { effort: 'low', format: { type: 'json_schema', schema: task.outputSchema } }, fallbacks: 'default' });
    expect(header(calls[0]!, 'anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(JSON.stringify(calls[0]!.body.messages)).toContain('Acme');
  });

  it('uses the configured model, without fallbacks where the model has none', async () => {
    const { impl, calls } = fakeFetch(200, claudeMessage('{"remarks":[]}'));
    await anthropicProvider({ apiKey: 'k', model: 'claude-haiku-5-5', fetchImpl: impl }).run(task);
    expect(calls[0]!.body.model).toBe('claude-haiku-5-5');
    expect(calls[0]!.body.fallbacks).toBeUndefined();
  });

  it('maps errors and refusals to safe messages without the key', async () => {
    const bad = anthropicProvider({ apiKey: 'sk-ant-secret', fetchImpl: fakeFetch(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }).impl });
    await expect(bad.run(task)).rejects.toThrow('The AI provider rejected the API key');
    const busy = anthropicProvider({ apiKey: 'k', fetchImpl: fakeFetch(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, { 'retry-after': '0', 'x-should-retry': 'false' }).impl });
    await expect(busy.run(task)).rejects.toThrow(/rate limit/);
    const refused = anthropicProvider({ apiKey: 'k', fetchImpl: fakeFetch(200, claudeMessage('', 'refusal')).impl });
    await expect(refused.run(task)).rejects.toThrow('The AI declined to answer this request');
    const garbage = anthropicProvider({ apiKey: 'k', fetchImpl: fakeFetch(200, claudeMessage('not json')).impl });
    await expect(garbage.run(task)).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe('OpenAI and compatible providers', () => {
  const completion = (content: string) => ({ choices: [{ message: { content }, finish_reason: 'stop' }] });

  it('OpenAI: strict JSON schema, bearer key, configured model', async () => {
    const { impl, calls } = fakeFetch(200, completion('{"remarks":["a"]}'));
    const result = await openAiProvider({ apiKey: 'sk-openai', model: 'm-1' }, impl).run(task);
    expect(result.content).toEqual({ remarks: ['a'] });
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(header(calls[0]!, 'authorization')).toBe('Bearer sk-openai');
    expect(calls[0]!.body).toMatchObject({ model: 'm-1', response_format: { type: 'json_schema', json_schema: { strict: true, schema: task.outputSchema } } });
    expect(calls[0]!.init.redirect).toBe('manual');
  });

  it('compatible server: own address, JSON mode with the schema in the prompt, no key needed', async () => {
    const { impl, calls } = fakeFetch(200, completion('```json\n{"remarks":[]}\n```'));
    const p = openAiProvider({ model: 'llama3.1', baseUrl: 'http://localhost:11434/v1/', strictSchema: false, name: 'localhost:11434' }, impl);
    expect(p.name).toBe('localhost:11434');
    expect((await p.run(task)).content).toEqual({ remarks: [] });
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(header(calls[0]!, 'authorization')).toBeNull();
    expect(calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(calls[0]!.body.messages)).toContain('additionalProperties');
  });

  it('maps errors, redirects and odd answers', async () => {
    const run = (status: number, body: unknown) => openAiProvider({ apiKey: 'k', model: 'm' }, fakeFetch(status, body).impl).run(task);
    await expect(run(401, {})).rejects.toThrow('The AI provider rejected the API key');
    await expect(run(429, {})).rejects.toThrow(/rate limit/);
    await expect(run(404, {})).rejects.toThrow(/does not know this model/);
    await expect(run(302, {})).rejects.toThrow(/redirects/);
    await expect(run(500, {})).rejects.toThrow('(500)');
    await expect(run(200, { choices: [{ message: { refusal: 'no' } }] })).rejects.toThrow('declined');
    await expect(run(200, { choices: [{ message: { content: '[1,2]' } }] })).rejects.toThrow('unexpected answer');
    const slow = (async () => {
      throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    await expect(openAiProvider({ model: 'm' }, slow).run(task)).rejects.toThrow('took too long');
  });
});

describe('factory', () => {
  it('builds a provider only when the settings are complete', () => {
    expect(aiConfigured({ provider: 'off' })).toBe(false);
    expect(aiConfigured({ provider: 'anthropic', apiKey: 'k' })).toBe(true);
    expect(aiConfigured({ provider: 'openai', apiKey: 'k' })).toBe(false);
    expect(aiConfigured({ provider: 'openai_compatible', model: 'm' })).toBe(false);
    expect(buildAiProvider({ provider: 'openai_compatible', model: 'm', baseUrl: 'https://x.example/v1' })?.name).toBe('x.example');
    expect(buildAiProvider({ provider: 'anthropic', apiKey: 'k' })?.name).toBe('Anthropic');
    expect(buildAiProvider({ provider: 'parallel' })).toBeUndefined();
  });
});
