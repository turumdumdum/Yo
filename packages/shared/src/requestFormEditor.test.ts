import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUEST_FORM, validateAnswers, visibleFields, type FieldDef, type RequestFormDefinition } from './requestForm';
import { isSystemField, nameNewQuestions, newFieldKey, optionsFromLines, parseRequestForm } from './requestFormEditor';

const clone = (): { steps: { title: string; description?: string; fields: FieldDef[] }[] } =>
  JSON.parse(JSON.stringify(DEFAULT_REQUEST_FORM));
const error = (form: unknown) => {
  const result = parseRequestForm(form);
  return 'error' in result ? result.error : null;
};

describe('parseRequestForm', () => {
  it('accepts the standard form', () => {
    expect(parseRequestForm(DEFAULT_REQUEST_FORM)).toEqual({ form: DEFAULT_REQUEST_FORM });
  });

  it('accepts a shorter form with renamed steps, new questions and moved system fields', () => {
    const form = clone();
    const all = form.steps.flatMap((s) => s.fields);
    const keep = new Set(['serviceName', 'vendorName', 'requestType', 'dataClassification', 'productionAccess', 'paymentType', 'annualCost', 'businessCriticality']);
    const custom: FieldDef[] = [
      { key: 'contactEmail', label: 'Vendor contact email', type: 'email', placeholder: 'sales@vendor.com' },
      { key: 'hasTrial', label: 'Did you try it?', type: 'radio', options: [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }] },
      { key: 'trialNotes', label: 'What did you learn?', type: 'textarea', maxLength: 500, optional: true, showWhen: { field: 'hasTrial', in: ['Yes'] } },
      { key: 'seats', label: 'Seats', type: 'integer', min: 1, max: 500 },
    ];
    const short = {
      steps: [
        { title: 'The basics', description: 'Two minutes.', fields: [...all.filter((f) => keep.has(f.key)).map((f) => (f.key === 'serviceName' ? { ...f, label: 'Tool name', hint: 'As the vendor calls it' } : f)), ...custom] },
      ],
    };
    expect(error(short)).toBeNull();
    const parsed = (parseRequestForm(short) as { form: RequestFormDefinition }).form;
    // The custom form drives validation.
    const { errors } = validateAnswers({ seats: 501, contactEmail: 'not-an-email' }, undefined, parsed);
    expect(errors.seats).toBe('Enter 500 or less');
    expect(errors.contactEmail).toMatch(/email address/);
    expect(errors.trialNotes).toBeUndefined();
    expect(visibleFields(0, { hasTrial: 'Yes' }, parsed).map((f) => f.key)).toContain('trialNotes');
  });

  it.each([
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.splice(0, 1), /must keep “Service name”/],
    [(f: ReturnType<typeof clone>) => ((f.steps[3]!.fields[0] as unknown as { type: string }).type = 'select'), /must stay “One choice \(buttons\)”/],
    [(f: ReturnType<typeof clone>) => ((f.steps[3]!.fields[0] as unknown as { options: unknown[] }).options.pop()), /choices of “Data classification”/],
    [(f: ReturnType<typeof clone>) => ((f.steps[0]!.fields[0] as FieldDef).optional = true), /must stay required/],
    [(f: ReturnType<typeof clone>) => delete (f.steps[4]!.fields[1] as { showWhen?: unknown }).showWhen, /When “Estimated annual cost” is shown/],
    [(f: ReturnType<typeof clone>) => (f.steps = []), /at least one step/],
    [(f: ReturnType<typeof clone>) => (f.steps[0]!.title = ' '), /needs a title/],
    [(f: ReturnType<typeof clone>) => f.steps.push({ title: 'Empty', fields: [] }), /has no questions/],
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.push({ ...f.steps[0]!.fields[0]!, label: 'Again' }), /Two fields use the key “serviceName”/],
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.push({ key: '9bad', label: 'Bad', type: 'text' }), /invalid key/],
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.push({ key: 'q', label: 'Q', type: 'radio', options: [{ value: 'A', label: 'A' }] }), /at least 2 choices/],
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.push({ key: 'q', label: 'Q', type: 'radio', options: [{ value: 'A', label: 'A' }, { value: 'A', label: 'A' }] }), /twice/],
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.push({ key: 'q', label: 'Q', type: 'text', maxLength: 5000 }), /maximum length/],
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.push({ key: 'q', label: 'Q', type: 'integer', min: 10, max: 5 }), /largest number/],
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.push({ key: 'q', label: 'Q', type: 'checkbox' } as unknown as FieldDef), /unknown answer type/],
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.unshift({ key: 'q', label: 'Q', type: 'text', showWhen: { field: 'requestType', in: ['Renewal'] } }), /does not come before it/],
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.push({ key: 'q', label: 'Q', type: 'text', showWhen: { field: 'purpose', in: ['x'] } }), /one-choice question/],
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.push({ key: 'q', label: 'Q', type: 'text', showWhen: { field: 'requestType', in: ['Lease'] } }), /does not offer/],
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.push({ key: 'q', label: 'Q', type: 'text', script: 'x' } as unknown as FieldDef), /unknown setting “script”/],
  ])('rejects broken form #%#', (breakIt, message) => {
    const form = clone();
    breakIt(form);
    expect(error(form)).toMatch(message);
  });

  it('rejects things that are not forms', () => {
    expect(error(null)).toMatch(/list of steps/);
    expect(error({ steps: 'x' })).toMatch(/list of steps/);
    expect(error({ steps: Array.from({ length: 13 }, () => ({ title: 'S', fields: [] })) })).toMatch(/at most 12 steps/);
  });
});

describe('helpers', () => {
  it('marks the fields the product relies on', () => {
    expect(isSystemField('dataClassification')).toBe(true);
    expect(isSystemField('purpose')).toBe(false);
  });

  it('derives unique keys from labels', () => {
    expect(newFieldKey('Vendor contact email', new Set())).toBe('vendorContactEmail');
    expect(newFieldKey('Vendor contact email', new Set(['vendorContactEmail']))).toBe('vendorContactEmail2');
    expect(newFieldKey('123 !!!', new Set())).toBe('question');
  });

  it('turns lines into choices', () => {
    expect(optionsFromLines('Yes\n\n No \nYes')).toEqual([
      { value: 'Yes', label: 'Yes' },
      { value: 'No', label: 'No' },
    ]);
  });
});

describe('nameNewQuestions', () => {
  it('names added questions after their labels and keeps conditions pointing at them', () => {
    const form = {
      steps: [
        {
          title: 'S',
          fields: [
            { key: 'serviceName', label: 'Tool name', type: 'text' as const },
            { key: 'newQuestion', label: 'Did you try it?', type: 'radio' as const, options: [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }] },
            { key: 'newQuestion2', label: 'What did you learn?', type: 'textarea' as const, showWhen: { field: 'newQuestion', in: ['Yes'] } },
            { key: 'newQuestion3', label: 'Tool name', type: 'text' as const },
          ],
        },
      ],
    };
    const named = nameNewQuestions(form, new Set(['serviceName']));
    expect(named.steps[0]!.fields.map((f) => f.key)).toEqual(['serviceName', 'didYouTryIt', 'whatDidYouLearn', 'toolName']);
    expect(named.steps[0]!.fields[2]!.showWhen).toEqual({ field: 'didYouTryIt', in: ['Yes'] });
    // Existing keys never change.
    expect(nameNewQuestions(form, new Set(['serviceName', 'newQuestion', 'newQuestion2', 'newQuestion3']))).toEqual(form);
  });
});
