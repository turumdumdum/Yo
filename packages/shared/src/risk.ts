import { RISK_TIERS, type RiskTier } from './domain';
import {
  allFields,
  DEFAULT_REQUEST_FORM,
  type Answers,
  type FieldDef,
  type OptionRisk,
  type RequestFormDefinition,
  type RiskBand,
  type RiskLevels,
} from './requestForm';

// Triage risk scoring (CLAUDE.md §6). How answers affect the risk is part of the request
// form, so an organization changes it in the form editor without a code change:
// - a choice of a one-choice or several-choices question can add points and/or set a
//   minimum tier;
// - a number or amount can add points when it reaches a threshold (the highest one wins);
// - the total decides the tier through the form's risk levels.
// Default weights are a starting proposal, not an approved policy: confirm with the owner.

export const DEFAULT_RISK_LEVELS: RiskLevels = { Medium: 3, High: 6, Critical: 9 };
export const MAX_RISK_POINTS = 20;

export interface RiskResult {
  tier: RiskTier;
  score: number;
  /** Human-readable explanation of each contribution, shown to reviewers. */
  reasons: string[];
}

const DEFAULT_FIELDS = new Map(allFields(DEFAULT_REQUEST_FORM).map((f) => [f.key, f]));

const hasChoices = (field: FieldDef): field is Extract<FieldDef, { options: unknown }> =>
  field.type === 'radio' || field.type === 'select' || field.type === 'multiselect';
const isNumber = (field: FieldDef): field is Extract<FieldDef, { type: 'integer' | 'money' }> =>
  field.type === 'integer' || field.type === 'money';

/**
 * Risk settings of a choice question. Forms saved before risk settings were part of the
 * form leave them unset; a question with a standard key then keeps the standard settings
 * for the choices it still offers. An explicit empty object means "no effect on risk".
 */
export function choiceRisk(field: FieldDef): Readonly<Record<string, OptionRisk>> {
  if (!hasChoices(field)) return {};
  if (field.risk) return field.risk;
  const standard = DEFAULT_FIELDS.get(field.key);
  if (!standard || !hasChoices(standard) || !standard.risk) return {};
  const offered = new Set(field.options.map((o) => o.value));
  return Object.fromEntries(Object.entries(standard.risk).filter(([value]) => offered.has(value)));
}

/** Point thresholds of a number question; same inheritance rule as `choiceRisk`. */
export function numberRiskBands(field: FieldDef): readonly RiskBand[] {
  if (!isNumber(field)) return [];
  if (field.riskBands) return field.riskBands;
  const standard = DEFAULT_FIELDS.get(field.key);
  return standard && isNumber(standard) ? (standard.riskBands ?? []) : [];
}

/** True when any answer to the question can change the risk. */
export function affectsRisk(field: FieldDef): boolean {
  return Object.values(choiceRisk(field)).some((r) => (r.points ?? 0) > 0 || r.atLeast) || numberRiskBands(field).length > 0;
}

/** The form with inherited risk settings written out, for the editor. */
export function withRiskDefaults(form: RequestFormDefinition): RequestFormDefinition {
  return {
    ...form,
    riskLevels: form.riskLevels ?? DEFAULT_RISK_LEVELS,
    steps: form.steps.map((step) => ({
      ...step,
      fields: step.fields.map((field) => {
        if (hasChoices(field)) return { ...field, risk: { ...choiceRisk(field) } };
        if (isNumber(field)) return { ...field, riskBands: [...numberRiskBands(field)] };
        return field;
      }),
    })),
  };
}

function tierForScore(score: number, levels: RiskLevels): RiskTier {
  if (score >= levels.Critical) return 'Critical';
  if (score >= levels.High) return 'High';
  if (score >= levels.Medium) return 'Medium';
  return 'Low';
}

/** Risk of validated answers (hidden questions are already removed from them). */
export function computeRisk(cleaned: Answers, form: RequestFormDefinition = DEFAULT_REQUEST_FORM): RiskResult {
  const reasons: string[] = [];
  const minimums: { tier: RiskTier; reason: string }[] = [];
  let score = 0;

  for (const field of allFields(form)) {
    const value = cleaned[field.key];
    if (value === undefined) continue;
    if (hasChoices(field)) {
      const risk = choiceRisk(field);
      const chosen = Array.isArray(value) ? value : [value];
      for (const choice of chosen) {
        if (typeof choice !== 'string') continue;
        const setting = risk[choice];
        if (!setting) continue;
        const label = field.options.find((o) => o.value === choice)?.label ?? choice;
        if (setting.points && setting.points > 0) {
          score += setting.points;
          reasons.push(`${field.label}: ${label} (+${setting.points})`);
        }
        if (setting.atLeast) minimums.push({ tier: setting.atLeast, reason: `${field.label} is ${label}` });
      }
    } else if (isNumber(field) && typeof value === 'number') {
      const band = [...numberRiskBands(field)].filter((b) => value >= b.from).sort((a, b) => b.from - a.from)[0];
      if (band && band.points > 0) {
        score += band.points;
        reasons.push(`${field.label} at or above ${band.from.toLocaleString('en-US')} (+${band.points})`);
      }
    }
  }

  let tier = tierForScore(score, form.riskLevels ?? DEFAULT_RISK_LEVELS);
  for (const minimum of minimums) {
    if (RISK_TIERS.indexOf(minimum.tier) > RISK_TIERS.indexOf(tier)) {
      tier = minimum.tier;
      reasons.push(`Minimum tier ${minimum.tier}: ${minimum.reason}`);
    }
  }
  return { tier, score, reasons };
}
