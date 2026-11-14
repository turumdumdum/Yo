import {
  RISK_TIERS,
  type BusinessCriticality,
  type DataClassification,
  type RiskTier,
} from './domain';

// Triage risk scoring (CLAUDE.md §6). The scoring configuration is plain data so that an
// organization can change weights in the workflow builder without a code change.

export interface RiskInput {
  dataClassification: DataClassification;
  businessCriticality: BusinessCriticality;
  productionAccess: boolean;
  /** Estimated annual cost in the organization's base currency; null/undefined when not Paid. */
  annualCost?: number | null;
}

export interface RiskFloor {
  field: 'dataClassification' | 'businessCriticality' | 'productionAccess';
  equals: string | boolean;
  /** The resulting tier is never lower than this when the field matches. */
  tier: RiskTier;
}

export interface RiskScoringConfig {
  dataClassification: Record<DataClassification, number>;
  businessCriticality: Record<BusinessCriticality, number>;
  productionAccess: number;
  /** The band with the highest `minAnnualCost` that the cost reaches applies. */
  costBands: { minAnnualCost: number; points: number }[];
  /** Minimum score for each tier. Low is the fallback and is always 0. */
  tierThresholds: Record<Exclude<RiskTier, 'Low'>, number>;
  floors: RiskFloor[];
}

export interface RiskResult {
  tier: RiskTier;
  score: number;
  /** Human-readable explanation of each contribution, shown to reviewers. */
  reasons: string[];
}

// Default weights are a starting proposal, not an approved policy: confirm with the owner.
export const DEFAULT_RISK_SCORING: RiskScoringConfig = {
  dataClassification: { Public: 0, Internal: 1, Confidential: 3, Restricted: 5 },
  businessCriticality: { Low: 0, Medium: 1, High: 2, Critical: 4 },
  productionAccess: 2,
  costBands: [
    { minAnnualCost: 10_000, points: 1 },
    { minAnnualCost: 50_000, points: 2 },
    { minAnnualCost: 250_000, points: 3 },
  ],
  tierThresholds: { Medium: 3, High: 6, Critical: 9 },
  floors: [
    { field: 'dataClassification', equals: 'Restricted', tier: 'High' },
    { field: 'businessCriticality', equals: 'Critical', tier: 'High' },
  ],
};

function tierRank(tier: RiskTier): number {
  return RISK_TIERS.indexOf(tier);
}

function tierForScore(score: number, thresholds: RiskScoringConfig['tierThresholds']): RiskTier {
  if (score >= thresholds.Critical) return 'Critical';
  if (score >= thresholds.High) return 'High';
  if (score >= thresholds.Medium) return 'Medium';
  return 'Low';
}

export function computeRiskTier(
  input: RiskInput,
  config: RiskScoringConfig = DEFAULT_RISK_SCORING,
): RiskResult {
  const reasons: string[] = [];
  let score = 0;

  const add = (points: number, reason: string) => {
    if (points === 0) return;
    score += points;
    reasons.push(`${reason} (+${points})`);
  };

  add(
    config.dataClassification[input.dataClassification],
    `Data classification: ${input.dataClassification}`,
  );
  add(
    config.businessCriticality[input.businessCriticality],
    `Business criticality: ${input.businessCriticality}`,
  );
  if (input.productionAccess) add(config.productionAccess, 'Access to production systems');

  const cost = input.annualCost ?? 0;
  const band = config.costBands
    .filter((b) => cost >= b.minAnnualCost)
    .sort((a, b) => b.minAnnualCost - a.minAnnualCost)[0];
  if (band) add(band.points, `Estimated annual cost at or above ${band.minAnnualCost}`);

  let tier = tierForScore(score, config.tierThresholds);

  for (const floor of config.floors) {
    if (input[floor.field] === floor.equals && tierRank(floor.tier) > tierRank(tier)) {
      tier = floor.tier;
      reasons.push(`Minimum tier ${floor.tier}: ${floor.field} is ${String(floor.equals)}`);
    }
  }

  return { tier, score, reasons };
}
