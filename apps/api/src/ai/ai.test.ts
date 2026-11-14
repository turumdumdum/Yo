import type { Answers } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { optionsFromEnv } from '../config';
import type { DraftRecord, RequestStore } from '../requests';
import { answerCheckTask, remarksFromResult, suggestionsFromResult, vendorLookupTask } from './assist';
import { parallelProvider } from './parallel';
import { AiProviderError, type AiProvider, type AiTask, type AiTaskResult } from './provider';

const ID = '11111111-2222-4333-8444-555555555555';
const answers: Answers = {
  serviceName: 'Acme Analytics',
  vendorName: 'Acme',
  vendorCountry: 'US',
  budgetOwner: { name: 'Ann Lee' },
  businessOwner: { notRequired: true },
};

describe('vendor lookup', () => {
  it('sends only what identifies the vendor', () => {
    const task = vendorLookupTask({ ...answers, purpose: 'Secret project', annualCost: 60000 })!;
    expect(task.input).toEqual({ service_name: 'Acme Analytics', vendor_name: 'Acme', vendor_website: '' });
    expect(JSON.stringify(task)).not.toContain('Secret project');
  });

  it('needs a service or vendor name', () => {
    expect(vendorLookupTask({ vendorWebsite: 'https://acme.example' })).toBeNull();
  });

  it('keeps valid, new values with their reasoning and sources', () => {
    const result: AiTaskResult = {
      content: {
        vendorWebsite: 'https://acme.example',
        vendorLegalEntity: ' Acme Inc. ',
        vendorCountry: 'us', // same as the current answer once normalized
        category: 'Data & analytics',
        dataLocation: '',
        vendorUsesAi: 'Unknown',
      },
      basis: [
        {
          field: 'vendorLegalEntity',
          reasoning: 'Named in the terms of service. ' + 'x'.repeat(400),
          sources: [
            { url: 'https://acme.example/terms', title: 'Terms' },
            { url: 'javascript:alert(1)', title: 'bad' },
          ],
        },
      ],
    };
    const suggestions = suggestionsFromResult(result, answers);
    expect(suggestions.map((s) => [s.field, s.value])).toEqual([
      ['vendorWebsite', 'https://acme.example'],
      ['vendorLegalEntity', 'Acme Inc.'],
      ['category', 'Data & analytics'],
    ]);
    const legal = suggestions.find((s) => s.field === 'vendorLegalEntity')!;
    expect(legal.reason).toHaveLength(300);
    expect(legal.sources).toEqual([{ url: 'https://acme.example/terms', title: 'Terms' }]);
  });

  it('drops values that would not pass form validation, and fields it was not asked for', () => {
    const result: AiTaskResult = {
      content: {
        vendorWebsite: 'not a url',
        vendorCountry: 'Atlantis',
        category: 'Spaceships',
        vendorUsesAi: 'Maybe',
        vendorLegalEntity: 42,
        riskTier: 'Low',
        annualCost: '1',
      },
      basis: [],
    };
    expect(suggestionsFromResult(result, {})).toEqual([]);
  });
});

describe('answer check', () => {
  it('sends the answers without the names of colleagues', () => {
    const task = answerCheckTask(answers);
    const sent = (task.input.answers ?? {}) as Answers;
    expect(sent.budgetOwner).toBe('Named');
    expect(sent.businessOwner).toBe('Not required');
    expect(sent.technicalOwner).toBe('Not answered');
    expect(JSON.stringify(task.input)).not.toContain('Ann Lee');
  });

  it('cleans up remarks', () => {
    const remarks = remarksFromResult({
      content: {
        remarks: [
          { field: 'dataLocation', severity: 'warning', message: '  The location is vague. ' },
          { field: 'madeUpField', severity: 'critical', message: 'General tip' },
          { field: 'purpose', severity: 'info', message: '' },
          'nonsense',
          ...Array.from({ length: 10 }, (_, i) => ({ field: '', severity: 'info', message: `Tip ${i}` })),
        ],
      },
      basis: [],
    });
    expect(remarks).toHaveLength(8);
    expect(remarks[0]).toEqual({ field: 'dataLocation', severity: 'warning', message: 'The location is vague.' });
    expect(remarks[1]).toEqual({ field: null, severity: 'info', message: 'General tip' });
    expect(remarksFromResult({ content: { remarks: 'none' }, basis: [] })).toEqual([]);
  });
});

function setup(draft: DraftRecord | null, provider?: AiProvider) {
  const store: RequestStore = {
    async getAsUser() {
      return draft;
    },
    async submit() {
      throw new Error('not used');
    },
  };
  const app = createApp({ requests: store, ai: provider });
  const post = (path: string, headers: Record<string, string> = { authorization: 'Bearer user-token' }) =>
    app.request(`/v1/requests/${ID}/ai/${path}`, { method: 'POST', headers });
  return { app, post };
}

function fakeProvider(result: AiTaskResult | Error) {
  const tasks: AiTask[] = [];
  const provider: AiProvider = {
    name: 'Fake',
    async run(task) {
      tasks.push(task);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { provider, tasks };
}

describe('AI routes', () => {
  const draft: DraftRecord = { id: ID, status: 'draft', answers };

  it('are off by default: the core works without any AI', async () => {
    const { app, post } = setup(draft);
    expect(await (await app.request('/v1/ai')).json()).toEqual({ enabled: false, provider: null });
    expect((await post('suggestions')).status).toBe(404);
    expect((await post('check')).status).toBe(404);
  });

  it('name the provider when enabled', async () => {
    const { app } = setup(draft, fakeProvider({ content: {}, basis: [] }).provider);
    expect(await (await app.request('/v1/ai')).json()).toEqual({ enabled: true, provider: 'Fake' });
  });

  it('return validated suggestions for the caller\'s own draft', async () => {
    const { provider, tasks } = fakeProvider({ content: { vendorLegalEntity: 'Acme Inc.', vendorCountry: 'XX' }, basis: [] });
    const { post } = setup(draft, provider);
    const res = await post('suggestions');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ suggestions: [{ field: 'vendorLegalEntity', value: 'Acme Inc.', reason: '', sources: [] }] });
    expect(tasks).toHaveLength(1);
  });

  it('return remarks', async () => {
    const { provider } = fakeProvider({ content: { remarks: [{ field: '', severity: 'info', message: 'Looks thin' }] }, basis: [] });
    const res = await setup(draft, provider).post('check');
    expect(await res.json()).toEqual({ remarks: [{ field: null, severity: 'info', message: 'Looks thin' }] });
  });

  it('require a session, a visible request and a draft, before calling the provider', async () => {
    const { provider, tasks } = fakeProvider({ content: {}, basis: [] });
    expect((await setup(draft, provider).post('check', {})).status).toBe(401);
    expect((await setup(null, provider).post('check')).status).toBe(404);
    expect((await setup({ ...draft, status: 'in_review' }, provider).post('check')).status).toBe(409);
    expect((await setup({ ...draft, answers: {} }, provider).post('suggestions')).status).toBe(422);
    expect(tasks).toEqual([]);
  });

  it('limit how often one request can ask', async () => {
    const { provider, tasks } = fakeProvider({ content: { remarks: [] }, basis: [] });
    const { post } = setup(draft, provider);
    expect((await post('check')).status).toBe(200);
    expect((await post('check')).status).toBe(429);
    expect(tasks).toHaveLength(1);
  });

  it('report provider failures without leaking details', async () => {
    const res = await setup(draft, fakeProvider(new AiProviderError('The AI provider took too long to answer. Try again later.')).provider).post('check');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'The AI provider took too long to answer. Try again later.' });
    const crash = await setup(draft, fakeProvider(new Error('secret stack')).provider).post('check');
    expect(crash.status).toBe(500);
    expect(await crash.json()).toEqual({ error: 'Internal server error' });
  });
});

describe('parallelProvider', () => {
  const task: AiTask = { instructions: 'Find facts.', input: { vendor_name: 'Acme' }, outputSchema: { type: 'object' } };

  function fakeFetch(responses: { status: number; body?: unknown }[]) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const next = responses.shift()!;
      return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
    }) as typeof fetch;
    return { impl, calls };
  }

  const completed = {
    run: { run_id: 'run_1', status: 'completed' },
    output: {
      type: 'json',
      content: { vendorLegalEntity: 'Acme Inc.' },
      basis: [{ field: 'vendorLegalEntity', reasoning: 'From the terms.', citations: [{ url: 'https://acme.example/terms', title: 'Terms' }] }],
    },
  };

  it('creates a run with the key in a header, waits through 408s and maps the result', async () => {
    const { impl, calls } = fakeFetch([
      { status: 202, body: { run_id: 'run_1', status: 'queued' } },
      { status: 408 },
      { status: 200, body: completed },
    ]);
    const result = await parallelProvider({ apiKey: 'key-123', processor: 'lite' }, impl).run(task);
    expect(result).toEqual({
      content: { vendorLegalEntity: 'Acme Inc.' },
      basis: [{ field: 'vendorLegalEntity', reasoning: 'From the terms.', sources: [{ url: 'https://acme.example/terms', title: 'Terms' }] }],
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.parallel.ai/v1/tasks/runs',
      'https://api.parallel.ai/v1/tasks/runs/run_1/result?timeout=25',
      'https://api.parallel.ai/v1/tasks/runs/run_1/result?timeout=25',
    ]);
    expect((calls[0]!.init!.headers as Record<string, string>)['x-api-key']).toBe('key-123');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.processor).toBe('lite');
    expect(body.task_spec).toEqual({ output_schema: { type: 'json', json_schema: { type: 'object' } } });
    expect(body.input).toContain('Find facts.');
    expect(body.input).toContain('"vendor_name":"Acme"');
    // The key never travels in the URL or the body.
    expect(JSON.stringify(calls.map((c) => [c.url, c.init!.body]))).not.toContain('key-123');
  });

  it.each([
    ['a rejected key', [{ status: 401 }], /rejected the API key/],
    ['a server error', [{ status: 500 }], /error \(500\)/],
    ['a failed run', [{ status: 202, body: { run_id: 'r', status: 'queued' } }, { status: 200, body: { ...completed, run: { run_id: 'r', status: 'failed' } } }], /could not complete/],
    ['a text answer', [{ status: 202, body: { run_id: 'r', status: 'queued' } }, { status: 200, body: { run: { run_id: 'r', status: 'completed' }, output: { type: 'text', content: 'hi' } } }], /unexpected answer/],
  ])('turns %s into a user-safe error', async (_label, responses, message) => {
    const { impl } = fakeFetch([...responses]);
    const failure = parallelProvider({ apiKey: 'k' }, impl).run(task);
    await expect(failure).rejects.toThrow(message);
    await expect(failure).rejects.toBeInstanceOf(AiProviderError);
  });

  it('gives up after the deadline', async () => {
    const { impl } = fakeFetch([{ status: 202, body: { run_id: 'r', status: 'queued' } }]);
    await expect(parallelProvider({ apiKey: 'k', timeoutMs: 0 }, impl).run(task)).rejects.toThrow(/took too long/);
  });
});

describe('configuration', () => {
  const base = { WEB_ORIGIN: 'http://localhost:5173', SUPABASE_URL: 'https://p.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'pub', SUPABASE_SERVICE_ROLE_KEY: 'secret' };

  it('leaves AI off unless a provider is named', () => {
    expect(optionsFromEnv(base).ai).toBeUndefined();
    expect(optionsFromEnv({ ...base, AI_PROVIDER: '' }).ai).toBeUndefined();
  });

  it('enables Parallel only with a key, and rejects unknown providers', () => {
    expect(optionsFromEnv({ ...base, AI_PROVIDER: 'parallel', PARALLEL_API_KEY: 'k' }).ai?.name).toBe('Parallel');
    expect(() => optionsFromEnv({ ...base, AI_PROVIDER: 'parallel' })).toThrow(/PARALLEL_API_KEY/);
    expect(() => optionsFromEnv({ ...base, AI_PROVIDER: 'skynet' })).toThrow(/Unknown AI_PROVIDER/);
  });
});
