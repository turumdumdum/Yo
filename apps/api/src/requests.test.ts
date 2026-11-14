import type { Answers, PlannedStage, RiskResult } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { NotADraftError, UnauthorizedError, type DraftRecord, type RequestStore } from './requests';

const ID = '11111111-2222-4333-8444-555555555555';

const complete: Answers = {
  serviceName: ' Acme Analytics ',
  vendorName: 'Acme Inc.',
  vendorWebsite: 'https://acme.example',
  requestType: 'New vendor',
  category: 'Data & analytics',
  purpose: 'Product analytics',
  neededBy: '2027-01-15',
  countryOfUse: 'EE',
  ourLegalEntity: 'Our Company OÜ',
  vendorLegalEntity: 'Acme Inc.',
  vendorCountry: 'US',
  signInMethod: 'SSO',
  platforms: ['Web'],
  expectedUsers: 25,
  vendorUsesAi: 'No',
  dataClassification: 'Restricted',
  personalData: 'No',
  dataLocation: 'EU',
  productionAccess: 'Yes',
  paymentType: 'Free',
  // Hidden for a free service: must not survive submission.
  annualCost: 999999,
  budgetOwner: { notRequired: true },
  businessOwner: { name: 'Bo Chen' },
  accessAdministrator: { notRequired: true },
  technicalOwner: { notRequired: true },
  businessCriticality: 'Low',
  // Something the browser tried to smuggle in.
  riskTier: 'Low',
};

function setup(draft: DraftRecord | null, overrides: Partial<RequestStore> = {}) {
  const calls: { id: string; answers: Answers; risk: RiskResult; stages: PlannedStage[] }[] = [];
  const tokens: string[] = [];
  const store: RequestStore = {
    async getAsUser(token) {
      tokens.push(token);
      return draft;
    },
    async submit(id, answers, risk, stages) {
      calls.push({ id, answers, risk, stages });
      return {
        id,
        status: 'in_review',
        risk_tier: risk.tier,
        risk_score: risk.score,
        risk_reasons: risk.reasons,
        submitted_at: '2026-11-14T10:00:00Z',
      };
    },
    ...overrides,
  };
  const app = createApp({ requests: store, webOrigin: 'http://localhost:5173' });
  const submit = (headers: Record<string, string> = { authorization: 'Bearer user-token' }, id = ID) =>
    app.request(`/v1/requests/${id}/submit`, { method: 'POST', headers });
  return { app, submit, calls, tokens };
}

describe('POST /v1/requests/:id/submit', () => {
  it('validates, computes the risk tier on the server and submits cleaned answers', async () => {
    const { submit, calls, tokens } = setup({ id: ID, status: 'draft', answers: complete });
    const res = await submit();
    expect(res.status).toBe(200);
    // Restricted 5 + production access 2 = 7 -> High.
    expect(await res.json()).toMatchObject({ id: ID, status: 'in_review', riskTier: 'High', riskScore: 7 });
    expect(tokens).toEqual(['user-token']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.answers.serviceName).toBe('Acme Analytics');
    expect('annualCost' in calls[0]!.answers).toBe(false);
    expect('riskTier' in calls[0]!.answers).toBe(false);
  });

  it('starts the stages that the tier and answers require', async () => {
    const { submit, calls } = setup({ id: ID, status: 'draft', answers: complete });
    await submit();
    const stages = calls[0]!.stages;
    // High risk, free service: everything except the finance review.
    expect(stages.filter((s) => s.status === 'In review').map((s) => s.name)).toEqual([
      'License check',
      'Security review',
      'Legal review',
      'IT review',
    ]);
    expect(stages.find((s) => s.name === 'Finance review')).toMatchObject({ status: 'Not required', slaDueAt: null });
    const due = new Date(stages[0]!.slaDueAt!).getTime();
    expect(due).toBeGreaterThan(Date.now() + 4 * 86_400_000);
    expect(due).toBeLessThan(Date.now() + 8 * 86_400_000);
  });

  it('requires a bearer token', async () => {
    const { submit, calls, tokens } = setup({ id: ID, status: 'draft', answers: complete });
    expect((await submit({})).status).toBe(401);
    expect((await submit({ authorization: 'Basic abc' })).status).toBe(401);
    expect(tokens).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('answers 401 when Supabase rejects the token', async () => {
    const { submit } = setup(null, {
      async getAsUser() {
        throw new UnauthorizedError();
      },
    });
    expect((await submit()).status).toBe(401);
  });

  it('answers 404 for requests the caller cannot see and for malformed ids', async () => {
    const { submit, calls, tokens } = setup(null);
    expect((await submit()).status).toBe(404);
    expect((await submit(undefined, 'not-a-uuid')).status).toBe(404);
    expect(tokens).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  it('refuses a request that is already submitted', async () => {
    const { submit, calls } = setup({ id: ID, status: 'submitted', answers: complete });
    expect((await submit()).status).toBe(409);
    expect(calls).toEqual([]);
  });

  it('answers 409 when the draft is submitted concurrently', async () => {
    const { submit } = setup(
      { id: ID, status: 'draft', answers: complete },
      {
        async submit() {
          throw new NotADraftError();
        },
      },
    );
    expect((await submit()).status).toBe(409);
  });

  it('returns field errors for incomplete answers and does not submit', async () => {
    const { submit, calls } = setup({ id: ID, status: 'draft', answers: { ...complete, serviceName: '', dataClassification: 'Secret' } });
    const res = await submit();
    expect(res.status).toBe(422);
    const body = (await res.json()) as { fields: Record<string, string> };
    expect(Object.keys(body.fields).sort()).toEqual(['dataClassification', 'serviceName']);
    expect(calls).toEqual([]);
  });

  it('allows the web origin and no other to call it from a browser', async () => {
    const { app } = setup(null);
    const preflight = (origin: string) =>
      app.request(`/v1/requests/${ID}/submit`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
    expect((await preflight('http://localhost:5173')).headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect((await preflight('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });
});
