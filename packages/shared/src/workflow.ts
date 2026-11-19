import { DEFAULT_STAGES, RISK_TIERS, type RiskTier, type StageStatus } from './domain';
import type { Answers, RequestFormDefinition } from './requestForm';
import { defaultReviewTemplate, type ReviewFieldDef, type ReviewRule, type ReviewTemplate } from './reviewForms';

// Default workflow (CLAUDE.md §6): after triage the required review stages start in
// parallel. Which stages are required is configuration, not code, so that the workflow
// builder (roadmap stage 3) can store it per organization.

export interface StageRule {
  name: string;
  /** The stage is required from this risk tier upwards. */
  minTier: RiskTier;
  /** When set, the stage is also skipped unless the answer has one of these values. */
  onlyWhen?: { field: string; label: string; in: readonly string[] };
  slaBusinessDays: number;
  /** What the reviewer confirms before approving. */
  checklist: readonly string[];
  /** Request form fields this review is mostly about; shown first to the reviewer. */
  focusFields: readonly string[];
}

export interface WorkflowConfig {
  stages: readonly StageRule[];
}

type DefaultStage = (typeof DEFAULT_STAGES)[number];

// Proposed defaults, not an approved policy: confirm with the owner.
const DEFAULT_RULES: Record<DefaultStage, Omit<StageRule, 'name'>> = {
  'License check': {
    minTier: 'Low',
    slaBusinessDays: 5,
    focusFields: ['purpose', 'expectedUsers', 'platforms', 'integrations', 'paymentType', 'contractTermMonths', 'alternatives'],
    checklist: [
      'The license terms allow our intended use',
      'Seats or usage limits cover the expected number of users',
      'We do not already have a tool or license that covers this need',
    ],
  },
  'Security review': {
    minTier: 'Medium',
    slaBusinessDays: 5,
    focusFields: ['signInMethod', 'platforms', 'integrations', 'vendorUsesAi', 'dataClassification', 'personalData', 'personalDataTypes', 'dataLocation', 'productionAccess'],
    checklist: [
      "The vendor's security documentation was reviewed (for example SOC 2 Type II, ISO/IEC 27001 or a questionnaire)",
      'The sign-in method meets our access policy',
      'The data classification and data location are acceptable',
      "The vendor's use of AI on our data is understood and acceptable",
    ],
  },
  'Legal review': {
    minTier: 'Medium',
    slaBusinessDays: 5,
    focusFields: ['ourLegalEntity', 'vendorLegalEntity', 'vendorCountry', 'countryOfUse', 'personalData', 'personalDataTypes', 'dataLocation', 'contractTermMonths', 'autoRenewal'],
    checklist: [
      'The contract or terms of service were reviewed',
      'A data processing agreement is in place if personal data is involved',
      'The vendor legal entity and its country of registration were verified',
    ],
  },
  'Finance review': {
    minTier: 'Low',
    onlyWhen: { field: 'paymentType', label: 'Paid or free', in: ['Paid'] },
    slaBusinessDays: 5,
    focusFields: ['paymentType', 'annualCost', 'currency', 'contractTermMonths', 'autoRenewal', 'costCenter', 'budgetOwner'],
    checklist: [
      'Budget is available and the budget owner confirmed it',
      'Price, contract term and renewal terms were reviewed',
      'The cost center is correct',
    ],
  },
  'IT review': {
    minTier: 'Low',
    slaBusinessDays: 5,
    focusFields: ['signInMethod', 'platforms', 'integrations', 'integrationsOther', 'expectedUsers', 'accessAdministrator', 'technicalOwner'],
    checklist: [
      'The platform and integrations are supported in our environment',
      'An access administrator and a technical owner are named',
      'Access can be removed when people leave',
    ],
  },
};

export const DEFAULT_WORKFLOW: WorkflowConfig = {
  stages: DEFAULT_STAGES.map((name) => ({ name, ...DEFAULT_RULES[name] })),
};

export interface PlannedStage {
  name: string;
  status: Extract<StageStatus, 'In review' | 'Not required'>;
  slaBusinessDays: number | null;
  /** ISO timestamp; null for stages that are not required. */
  slaDueAt: string | null;
  /** Why the stage is not required, shown to everyone who can see the request. */
  note: string | null;
  /** Checklist labels for the reviewer; empty for stages that are not required. */
  checklist: string[];
  /** The review form the reviewer fills in, copied into the stage. */
  reviewFields: ReviewFieldDef[];
  reviewRules: ReviewRule[];
}

export const STAGE_DECISIONS = ['Approved', 'Approved with conditions', 'Rejected'] as const;
export type StageDecision = (typeof STAGE_DECISIONS)[number];

/** Request form fields a reviewer of the named stage should look at first; empty for unknown stages. */
export function focusFieldsForStage(stageName: string, config: WorkflowConfig = DEFAULT_WORKFLOW): readonly string[] {
  return config.stages.find((rule) => rule.name === stageName)?.focusFields ?? [];
}

/**
 * Adds business days, skipping Saturdays and Sundays (UTC). Public holidays are not
 * known yet; they come with per-organization calendars.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const result = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const weekday = result.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return result;
}

/** Decides, for a triaged request, which stages start and which are not required. */
export function planStages(
  tier: RiskTier,
  answers: Answers,
  submittedAt: Date,
  config: WorkflowConfig = DEFAULT_WORKFLOW,
  /** The organization's review forms by stage name; stages without one get the default form. */
  reviewTemplates: Readonly<Record<string, ReviewTemplate>> = {},
  /** The form the request used. A condition on a question the form does not ask is ignored. */
  form?: RequestFormDefinition,
): PlannedStage[] {
  const asks = (when: NonNullable<StageRule['onlyWhen']>) => {
    if (!form) return true;
    const field = form.steps.flatMap((s) => s.fields).find((f) => f.key === when.field);
    return !!field && 'options' in field && field.options.some((o) => when.in.includes(o.value));
  };
  return config.stages.map((rule) => {
    let note: string | null = null;
    if (RISK_TIERS.indexOf(tier) < RISK_TIERS.indexOf(rule.minTier)) {
      note = `Not required for ${tier} risk`;
    } else if (rule.onlyWhen && asks(rule.onlyWhen)) {
      const value = answers[rule.onlyWhen.field];
      if (typeof value !== 'string' || !rule.onlyWhen.in.includes(value)) {
        note = `Not required: ${rule.onlyWhen.label} is ${typeof value === 'string' ? value : 'not answered'}`;
      }
    }
    if (note) {
      return { name: rule.name, status: 'Not required', slaBusinessDays: null, slaDueAt: null, note, checklist: [], reviewFields: [], reviewRules: [] };
    }
    const form = reviewTemplates[rule.name] ?? defaultReviewTemplate(rule.name);
    return {
      name: rule.name,
      status: 'In review',
      slaBusinessDays: rule.slaBusinessDays,
      slaDueAt: addBusinessDays(submittedAt, rule.slaBusinessDays).toISOString(),
      note: null,
      checklist: [...rule.checklist],
      reviewFields: form.fields,
      reviewRules: form.rules,
    };
  });
}
