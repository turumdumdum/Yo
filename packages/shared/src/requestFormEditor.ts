import { RISK_TIERS } from './domain';
import {
  type FieldDef,
  type FieldType,
  type Option,
  type RequestFormDefinition,
  type StepDef,
} from './requestForm';
import { MAX_RISK_POINTS } from './risk';

// Checks a request form an administrator built, before it is stored or used. Shared by the
// editor (instant feedback) and the API (the check that counts). Returns the first problem
// as a sentence a non-technical admin can act on.

export const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

export const LIMITS = {
  steps: 12,
  fieldsPerStep: 40,
  fields: 120,
  options: 300,
  title: 80,
  description: 400,
  label: 120,
  hint: 300,
  placeholder: 120,
  option: 120,
  textMax: 2000,
} as const;

/** Field types an administrator can choose, with plain-language names. */
export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Short text',
  textarea: 'Long text',
  email: 'Email address',
  phone: 'Phone number',
  url: 'Web address',
  date: 'Date',
  integer: 'Whole number',
  money: 'Amount of money',
  radio: 'One choice (buttons)',
  select: 'One choice (drop-down list)',
  multiselect: 'Several choices',
  owner: 'Person (name or “Not required”)',
};

const isChoice = (type: FieldType) => type === 'select' || type === 'radio' || type === 'multiselect';
const isText = (type: FieldType) => ['text', 'textarea', 'url', 'email', 'phone', 'date'].includes(type);
const isNumber = (type: FieldType) => type === 'integer' || type === 'money';
const TYPES = new Set(Object.keys(FIELD_TYPE_LABELS));

const str = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const optionalStr = (value: unknown, max: number) => value === undefined || (typeof value === 'string' && value.length <= max);
const riskPoints = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_RISK_POINTS;

function checkField(raw: unknown, seen: Map<string, FieldDef>, where: string): string | null {
  if (!raw || typeof raw !== 'object') return `${where}: a field is malformed`;
  const f = raw as Record<string, unknown>;
  const name = typeof f.label === 'string' && f.label.trim() ? `“${f.label.trim()}”` : where;
  if (typeof f.key !== 'string' || !FIELD_KEY.test(f.key)) return `${name} has an invalid key`;
  if (seen.has(f.key)) return `Two fields use the key “${f.key}”`;
  if (!str(f.label, LIMITS.label)) return `${where}: every question needs a label of at most ${LIMITS.label} characters`;
  if (!optionalStr(f.hint, LIMITS.hint)) return `${name}: the help text is longer than ${LIMITS.hint} characters`;
  if (!optionalStr(f.placeholder, LIMITS.placeholder)) return `${name}: the example is longer than ${LIMITS.placeholder} characters`;
  if (f.optional !== undefined && typeof f.optional !== 'boolean') return `${name}: “required” must be yes or no`;
  if (typeof f.type !== 'string' || !TYPES.has(f.type)) return `${name} has an unknown answer type`;
  const type = f.type as FieldType;

  if (isChoice(type)) {
    if (!Array.isArray(f.options)) return `${name} needs a list of choices`;
    const minimum = type === 'multiselect' ? 1 : 2;
    if (f.options.length < minimum) return `${name} needs at least ${minimum} choices`;
    if (f.options.length > LIMITS.options) return `${name} has more than ${LIMITS.options} choices`;
    const values = new Set<string>();
    for (const option of f.options as unknown[]) {
      const o = option as Partial<Option> | null;
      if (!o || !str(o.value, LIMITS.option) || !str(o.label, LIMITS.option)) return `${name} has an empty or too long choice`;
      if (values.has(o.value!)) return `${name} lists the choice “${o.value}” twice`;
      values.add(o.value!);
    }
    if (f.risk !== undefined) {
      if (!f.risk || typeof f.risk !== 'object' || Array.isArray(f.risk)) return `${name}: the risk settings are malformed`;
      for (const [value, setting] of Object.entries(f.risk as Record<string, unknown>)) {
        if (!values.has(value)) return `${name}: the risk settings mention “${value}”, which is not one of its choices`;
        const r = setting as { points?: unknown; atLeast?: unknown } | null;
        if (!r || typeof r !== 'object') return `${name}: the risk settings are malformed`;
        if (r.points !== undefined && !riskPoints(r.points)) return `${name}: risk points must be a whole number from 0 to ${MAX_RISK_POINTS}`;
        if (r.atLeast !== undefined && !(RISK_TIERS as readonly unknown[]).includes(r.atLeast)) return `${name}: the minimum risk level is unknown`;
        if (Object.keys(r).some((k) => k !== 'points' && k !== 'atLeast')) return `${name}: the risk settings are malformed`;
      }
    }
  } else if (f.options !== undefined || f.risk !== undefined) return `${name} cannot have choices`;

  if (isText(type)) {
    if (f.maxLength !== undefined && (!Number.isInteger(f.maxLength) || (f.maxLength as number) < 1 || (f.maxLength as number) > LIMITS.textMax)) {
      return `${name}: the maximum length must be between 1 and ${LIMITS.textMax} characters`;
    }
  } else if (f.maxLength !== undefined) return `${name} cannot have a maximum length`;

  if (isNumber(type)) {
    if (typeof f.min !== 'number' || !Number.isFinite(f.min)) return `${name} needs a smallest allowed number`;
    if (f.max !== undefined && (typeof f.max !== 'number' || !Number.isFinite(f.max) || f.max < f.min)) {
      return `${name}: the largest number must not be below the smallest`;
    }
    if (f.riskBands !== undefined) {
      if (!Array.isArray(f.riskBands) || f.riskBands.length > 10) return `${name}: use at most 10 risk thresholds`;
      const seenFrom = new Set<number>();
      for (const band of f.riskBands as unknown[]) {
        const b = band as { from?: unknown; points?: unknown } | null;
        if (!b || typeof b.from !== 'number' || !Number.isFinite(b.from) || !riskPoints(b.points) || Object.keys(b).some((k) => k !== 'from' && k !== 'points')) {
          return `${name}: every risk threshold needs a number and whole points from 0 to ${MAX_RISK_POINTS}`;
        }
        if (seenFrom.has(b.from)) return `${name} has two risk thresholds at ${b.from}`;
        seenFrom.add(b.from);
      }
    }
  } else if (f.min !== undefined || f.max !== undefined || f.riskBands !== undefined) return `${name} cannot have number limits`;

  if (f.showWhen !== undefined) {
    const when = f.showWhen as { field?: unknown; in?: unknown };
    const controller = typeof when.field === 'string' ? seen.get(when.field) : undefined;
    if (!controller) return `${name} depends on a question that does not come before it`;
    if (controller.type !== 'select' && controller.type !== 'radio') return `${name} can only depend on a one-choice question`;
    if (!Array.isArray(when.in) || when.in.length === 0) return `${name}: choose which answers show it`;
    if (when.in.some((v) => !controller.options.some((o) => o.value === v))) {
      return `${name} depends on an answer that “${controller.label}” does not offer`;
    }
  }

  const known = new Set(['key', 'label', 'hint', 'placeholder', 'optional', 'type', 'options', 'risk', 'maxLength', 'min', 'max', 'riskBands', 'showWhen']);
  const extra = Object.keys(f).find((k) => !known.has(k));
  if (extra) return `${name} has an unknown setting “${extra}”`;
  return null;
}

/** Returns the form, or the first problem as a sentence. */
export function parseRequestForm(input: unknown): { form: RequestFormDefinition } | { error: string } {
  if (!input || typeof input !== 'object' || !Array.isArray((input as { steps?: unknown }).steps)) {
    return { error: 'The form must have a list of steps' };
  }
  const formExtra = Object.keys(input).find((k) => !['steps', 'titleField', 'riskLevels', 'confidential', 'businessOwnerField'].includes(k));
  if (formExtra) return { error: `The form has an unknown setting “${formExtra}”` };
  const steps = (input as { steps: unknown[] }).steps;
  if (steps.length === 0) return { error: 'The form needs at least one step' };
  if (steps.length > LIMITS.steps) return { error: `Use at most ${LIMITS.steps} steps` };

  const seen = new Map<string, FieldDef>();
  for (const [i, rawStep] of steps.entries()) {
    const step = rawStep as Partial<StepDef> | null;
    const where = `Step ${i + 1}`;
    if (!step || !str(step.title, LIMITS.title)) return { error: `${where} needs a title of at most ${LIMITS.title} characters` };
    if (!optionalStr(step.description, LIMITS.description)) return { error: `${where}: the description is too long` };
    if (!Array.isArray(step.fields) || step.fields.length === 0) return { error: `Step “${step.title}” has no questions` };
    if (step.fields.length > LIMITS.fieldsPerStep) return { error: `Step “${step.title}” has more than ${LIMITS.fieldsPerStep} questions` };
    const extra = Object.keys(step).find((k) => !['title', 'description', 'fields'].includes(k));
    if (extra) return { error: `${where} has an unknown setting “${extra}”` };
    for (const rawField of step.fields as unknown[]) {
      const problem = checkField(rawField, seen, `Step “${step.title}”`);
      if (problem) return { error: problem };
      const field = rawField as FieldDef;
      seen.set(field.key, field);
    }
  }
  if (seen.size > LIMITS.fields) return { error: `Use at most ${LIMITS.fields} questions` };
  const { titleField, riskLevels } = input as { titleField?: unknown; riskLevels?: unknown };
  if (titleField !== undefined) {
    const field = typeof titleField === 'string' ? seen.get(titleField) : undefined;
    if (!field || field.type !== 'text') return { error: 'The request name must come from a short-text question in the form' };
    if (field.optional || field.showWhen) return { error: `“${field.label}” names the request, so it must be required and always shown` };
  }
  const { confidential, businessOwnerField } = input as { confidential?: unknown; businessOwnerField?: unknown };
  if (confidential !== undefined) {
    const rule = confidential as { field?: unknown; in?: unknown } | null;
    const field = rule && typeof rule.field === 'string' ? seen.get(rule.field) : undefined;
    if (!field || (field.type !== 'radio' && field.type !== 'select')) return { error: 'The confidentiality question must be a one-choice question in the form' };
    if (!Array.isArray(rule!.in) || rule!.in.length === 0 || rule!.in.some((v) => !field.options.some((o) => o.value === v))) {
      return { error: `Choose which answers to “${field.label}” make a request confidential` };
    }
    if (Object.keys(rule!).some((k) => k !== 'field' && k !== 'in')) return { error: 'The confidentiality setting is malformed' };
  }
  if (businessOwnerField !== undefined) {
    const field = typeof businessOwnerField === 'string' ? seen.get(businessOwnerField) : undefined;
    if (!field || field.type !== 'owner') return { error: 'The business owner must be a person question in the form' };
  }
  if (riskLevels !== undefined) {
    const l = riskLevels as Record<string, unknown> | null;
    const ok =
      !!l && typeof l === 'object' && Object.keys(l).length === 3 &&
      [l.Medium, l.High, l.Critical].every((v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 200);
    if (!ok) return { error: 'Risk levels need a whole number of points for Medium, High and Critical' };
    if (!((l.Medium as number) < (l.High as number) && (l.High as number) < (l.Critical as number))) {
      return { error: 'Risk levels must grow: Medium below High, High below Critical' };
    }
  }
  return { form: input as RequestFormDefinition };
}

/** A key for a new question, derived from its label and unique in the form. */
export function newFieldKey(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : ''))
      .replace(/^[^a-z]+/, '')
      .slice(0, 30) || 'question';
  let key = base;
  for (let i = 2; taken.has(key) || !FIELD_KEY.test(key); i++) key = `${base}${i}`;
  return key;
}

/** Choices typed one per line, as stored options. Empty lines and duplicates are dropped. */
export function optionsFromLines(text: string): Option[] {
  const values = [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean))];
  return values.map((value) => ({ value, label: value }));
}

/**
 * Gives questions added in the editor keys derived from their labels ("Vendor contact
 * email" -> vendorContactEmail), so stored answers have readable names. Questions that
 * existed before keep their key, because saved answers refer to it. Conditions that point
 * at a renamed question follow it.
 */
export function nameNewQuestions(form: RequestFormDefinition, existingKeys: ReadonlySet<string>): RequestFormDefinition {
  const renamed = new Map<string, string>();
  const taken = new Set([...form.steps.flatMap((s) => s.fields.map((f) => f.key))].filter((k) => existingKeys.has(k)));
  for (const field of form.steps.flatMap((s) => s.fields)) {
    if (existingKeys.has(field.key)) continue;
    const key = newFieldKey(field.label, taken);
    taken.add(key);
    renamed.set(field.key, key);
  }
  return {
    ...form,
    ...(form.titleField && renamed.has(form.titleField) ? { titleField: renamed.get(form.titleField)! } : {}),
    ...(form.confidential && renamed.has(form.confidential.field) ? { confidential: { ...form.confidential, field: renamed.get(form.confidential.field)! } } : {}),
    ...(form.businessOwnerField && renamed.has(form.businessOwnerField) ? { businessOwnerField: renamed.get(form.businessOwnerField)! } : {}),
    steps: form.steps.map((step) => ({
      ...step,
      fields: step.fields.map((f) => {
        const key = renamed.get(f.key) ?? f.key;
        const when = f.showWhen && renamed.has(f.showWhen.field) ? { ...f.showWhen, field: renamed.get(f.showWhen.field)! } : f.showWhen;
        return { ...f, key, ...(when ? { showWhen: when } : {}) } as FieldDef;
      }),
    })),
  };
}

/**
 * Keeps a form consistent after an edit in the editor: when a question is removed or its
 * choices or type change, conditions and settings that pointed at what is gone are dropped
 * instead of leaving the admin with an error they did not cause.
 * - a condition on a question that no longer exists or is no longer one-choice is removed;
 * - a condition keeps only answers its question still offers;
 * - risk settings keep only existing choices;
 * - the request name stops pointing at a question that is gone or no longer short text.
 * Problems the admin can fix on purpose (a condition on a later question) are left for the
 * validator to report.
 */
export function repairRequestForm(form: RequestFormDefinition): RequestFormDefinition {
  const byKey = new Map(form.steps.flatMap((s) => s.fields).map((f) => [f.key, f]));
  const steps = form.steps.map((step) => ({
    ...step,
    fields: step.fields.map((field) => {
      let next = field;
      if (field.showWhen) {
        const controller = byKey.get(field.showWhen.field);
        if (!controller || (controller.type !== 'radio' && controller.type !== 'select')) {
          const { showWhen: _removed, ...rest } = field;
          next = rest as FieldDef;
        } else {
          const offered = new Set(controller.options.map((o) => o.value));
          const kept = field.showWhen.in.filter((v) => offered.has(v));
          if (kept.length !== field.showWhen.in.length) next = { ...field, showWhen: { ...field.showWhen, in: kept } };
        }
      }
      if ('options' in next && next.risk) {
        const offered = new Set(next.options.map((o) => o.value));
        const entries = Object.entries(next.risk).filter(([value]) => offered.has(value));
        if (entries.length !== Object.keys(next.risk).length) next = { ...next, risk: Object.fromEntries(entries) };
      }
      return next;
    }),
  }));
  const next: { -readonly [K in keyof RequestFormDefinition]: RequestFormDefinition[K] } = { ...form, steps };
  const title = form.titleField ? byKey.get(form.titleField) : undefined;
  if (form.titleField && (!title || title.type !== 'text')) delete next.titleField;
  if (form.confidential) {
    const controller = byKey.get(form.confidential.field);
    if (!controller || (controller.type !== 'radio' && controller.type !== 'select')) delete next.confidential;
    else {
      const kept = form.confidential.in.filter((v) => controller.options.some((o) => o.value === v));
      if (kept.length !== form.confidential.in.length) next.confidential = { ...form.confidential, in: kept };
    }
  }
  if (form.businessOwnerField && byKey.get(form.businessOwnerField)?.type !== 'owner') delete next.businessOwnerField;
  return next;
}

/** Questions whose condition points at the given question. */
export function questionsDependingOn(form: RequestFormDefinition, key: string): FieldDef[] {
  return form.steps.flatMap((s) => s.fields).filter((f) => f.showWhen?.field === key);
}
