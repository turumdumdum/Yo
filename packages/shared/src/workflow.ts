import { DEFAULT_STAGES, RISK_TIERS, type RiskTier, type StageStatus } from './domain';
import type { Answers } from './requestForm';

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
}

export interface WorkflowConfig {
  stages: readonly StageRule[];
}

type DefaultStage = (typeof DEFAULT_STAGES)[number];

// Proposed defaults, not an approved policy: confirm with the owner.
const DEFAULT_RULES: Record<DefaultStage, Omit<StageRule, 'name'>> = {
  'License check': { minTier: 'Low', slaBusinessDays: 5 },
  'Security review': { minTier: 'Medium', slaBusinessDays: 5 },
  'Legal review': { minTier: 'Medium', slaBusinessDays: 5 },
  'Finance review': {
    minTier: 'Low',
    onlyWhen: { field: 'paymentType', label: 'Paid or free', in: ['Paid'] },
    slaBusinessDays: 5,
  },
  'IT review': { minTier: 'Low', slaBusinessDays: 5 },
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
): PlannedStage[] {
  return config.stages.map((rule) => {
    let note: string | null = null;
    if (RISK_TIERS.indexOf(tier) < RISK_TIERS.indexOf(rule.minTier)) {
      note = `Not required for ${tier} risk`;
    } else if (rule.onlyWhen) {
      const value = answers[rule.onlyWhen.field];
      if (typeof value !== 'string' || !rule.onlyWhen.in.includes(value)) {
        note = `Not required: ${rule.onlyWhen.label} is ${typeof value === 'string' ? value : 'not answered'}`;
      }
    }
    if (note) return { name: rule.name, status: 'Not required', slaBusinessDays: null, slaDueAt: null, note };
    return {
      name: rule.name,
      status: 'In review',
      slaBusinessDays: rule.slaBusinessDays,
      slaDueAt: addBusinessDays(submittedAt, rule.slaBusinessDays).toISOString(),
      note: null,
    };
  });
}
