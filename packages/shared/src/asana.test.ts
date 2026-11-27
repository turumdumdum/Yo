import { describe, expect, it } from 'vitest';
import { asanaFieldToQuestion, asanaMapping, importAsanaField, normalizeAsanaFields, type AsanaField } from './asana';
import { DEFAULT_REQUEST_FORM, type RequestFormDefinition } from './requestForm';
import { parseRequestForm } from './requestFormEditor';

const setting = (custom_field: Record<string, unknown>, is_important = false) => ({ gid: '1', is_important, custom_field });

const RAW = [
  setting(
    {
      gid: '1201',
      name: '  Priority\u0000 ',
      resource_subtype: 'enum',
      enum_options: [
        { gid: '11', name: 'Low', enabled: true },
        { gid: '12', name: 'High', enabled: true },
        { gid: '13', name: 'Old', enabled: false },
        { gid: 'x', name: 'Bad gid' },
      ],
    },
    true,
  ),
  setting({ gid: '1202', name: 'Teams', resource_subtype: 'multi_enum', enum_options: [{ gid: '21', name: 'Sales' }, { gid: '22', name: 'Sales' }] }),
  setting({ gid: '1203', name: 'Budget', resource_subtype: 'number', precision: 2 }),
  setting({ gid: '1204', name: 'Seats', resource_subtype: 'number', precision: 0 }),
  setting({ gid: '1205', name: 'Go-live', resource_subtype: 'date' }),
  setting({ gid: '1206', name: 'Approver', resource_subtype: 'people' }),
  setting({ gid: '1207', name: 'Score', resource_subtype: 'formula' }),
  setting({ gid: 'abc', name: 'No gid' }),
  setting({ gid: '1208', name: '' }),
  { custom_field: null },
];

describe('normalizeAsanaFields', () => {
  it('keeps well-formed fields and cleans names', () => {
    const fields = normalizeAsanaFields(RAW);
    expect(fields.map((f) => f.gid)).toEqual(['1201', '1202', '1203', '1204', '1205', '1206', '1207']);
    expect(fields[0]).toMatchObject({ name: 'Priority', important: true, options: [{ gid: '11' }, { gid: '12' }, { gid: '13', enabled: false }] });
    expect(normalizeAsanaFields('nope')).toEqual([]);
  });
});

describe('asanaMapping and asanaFieldToQuestion', () => {
  const fields = normalizeAsanaFields(RAW);
  const byGid = (g: string) => fields.find((f) => f.gid === g)!;

  it('maps each Asana type to a question type', () => {
    expect(fields.map((f) => asanaMapping(f).type)).toEqual(['radio', 'multiselect', 'text', 'integer', 'date', 'text', null]);
    expect(asanaMapping(byGid('1207')).note).toMatch(/cannot be imported/);
  });

  it('turns values into choices, without disabled ones unless asked, and keeps the gids', () => {
    const made = asanaFieldToQuestion(byGid('1201'), new Set());
    expect(made).toMatchObject({
      question: { key: 'priority', type: 'radio', optional: false, options: [{ value: 'Low' }, { value: 'High' }], source: { system: 'asana', fieldGid: '1201', optionGids: { Low: '11', High: '12' } } },
    });
    const all = asanaFieldToQuestion(byGid('1201'), new Set(), true);
    expect('question' in all && 'options' in all.question && all.question.options.length).toBe(3);
  });

  it('gives duplicate values distinct choices and keys distinct names', () => {
    const made = asanaFieldToQuestion(byGid('1202'), new Set(['teams']));
    expect(made).toMatchObject({ question: { key: 'teams2', options: [{ value: 'Sales' }, { value: 'Sales (2)' }] } });
  });

  it('refuses a single-choice field with fewer than two values', () => {
    const one: AsanaField = { ...byGid('1201'), options: [{ gid: '1', name: 'Only', enabled: true }] };
    expect(asanaFieldToQuestion(one, new Set())).toEqual({ error: 'A single-choice field needs at least two values' });
  });
});

describe('importAsanaField', () => {
  const fields = normalizeAsanaFields(RAW);
  const priority = fields[0]!;

  it('adds questions that pass the form check, then updates instead of duplicating', () => {
    let form: RequestFormDefinition = DEFAULT_REQUEST_FORM;
    for (const f of fields.slice(0, 6)) {
      const r = importAsanaField(form, 0, f);
      if ('error' in r) throw new Error(r.error);
      expect(r.result).toBe('added');
      form = r.form;
    }
    expect(parseRequestForm(form)).toHaveProperty('form');

    const withRisk: RequestFormDefinition = {
      ...form,
      steps: form.steps.map((s) => ({ ...s, fields: s.fields.map((f) => (f.source?.fieldGid === '1201' && 'options' in f ? { ...f, risk: { High: { points: 2 } }, label: 'Our priority' } : f)) })),
    };
    const changed: AsanaField = { ...priority, options: [{ gid: '12', name: 'High', enabled: true }, { gid: '14', name: 'Urgent', enabled: true }] };
    const r = importAsanaField(withRisk, 0, changed);
    if ('error' in r) throw new Error(r.error);
    expect(r.result).toBe('updated');
    const q = r.form.steps.flatMap((s) => s.fields).filter((f) => f.source?.fieldGid === '1201');
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ label: 'Our priority', options: [{ value: 'High' }, { value: 'Urgent' }], risk: { High: { points: 2 } } });
    expect(parseRequestForm(r.form)).toHaveProperty('form');
    expect(importAsanaField(r.form, 0, changed)).toMatchObject({ result: 'unchanged' });
  });
});

describe('parseRequestForm with an import source', () => {
  const base = { key: 'p', label: 'P', type: 'select', options: [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }] };
  const form = (field: Record<string, unknown>) => ({ steps: [{ title: 'S', fields: [field] }] });

  it('accepts a valid source and refuses malformed ones', () => {
    expect(parseRequestForm(form({ ...base, source: { system: 'asana', fieldGid: '1', optionGids: { A: '2' } } }))).toHaveProperty('form');
    expect(parseRequestForm(form({ ...base, source: { system: 'jira', fieldGid: '1' } }))).toHaveProperty('error');
    expect(parseRequestForm(form({ ...base, source: { system: 'asana', fieldGid: '1', optionGids: { C: '2' } } }))).toEqual({ error: '“P”: the import source lists an unknown choice' });
    expect(parseRequestForm(form({ ...base, source: { system: 'asana', fieldGid: '1', extra: 1 } }))).toHaveProperty('error');
    expect(parseRequestForm(form({ key: 't', label: 'T', type: 'text', source: { system: 'asana', fieldGid: '9', optionGids: {} } }))).toHaveProperty('error');
  });
});

describe('repairRequestForm with imported questions', () => {
  it('drops the Asana ids of choices that were edited away', async () => {
    const { repairRequestForm } = await import('./requestFormEditor');
    const form: RequestFormDefinition = {
      steps: [
        {
          title: 'S',
          fields: [
            { key: 'p', label: 'P', type: 'select', options: [{ value: 'A', label: 'A' }, { value: 'C', label: 'C' }], source: { system: 'asana', fieldGid: '1', optionGids: { A: '2', B: '3' } } },
            { key: 't', label: 'T', type: 'text', source: { system: 'asana', fieldGid: '9', optionGids: { X: '4' } } },
          ],
        },
      ],
    };
    const repaired = repairRequestForm(form);
    expect(repaired.steps[0]!.fields.map((f) => f.source)).toEqual([
      { system: 'asana', fieldGid: '1', optionGids: { A: '2' } },
      { system: 'asana', fieldGid: '9' },
    ]);
    expect(parseRequestForm(repaired)).toHaveProperty('form');
  });
});
