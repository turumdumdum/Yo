import type { FieldDef, Option, RequestFormDefinition } from './requestForm';
import { LIMITS, newFieldKey } from './requestFormEditor';

// Asana project custom fields as request form questions. The API reads the fields with the
// organization's token (see apps/api/src/asana.ts) and passes them through normalizeAsanaFields;
// the form editor turns the ones an admin picks into questions with asanaFieldToQuestion.

/** Where an imported question came from, so a later import updates it instead of adding a copy. */
export interface FieldSource {
  system: 'asana';
  /** Asana custom field gid. */
  fieldGid: string;
  /** Asana enum option gid of each choice, by choice value. */
  optionGids?: Readonly<Record<string, string>>;
}

export interface AsanaOption {
  gid: string;
  name: string;
  enabled: boolean;
}

export interface AsanaField {
  gid: string;
  name: string;
  description: string;
  /** Asana resource_subtype: text, enum, multi_enum, number, date, people, … */
  subtype: string;
  /** Decimal places of a number field. */
  precision: number | null;
  important: boolean;
  options: AsanaOption[];
}

/** Asana ids are strings of digits. */
export const ASANA_GID = /^\d{1,32}$/;

const MAX_FIELDS = 200;
const MAX_DESCRIPTION = 300;

const text = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max)
    : '';
const gid = (value: unknown): string | null => (typeof value === 'string' && ASANA_GID.test(value) ? value : null);

/**
 * Turns the `data` of GET /projects/{gid}/custom_field_settings into clean fields. Asana's
 * answer is untrusted input: unknown shapes are dropped, names are cut to our limits.
 */
export function normalizeAsanaFields(settings: unknown): AsanaField[] {
  if (!Array.isArray(settings)) return [];
  const out: AsanaField[] = [];
  const seen = new Set<string>();
  for (const setting of settings.slice(0, MAX_FIELDS)) {
    const s = setting as { is_important?: unknown; custom_field?: Record<string, unknown> } | null;
    const f = s?.custom_field;
    const id = gid(f?.gid);
    const name = text(f?.name, LIMITS.label);
    if (!f || !id || !name || seen.has(id)) continue;
    seen.add(id);
    const subtype = text(f.resource_subtype, 30) || text(f.type, 30);
    const options: AsanaOption[] = [];
    if (Array.isArray(f.enum_options)) {
      for (const raw of f.enum_options.slice(0, LIMITS.options)) {
        const o = raw as { gid?: unknown; name?: unknown; enabled?: unknown } | null;
        const optionGid = gid(o?.gid);
        const optionName = text(o?.name, LIMITS.option);
        if (optionGid && optionName) options.push({ gid: optionGid, name: optionName, enabled: o?.enabled !== false });
      }
    }
    out.push({
      gid: id,
      name,
      description: text(f.description, MAX_DESCRIPTION),
      subtype,
      precision: typeof f.precision === 'number' && Number.isInteger(f.precision) ? f.precision : null,
      important: s?.is_important === true,
      options,
    });
  }
  return out;
}

export interface AsanaMapping {
  /** Our question type, or null when the field cannot be imported. */
  type: FieldDef['type'] | null;
  /** Plain-language note shown next to the field; empty when the type says it all. */
  note: string;
}

/** Which question type an Asana field becomes. */
export function asanaMapping(field: AsanaField, includeDisabled = false): AsanaMapping {
  const choices = field.options.filter((o) => includeDisabled || o.enabled).length;
  switch (field.subtype) {
    case 'enum':
      if (choices < 2) return { type: null, note: 'A single-choice field needs at least two values' };
      return { type: choices <= 4 ? 'radio' : 'select', note: `${choices} values` };
    case 'multi_enum':
      if (choices < 1) return { type: null, note: 'Has no values' };
      return { type: 'multiselect', note: `${choices} values` };
    case 'text':
      return { type: 'text', note: '' };
    case 'number':
      return field.precision && field.precision > 0
        ? { type: 'text', note: `Number with ${field.precision} decimals, imported as short text` }
        : { type: 'integer', note: '' };
    case 'date':
      return { type: 'date', note: '' };
    case 'people':
      return { type: 'text', note: 'Asana people field, asked as a name or email' };
    default:
      return { type: null, note: `Asana “${field.subtype || 'unknown'}” fields cannot be imported` };
  }
}

/** Choices with unique values; the Asana option gid of each is kept. */
function choicesOf(field: AsanaField, includeDisabled: boolean): { options: Option[]; optionGids: Record<string, string> } {
  const options: Option[] = [];
  const optionGids: Record<string, string> = {};
  for (const o of field.options) {
    if (!includeDisabled && !o.enabled) continue;
    let value = o.name;
    for (let i = 2; value in optionGids; i++) value = `${o.name} (${i})`.slice(0, LIMITS.option);
    options.push({ value, label: value });
    optionGids[value] = o.gid;
  }
  return { options, optionGids };
}

/** A new question for the field, or null with the reason. */
export function asanaFieldToQuestion(
  field: AsanaField,
  taken: ReadonlySet<string>,
  includeDisabled = false,
): { question: FieldDef } | { error: string } {
  const mapping = asanaMapping(field, includeDisabled);
  if (!mapping.type) return { error: mapping.note };
  const key = newFieldKey(field.name, taken);
  const base = {
    key,
    label: field.name,
    ...(field.description ? { hint: field.description } : {}),
    optional: !field.important,
    source: { system: 'asana', fieldGid: field.gid } as FieldSource,
  };
  switch (mapping.type) {
    case 'radio':
    case 'select':
    case 'multiselect': {
      const { options, optionGids } = choicesOf(field, includeDisabled);
      return { question: { ...base, type: mapping.type, options, source: { ...base.source, optionGids } } };
    }
    case 'integer':
      return { question: { ...base, type: 'integer', min: 0 } };
    case 'date':
      return { question: { ...base, type: 'date' } };
    default:
      return {
        question: {
          ...base,
          type: 'text',
          ...(field.subtype === 'people' ? { placeholder: 'Name or email' } : {}),
        },
      };
  }
}

/**
 * Adds the field to a step, or, when a question already came from the same Asana field,
 * updates its choices: kept values keep their risk settings, removed ones are dropped.
 */
export function importAsanaField(
  form: RequestFormDefinition,
  stepIndex: number,
  field: AsanaField,
  includeDisabled = false,
): { form: RequestFormDefinition; result: 'added' | 'updated' | 'unchanged' } | { error: string } {
  const existing = form.steps.flatMap((s) => s.fields).find((f) => f.source?.fieldGid === field.gid);
  if (existing) {
    if (existing.type !== 'select' && existing.type !== 'radio' && existing.type !== 'multiselect') return { form, result: 'unchanged' };
    const { options, optionGids } = choicesOf(field, includeDisabled);
    if (options.length < (existing.type === 'multiselect' ? 1 : 2)) return { error: `“${existing.label}” would have too few values` };
    const values = new Set(options.map((o) => o.value));
    const risk = existing.risk ? Object.fromEntries(Object.entries(existing.risk).filter(([v]) => values.has(v))) : undefined;
    const updated: FieldDef = { ...existing, options, ...(risk ? { risk } : {}), source: { system: 'asana', fieldGid: field.gid, optionGids } };
    const same = JSON.stringify(existing.options) === JSON.stringify(options);
    return {
      form: { ...form, steps: form.steps.map((s) => ({ ...s, fields: s.fields.map((f) => (f.key === existing.key ? updated : f)) })) },
      result: same ? 'unchanged' : 'updated',
    };
  }
  const step = form.steps[stepIndex];
  if (!step) return { error: 'Choose a step' };
  const taken = new Set(form.steps.flatMap((s) => s.fields.map((f) => f.key)));
  const made = asanaFieldToQuestion(field, taken, includeDisabled);
  if ('error' in made) return made;
  return {
    form: { ...form, steps: form.steps.map((s, i) => (i === stepIndex ? { ...s, fields: [...s.fields, made.question] } : s)) },
    result: 'added',
  };
}

/** Checks a stored `source` setting; returns a problem or null. */
export function checkFieldSource(source: unknown, optionValues: ReadonlySet<string> | null): string | null {
  const s = source as { system?: unknown; fieldGid?: unknown; optionGids?: unknown } | null;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'the import source is malformed';
  if (Object.keys(s).some((k) => !['system', 'fieldGid', 'optionGids'].includes(k))) return 'the import source is malformed';
  if (s.system !== 'asana' || typeof s.fieldGid !== 'string' || !ASANA_GID.test(s.fieldGid)) return 'the import source is malformed';
  if (s.optionGids !== undefined) {
    if (!optionValues || !s.optionGids || typeof s.optionGids !== 'object' || Array.isArray(s.optionGids)) return 'the import source is malformed';
    for (const [value, optionGid] of Object.entries(s.optionGids)) {
      if (!optionValues.has(value) || typeof optionGid !== 'string' || !ASANA_GID.test(optionGid)) return 'the import source lists an unknown choice';
    }
  }
  return null;
}
