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
  /** 'external': the review happens in another service; this app sends the data and shows its status. */
  handledBy: 'here' | 'external';
  /** How to review, written by the organization; shown to reviewers in the Guide tab. */
  guide: string;
}

export type WorkflowSettings = Record<string, StageSettings>;

export const STAGE_LIMITS = { slaMin: 1, slaMax: 60, checklistItems: 20, checklistItem: 200, conditionValues: 50, guide: 8000 } as const;

/**
 * Starting guides, in our own words. Lines starting with "## " are headings, lines starting
 * with "- " are list items; everything else is a paragraph.
 */
export const DEFAULT_REVIEW_GUIDES: Record<string, string> = {
  'License check': [
    '## Goal',
    'Make sure we may use the service the way the requester describes, and that we are not paying twice for the same need.',
    '## Steps',
    '- Read the terms of service or licence: commercial use, number of users, data ownership, termination.',
    '- Compare the expected number of users with the plan and its limits.',
    '- Search the vendor registry for an approved tool that already covers this need.',
    '- Note any open-source licence that obliges us to publish code.',
    '## When to ask the requester',
    '- The plan or edition is unclear.',
    '- The use goes beyond what the free or trial terms allow.',
  ].join('\n'),
  'Security review': [
    '## Goal',
    'Decide whether the vendor protects our data well enough for its classification, and which configuration is required.',
    '## Steps',
    '- Check the security evidence: SOC 2 Type II or ISO/IEC 27001 report, its date and scope; otherwise a security questionnaire.',
    '- Check sign-in: SSO and MFA, how accounts are removed, admin roles.',
    '- Check data: what data, where it is stored, encryption, retention and deletion, sub-processors.',
    '- Check AI use: is our data used to train models, can it be switched off.',
    '- Go through the Configuration tab: decide on every required control. Use an exception only with compensating measures and an end date.',
    '## Red flags',
    '- No independent security report for Confidential or Restricted data.',
    '- Shared accounts or no MFA for administrators.',
    '- Data stored outside the approved location.',
  ].join('\n'),
  'Legal review': [
    '## Goal',
    'Make sure the contract protects us and matches the data the vendor will handle.',
    '## Steps',
    '- Check the contracting entities and the governing law.',
    '- With personal data: a data processing agreement, sub-processors, transfers outside the approved area.',
    '- Liability, indemnities, termination and what happens to our data at the end.',
    '- Auto-renewal and notice periods.',
  ].join('\n'),
  'Finance review': [
    '## Goal',
    'Confirm the budget, the price and the commercial terms.',
    '## Steps',
    '- Budget owner confirmed and cost center correct.',
    '- Price matches the quote; currency and taxes clear.',
    '- Contract term, renewal and price increases understood.',
    '- Prefer annual payment only when the discount is worth the commitment.',
  ].join('\n'),
  'IT review': [
    '## Goal',
    'Make sure we can run, connect and support the service.',
    '## Steps',
    '- Platforms and integrations are supported in our environment.',
    '- An access administrator and a technical owner are named.',
    '- Onboarding and offboarding are clear; access can be removed when people leave.',
    '- Check for overlap with tools we already run.',
  ].join('\n'),
};

function fromRule(rule: StageRule): StageSettings {
  return {
    requirement: rule.minTier === 'Low' ? 'always' : 'by_risk',
    minTier: rule.minTier === 'Low' ? 'Medium' : (rule.minTier as RaisedTier),
    onlyWhen: rule.onlyWhen ? { field: rule.onlyWhen.field, in: [...rule.onlyWhen.in] } : null,
    slaBusinessDays: rule.slaBusinessDays,
    checklist: [...rule.checklist],
    handledBy: 'here',
    guide: DEFAULT_REVIEW_GUIDES[rule.name] ?? '',
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
    const known = new Set(['requirement', 'minTier', 'onlyWhen', 'slaBusinessDays', 'checklist', 'handledBy', 'guide']);
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
    // Settings saved before these existed get the defaults.
    const handledBy = s.handledBy ?? 'here';
    if (handledBy !== 'here' && handledBy !== 'external') return { error: `${stage}: choose where the review happens` };
    const guide = s.guide === undefined ? (DEFAULT_REVIEW_GUIDES[stage] ?? '') : s.guide;
    if (typeof guide !== 'string' || guide.length > STAGE_LIMITS.guide) return { error: `${stage}: the guide is longer than ${STAGE_LIMITS.guide} characters` };
    settings[stage] = { requirement: s.requirement as StageRequirement, minTier: s.minTier as RaisedTier, onlyWhen, slaBusinessDays: sla as number, checklist, handledBy, guide: guide.trim() };
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
        ...(s.handledBy === 'external' ? { external: true } : {}),
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
