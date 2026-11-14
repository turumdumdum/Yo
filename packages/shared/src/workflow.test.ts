import { describe, expect, it } from 'vitest';
import { REQUEST_FORM_STEPS } from './requestForm';
import { addBusinessDays, DEFAULT_WORKFLOW, focusStepsForStage, planStages, type WorkflowConfig } from './workflow';

// 2026-11-13 is a Friday.
const friday = new Date('2026-11-13T15:30:00Z');

const required = (stages: ReturnType<typeof planStages>) => stages.filter((s) => s.status === 'In review').map((s) => s.name);

describe('addBusinessDays', () => {
  it.each([
    ['2026-11-13T15:30:00Z', 1, '2026-11-16T15:30:00.000Z'], // Fri -> Mon
    ['2026-11-13T15:30:00Z', 5, '2026-11-20T15:30:00.000Z'], // Fri -> next Fri
    ['2026-11-14T09:00:00Z', 1, '2026-11-16T09:00:00.000Z'], // Sat -> Mon
    ['2026-11-15T09:00:00Z', 2, '2026-11-17T09:00:00.000Z'], // Sun -> Tue
    ['2026-11-16T09:00:00Z', 4, '2026-11-20T09:00:00.000Z'], // Mon -> Fri
    ['2026-11-16T09:00:00Z', 0, '2026-11-16T09:00:00.000Z'],
    ['2026-12-30T09:00:00Z', 3, '2027-01-04T09:00:00.000Z'], // across the year end
  ])('%s + %i business days', (from, days, expected) => {
    expect(addBusinessDays(new Date(from), days).toISOString()).toBe(expected);
  });

  it('does not change the date it was given', () => {
    addBusinessDays(friday, 3);
    expect(friday.toISOString()).toBe('2026-11-13T15:30:00.000Z');
  });
});

describe('planStages (default workflow)', () => {
  it('keeps the five default stages in order, whatever the tier', () => {
    expect(planStages('Low', {}, friday).map((s) => s.name)).toEqual([
      'License check',
      'Security review',
      'Legal review',
      'Finance review',
      'IT review',
    ]);
  });

  it('requires only the license and IT checks for a free Low-risk tool', () => {
    const stages = planStages('Low', { paymentType: 'Free' }, friday);
    expect(required(stages)).toEqual(['License check', 'IT review']);
    expect(stages.find((s) => s.name === 'Security review')).toMatchObject({
      status: 'Not required',
      slaDueAt: null,
      note: 'Not required for Low risk',
    });
    expect(stages.find((s) => s.name === 'Finance review')!.note).toBe('Not required: Paid or free is Free');
  });

  it('adds the finance review for paid services', () => {
    expect(required(planStages('Low', { paymentType: 'Paid' }, friday))).toEqual(['License check', 'Finance review', 'IT review']);
  });

  it.each(['Medium', 'High', 'Critical'] as const)('requires every stage for a paid %s-risk request', (tier) => {
    expect(required(planStages(tier, { paymentType: 'Paid' }, friday))).toHaveLength(5);
  });

  it('skips the finance review for a free tool even at Critical risk', () => {
    expect(required(planStages('Critical', { paymentType: 'Trial' }, friday))).toEqual([
      'License check',
      'Security review',
      'Legal review',
      'IT review',
    ]);
  });

  it('starts the SLA clock at submission, in business days', () => {
    const stage = planStages('Low', {}, friday).find((s) => s.name === 'License check')!;
    expect(stage).toMatchObject({ status: 'In review', slaBusinessDays: 5, slaDueAt: '2026-11-20T15:30:00.000Z', note: null });
  });
});

describe('planStages (custom workflow)', () => {
  it('follows organization-specific stages, tiers and deadlines without code changes', () => {
    const config: WorkflowConfig = {
      stages: [
        { name: 'Procurement', minTier: 'Low', slaBusinessDays: 2, checklist: ['Three quotes collected'], focusSteps: [4] },
        { name: 'Privacy review', minTier: 'Low', onlyWhen: { field: 'personalData', label: 'Personal data', in: ['Yes'] }, slaBusinessDays: 10, checklist: [], focusSteps: [] },
        { name: 'Board approval', minTier: 'Critical', slaBusinessDays: 20, checklist: [], focusSteps: [] },
      ],
    };
    const stages = planStages('High', { personalData: 'Yes' }, friday, config);
    expect(required(stages)).toEqual(['Procurement', 'Privacy review']);
    expect(stages[0]!.slaDueAt).toBe('2026-11-17T15:30:00.000Z');
    expect(stages[2]!.note).toBe('Not required for High risk');
    expect(planStages('High', {}, friday, config)[1]!.note).toBe('Not required: Personal data is not answered');
  });

  it('gives required stages their checklist and leaves it empty otherwise', () => {
    const stages = planStages('Low', { paymentType: 'Free' }, friday);
    expect(stages.find((s) => s.name === 'License check')!.checklist).toHaveLength(3);
    expect(stages.find((s) => s.name === 'Security review')!.checklist).toEqual([]);
    for (const rule of DEFAULT_WORKFLOW.stages) expect(rule.checklist.length).toBeGreaterThan(0);
  });

  it('gives the security review its form, from the organization when it has one', () => {
    const byDefault = planStages('High', {}, friday).find((s) => s.name === 'Security review')!;
    expect(byDefault.reviewFields.map((f) => f.key)).toContain('certifications');
    expect(byDefault.reviewRules.length).toBeGreaterThan(0);
    const custom = { fields: [{ key: 'q', label: 'Q', type: 'text' as const, required: true }], rules: [] };
    const configured = planStages('High', {}, friday, DEFAULT_WORKFLOW, { 'Security review': custom });
    expect(configured.find((s) => s.name === 'Security review')!.reviewFields).toEqual(custom.fields);
    // Stages without a form, and stages that are not required, get none.
    expect(configured.find((s) => s.name === 'License check')!.reviewFields).toEqual([]);
    expect(planStages('Low', {}, friday).find((s) => s.name === 'Security review')!.reviewFields).toEqual([]);
  });

  it('points each default stage at existing form steps', () => {
    for (const rule of DEFAULT_WORKFLOW.stages) {
      expect(rule.focusSteps.length).toBeGreaterThan(0);
      for (const index of rule.focusSteps) expect(REQUEST_FORM_STEPS[index]).toBeDefined();
    }
    expect(focusStepsForStage('Finance review')).toEqual([4, 5]);
    expect(focusStepsForStage('Something custom')).toEqual([]);
  });

  it('exposes the default configuration as plain data', () => {
    expect(JSON.parse(JSON.stringify(DEFAULT_WORKFLOW))).toEqual(DEFAULT_WORKFLOW);
  });
});
