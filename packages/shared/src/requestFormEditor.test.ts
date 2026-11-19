import { describe, expect, it } from 'vitest';
import { businessOwnerEmail, DEFAULT_REQUEST_FORM, isConfidential, validateAnswers, visibleFields, type FieldDef, type RequestFormDefinition } from './requestForm';
import { nameNewQuestions, newFieldKey, optionsFromLines, parseRequestForm, questionsDependingOn, repairRequestForm } from './requestFormEditor';

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

  it('accepts a form where every standard question was changed or removed', () => {
    const form = clone();
    const all = form.steps.flatMap((s) => s.fields);
    const keep = new Set(['serviceName', 'dataClassification']);
    const custom: FieldDef[] = [
      { key: 'contactEmail', label: 'Vendor contact email', type: 'email', placeholder: 'sales@vendor.com' },
      { key: 'hasTrial', label: 'Did you try it?', type: 'radio', options: [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }] },
      { key: 'trialNotes', label: 'What did you learn?', type: 'textarea', maxLength: 500, optional: true, showWhen: { field: 'hasTrial', in: ['Yes'] } },
      { key: 'seats', label: 'Seats', type: 'integer', min: 1, max: 500 },
    ];
    const short = {
      steps: [
        {
          title: 'The basics',
          description: 'Two minutes.',
          fields: [
            ...all
              .filter((f) => keep.has(f.key))
              .map((f) =>
                f.key === 'serviceName'
                  ? { ...f, label: 'Tool name', hint: 'As the vendor calls it' }
                  : { key: f.key, label: 'Is it secret?', type: 'multiselect' as const, options: [{ value: 'Yes', label: 'Yes' }], risk: { Yes: { points: 20, atLeast: 'Critical' as const } } },
              ),
            ...custom,
          ],
        },
      ],
      titleField: 'serviceName',
      riskLevels: { Medium: 1, High: 2, Critical: 3 },
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
    [(f: ReturnType<typeof clone>) => f.steps[0]!.fields.splice(0, 1), /request name must come from a short-text question/],
    [(f: ReturnType<typeof clone>) => ((f.steps[0]!.fields[0] as FieldDef).optional = true), /names the request, so it must be required/],
    [(f: ReturnType<typeof clone>) => ((f.steps[3]!.fields[0] as unknown as { options: unknown[] }).options.pop()), /mention “Restricted”, which is not one of its choices/],
    [(f: ReturnType<typeof clone>) => ((f.steps[3]!.fields[0] as unknown as { risk: unknown }).risk = { Public: { points: 99 } }), /whole number from 0 to 20/],
    [(f: ReturnType<typeof clone>) => ((f.steps[3]!.fields[0] as unknown as { risk: unknown }).risk = { Public: { atLeast: 'Huge' } }), /minimum risk level is unknown/],
    [(f: ReturnType<typeof clone>) => ((f.steps[4]!.fields[1] as unknown as { riskBands: unknown }).riskBands = [{ from: 'a', points: 1 }]), /every risk threshold/],
    [(f: ReturnType<typeof clone>) => ((f.steps[0]!.fields[0] as unknown as { risk: unknown }).risk = {}), /cannot have choices/],
    [(f: ReturnType<typeof clone>) => ((f as { riskLevels?: unknown }).riskLevels = { Medium: 5, High: 4, Critical: 9 }), /must grow/],
    [(f: ReturnType<typeof clone>) => ((f as { extra?: unknown }).extra = 1), /unknown setting “extra”/],
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

  it('lets any short-text question name the request', () => {
    const form = { steps: [{ title: 'S', fields: [{ key: 'tool', label: 'Tool', type: 'text' }] }], titleField: 'tool' };
    expect(error(form)).toBeNull();
    expect(error({ ...form, titleField: 'missing' })).toMatch(/request name/);
    // Without titleField a form simply has no request name unless it keeps serviceName.
    expect(error({ steps: form.steps })).toBeNull();
  });

  it('rejects things that are not forms', () => {
    expect(error(null)).toMatch(/list of steps/);
    expect(error({ steps: 'x' })).toMatch(/list of steps/);
    expect(error({ steps: Array.from({ length: 13 }, () => ({ title: 'S', fields: [] })) })).toMatch(/at most 12 steps/);
  });
});

describe('helpers', () => {
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

describe('repairRequestForm', () => {
  const yesNo = [
    { value: 'Yes', label: 'Yes' },
    { value: 'No', label: 'No' },
  ];
  const form: RequestFormDefinition = {
    titleField: 'tool',
    steps: [
      {
        title: 'S',
        fields: [
          { key: 'tool', label: 'Tool', type: 'text' },
          { key: 'paid', label: 'Paid?', type: 'radio', options: yesNo, risk: { Yes: { points: 1 }, No: { points: 0 } } },
          { key: 'cost', label: 'Cost', type: 'money', min: 0, showWhen: { field: 'paid', in: ['Yes', 'No'] } },
        ],
      },
    ],
  };

  it('leaves a consistent form alone', () => {
    expect(repairRequestForm(form)).toEqual(form);
    expect(questionsDependingOn(form, 'paid').map((f) => f.key)).toEqual(['cost']);
  });

  it('drops conditions, risk settings and the request name that point at what is gone', () => {
    const withoutPaid = { ...form, steps: [{ ...form.steps[0]!, fields: [form.steps[0]!.fields[0]!, form.steps[0]!.fields[2]!] }] };
    expect(repairRequestForm(withoutPaid).steps[0]!.fields[1]!.showWhen).toBeUndefined();

    const fewerChoices = copyWith(form, 1, { ...form.steps[0]!.fields[1]!, options: [yesNo[0]!] } as FieldDef);
    const repaired = repairRequestForm(fewerChoices);
    expect(repaired.steps[0]!.fields[2]!.showWhen).toEqual({ field: 'paid', in: ['Yes'] });
    expect((repaired.steps[0]!.fields[1] as { risk?: unknown }).risk).toEqual({ Yes: { points: 1 } });

    const titleIsLongText = copyWith(form, 0, { key: 'tool', label: 'Tool', type: 'textarea' });
    expect(repairRequestForm(titleIsLongText).titleField).toBeUndefined();
  });
});

function copyWith(form: RequestFormDefinition, index: number, field: FieldDef): RequestFormDefinition {
  return { ...form, steps: [{ ...form.steps[0]!, fields: form.steps[0]!.fields.map((f, i) => (i === index ? field : f)) }] };
}

describe('confidentiality settings', () => {
  it('reads the confidentiality answer and the business owner email', () => {
    expect(isConfidential({ confidential: 'Yes' })).toBe(true);
    expect(isConfidential({ confidential: 'No' })).toBe(false);
    expect(isConfidential({})).toBe(false);
    expect(isConfidential({ confidential: 'Yes' }, { steps: DEFAULT_REQUEST_FORM.steps })).toBe(false);
    expect(businessOwnerEmail({ businessOwner: { name: ' Ann@Acme.example ' } })).toBe('ann@acme.example');
    expect(businessOwnerEmail({ businessOwner: { name: 'Ann Lee' } })).toBeNull();
    expect(businessOwnerEmail({ businessOwner: { notRequired: true } })).toBeNull();
  });

  it('validates and repairs the settings', () => {
    const form = clone() as unknown as Record<string, unknown>;
    form.confidential = { field: 'confidential', in: ['Maybe'] };
    expect(error(form)).toMatch(/make a request confidential/);
    form.confidential = { field: 'purpose', in: ['Yes'] };
    expect(error(form)).toMatch(/one-choice question/);
    delete form.confidential;
    form.businessOwnerField = 'purpose';
    expect(error(form)).toMatch(/person question/);

    const withoutQuestion = { ...DEFAULT_REQUEST_FORM, steps: DEFAULT_REQUEST_FORM.steps.map((s) => ({ ...s, fields: s.fields.filter((f) => f.key !== 'confidential' && f.key !== 'businessOwner') })) };
    const repaired = repairRequestForm(withoutQuestion);
    expect(repaired.confidential).toBeUndefined();
    expect(repaired.businessOwnerField).toBeUndefined();
    expect(error(repaired)).toBeNull();
  });
});
