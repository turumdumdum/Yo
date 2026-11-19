import { defaultWorkflowSettings, type Answers, type PlannedStage, type RiskResult } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { NotADraftError, UnauthorizedError, type DraftRecord, type RequestStore, type Visibility } from './requests';

const ID = '11111111-2222-4333-8444-555555555555';
const ORG = '99999999-2222-4333-8444-555555555555';

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
  const calls: { id: string; answers: Answers; risk: RiskResult; stages: PlannedStage[]; visibility?: Visibility }[] = [];
  const tokens: string[] = [];
  const store: RequestStore = {
    async getReviewTemplates() {
      return {};
    },
    async getAsUser(token) {
      tokens.push(token);
      return draft;
    },
    async submit(id, answers, risk, stages, visibility) {
      calls.push({ id, answers, risk, stages, visibility });
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
    const { submit, calls, tokens } = setup({ id: ID, org_id: ORG, status: 'draft', answers: complete });
    const res = await submit();
    expect(res.status).toBe(200);
    // Restricted 5 + production access 2 = 7 -> High.
    expect(await res.json()).toMatchObject({ id: ID, status: 'in_review', riskTier: 'High', riskScore: 7 });
    expect(tokens).toEqual(['user-token']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.answers.serviceName).toBe('Acme Analytics');
    expect('annualCost' in calls[0]!.answers).toBe(false);
    expect('riskTier' in calls[0]!.answers).toBe(false);
    expect(calls[0]!.visibility).toEqual({ confidential: false, businessOwnerEmail: null });
  });

  it('passes on a request for confidentiality and the business owner email', async () => {
    const answers = { ...complete, confidential: 'Yes', businessOwner: { name: 'Bo@Acme.example' } };
    const { submit, calls } = setup({ id: ID, org_id: ORG, status: 'draft', answers });
    expect((await submit()).status).toBe(200);
    expect(calls[0]!.visibility).toEqual({ confidential: true, businessOwnerEmail: 'bo@acme.example' });
  });

  it('starts the stages that the tier and answers require', async () => {
    const { submit, calls } = setup({ id: ID, org_id: ORG, status: 'draft', answers: complete });
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

  it("copies the organization's review form into the stage, and falls back to the default for a broken one", async () => {
    const custom = { fields: [{ key: 'q', label: 'Q', type: 'text', required: true }], rules: [] };
    const orgs: string[] = [];
    let forms: Record<string, unknown> = { 'Security review': custom };
    const { submit, calls } = setup(
      { id: ID, org_id: ORG, status: 'draft', answers: complete },
      {
        async getReviewTemplates(orgId) {
          orgs.push(orgId);
          return forms;
        },
      },
    );
    await submit();
    expect(orgs).toEqual([ORG]);
    expect(calls[0]!.stages.find((s) => s.name === 'Security review')!.reviewFields).toEqual(custom.fields);
    forms = { 'Security review': { fields: [{ key: '1bad' }], rules: [] } };
    await submit();
    expect(calls[1]!.stages.find((s) => s.name === 'Security review')!.reviewFields.map((f) => f.key)).toContain('certifications');
  });

  it("validates against the form the draft was started with", async () => {
    const custom = {
      steps: [
        {
          title: 'Basics',
          fields: [
            { key: 'serviceName', label: 'Tool', type: 'text' },
            { key: 'vendorName', label: 'Vendor', type: 'text' },
            { key: 'requestType', label: 'Request type', type: 'radio', options: ['New vendor', 'New service', 'Renewal', 'Change of scope'].map((v) => ({ value: v, label: v })) },
            { key: 'dataClassification', label: 'Data', type: 'radio', options: ['Public', 'Internal', 'Confidential', 'Restricted'].map((v) => ({ value: v, label: v })) },
            { key: 'productionAccess', label: 'Prod', type: 'radio', options: ['Yes', 'No'].map((v) => ({ value: v, label: v })) },
            { key: 'paymentType', label: 'Paid', type: 'radio', options: ['Free', 'Trial', 'Paid'].map((v) => ({ value: v, label: v })) },
            { key: 'annualCost', label: 'Cost', type: 'money', min: 0, showWhen: { field: 'paymentType', in: ['Paid'] } },
            { key: 'businessCriticality', label: 'Criticality', type: 'radio', options: ['Low', 'Medium', 'High', 'Critical'].map((v) => ({ value: v, label: v })) },
            { key: 'seats', label: 'Seats', type: 'integer', min: 1, max: 100 },
          ],
        },
      ],
    };
    const answers = { serviceName: 'Tool', vendorName: 'V', requestType: 'New vendor', dataClassification: 'Public', productionAccess: 'No', paymentType: 'Free', businessCriticality: 'Low', seats: 10 };
    const ok = setup({ id: ID, org_id: ORG, status: 'draft', answers, form: custom });
    expect((await ok.submit()).status).toBe(200);
    // Only the custom form's questions are kept; the standard form's are not required.
    expect(Object.keys(ok.calls[0]!.answers).sort()).toEqual(Object.keys(answers).sort());
    const tooMany = setup({ id: ID, org_id: ORG, status: 'draft', answers: { ...answers, seats: 101 }, form: custom });
    const res = await tooMany.submit();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ fields: { seats: 'Enter 100 or less' } });
  });

  it('scores risk and plans stages from a form without any standard question', async () => {
    const custom = {
      steps: [
        {
          title: 'Only',
          fields: [
            { key: 'tool', label: 'Tool', type: 'text' },
            { key: 'cards', label: 'Card data?', type: 'radio', options: [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }], risk: { Yes: { points: 1, atLeast: 'Critical' } } },
          ],
        },
      ],
      titleField: 'tool',
    };
    const { submit, calls } = setup({ id: ID, org_id: ORG, status: 'draft', answers: { tool: 'Acme', cards: 'Yes' }, form: custom });
    expect(await (await submit()).json()).toMatchObject({ riskTier: 'Critical', riskScore: 1 });
    expect(calls[0]!.risk.reasons).toEqual(['Card data?: Yes (+1)', 'Minimum tier Critical: Card data? is Yes']);
    // The form does not ask "Paid or free", so the finance review is not skipped on it.
    expect(calls[0]!.stages.filter((s) => s.status !== 'Not required').map((s) => s.name)).toContain('Finance review');
  });

  it("plans stages with the organization's review settings", async () => {
    const settings = defaultWorkflowSettings();
    settings['Security review'] = { ...settings['Security review']!, requirement: 'never' };
    settings['Legal review'] = { ...settings['Legal review']!, requirement: 'always', slaBusinessDays: 2, checklist: ['Terms read'] };
    const { submit, calls } = setup({ id: ID, org_id: ORG, status: 'draft', answers: complete }, { getWorkflowSettings: async () => settings });
    expect((await submit()).status).toBe(200);
    const byName = Object.fromEntries(calls[0]!.stages.map((s) => [s.name, s]));
    expect(byName['Security review']!.note).toBe('Not required: turned off by your organization');
    expect(byName['Legal review']).toMatchObject({ status: 'In review', slaBusinessDays: 2, checklist: ['Terms read'] });
  });

  it('falls back to the standard form when the stored form is broken', async () => {
    const { submit } = setup({ id: ID, org_id: ORG, status: 'draft', answers: complete, form: { steps: 'broken' } });
    expect((await submit()).status).toBe(200);
  });

  it('requires a bearer token', async () => {
    const { submit, calls, tokens } = setup({ id: ID, org_id: ORG, status: 'draft', answers: complete });
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
    const { submit, calls } = setup({ id: ID, org_id: ORG, status: 'submitted', answers: complete });
    expect((await submit()).status).toBe(409);
    expect(calls).toEqual([]);
  });

  it('answers 409 when the draft is submitted concurrently', async () => {
    const { submit } = setup(
      { id: ID, org_id: ORG, status: 'draft', answers: complete },
      {
        async submit() {
          throw new NotADraftError();
        },
      },
    );
    expect((await submit()).status).toBe(409);
  });

  it('returns field errors for incomplete answers and does not submit', async () => {
    const { submit, calls } = setup({ id: ID, org_id: ORG, status: 'draft', answers: { ...complete, serviceName: '', dataClassification: 'Secret' } });
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
