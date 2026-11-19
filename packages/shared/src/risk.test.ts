import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUEST_FORM, type FieldDef, type RequestFormDefinition } from './requestForm';
import { affectsRisk, choiceRisk, computeRisk, numberRiskBands, withRiskDefaults } from './risk';

const base = { dataClassification: 'Public', businessCriticality: 'Low', productionAccess: 'No' };

describe('computeRisk (standard form)', () => {
  it('rates a free, public, non-critical tool as Low with score 0', () => {
    expect(computeRisk(base)).toEqual({ tier: 'Low', score: 0, reasons: [] });
  });

  it('adds up classification, criticality, production access and cost', () => {
    const result = computeRisk({
      dataClassification: 'Confidential', // 3
      businessCriticality: 'High', // 2
      productionAccess: 'Yes', // 2
      annualCost: 60_000, // 2
    });
    expect(result.score).toBe(9);
    expect(result.tier).toBe('Critical');
    expect(result.reasons).toEqual([
      'Data classification: Confidential (+3)',
      'Access to production systems?: Yes (+2)',
      'Estimated annual cost at or above 50,000 (+2)',
      'Business criticality: High (+2)',
    ]);
  });

  it('uses the highest cost band that the cost reaches', () => {
    expect(computeRisk({ ...base, annualCost: 9_999 }).score).toBe(0);
    expect(computeRisk({ ...base, annualCost: 10_000 }).score).toBe(1);
    expect(computeRisk({ ...base, annualCost: 50_000 }).score).toBe(2);
    expect(computeRisk({ ...base, annualCost: 1_000_000 }).score).toBe(3);
  });

  it('never rates Restricted data or Critical business criticality below High', () => {
    const result = computeRisk({ ...base, dataClassification: 'Restricted' });
    expect(result).toMatchObject({ score: 5, tier: 'High' });
    expect(result.reasons.at(-1)).toBe('Minimum tier High: Data classification is Restricted');
    expect(computeRisk({ ...base, businessCriticality: 'Critical' }).tier).toBe('High');
  });

  it('does not let a minimum lower a tier that is already higher', () => {
    const result = computeRisk({ dataClassification: 'Restricted', businessCriticality: 'Critical', productionAccess: 'Yes', annualCost: 300_000 });
    expect(result.tier).toBe('Critical');
    expect(result.reasons.some((r) => r.startsWith('Minimum'))).toBe(false);
  });
});

describe('computeRisk (custom form)', () => {
  const yesNo = [
    { value: 'Yes', label: 'Yes' },
    { value: 'No', label: 'No' },
  ];
  const form: RequestFormDefinition = {
    steps: [
      {
        title: 'Only',
        fields: [
          { key: 'tool', label: 'Tool', type: 'text' },
          { key: 'health', label: 'Health data?', type: 'radio', options: yesNo, risk: { Yes: { points: 4, atLeast: 'Critical' } } },
          {
            key: 'kinds',
            label: 'Kinds of data',
            type: 'multiselect',
            options: [
              { value: 'Names', label: 'Names' },
              { value: 'Cards', label: 'Payment cards' },
            ],
            risk: { Names: { points: 1 }, Cards: { points: 3 } },
          },
          { key: 'seats', label: 'Seats', type: 'integer', min: 1, riskBands: [{ from: 1000, points: 2 }, { from: 100, points: 1 }] },
          // Standard key with risk switched off explicitly.
          { key: 'productionAccess', label: 'Production?', type: 'radio', options: yesNo, risk: {} },
        ],
      },
    ],
    riskLevels: { Medium: 2, High: 4, Critical: 8 },
  };

  it('scores any question the admin configured, with the form’s own levels', () => {
    expect(computeRisk({ kinds: ['Names', 'Cards'], seats: 150, productionAccess: 'Yes' }, form)).toEqual({
      tier: 'High',
      score: 5,
      reasons: ['Kinds of data: Names (+1)', 'Kinds of data: Payment cards (+3)', 'Seats at or above 100 (+1)'],
    });
    expect(computeRisk({ health: 'Yes' }, form).tier).toBe('Critical');
    expect(computeRisk({ seats: 5000 }, form).score).toBe(2);
  });

  it('works when the standard risk questions are gone', () => {
    expect(computeRisk({ tool: 'X' }, form)).toEqual({ tier: 'Low', score: 0, reasons: [] });
  });

  it('keeps standard settings for forms saved before risk was configurable', () => {
    const legacy: FieldDef = {
      key: 'dataClassification',
      label: 'Sensitivity',
      type: 'select',
      options: [
        { value: 'Public', label: 'Public' },
        { value: 'Restricted', label: 'Very secret' },
      ],
    };
    expect(choiceRisk(legacy)).toEqual({ Restricted: { points: 5, atLeast: 'High' } });
    expect(computeRisk({ dataClassification: 'Restricted' }, { steps: [{ title: 'S', fields: [legacy] }] }).reasons[0]).toBe(
      'Sensitivity: Very secret (+5)',
    );
    expect(affectsRisk(form.steps[0]!.fields[4]!)).toBe(false);
    expect(numberRiskBands({ key: 'annualCost', label: 'Cost', type: 'money', min: 0 })).toHaveLength(3);
  });

  it('writes inherited settings out for the editor', () => {
    const filled = withRiskDefaults({ steps: [{ title: 'S', fields: [{ key: 'productionAccess', label: 'P', type: 'radio', options: [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }] }] }] });
    expect(filled.riskLevels).toEqual({ Medium: 3, High: 6, Critical: 9 });
    expect(filled.steps[0]!.fields[0]).toMatchObject({ risk: { Yes: { points: 2 } } });
    expect(withRiskDefaults(DEFAULT_REQUEST_FORM).steps.flatMap((s) => s.fields).filter(affectsRisk).map((f) => f.key)).toEqual([
      'dataClassification',
      'productionAccess',
      'annualCost',
      'businessCriticality',
    ]);
  });
});
