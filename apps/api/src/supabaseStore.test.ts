import { describe, expect, it } from 'vitest';
import { NotADraftError, UnauthorizedError } from './requests';
import { supabaseRequestStore } from './supabaseStore';

const config = { url: 'https://project.supabase.co/', publishableKey: 'pub-key', serviceRoleKey: 'secret-key' };
const ID = '11111111-2222-4333-8444-555555555555';

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { impl, calls };
}

describe('supabaseRequestStore', () => {
  it("reads with the user's token and the publishable key, never the secret key", async () => {
    const { impl, calls } = fakeFetch(200, [{ id: ID, org_id: 'o', status: 'draft', answers: {} }]);
    const row = await supabaseRequestStore(config, impl).getAsUser('user-token', ID);
    expect(row).toEqual({ id: ID, org_id: 'o', status: 'draft', answers: {} });
    expect(calls[0]!.url).toBe(`https://project.supabase.co/rest/v1/requests?id=eq.${ID}&select=id%2Corg_id%2Cstatus%2Canswers%2Cform`);
    expect(calls[0]!.init!.headers).toEqual({ apikey: 'pub-key', authorization: 'Bearer user-token' });
  });

  it('returns null when RLS hides the request', async () => {
    const { impl } = fakeFetch(200, []);
    expect(await supabaseRequestStore(config, impl).getAsUser('user-token', ID)).toBeNull();
  });

  it('maps a rejected token to UnauthorizedError', async () => {
    const { impl } = fakeFetch(401, { message: 'JWT expired' });
    await expect(supabaseRequestStore(config, impl).getAsUser('bad', ID)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('submits through the service-role RPC', async () => {
    const { impl, calls } = fakeFetch(200, { id: ID, status: 'in_review', risk_tier: 'Low', risk_score: 0, risk_reasons: [], submitted_at: 'now' });
    await supabaseRequestStore(config, impl).submit(
      ID,
      { serviceName: 'A' },
      { tier: 'Low', score: 0, reasons: [] },
      [{ name: 'License check', status: 'In review', slaBusinessDays: 5, slaDueAt: '2026-11-20T15:30:00.000Z', note: null, checklist: ['Terms ok'], reviewFields: [], reviewRules: [] }],
      { confidential: true, businessOwnerEmail: 'bo@acme.example' },
    );
    // Visibility first, so the request is never visible without it.
    expect(calls[0]!.url).toBe('https://project.supabase.co/rest/v1/rpc/set_request_confidentiality');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ p_request_id: ID, p_confidential: true, p_business_owner_email: 'bo@acme.example' });
    expect(calls[1]!.url).toBe('https://project.supabase.co/rest/v1/rpc/submit_request');
    expect((calls[1]!.init!.headers as Record<string, string>).apikey).toBe('secret-key');
    expect(JSON.parse(calls[1]!.init!.body as string)).toEqual({
      p_request_id: ID,
      p_answers: { serviceName: 'A' },
      p_risk_tier: 'Low',
      p_risk_score: 0,
      p_risk_reasons: [],
      p_stages: [
        { name: 'License check', status: 'In review', note: null, sla_business_days: 5, sla_due_at: '2026-11-20T15:30:00.000Z', checklist: ['Terms ok'], review_fields: [], review_rules: [] },
      ],
    });
  });

  it('maps "not a draft" to NotADraftError', async () => {
    const { impl } = fakeFetch(400, { message: 'request is not a draft' });
    await expect(
      supabaseRequestStore(config, impl).submit(ID, {}, { tier: 'Low', score: 0, reasons: [] }, []),
    ).rejects.toBeInstanceOf(NotADraftError);
  });
});
