import type { FieldSource } from './asana';
import { COUNTRIES } from './countries';
import {
  BUSINESS_CRITICALITIES,
  DATA_CLASSIFICATIONS,
  PAYMENT_TYPES,
  REQUEST_TYPES,
  type DataClassification,
  type RiskTier,
} from './domain';

// The request form (CLAUDE.md §5), described as data. The same definition drives the form
// UI, server-side validation and the answer summary, so a field is declared once.
// Organizations can replace the standard form with their own (see requestFormEditor.ts);
// every function here therefore takes the form it works on, defaulting to the standard one.

export type Answers = Record<string, unknown>;

export interface Option {
  value: string;
  label: string;
}

/** Value of an owner field: a named person, or an explicit "Not required". */
export interface OwnerValue {
  name?: string;
  notRequired?: boolean;
}

interface FieldBase {
  key: string;
  label: string;
  /** Help text shown under the label. */
  hint?: string;
  /** Example shown inside an empty input. */
  placeholder?: string;
  optional?: boolean;
  /** The field is shown, validated and stored only when another answer has one of these values. */
  showWhen?: { field: string; in: readonly string[] };
  /** Set when the question was imported from another system (Asana), so a new import updates it. */
  source?: FieldSource;
}

/** How choosing an option affects the risk tier. */
export interface OptionRisk {
  /** Points added to the risk score. */
  points?: number;
  /** The tier is never lower than this when the option is chosen. */
  atLeast?: RiskTier;
}

/** Points added when a number reaches `from`; the highest band reached applies. */
export interface RiskBand {
  from: number;
  points: number;
}

/** Minimum score for each tier; below Medium the tier is Low. */
export type RiskLevels = Record<Exclude<RiskTier, 'Low'>, number>;

export type FieldDef = FieldBase &
  (
    | { type: 'text' | 'textarea' | 'url' | 'email' | 'phone' | 'date'; maxLength?: number }
    | { type: 'integer' | 'money'; min: number; max?: number; riskBands?: readonly RiskBand[] }
    | { type: 'select' | 'radio' | 'multiselect'; options: readonly Option[]; risk?: Readonly<Record<string, OptionRisk>> }
    | { type: 'owner' }
  );

export type FieldType = FieldDef['type'];

export interface StepDef {
  title: string;
  /** Short explanation shown at the top of the step. */
  description?: string;
  fields: readonly FieldDef[];
}

export interface RequestFormDefinition {
  steps: readonly StepDef[];
  /** Key of the short-text question whose answer names the request. Defaults to serviceName. */
  titleField?: string;
  /** Risk score needed for each tier; see risk.ts. */
  riskLevels?: RiskLevels;
  /** A one-choice question whose answers (`in`) make the request confidential. */
  confidential?: { field: string; in: readonly string[] };
  /** Key of the person question naming the business owner, who may see a confidential request. */
  businessOwnerField?: string;
}

const options = (values: readonly string[]): Option[] => values.map((value) => ({ value, label: value }));
const YES_NO = options(['Yes', 'No']);
const COUNTRY_OPTIONS: Option[] = COUNTRIES.map(([value, label]) => ({ value, label }));

// Starter catalogs. Per-organization catalogs arrive with the workflow builder (roadmap stage 3).
export const CATEGORIES = [
  'SaaS application',
  'Infrastructure & hosting',
  'Security',
  'Data & analytics',
  'Developer tools',
  'Marketing & sales',
  'HR & recruiting',
  'Finance & legal',
  'Communication & collaboration',
  'Professional services',
  'Hardware',
  'Other',
] as const;

export const INTEGRATION_CATALOG = [
  'Google Workspace',
  'Microsoft 365',
  'Slack',
  'Okta',
  'Jira',
  'Asana',
  'GitHub',
  'GitLab',
  'Salesforce',
  'HubSpot',
  'AWS',
  'Google Cloud',
  'Azure',
  'Snowflake',
  'Zapier',
] as const;

export const CURRENCIES = ['EUR', 'USD', 'GBP', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'JPY', 'CAD', 'AUD'] as const;

export const SIGN_IN_METHODS = ['SSO', 'Email + password', 'API key', 'Shared account'] as const;
export const PLATFORMS = ['Web', 'Desktop', 'Mobile', 'Browser extension', 'API', 'On-prem'] as const;

const INTERNAL_OR_HIGHER: readonly DataClassification[] = ['Internal', 'Confidential', 'Restricted'];
const whenPaid = { field: 'paymentType', in: ['Paid'] } as const;

export const REQUEST_FORM_STEPS: readonly StepDef[] = [
  {
    title: 'What do you need?',
    description: 'Tell us which service you want and why. Reviewers read this first.',
    fields: [
      { key: 'serviceName', label: 'Service name', type: 'text', placeholder: 'For example Figma' },
      { key: 'vendorName', label: 'Vendor', type: 'text', hint: 'The company that sells the service.', placeholder: 'For example Figma, Inc.' },
      { key: 'vendorWebsite', label: 'Vendor website', type: 'url', hint: 'https:// is added for you.', placeholder: 'vendor.com' },
      { key: 'requestType', label: 'Request type', type: 'radio', options: options(REQUEST_TYPES) },
      { key: 'category', label: 'Category', type: 'select', options: options(CATEGORIES) },
      { key: 'purpose', label: 'Purpose of use', type: 'textarea', hint: 'What will the service be used for, and by whom?' },
      { key: 'neededBy', label: 'Needed by', type: 'date' },
      { key: 'alternatives', label: 'Alternatives considered', type: 'textarea', optional: true },
      {
        key: 'confidential',
        label: 'Keep this request confidential?',
        type: 'radio',
        optional: true,
        hint: 'Choose Yes for sensitive plans, for example a planned acquisition or a tool for an investigation.',
        options: [
          { value: 'No', label: 'No, the usual managers and reviewers can see it' },
          { value: 'Yes', label: 'Yes, only the business owner, org admins and the people they add' },
        ],
      },
    ],
  },
  {
    title: 'Entities & geography',
    description: 'Which companies sign the contract and where the service will be used.',
    fields: [
      { key: 'countryOfUse', label: 'Country of use', type: 'select', options: COUNTRY_OPTIONS },
      { key: 'ourLegalEntity', label: 'Our legal entity', type: 'text', hint: 'The company that will sign the contract.' },
      { key: 'vendorLegalEntity', label: 'Vendor legal entity', type: 'text' },
      { key: 'vendorCountry', label: 'Vendor country of registration', type: 'select', options: COUNTRY_OPTIONS },
    ],
  },
  {
    title: 'Access & platform',
    description: 'How people will sign in and what the service connects to.',
    fields: [
      { key: 'signInMethod', label: 'Sign-in method', type: 'radio', options: options(SIGN_IN_METHODS) },
      { key: 'platforms', label: 'Planned platform', type: 'multiselect', options: options(PLATFORMS) },
      {
        key: 'integrations',
        label: 'Integrations',
        type: 'multiselect',
        options: options(INTEGRATION_CATALOG),
        optional: true,
        hint: 'Systems the service will connect to.',
      },
      { key: 'integrationsOther', label: 'Other integrations', type: 'text', optional: true },
      { key: 'expectedUsers', label: 'Expected number of users', type: 'integer', min: 1 },
      {
        key: 'vendorUsesAi',
        label: 'Does the vendor use AI on our data?',
        type: 'radio',
        options: options(['Yes', 'No', 'Unknown']),
      },
    ],
  },
  {
    title: 'Data',
    description: 'What data the vendor will see. If unsure, choose the higher classification.',
    fields: [
      {
        key: 'dataClassification',
        label: 'Data classification',
        type: 'radio',
        options: options(DATA_CLASSIFICATIONS),
        risk: { Internal: { points: 1 }, Confidential: { points: 3 }, Restricted: { points: 5, atLeast: 'High' } },
      },
      {
        key: 'personalData',
        label: 'Personal data involved?',
        type: 'radio',
        options: YES_NO,
        showWhen: { field: 'dataClassification', in: INTERNAL_OR_HIGHER },
      },
      {
        key: 'personalDataTypes',
        label: 'What personal data, and whose?',
        type: 'textarea',
        hint: 'For example names and work emails of employees.',
        showWhen: { field: 'personalData', in: ['Yes'] },
      },
      { key: 'dataLocation', label: 'Data location', type: 'text', hint: 'Where the vendor stores and processes the data.' },
      { key: 'productionAccess', label: 'Access to production systems?', type: 'radio', options: YES_NO, risk: { Yes: { points: 2 } } },
    ],
  },
  {
    title: 'Commercials',
    description: 'What it costs and how the contract runs.',
    fields: [
      { key: 'paymentType', label: 'Paid or free', type: 'radio', options: options(PAYMENT_TYPES) },
      {
        key: 'annualCost',
        label: 'Estimated annual cost',
        type: 'money',
        min: 0,
        showWhen: whenPaid,
        riskBands: [
          { from: 10_000, points: 1 },
          { from: 50_000, points: 2 },
          { from: 250_000, points: 3 },
        ],
      },
      { key: 'currency', label: 'Currency', type: 'select', options: options(CURRENCIES), showWhen: whenPaid },
      { key: 'contractTermMonths', label: 'Contract term (months)', type: 'integer', min: 1, showWhen: whenPaid },
      { key: 'autoRenewal', label: 'Auto-renewal', type: 'radio', options: YES_NO, showWhen: whenPaid },
      { key: 'costCenter', label: 'Cost center', type: 'text', showWhen: whenPaid },
    ],
  },
  {
    title: 'Ownership',
    description: 'Who is responsible for this service. Choose “Not required” where a role does not apply.',
    fields: [
      { key: 'budgetOwner', label: 'Budget owner', type: 'owner' },
      {
        key: 'businessOwner',
        label: 'Business owner',
        type: 'owner',
        hint: 'Use their work email, so they can follow the request even when it is confidential.',
      },
      { key: 'accessAdministrator', label: 'Access administrator', type: 'owner' },
      { key: 'technicalOwner', label: 'Technical owner', type: 'owner' },
    ],
  },
  {
    title: 'Review',
    description: 'How important the service is, files for reviewers, and a last check of your answers.',
    fields: [
      {
        key: 'businessCriticality',
        label: 'Business criticality',
        type: 'radio',
        options: options(BUSINESS_CRITICALITIES),
        hint: 'How badly would the business be affected if this service stopped working?',
        risk: { Medium: { points: 1 }, High: { points: 2 }, Critical: { points: 4, atLeast: 'High' } },
      },
    ],
  },
];

/** The standard form every organization starts with. */
export const DEFAULT_REQUEST_FORM: RequestFormDefinition = {
  steps: REQUEST_FORM_STEPS,
  titleField: 'serviceName',
  confidential: { field: 'confidential', in: ['Yes'] },
  businessOwnerField: 'businessOwner',
};

/** Whether validated answers ask to keep the request confidential. */
export function isConfidential(cleaned: Answers, form: RequestFormDefinition = DEFAULT_REQUEST_FORM): boolean {
  const rule = form.confidential;
  if (!rule) return false;
  const value = cleaned[rule.field];
  return typeof value === 'string' && rule.in.includes(value);
}

/** The business owner's answer when it is an email address; null otherwise. */
export function businessOwnerEmail(cleaned: Answers, form: RequestFormDefinition = DEFAULT_REQUEST_FORM): string | null {
  const key = form.businessOwnerField ?? 'businessOwner';
  const value = cleaned[key] as OwnerValue | undefined;
  const name = value && typeof value === 'object' && typeof value.name === 'string' ? value.name.trim() : '';
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(name) ? name.toLowerCase() : null;
}

/** Key of the question that names a request. */
export function titleFieldKey(form: RequestFormDefinition = DEFAULT_REQUEST_FORM): string {
  return form.titleField ?? 'serviceName';
}

const TEXT_MAX = 200;
const TEXTAREA_MAX = 2000;
/** Values above this are almost certainly typing mistakes. */
const NUMBER_MAX = 1_000_000_000_000;

/** Every field of a form, in display order. */
export function allFields(form: RequestFormDefinition = DEFAULT_REQUEST_FORM): FieldDef[] {
  return form.steps.flatMap((step) => [...step.fields]);
}

function findField(key: string, form: RequestFormDefinition): FieldDef | undefined {
  for (const step of form.steps) {
    const field = step.fields.find((f) => f.key === key);
    if (field) return field;
  }
  return undefined;
}

function isVisible(field: FieldDef, answers: Answers, form: RequestFormDefinition, depth = 0): boolean {
  if (!field.showWhen) return true;
  const controller = findField(field.showWhen.field, form);
  // A field controlled by a hidden field is hidden too. The depth guard protects against
  // stored forms with a cycle; the form validator refuses those.
  if (controller && (depth > 20 || !isVisible(controller, answers, form, depth + 1))) return false;
  const value = answers[field.showWhen.field];
  return typeof value === 'string' && field.showWhen.in.includes(value);
}

/** Fields of a step that apply to the given answers, in display order. */
export function visibleFields(stepIndex: number, answers: Answers, form: RequestFormDefinition = DEFAULT_REQUEST_FORM): FieldDef[] {
  return (form.steps[stepIndex]?.fields ?? []).filter((f) => isVisible(f, answers, form));
}

/** Adds https:// to a web address that has no scheme: "acme.example" becomes "https://acme.example". */
export function withHttps(raw: string): string {
  const value = raw.trim();
  if (value === '' || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return `https://${value.replace(/^\/+/, '')}`;
}

type Checked = { value: unknown } | { error: string } | { empty: true };

function checkField(field: FieldDef, raw: unknown): Checked {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'url':
    case 'email':
    case 'phone':
    case 'date': {
      if (typeof raw !== 'string' || raw.trim() === '') return { empty: true };
      // A web address typed without a scheme gets https://.
      const value = field.type === 'url' ? withHttps(raw) : field.type === 'email' ? raw.trim().toLowerCase() : raw.trim();
      const max = Math.min(field.maxLength ?? Infinity, field.type === 'textarea' ? TEXTAREA_MAX : TEXT_MAX);
      if (value.length > max) return { error: `Use at most ${max} characters` };
      if (field.type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
        return { error: 'Enter an email address such as name@company.com' };
      }
      if (field.type === 'phone' && !/^\+?[0-9][0-9 ()./-]{5,24}$/.test(value)) {
        return { error: 'Enter a phone number such as +372 5555 1234' };
      }
      if (field.type === 'url') {
        // No URL global here: this package is built without DOM or Node typings.
        if (!/^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+([/:?#]\S*)?$/i.test(value)) {
          return { error: 'Enter a web address such as vendor.example' };
        }
      }
      if (field.type === 'date') {
        const valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
        if (!valid) return { error: 'Enter a valid date' };
      }
      return { value };
    }
    case 'integer':
    case 'money': {
      if (raw === null || raw === undefined || raw === '') return { empty: true };
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.trim()) : NaN;
      if (!Number.isFinite(value)) return { error: 'Enter a number' };
      if (field.type === 'integer' && !Number.isInteger(value)) return { error: 'Enter a whole number' };
      if (value < field.min) return { error: `Enter ${field.min} or more` };
      if (field.max !== undefined && value > field.max) return { error: `Enter ${field.max} or less` };
      if (value > NUMBER_MAX) return { error: 'This number is too large' };
      return { value };
    }
    case 'select':
    case 'radio': {
      if (raw === null || raw === undefined || raw === '') return { empty: true };
      if (typeof raw !== 'string' || !field.options.some((o) => o.value === raw)) return { error: 'Choose one of the options' };
      return { value: raw };
    }
    case 'multiselect': {
      if (raw === null || raw === undefined) return { empty: true };
      if (!Array.isArray(raw)) return { error: 'Choose from the options' };
      if (raw.length === 0) return { empty: true };
      const allowed = new Set(field.options.map((o) => o.value));
      if (!raw.every((v) => typeof v === 'string' && allowed.has(v))) return { error: 'Choose from the options' };
      // Keep catalog order and drop duplicates.
      return { value: field.options.map((o) => o.value).filter((v) => raw.includes(v)) };
    }
    case 'owner': {
      if (!raw || typeof raw !== 'object') return { empty: true };
      const owner = raw as OwnerValue;
      if (owner.notRequired === true) return { value: { notRequired: true } satisfies OwnerValue };
      if (typeof owner.name !== 'string' || owner.name.trim() === '') return { empty: true };
      const name = owner.name.trim();
      if (name.length > TEXT_MAX) return { error: `Use at most ${TEXT_MAX} characters` };
      return { value: { name } satisfies OwnerValue };
    }
  }
}

function requiredMessage(field: FieldDef): string {
  switch (field.type) {
    case 'owner':
      return 'Enter a name or choose "Not required"';
    case 'select':
    case 'radio':
      return 'Choose an option';
    case 'multiselect':
      return 'Choose at least one option';
    default:
      return 'This field is required';
  }
}

export interface ValidationResult {
  /** Field key -> message. Empty when the answers are complete and valid. */
  errors: Record<string, string>;
  /** Normalized answers: trimmed, typed, without hidden or unknown fields. */
  cleaned: Answers;
}

/** Validates every visible field of the given steps (all steps by default). */
export function validateAnswers(
  answers: Answers,
  stepIndexes?: readonly number[],
  form: RequestFormDefinition = DEFAULT_REQUEST_FORM,
): ValidationResult {
  const errors: Record<string, string> = {};
  const cleaned: Answers = {};
  const steps = stepIndexes ?? form.steps.map((_, i) => i);
  for (const stepIndex of steps) {
    for (const field of visibleFields(stepIndex, answers, form)) {
      const checked = checkField(field, answers[field.key]);
      if ('error' in checked) errors[field.key] = checked.error;
      else if ('empty' in checked) {
        if (!field.optional) errors[field.key] = requiredMessage(field);
      } else cleaned[field.key] = checked.value;
    }
  }
  return { errors, cleaned };
}

/**
 * Normalizes one proposed value for a field (for example an AI suggestion).
 * Returns undefined when the form has no such field or the value is not acceptable.
 */
export function normalizeAnswer(key: string, raw: unknown, form: RequestFormDefinition = DEFAULT_REQUEST_FORM): unknown {
  const field = findField(key, form);
  if (!field) return undefined;
  const checked = checkField(field, raw);
  return 'value' in checked ? checked.value : undefined;
}

/** Label of a form field, or undefined for an unknown key. */
export function fieldLabel(key: string, form: RequestFormDefinition = DEFAULT_REQUEST_FORM): string | undefined {
  return findField(key, form)?.label;
}

/** Index of the step a field is on, or -1. */
export function stepOfField(key: string, form: RequestFormDefinition = DEFAULT_REQUEST_FORM): number {
  return form.steps.findIndex((step) => step.fields.some((f) => f.key === key));
}

/** Index of the first step that has a validation error, or -1. */
export function firstStepWithErrors(errors: Record<string, string>, form: RequestFormDefinition = DEFAULT_REQUEST_FORM): number {
  return form.steps.findIndex((step) => step.fields.some((f) => f.key in errors));
}

/** Text shown for an answer in summaries. */
export function formatAnswer(field: FieldDef, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  switch (field.type) {
    case 'select':
    case 'radio':
      return field.options.find((o) => o.value === value)?.label ?? String(value);
    case 'multiselect':
      return Array.isArray(value) && value.length > 0 ? value.join(', ') : '—';
    case 'owner': {
      const owner = value as OwnerValue;
      return owner.notRequired ? 'Not required' : owner.name || '—';
    }
    case 'money':
    case 'integer':
      return typeof value === 'number' ? value.toLocaleString('en-US') : String(value);
    default:
      return String(value);
  }
}

/** Rule-based completeness hints for the review step. They never block submission. */
export function completenessHints(answers: Answers, form: RequestFormDefinition = DEFAULT_REQUEST_FORM): string[] {
  const hints: string[] = [];
  const classification = answers.dataClassification;
  if (classification === 'Confidential' || classification === 'Restricted') {
    hints.push('Reviewers will ask for a security report from the vendor (for example SOC 2 Type II or ISO/IEC 27001). Have it ready.');
  }
  if (answers.personalData === 'Yes') {
    hints.push('Personal data is involved: a data processing agreement (DPA) with the vendor will be needed.');
  }
  if (answers.vendorUsesAi === 'Yes' || answers.vendorUsesAi === 'Unknown') {
    hints.push('Find out how the vendor uses AI on our data and whether it trains models on it.');
  }
  if (answers.paymentType === 'Paid' && typeof answers.annualCost === 'number' && answers.annualCost >= 10_000) {
    hints.push('Have the vendor quote or order form ready for the finance review.');
  }
  if (answers.signInMethod === 'Shared account') {
    hints.push('Shared accounts are hard to audit. Ask the vendor whether SSO or individual accounts are available.');
  }
  const asksAlternatives = form.steps.some((step) => step.fields.some((f) => f.key === 'alternatives'));
  if (asksAlternatives && (typeof answers.alternatives !== 'string' || answers.alternatives.trim() === '')) {
    hints.push('Listing the alternatives you considered speeds up the review.');
  }
  return hints;
}
