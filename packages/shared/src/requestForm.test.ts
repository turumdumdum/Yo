import { describe, expect, it } from 'vitest';
import { computeRiskTier } from './risk';
import {
  completenessHints,
  firstStepWithErrors,
  formatAnswer,
  REQUEST_FORM_STEPS,
  riskInputFromAnswers,
  validateAnswers,
  visibleFields,
  withHttps,
  type Answers,
} from './requestForm';

const complete: Answers = {
  serviceName: 'Acme Analytics',
  vendorName: 'Acme Inc.',
  vendorWebsite: 'https://acme.example',
  requestType: 'New vendor',
  category: 'Data & analytics',
  purpose: 'Product analytics for the growth team',
  neededBy: '2027-01-15',
  countryOfUse: 'EE',
  ourLegalEntity: 'Our Company OÜ',
  vendorLegalEntity: 'Acme Inc.',
  vendorCountry: 'US',
  signInMethod: 'SSO',
  platforms: ['Web', 'API'],
  expectedUsers: 25,
  vendorUsesAi: 'No',
  dataClassification: 'Confidential',
  personalData: 'Yes',
  personalDataTypes: 'Names and emails of customers',
  dataLocation: 'EU (Frankfurt)',
  productionAccess: 'No',
  paymentType: 'Paid',
  annualCost: 60000,
  currency: 'EUR',
  contractTermMonths: 12,
  autoRenewal: 'Yes',
  costCenter: 'GROWTH-01',
  budgetOwner: { name: 'Ann Lee' },
  businessOwner: { name: 'Bo Chen' },
  accessAdministrator: { notRequired: true },
  technicalOwner: { name: 'Cy Diaz' },
  businessCriticality: 'High',
};

describe('form definition', () => {
  it('has the seven steps with unique field keys', () => {
    expect(REQUEST_FORM_STEPS.map((s) => s.title)).toEqual([
      'What do you need?',
      'Entities & geography',
      'Access & platform',
      'Data',
      'Commercials',
      'Ownership',
      'Review',
    ]);
    const keys = REQUEST_FORM_STEPS.flatMap((s) => s.fields.map((f) => f.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('only refers to existing fields in showWhen', () => {
    const keys = new Set(REQUEST_FORM_STEPS.flatMap((s) => s.fields.map((f) => f.key)));
    for (const field of REQUEST_FORM_STEPS.flatMap((s) => s.fields)) {
      if (field.showWhen) expect(keys.has(field.showWhen.field)).toBe(true);
    }
  });
});

describe('validateAnswers', () => {
  it('accepts a complete request and keeps optional fields out when empty', () => {
    const { errors, cleaned } = validateAnswers(complete);
    expect(errors).toEqual({});
    expect(cleaned.serviceName).toBe('Acme Analytics');
    expect('alternatives' in cleaned).toBe(false);
    expect('integrations' in cleaned).toBe(false);
  });

  it('reports every missing required field of an empty form', () => {
    const { errors } = validateAnswers({});
    expect(Object.keys(errors)).toEqual(
      expect.arrayContaining(['serviceName', 'requestType', 'platforms', 'dataClassification', 'paymentType', 'budgetOwner', 'businessCriticality']),
    );
    expect(errors.alternatives).toBeUndefined();
    // Conditional fields are not required while hidden.
    expect(errors.personalData).toBeUndefined();
    expect(errors.annualCost).toBeUndefined();
    expect(firstStepWithErrors(errors)).toBe(0);
  });

  it('asks personal-data questions only for Internal data or higher', () => {
    expect(visibleFields(3, { dataClassification: 'Public' }).map((f) => f.key)).not.toContain('personalData');
    expect(visibleFields(3, { dataClassification: 'Internal' }).map((f) => f.key)).toContain('personalData');
    const publicData = validateAnswers({ ...complete, dataClassification: 'Public' });
    expect(publicData.errors).toEqual({});
    // Answers to hidden questions are dropped, including questions that depend on them.
    expect('personalData' in publicData.cleaned).toBe(false);
    expect('personalDataTypes' in publicData.cleaned).toBe(false);
  });

  it('asks what personal data only when personal data is involved', () => {
    const { errors, cleaned } = validateAnswers({ ...complete, personalData: 'No' });
    expect(errors).toEqual({});
    expect('personalDataTypes' in cleaned).toBe(false);
    expect(validateAnswers({ ...complete, personalDataTypes: '' }).errors.personalDataTypes).toBeDefined();
  });

  it('asks for cost fields only when Paid', () => {
    const free = validateAnswers({ ...complete, paymentType: 'Free' });
    expect(free.errors).toEqual({});
    for (const key of ['annualCost', 'currency', 'contractTermMonths', 'autoRenewal', 'costCenter']) {
      expect(key in free.cleaned).toBe(false);
    }
    const paid = validateAnswers({ ...complete, annualCost: undefined, currency: undefined });
    expect(Object.keys(paid.errors).sort()).toEqual(['annualCost', 'currency']);
  });

  it('requires a name or "Not required" for each owner', () => {
    expect(validateAnswers({ ...complete, budgetOwner: {} }).errors.budgetOwner).toMatch(/Not required/);
    expect(validateAnswers({ ...complete, budgetOwner: { name: '  ' } }).errors.budgetOwner).toBeDefined();
    expect(validateAnswers({ ...complete, budgetOwner: { notRequired: true, name: 'ignored' } }).cleaned.budgetOwner).toEqual({
      notRequired: true,
    });
  });

  it.each([
    ['vendorWebsite', 'acme'],
    ['vendorWebsite', 'ftp://acme.example'],
    ['vendorWebsite', 'javascript:alert(1)'],
    ['vendorWebsite', 'https://localhost'],
    ['neededBy', '2027-02-30'],
    ['neededBy', '15/01/2027'],
    ['requestType', 'Something else'],
    ['countryOfUse', 'ZZ'],
    ['platforms', ['Web', 'Fax']],
    ['platforms', []],
    ['expectedUsers', 0],
    ['expectedUsers', 2.5],
    ['expectedUsers', 'many'],
    ['annualCost', -1],
    ['serviceName', 'x'.repeat(201)],
  ])('rejects %s = %j', (key, value) => {
    expect(validateAnswers({ ...complete, [key]: value }).errors[key]).toBeDefined();
  });

  it.each([
    ['acme.example', 'https://acme.example'],
    ['  www.acme.example/pricing ', 'https://www.acme.example/pricing'],
    ['//acme.example', 'https://acme.example'],
    ['http://acme.example', 'http://acme.example'],
    ['HTTPS://acme.example', 'HTTPS://acme.example'],
  ])('adds https:// to a website typed as %s', (typed, stored) => {
    expect(withHttps(typed)).toBe(stored);
    expect(validateAnswers({ ...complete, vendorWebsite: typed }).cleaned.vendorWebsite).toBe(stored);
  });

  it('leaves an empty website empty', () => {
    expect(withHttps('  ')).toBe('');
  });

  it('normalizes values and drops unknown keys', () => {
    const { errors, cleaned } = validateAnswers({
      ...complete,
      serviceName: '  Acme Analytics ',
      expectedUsers: '25',
      platforms: ['API', 'Web', 'Web'],
      injected: 'DROP TABLE',
    });
    expect(errors).toEqual({});
    expect(cleaned.serviceName).toBe('Acme Analytics');
    expect(cleaned.expectedUsers).toBe(25);
    expect(cleaned.platforms).toEqual(['Web', 'API']);
    expect('injected' in cleaned).toBe(false);
  });

  it('can validate a single step', () => {
    const { errors } = validateAnswers({ serviceName: 'Acme' }, [1]);
    expect(Object.keys(errors).sort()).toEqual(['countryOfUse', 'ourLegalEntity', 'vendorCountry', 'vendorLegalEntity']);
  });
});

describe('derived values', () => {
  it('builds the triage input from cleaned answers', () => {
    const { cleaned } = validateAnswers(complete);
    expect(riskInputFromAnswers(cleaned)).toEqual({
      dataClassification: 'Confidential',
      businessCriticality: 'High',
      productionAccess: false,
      annualCost: 60000,
    });
    // Confidential 3 + High 2 + cost band 2 = 7.
    expect(computeRiskTier(riskInputFromAnswers(cleaned))).toMatchObject({ tier: 'High', score: 7 });
  });

  it('ignores cost for free services', () => {
    const { cleaned } = validateAnswers({ ...complete, paymentType: 'Free' });
    expect(riskInputFromAnswers(cleaned).annualCost).toBeNull();
  });

  it('formats answers for the summary', () => {
    const field = (key: string) => REQUEST_FORM_STEPS.flatMap((s) => s.fields).find((f) => f.key === key)!;
    expect(formatAnswer(field('countryOfUse'), 'EE')).toBe('Estonia');
    expect(formatAnswer(field('platforms'), ['Web', 'API'])).toBe('Web, API');
    expect(formatAnswer(field('accessAdministrator'), { notRequired: true })).toBe('Not required');
    expect(formatAnswer(field('budgetOwner'), { name: 'Ann Lee' })).toBe('Ann Lee');
    expect(formatAnswer(field('annualCost'), 60000)).toBe('60,000');
    expect(formatAnswer(field('alternatives'), undefined)).toBe('—');
  });

  it('gives rule-based hints without blocking', () => {
    const hints = completenessHints(complete);
    expect(hints.some((h) => h.includes('security report'))).toBe(true);
    expect(hints.some((h) => h.includes('DPA'))).toBe(true);
    expect(hints.some((h) => h.includes('quote'))).toBe(true);
    expect(hints.some((h) => h.includes('alternatives'))).toBe(true);
    expect(
      completenessHints({ dataClassification: 'Public', vendorUsesAi: 'No', paymentType: 'Free', alternatives: 'Tool B' }),
    ).toEqual([]);
  });
});
