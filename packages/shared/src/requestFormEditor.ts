import {
  DEFAULT_REQUEST_FORM,
  SYSTEM_FIELD_KEYS,
  type FieldDef,
  type FieldType,
  type Option,
  type RequestFormDefinition,
  type StepDef,
} from './requestForm';

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

const SYSTEM = new Set<string>(SYSTEM_FIELD_KEYS);
const DEFAULT_FIELDS = new Map(DEFAULT_REQUEST_FORM.steps.flatMap((s) => s.fields).map((f) => [f.key, f]));

export function isSystemField(key: string): boolean {
  return SYSTEM.has(key);
}

const isChoice = (type: FieldType) => type === 'select' || type === 'radio' || type === 'multiselect';
const isText = (type: FieldType) => ['text', 'textarea', 'url', 'email', 'phone', 'date'].includes(type);
const isNumber = (type: FieldType) => type === 'integer' || type === 'money';
const TYPES = new Set(Object.keys(FIELD_TYPE_LABELS));

const str = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const optionalStr = (value: unknown, max: number) => value === undefined || (typeof value === 'string' && value.length <= max);
const sameValues = (a: readonly Option[], b: readonly Option[]) =>
  a.length === b.length && a.every((o, i) => o.value === b[i]!.value);

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
  } else if (f.options !== undefined) return `${name} cannot have choices`;

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
  } else if (f.min !== undefined || f.max !== undefined) return `${name} cannot have number limits`;

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

  const known = new Set(['key', 'label', 'hint', 'placeholder', 'optional', 'type', 'options', 'maxLength', 'min', 'max', 'showWhen']);
  const extra = Object.keys(f).find((k) => !known.has(k));
  if (extra) return `${name} has an unknown setting “${extra}”`;
  return null;
}

/** Checks the fields the product depends on are still there and unchanged in meaning. */
function checkSystemField(field: FieldDef): string | null {
  const original = DEFAULT_FIELDS.get(field.key)!;
  const name = `“${field.label}”`;
  if (field.type !== original.type) return `${name} is used to work out the risk and must stay “${FIELD_TYPE_LABELS[original.type]}”`;
  if ('options' in original && 'options' in field && !sameValues(original.options, field.options)) {
    return `The choices of ${name} are used to work out the risk and cannot be changed`;
  }
  if (Boolean(field.optional) !== Boolean(original.optional)) return `${name} is used to work out the risk and must stay required`;
  if (JSON.stringify(field.showWhen ?? null) !== JSON.stringify(original.showWhen ?? null)) {
    return `When ${name} is shown cannot be changed`;
  }
  if ('min' in original && 'min' in field && (field.min !== original.min || field.max !== original.max)) {
    return `The number limits of ${name} cannot be changed`;
  }
  return null;
}

/** Returns the form, or the first problem as a sentence. */
export function parseRequestForm(input: unknown): { form: RequestFormDefinition } | { error: string } {
  if (!input || typeof input !== 'object' || !Array.isArray((input as { steps?: unknown }).steps)) {
    return { error: 'The form must have a list of steps' };
  }
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
      if (isSystemField(field.key)) {
        const systemProblem = checkSystemField(field);
        if (systemProblem) return { error: systemProblem };
      }
      seen.set(field.key, field);
    }
  }
  if (seen.size > LIMITS.fields) return { error: `Use at most ${LIMITS.fields} questions` };
  const missing = SYSTEM_FIELD_KEYS.find((key) => !seen.has(key));
  if (missing) return { error: `The form must keep “${DEFAULT_FIELDS.get(missing)!.label}”: it is used to work out the risk` };
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
