import { z } from 'zod';
import { allFields, type Answers } from './requestForm';

// Structured review forms that reviewers fill in for a stage (for example the security
// review). Like the workflow, a form is data, not code: each organization can change
// fields, options and rules from the Admin section (CLAUDE.md §3, §7).
//
// The default security review form follows common vendor-assessment practice. It names
// certifications and topics in our own words and quotes no standard; it is a starting
// point, not a certification guarantee.

export const REVIEW_FIELD_TYPES = ['select', 'multiselect', 'date', 'text', 'textarea'] as const;
export type ReviewFieldType = (typeof REVIEW_FIELD_TYPES)[number];

export interface ReviewFieldDef {
  /** Stable identifier of the answer. Never changes once answers exist. */
  key: string;
  label: string;
  /** Heading the field is grouped under. */
  section?: string;
  help?: string;
  type: ReviewFieldType;
  required: boolean;
  /** Choices for select and multiselect fields. */
  options?: string[];
  /** Choices that are flagged to the reviewer as a concern. */
  concernValues?: string[];
  /** Date fields: flag dates older than this many months. */
  maxAgeMonths?: number;
}

/**
 * When the request answer `when.field` has one of `when.in`, the review answer `field`
 * (a multiselect) should include at least one of `anyOf`. Shown as a concern, not a block:
 * the reviewer may still approve with conditions.
 */
export interface ReviewRule {
  when: { field: string; in: string[] };
  field: string;
  anyOf: string[];
  message: string;
}

export interface ReviewTemplate {
  fields: ReviewFieldDef[];
  rules: ReviewRule[];
}

export const EMPTY_REVIEW_TEMPLATE: ReviewTemplate = { fields: [], rules: [] };

export const CERTIFICATIONS = [
  'SOC 2 Type II',
  'SOC 2 Type I',
  'ISO/IEC 27001',
  'ISO/IEC 27017',
  'ISO/IEC 27018',
  'ISO/IEC 27701',
  'PCI DSS',
  'CSA STAR Level 2',
  'BSI C5',
  'Cyber Essentials Plus',
  'FedRAMP',
  'HIPAA (third-party attestation)',
  'None',
];

const YES_NO_UNKNOWN = ['Yes', 'No', 'Unknown'];

const SECURITY_REVIEW: ReviewTemplate = {
  fields: [
    // Certifications and assurance
    {
      key: 'certifications',
      section: 'Certifications and assurance',
      label: 'Current certifications and attestation reports',
      help: 'Only count reports or certificates you have seen, not logos on a website.',
      type: 'multiselect',
      required: true,
      options: CERTIFICATIONS,
      concernValues: ['None'],
    },
    {
      key: 'reportDate',
      section: 'Certifications and assurance',
      label: 'Date of the latest report or certificate',
      help: 'For SOC 2 the end of the report period, for ISO the issue date of the certificate.',
      type: 'date',
      required: false,
      maxAgeMonths: 12,
    },
    {
      key: 'scopeCoversService',
      section: 'Certifications and assurance',
      label: 'The scope of the certification covers this service',
      type: 'select',
      required: false,
      options: ['Yes', 'Partly', 'No', 'Unknown'],
      concernValues: ['Partly', 'No', 'Unknown'],
    },
    {
      key: 'penTestDate',
      section: 'Certifications and assurance',
      label: 'Date of the last independent penetration test',
      type: 'date',
      required: false,
      maxAgeMonths: 12,
    },
    {
      key: 'questionnaire',
      section: 'Certifications and assurance',
      label: 'Security questionnaire',
      help: 'For example a standard questionnaire such as CAIQ or SIG, or your own.',
      type: 'select',
      required: false,
      options: ['Completed by the vendor', 'Answered from the public trust center', 'Not provided'],
      concernValues: ['Not provided'],
    },
    // Identity and access
    {
      key: 'sso',
      section: 'Identity and access',
      label: 'Single sign-on',
      type: 'select',
      required: false,
      options: ['SAML', 'OpenID Connect', 'No single sign-on', 'Unknown'],
      concernValues: ['No single sign-on', 'Unknown'],
    },
    {
      key: 'mfa',
      section: 'Identity and access',
      label: 'Multi-factor authentication',
      type: 'select',
      required: true,
      options: ['Enforced for all users', 'Available, not enforced', 'Not available', 'Not applicable (single sign-on only)'],
      concernValues: ['Not available'],
    },
    {
      key: 'scim',
      section: 'Identity and access',
      label: 'Automatic user provisioning and removal (SCIM)',
      type: 'select',
      required: false,
      options: ['Yes', 'No', 'Not needed'],
    },
    {
      key: 'roleBasedAccess',
      section: 'Identity and access',
      label: 'Role-based access control',
      type: 'select',
      required: false,
      options: YES_NO_UNKNOWN,
      concernValues: ['No'],
    },
    {
      key: 'auditLogs',
      section: 'Identity and access',
      label: 'Audit logs of user and admin activity',
      type: 'select',
      required: false,
      options: ['Available to us', 'Kept by the vendor only', 'Not available'],
      concernValues: ['Not available'],
    },
    // Data protection
    {
      key: 'encryptionInTransit',
      section: 'Data protection',
      label: 'Encryption in transit',
      type: 'select',
      required: false,
      options: ['TLS 1.2 or newer', 'Older or unknown'],
      concernValues: ['Older or unknown'],
    },
    {
      key: 'encryptionAtRest',
      section: 'Data protection',
      label: 'Encryption at rest',
      type: 'select',
      required: true,
      options: YES_NO_UNKNOWN,
      concernValues: ['No', 'Unknown'],
    },
    {
      key: 'customerManagedKeys',
      section: 'Data protection',
      label: 'Customer-managed encryption keys',
      type: 'select',
      required: false,
      options: ['Yes', 'No', 'Not needed'],
    },
    {
      key: 'dataResidency',
      section: 'Data protection',
      label: 'Where our data is stored',
      type: 'select',
      required: false,
      options: ['EU only', 'EU and other regions', 'Outside the EU', 'Unknown'],
      concernValues: ['Unknown'],
    },
    {
      key: 'subprocessors',
      section: 'Data protection',
      label: 'Subprocessors',
      type: 'select',
      required: false,
      options: ['List reviewed, acceptable', 'List reviewed, concerns', 'Not published'],
      concernValues: ['List reviewed, concerns', 'Not published'],
    },
    {
      key: 'aiTraining',
      section: 'Data protection',
      label: 'The vendor trains AI models on our data',
      type: 'select',
      required: false,
      options: ['No', 'Yes, with opt-out', 'Yes, without opt-out', 'Unknown'],
      concernValues: ['Yes, without opt-out', 'Unknown'],
    },
    {
      key: 'deletionAfterContract',
      section: 'Data protection',
      label: 'Deletion of our data after the contract ends',
      type: 'select',
      required: false,
      options: ['Within 30 days', 'Within 90 days', 'Longer or not committed'],
      concernValues: ['Longer or not committed'],
    },
    {
      key: 'backups',
      section: 'Data protection',
      label: 'Backups and disaster recovery',
      type: 'select',
      required: false,
      options: ['In place and tested', 'In place, testing unknown', 'Not in place or unknown'],
      concernValues: ['Not in place or unknown'],
    },
    // Operations and incidents
    {
      key: 'breachNotification',
      section: 'Operations and incidents',
      label: 'Commitment to notify us of a security incident',
      type: 'select',
      required: false,
      options: ['Within 72 hours', 'Later than 72 hours', 'No commitment'],
      concernValues: ['Later than 72 hours', 'No commitment'],
    },
    {
      key: 'knownIncidents',
      section: 'Operations and incidents',
      label: 'Publicly known security incidents in the last 3 years',
      type: 'select',
      required: false,
      options: ['None found', 'Yes, handled well', 'Yes, with concerns'],
      concernValues: ['Yes, with concerns'],
    },
    {
      key: 'vulnerabilityDisclosure',
      section: 'Operations and incidents',
      label: 'Vulnerability disclosure policy or bug bounty',
      type: 'select',
      required: false,
      options: YES_NO_UNKNOWN,
    },
    {
      key: 'availabilityCommitment',
      section: 'Operations and incidents',
      label: 'Availability commitment (SLA)',
      help: 'For example 99.9% per month.',
      type: 'text',
      required: false,
    },
    // Conclusion
    {
      key: 'residualRisk',
      section: 'Conclusion',
      label: 'Residual security risk',
      help: 'Your judgement after taking all answers into account.',
      type: 'select',
      required: true,
      options: ['Low', 'Medium', 'High', 'Critical'],
      concernValues: ['High', 'Critical'],
    },
    {
      key: 'findings',
      section: 'Conclusion',
      label: 'Findings and recommendations',
      type: 'textarea',
      required: false,
    },
  ],
  rules: [
    {
      when: { field: 'dataClassification', in: ['Restricted'] },
      field: 'certifications',
      anyOf: ['SOC 2 Type II', 'ISO/IEC 27001'],
      message: 'Restricted data: the vendor should hold SOC 2 Type II or ISO/IEC 27001.',
    },
    {
      when: { field: 'dataClassification', in: ['Confidential'] },
      field: 'certifications',
      anyOf: ['SOC 2 Type II', 'SOC 2 Type I', 'ISO/IEC 27001'],
      message: 'Confidential data: the vendor should hold a SOC 2 report or ISO/IEC 27001.',
    },
  ],
};

/** Forms used when an organization has not configured its own. */
export const DEFAULT_REVIEW_TEMPLATES: Readonly<Record<string, ReviewTemplate>> = {
  'Security review': SECURITY_REVIEW,
};

export function defaultReviewTemplate(stageName: string): ReviewTemplate {
  return DEFAULT_REVIEW_TEMPLATES[stageName] ?? EMPTY_REVIEW_TEMPLATE;
}

// ---------------------------------------------------------------------------
// Validating a template (admin input)
// ---------------------------------------------------------------------------

export const REVIEW_FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const LIMITS = { fields: 60, rules: 20, options: 40 };

const option = z.string().trim().min(1, 'Options cannot be empty').max(80, 'Use at most 80 characters per option');

const fieldSchema = z
  .object({
    key: z.string().regex(REVIEW_FIELD_KEY, 'Invalid field key'),
    label: z.string().trim().min(1, 'Every field needs a label').max(120, 'Use at most 120 characters for a label'),
    section: z.string().trim().max(60).optional(),
    help: z.string().trim().max(300).optional(),
    type: z.enum(REVIEW_FIELD_TYPES),
    required: z.boolean(),
    options: z.array(option).max(LIMITS.options).optional(),
    concernValues: z.array(option).max(LIMITS.options).optional(),
    maxAgeMonths: z.number().int().min(1).max(120).optional(),
  })
  .superRefine((field, ctx) => {
    const choice = field.type === 'select' || field.type === 'multiselect';
    const options = field.options ?? [];
    if (choice && options.length < (field.type === 'select' ? 2 : 1)) {
      ctx.addIssue({ code: 'custom', message: `"${field.label}" needs at least ${field.type === 'select' ? 2 : 1} options` });
    }
    if (new Set(options).size !== options.length) ctx.addIssue({ code: 'custom', message: `"${field.label}" lists an option twice` });
    if (!choice && (options.length > 0 || (field.concernValues ?? []).length > 0)) {
      ctx.addIssue({ code: 'custom', message: `"${field.label}" cannot have options` });
    }
    if ((field.concernValues ?? []).some((v) => !options.includes(v))) {
      ctx.addIssue({ code: 'custom', message: `"${field.label}" flags a value that is not one of its options` });
    }
    if (field.maxAgeMonths !== undefined && field.type !== 'date') {
      ctx.addIssue({ code: 'custom', message: `Only date fields can have a maximum age ("${field.label}")` });
    }
  });

const ruleSchema = z.object({
  when: z.object({ field: z.string().min(1), in: z.array(z.string().min(1)).min(1, 'Choose when the rule applies').max(20) }),
  field: z.string().min(1),
  anyOf: z.array(option).min(1, 'Choose at least one acceptable value').max(LIMITS.options),
  message: z.string().trim().min(1, 'Every rule needs a message').max(300),
});

/** Request form fields a rule can depend on: those with a fixed set of answers. */
export function ruleConditionFields(): { key: string; label: string; options: string[] }[] {
  return allFields().flatMap((f) =>
    (f.type === 'select' || f.type === 'radio') && f.options.length <= 12
      ? [{ key: f.key, label: f.label, options: f.options.map((o) => o.value) }]
      : [],
  );
}

export const reviewTemplateSchema = z
  .object({
    fields: z.array(fieldSchema).max(LIMITS.fields, `Use at most ${LIMITS.fields} fields`),
    rules: z.array(ruleSchema).max(LIMITS.rules, `Use at most ${LIMITS.rules} rules`),
  })
  .superRefine((template, ctx) => {
    const keys = template.fields.map((f) => f.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Two fields have the same key' });
    const conditions = new Map(ruleConditionFields().map((c) => [c.key, c]));
    template.rules.forEach((rule, i) => {
      const target = template.fields.find((f) => f.key === rule.field);
      if (!target || target.type !== 'multiselect') {
        ctx.addIssue({ code: 'custom', message: `Rule ${i + 1} must check a multiple-choice field of this form` });
      } else if (rule.anyOf.some((v) => !(target.options ?? []).includes(v))) {
        ctx.addIssue({ code: 'custom', message: `Rule ${i + 1} expects a value that "${target.label}" does not offer` });
      }
      const condition = conditions.get(rule.when.field);
      if (!condition) ctx.addIssue({ code: 'custom', message: `Rule ${i + 1} depends on an unknown request field` });
      else if (rule.when.in.some((v) => !condition.options.includes(v))) {
        ctx.addIssue({ code: 'custom', message: `Rule ${i + 1} depends on an answer that "${condition.label}" does not offer` });
      }
    });
  });

/** Returns the template, or the first problem as a sentence. */
export function parseReviewTemplate(input: unknown): { template: ReviewTemplate } | { error: string } {
  const parsed = reviewTemplateSchema.safeParse(input);
  if (parsed.success) return { template: parsed.data as ReviewTemplate };
  return { error: parsed.error.issues[0]?.message ?? 'The form is not valid' };
}

// ---------------------------------------------------------------------------
// Answers (reviewer input). Keep in sync with private.review_answers_error() in SQL,
// which is the check that counts.
// ---------------------------------------------------------------------------

const isEmpty = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);

function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);
}

/** Problems with the answers, by field key. With `forDecision`, required fields must be answered. */
export function validateReviewAnswers(fields: readonly ReviewFieldDef[], answers: Answers, forDecision = true): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const value = answers[field.key];
    if (isEmpty(value)) {
      if (forDecision && field.required) errors[field.key] = 'Answer this before approving';
      continue;
    }
    const options = field.options ?? [];
    switch (field.type) {
      case 'select':
        if (typeof value !== 'string' || !options.includes(value)) errors[field.key] = 'Choose one of the options';
        break;
      case 'multiselect':
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !options.includes(v))) {
          errors[field.key] = 'Choose from the options';
        }
        break;
      case 'date':
        if (typeof value !== 'string' || !validDate(value)) errors[field.key] = 'Enter a valid date';
        break;
      default:
        if (typeof value !== 'string' || value.length > 2000) errors[field.key] = 'Use at most 2000 characters';
    }
  }
  return errors;
}

export interface ReviewConcern {
  field: string | null;
  message: string;
}

function monthsAgo(now: Date, months: number): string {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate()));
  return date.toISOString().slice(0, 10);
}

/** Answers the reviewer should look at again: flagged values, old dates and unmet rules. */
export function reviewConcerns(template: ReviewTemplate, answers: Answers, requestAnswers: Answers, now: Date = new Date()): ReviewConcern[] {
  const concerns: ReviewConcern[] = [];
  for (const field of template.fields) {
    const value = answers[field.key];
    if (isEmpty(value)) continue;
    const flagged = (field.concernValues ?? []).filter((v) => (Array.isArray(value) ? value.includes(v) : value === v));
    for (const v of flagged) concerns.push({ field: field.key, message: `${field.label}: ${v}` });
    if (field.type === 'date' && field.maxAgeMonths && typeof value === 'string' && value < monthsAgo(now, field.maxAgeMonths)) {
      concerns.push({ field: field.key, message: `${field.label} is older than ${field.maxAgeMonths} months` });
    }
  }
  for (const rule of template.rules) {
    const condition = requestAnswers[rule.when.field];
    if (typeof condition !== 'string' || !rule.when.in.includes(condition)) continue;
    const value = answers[rule.field];
    if (isEmpty(value)) continue;
    const chosen = Array.isArray(value) ? value : [value];
    if (!rule.anyOf.some((v) => chosen.includes(v))) concerns.push({ field: rule.field, message: rule.message });
  }
  return concerns;
}
