import { DEFAULT_STAGES, RISK_TIERS, type RiskTier } from './domain';
import { DEFAULT_WORKFLOW, type StageRule, type WorkflowConfig } from './workflow';

// What an organization decides about each review stage: when it is needed, how long the
// reviewer has, and what the reviewer confirms. Stored per organization as data and
// turned into the workflow used at submission (CLAUDE.md §6: configuration, not code).
// The review form of a stage is configured separately (reviewForms.ts).

export const STAGE_REQUIREMENTS = ['always', 'by_risk', 'never'] as const;
export type StageRequirement = (typeof STAGE_REQUIREMENTS)[number];

export const STAGE_REQUIREMENT_LABELS: Record<StageRequirement, string> = {
  always: 'Always',
  by_risk: 'From a risk level',
  never: 'Never (turned off)',
};

export type RaisedTier = Exclude<RiskTier, 'Low'>;

export interface StageSettings {
  requirement: StageRequirement;
  /** With `by_risk`: the lowest risk level that needs this review. */
  minTier: RaisedTier;
  /** Also needed only when a one-choice answer has one of these values. */
  onlyWhen: { field: string; in: string[] } | null;
  slaBusinessDays: number;
  /** What the reviewer confirms before approving. */
  checklist: string[];
}

export type WorkflowSettings = Record<string, StageSettings>;

export const STAGE_LIMITS = { slaMin: 1, slaMax: 60, checklistItems: 20, checklistItem: 200, conditionValues: 50 } as const;

function fromRule(rule: StageRule): StageSettings {
  return {
    requirement: rule.minTier === 'Low' ? 'always' : 'by_risk',
    minTier: rule.minTier === 'Low' ? 'Medium' : (rule.minTier as RaisedTier),
    onlyWhen: rule.onlyWhen ? { field: rule.onlyWhen.field, in: [...rule.onlyWhen.in] } : null,
    slaBusinessDays: rule.slaBusinessDays,
    checklist: [...rule.checklist],
  };
}

/** The standard settings, as the default workflow defines them. */
export function defaultWorkflowSettings(): WorkflowSettings {
  return Object.fromEntries(DEFAULT_WORKFLOW.stages.map((rule) => [rule.name, fromRule(rule)]));
}

const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

/** Checks settings sent by an admin. Returns the cleaned settings or the first problem. */
export function parseWorkflowSettings(input: unknown): { settings: WorkflowSettings } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Expected settings for each review' };
  const raw = input as Record<string, unknown>;
  const extra = Object.keys(raw).find((k) => !(DEFAULT_STAGES as readonly string[]).includes(k));
  if (extra) return { error: `Unknown review “${extra}”` };
  const settings: WorkflowSettings = {};
  for (const stage of DEFAULT_STAGES) {
    const s = raw[stage] as Partial<StageSettings> | undefined;
    if (!s || typeof s !== 'object') return { error: `Settings for ${stage} are missing` };
    const known = new Set(['requirement', 'minTier', 'onlyWhen', 'slaBusinessDays', 'checklist']);
    const unknown = Object.keys(s).find((k) => !known.has(k));
    if (unknown) return { error: `${stage} has an unknown setting “${unknown}”` };
    if (!(STAGE_REQUIREMENTS as readonly unknown[]).includes(s.requirement)) return { error: `${stage}: choose when the review is needed` };
    if (!(RISK_TIERS as readonly unknown[]).includes(s.minTier) || (s.minTier as string) === 'Low') return { error: `${stage}: choose Medium, High or Critical as the risk level` };
    const sla = s.slaBusinessDays;
    if (!Number.isInteger(sla) || (sla as number) < STAGE_LIMITS.slaMin || (sla as number) > STAGE_LIMITS.slaMax) {
      return { error: `${stage}: the time to review must be ${STAGE_LIMITS.slaMin} to ${STAGE_LIMITS.slaMax} business days` };
    }
    if (!Array.isArray(s.checklist) || s.checklist.length > STAGE_LIMITS.checklistItems) {
      return { error: `${stage}: use at most ${STAGE_LIMITS.checklistItems} checklist items` };
    }
    const checklist = s.checklist.map((item) => (typeof item === 'string' ? item.trim() : ''));
    if (checklist.some((item) => item === '' || item.length > STAGE_LIMITS.checklistItem)) {
      return { error: `${stage}: each checklist item needs 1 to ${STAGE_LIMITS.checklistItem} characters` };
    }
    let onlyWhen: StageSettings['onlyWhen'] = null;
    if (s.onlyWhen !== null && s.onlyWhen !== undefined) {
      const w = s.onlyWhen as { field?: unknown; in?: unknown };
      if (typeof w.field !== 'string' || !FIELD_KEY.test(w.field)) return { error: `${stage}: choose the question of the condition` };
      if (!Array.isArray(w.in) || w.in.length === 0 || w.in.length > STAGE_LIMITS.conditionValues || w.in.some((v) => typeof v !== 'string' || v.length > 120)) {
        return { error: `${stage}: choose which answers need the review` };
      }
      onlyWhen = { field: w.field, in: [...new Set(w.in as string[])] };
    }
    settings[stage] = { requirement: s.requirement as StageRequirement, minTier: s.minTier as RaisedTier, onlyWhen, slaBusinessDays: sla as number, checklist };
  }
  // Every request needs at least one review, or it would never get a decision.
  if (!Object.values(settings).some((s) => s.requirement === 'always' && s.onlyWhen === null)) {
    return { error: 'At least one review must always be needed, without a condition, so that every request gets a decision' };
  }
  return { settings };
}

/** The workflow for submission. Stored settings that fail the check fall back to the default. */
export function workflowFromSettings(stored: unknown): WorkflowConfig {
  if (stored === null || stored === undefined) return DEFAULT_WORKFLOW;
  const parsed = parseWorkflowSettings(stored);
  if ('error' in parsed) return DEFAULT_WORKFLOW;
  return {
    stages: DEFAULT_WORKFLOW.stages.map((rule) => {
      const s = parsed.settings[rule.name]!;
      return {
        name: rule.name,
        minTier: s.requirement === 'by_risk' ? s.minTier : 'Low',
        ...(s.requirement === 'never' ? { off: true } : {}),
        ...(s.onlyWhen ? { onlyWhen: { field: s.onlyWhen.field, in: s.onlyWhen.in } } : {}),
        slaBusinessDays: s.slaBusinessDays,
        checklist: s.checklist,
        focusFields: rule.focusFields,
      };
    }),
  };
}

/** One line for an admin: when the review is needed. */
export function describeRequirement(s: StageSettings, labelOf: (field: string) => string = (f) => f): string {
  const base = s.requirement === 'always' ? 'Always needed' : s.requirement === 'by_risk' ? `Needed from ${s.minTier} risk` : 'Turned off';
  if (s.requirement === 'never' || !s.onlyWhen) return base;
  return `${base}, only when “${labelOf(s.onlyWhen.field)}” is ${s.onlyWhen.in.join(' or ')}`;
}
