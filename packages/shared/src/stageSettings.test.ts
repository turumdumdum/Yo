import { describe, expect, it } from 'vitest';
import { DEFAULT_REQUEST_FORM } from './requestForm';
import { defaultWorkflowSettings, describeRequirement, parseWorkflowSettings, workflowFromSettings } from './stageSettings';
import { DEFAULT_WORKFLOW, planStages } from './workflow';

const friday = new Date('2026-11-20T12:00:00Z');
const required = (stages: { name: string; status: string }[]) => stages.filter((s) => s.status !== 'Not required').map((s) => s.name);

describe('workflow settings', () => {
  it('describe the default workflow exactly', () => {
    const settings = defaultWorkflowSettings();
    expect(parseWorkflowSettings(settings)).toEqual({ settings });
    expect(workflowFromSettings(settings)).toEqual({
      stages: DEFAULT_WORKFLOW.stages.map(({ onlyWhen, ...rule }) => ({ ...rule, ...(onlyWhen ? { onlyWhen: { field: onlyWhen.field, in: onlyWhen.in } } : {}) })),
    });
    expect(workflowFromSettings(null)).toBe(DEFAULT_WORKFLOW);
    expect(describeRequirement(settings['Security review']!)).toBe('Needed from Medium risk');
    expect(describeRequirement(settings['Finance review']!, () => 'Paid or free')).toBe('Always needed, only when “Paid or free” is Paid');
  });

  it('turn reviews on, off, by risk, with their own SLA and checklist', () => {
    const settings = defaultWorkflowSettings();
    settings['Legal review'] = { ...settings['Legal review']!, requirement: 'never' };
    settings['Security review'] = { ...settings['Security review']!, requirement: 'always', slaBusinessDays: 2, checklist: ['Pen test report read'] };
    settings['IT review'] = { ...settings['IT review']!, requirement: 'by_risk', minTier: 'High' };
    settings['Finance review'] = { ...settings['Finance review']!, onlyWhen: null };
    const config = workflowFromSettings(settings);
    const stages = planStages('Medium', { paymentType: 'Free' }, friday, config, {}, DEFAULT_REQUEST_FORM);
    expect(required(stages)).toEqual(['License check', 'Security review', 'Finance review']);
    expect(stages.find((s) => s.name === 'Legal review')!.note).toBe('Not required: turned off by your organization');
    expect(stages.find((s) => s.name === 'IT review')!.note).toBe('Not required for Medium risk');
    const security = stages.find((s) => s.name === 'Security review')!;
    expect(security.checklist).toEqual(['Pen test report read']);
    expect(security.slaDueAt).toBe('2026-11-24T12:00:00.000Z');
  });

  it('take the condition label from the request form', () => {
    const stages = planStages('Low', { paymentType: 'Free' }, friday, workflowFromSettings(defaultWorkflowSettings()), {}, DEFAULT_REQUEST_FORM);
    expect(stages.find((s) => s.name === 'Finance review')!.note).toBe('Not required: Paid or free is Free');
  });

  it.each([
    [(s: ReturnType<typeof defaultWorkflowSettings>) => delete s['IT review'], /IT review are missing/],
    [(s: ReturnType<typeof defaultWorkflowSettings>) => ((s as Record<string, unknown>).Extra = {}), /Unknown review “Extra”/],
    [(s: ReturnType<typeof defaultWorkflowSettings>) => ((s['IT review'] as { requirement: string }).requirement = 'maybe'), /when the review is needed/],
    [(s: ReturnType<typeof defaultWorkflowSettings>) => ((s['IT review'] as { minTier: string }).minTier = 'Low'), /Medium, High or Critical/],
    [(s: ReturnType<typeof defaultWorkflowSettings>) => (s['IT review']!.slaBusinessDays = 0), /1 to 60 business days/],
    [(s: ReturnType<typeof defaultWorkflowSettings>) => (s['IT review']!.checklist = ['  ']), /checklist item/],
    [(s: ReturnType<typeof defaultWorkflowSettings>) => (s['IT review']!.onlyWhen = { field: 'paymentType', in: [] }), /which answers/],
    [
      (s: ReturnType<typeof defaultWorkflowSettings>) => {
        for (const stage of Object.values(s)) stage.requirement = 'by_risk';
      },
      /At least one review must always be needed/,
    ],
  ])('reject broken settings #%#', (breakIt, message) => {
    const settings = defaultWorkflowSettings();
    breakIt(settings);
    const result = parseWorkflowSettings(settings);
    expect('error' in result && result.error).toMatch(message);
    // Broken stored settings never break submission.
    expect(workflowFromSettings(settings)).toBe(DEFAULT_WORKFLOW);
  });
});
