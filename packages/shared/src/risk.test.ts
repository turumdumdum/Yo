import { describe, expect, it } from 'vitest';
import { computeRiskTier, DEFAULT_RISK_SCORING, type RiskInput, type RiskScoringConfig } from './risk';

const base: RiskInput = {
  dataClassification: 'Public',
  businessCriticality: 'Low',
  productionAccess: false,
  annualCost: null,
};

describe('computeRiskTier (default scoring)', () => {
  it('rates a free, public, non-critical tool as Low with score 0', () => {
    expect(computeRiskTier(base)).toEqual({ tier: 'Low', score: 0, reasons: [] });
  });

  it('adds up classification, criticality, production access and cost', () => {
    const result = computeRiskTier({
      dataClassification: 'Confidential', // 3
      businessCriticality: 'High', // 2
      productionAccess: true, // 2
      annualCost: 60_000, // 2
    });
    expect(result.score).toBe(9);
    expect(result.tier).toBe('Critical');
    expect(result.reasons).toHaveLength(4);
  });

  it.each([
    [2, 'Low'],
    [3, 'Medium'],
    [5, 'Medium'],
    [6, 'High'],
    [8, 'High'],
    [9, 'Critical'],
  ] as const)('maps score %i to %s at the tier boundaries', (score, tier) => {
    // Isolate thresholds: put the whole score on production access.
    const config: RiskScoringConfig = { ...DEFAULT_RISK_SCORING, productionAccess: score, floors: [] };
    expect(computeRiskTier({ ...base, productionAccess: true }, config).tier).toBe(tier);
  });

  it('uses the highest cost band that the cost reaches', () => {
    expect(computeRiskTier({ ...base, annualCost: 9_999 }).score).toBe(0);
    expect(computeRiskTier({ ...base, annualCost: 10_000 }).score).toBe(1);
    expect(computeRiskTier({ ...base, annualCost: 50_000 }).score).toBe(2);
    expect(computeRiskTier({ ...base, annualCost: 1_000_000 }).score).toBe(3);
  });

  it('treats missing cost as zero', () => {
    expect(computeRiskTier({ ...base, annualCost: undefined }).score).toBe(0);
  });

  it('never rates Restricted data below High', () => {
    const result = computeRiskTier({ ...base, dataClassification: 'Restricted' });
    expect(result.score).toBe(5);
    expect(result.tier).toBe('High');
    expect(result.reasons.at(-1)).toMatch(/Minimum tier High/);
  });

  it('never rates Critical business criticality below High', () => {
    expect(computeRiskTier({ ...base, businessCriticality: 'Critical' }).tier).toBe('High');
  });

  it('does not let a floor lower a tier that is already higher', () => {
    const result = computeRiskTier({
      dataClassification: 'Restricted',
      businessCriticality: 'Critical',
      productionAccess: true,
      annualCost: 300_000,
    });
    expect(result.tier).toBe('Critical');
  });
});

describe('computeRiskTier (custom scoring)', () => {
  it('follows organization-specific weights and floors without code changes', () => {
    const config: RiskScoringConfig = {
      ...DEFAULT_RISK_SCORING,
      dataClassification: { Public: 0, Internal: 0, Confidential: 0, Restricted: 0 },
      floors: [{ field: 'productionAccess', equals: true, tier: 'Critical' }],
    };
    expect(computeRiskTier({ ...base, dataClassification: 'Restricted' }, config).tier).toBe('Low');
    expect(computeRiskTier({ ...base, productionAccess: true }, config).tier).toBe('Critical');
  });

  it('accepts cost bands in any order', () => {
    const config: RiskScoringConfig = {
      ...DEFAULT_RISK_SCORING,
      costBands: [...DEFAULT_RISK_SCORING.costBands].reverse(),
    };
    expect(computeRiskTier({ ...base, annualCost: 60_000 }, config).score).toBe(2);
  });
});
