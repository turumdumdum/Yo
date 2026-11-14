import { COUNTRIES } from './countries';
import {
  BUSINESS_CRITICALITIES,
  DATA_CLASSIFICATIONS,
  PAYMENT_TYPES,
  REQUEST_TYPES,
  type BusinessCriticality,
  type DataClassification,
} from './domain';
import type { RiskInput } from './risk';

// The 7-step request form (CLAUDE.md §5), described as data. The same definitions drive
// the form UI, server-side validation and the answer summary, so a field is declared once.
// File attachments (step 7) are not part of the form yet.

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
  hint?: string;
  optional?: boolean;
  /** The field is shown, validated and stored only when another answer has one of these values. */
  showWhen?: { field: string; in: readonly string[] };
}

export type FieldDef = FieldBase &
  (
    | { type: 'text' | 'textarea' | 'url' | 'date' }
    | { type: 'integer' | 'money'; min: number }
    | { type: 'select' | 'radio'; options: readonly Option[] }
    | { type: 'multiselect'; options: readonly Option[] }
    | { type: 'owner' }
  );

export interface StepDef {
  title: string;
  fields: readonly FieldDef[];
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
    fields: [
      { key: 'serviceName', label: 'Service name', type: 'text' },
      { key: 'vendorName', label: 'Vendor', type: 'text' },
      { key: 'vendorWebsite', label: 'Vendor website', type: 'url', hint: 'For example https://vendor.example' },
      { key: 'requestType', label: 'Request type', type: 'radio', options: options(REQUEST_TYPES) },
      { key: 'category', label: 'Category', type: 'select', options: options(CATEGORIES) },
      { key: 'purpose', label: 'Purpose of use', type: 'textarea', hint: 'What will the service be used for, and by whom?' },
      { key: 'neededBy', label: 'Needed by', type: 'date' },
      { key: 'alternatives', label: 'Alternatives considered', type: 'textarea', optional: true },
    ],
  },
  {
    title: 'Entities & geography',
    fields: [
      { key: 'countryOfUse', label: 'Country of use', type: 'select', options: COUNTRY_OPTIONS },
      { key: 'ourLegalEntity', label: 'Our legal entity', type: 'text', hint: 'The company that will sign the contract.' },
      { key: 'vendorLegalEntity', label: 'Vendor legal entity', type: 'text' },
      { key: 'vendorCountry', label: 'Vendor country of registration', type: 'select', options: COUNTRY_OPTIONS },
    ],
  },
  {
    title: 'Access & platform',
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
    fields: [
      { key: 'dataClassification', label: 'Data classification', type: 'radio', options: options(DATA_CLASSIFICATIONS) },
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
      { key: 'productionAccess', label: 'Access to production systems?', type: 'radio', options: YES_NO },
    ],
  },
  {
    title: 'Commercials',
    fields: [
      { key: 'paymentType', label: 'Paid or free', type: 'radio', options: options(PAYMENT_TYPES) },
      { key: 'annualCost', label: 'Estimated annual cost', type: 'money', min: 0, showWhen: whenPaid },
      { key: 'currency', label: 'Currency', type: 'select', options: options(CURRENCIES), showWhen: whenPaid },
      { key: 'contractTermMonths', label: 'Contract term (months)', type: 'integer', min: 1, showWhen: whenPaid },
      { key: 'autoRenewal', label: 'Auto-renewal', type: 'radio', options: YES_NO, showWhen: whenPaid },
      { key: 'costCenter', label: 'Cost center', type: 'text', showWhen: whenPaid },
    ],
  },
  {
    title: 'Ownership',
    fields: [
      { key: 'budgetOwner', label: 'Budget owner', type: 'owner' },
      { key: 'businessOwner', label: 'Business owner', type: 'owner' },
      { key: 'accessAdministrator', label: 'Access administrator', type: 'owner' },
      { key: 'technicalOwner', label: 'Technical owner', type: 'owner' },
    ],
  },
  {
    title: 'Review',
    fields: [
      {
        key: 'businessCriticality',
        label: 'Business criticality',
        type: 'radio',
        options: options(BUSINESS_CRITICALITIES),
        hint: 'How badly would the business be affected if this service stopped working?',
      },
    ],
  },
];

const TEXT_MAX = 200;
const TEXTAREA_MAX = 2000;
/** Values above this are almost certainly typing mistakes. */
const NUMBER_MAX = 1_000_000_000_000;

function isVisible(field: FieldDef, answers: Answers): boolean {
  if (!field.showWhen) return true;
  const controller = findField(field.showWhen.field);
  // A field controlled by a hidden field is hidden too.
  if (controller && !isVisible(controller, answers)) return false;
  const value = answers[field.showWhen.field];
  return typeof value === 'string' && field.showWhen.in.includes(value);
}

function findField(key: string): FieldDef | undefined {
  for (const step of REQUEST_FORM_STEPS) {
    const field = step.fields.find((f) => f.key === key);
    if (field) return field;
  }
  return undefined;
}

/** Fields of a step that apply to the given answers, in display order. */
export function visibleFields(stepIndex: number, answers: Answers): FieldDef[] {
  return (REQUEST_FORM_STEPS[stepIndex]?.fields ?? []).filter((f) => isVisible(f, answers));
}

type Checked = { value: unknown } | { error: string } | { empty: true };

function checkField(field: FieldDef, raw: unknown): Checked {
  switch (field.type) {
    case 'text':
    case 'textarea':
    case 'url':
    case 'date': {
      if (typeof raw !== 'string' || raw.trim() === '') return { empty: true };
      const value = raw.trim();
      const max = field.type === 'textarea' ? TEXTAREA_MAX : TEXT_MAX;
      if (value.length > max) return { error: `Use at most ${max} characters` };
      if (field.type === 'url') {
        // No URL global here: this package is built without DOM or Node typings.
        if (!/^https?:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+([/:?#]\S*)?$/i.test(value)) {
          return { error: 'Enter a web address that starts with https://' };
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
export function validateAnswers(answers: Answers, stepIndexes?: readonly number[]): ValidationResult {
  const errors: Record<string, string> = {};
  const cleaned: Answers = {};
  const steps = stepIndexes ?? REQUEST_FORM_STEPS.map((_, i) => i);
  for (const stepIndex of steps) {
    for (const field of visibleFields(stepIndex, answers)) {
      const checked = checkField(field, answers[field.key]);
      if ('error' in checked) errors[field.key] = checked.error;
      else if ('empty' in checked) {
        if (!field.optional) errors[field.key] = requiredMessage(field);
      } else cleaned[field.key] = checked.value;
    }
  }
  return { errors, cleaned };
}

/** Index of the first step that has a validation error, or -1. */
export function firstStepWithErrors(errors: Record<string, string>): number {
  return REQUEST_FORM_STEPS.findIndex((step) => step.fields.some((f) => f.key in errors));
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

/** Triage input from validated answers. The cost is taken as entered; currency conversion is not designed yet. */
export function riskInputFromAnswers(cleaned: Answers): RiskInput {
  return {
    dataClassification: cleaned.dataClassification as DataClassification,
    businessCriticality: cleaned.businessCriticality as BusinessCriticality,
    productionAccess: cleaned.productionAccess === 'Yes',
    annualCost: cleaned.paymentType === 'Paid' && typeof cleaned.annualCost === 'number' ? cleaned.annualCost : null,
  };
}

/** Rule-based completeness hints for the review step. They never block submission. */
export function completenessHints(answers: Answers): string[] {
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
  if (typeof answers.alternatives !== 'string' || answers.alternatives.trim() === '') {
    hints.push('Listing the alternatives you considered speeds up the review.');
  }
  return hints;
}
