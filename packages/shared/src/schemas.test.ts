import { describe, expect, it } from 'vitest';
import { createInvitationSchema, createOrganizationSchema, riskInputSchema } from './schemas';

describe('schemas', () => {
  it('trims and bounds organization names', () => {
    expect(createOrganizationSchema.parse({ name: '  Acme  ' })).toEqual({ name: 'Acme' });
    expect(createOrganizationSchema.safeParse({ name: ' a ' }).success).toBe(false);
  });

  it('lower-cases invitation emails and rejects unknown roles', () => {
    expect(createInvitationSchema.parse({ email: 'Ann@Example.com', role: 'reviewer' })).toEqual({
      email: 'ann@example.com',
      role: 'reviewer',
    });
    expect(createInvitationSchema.safeParse({ email: 'ann@example.com', role: 'superuser' }).success).toBe(false);
    expect(createInvitationSchema.safeParse({ email: 'not-an-email', role: 'reviewer' }).success).toBe(false);
  });

  it('rejects negative cost and unknown classifications', () => {
    const ok = { dataClassification: 'Internal', businessCriticality: 'Low', productionAccess: false };
    expect(riskInputSchema.safeParse(ok).success).toBe(true);
    expect(riskInputSchema.safeParse({ ...ok, annualCost: -1 }).success).toBe(false);
    expect(riskInputSchema.safeParse({ ...ok, dataClassification: 'Secret' }).success).toBe(false);
  });
});
