import { describe, expect, it } from 'vitest';
import { configRequirementsFor, DEFAULT_SECURITY_BASELINE, exceptionState, parseSecurityBaseline } from './securityBaseline';

describe('security baseline', () => {
  it('accepts the standard baseline', () => {
    expect(parseSecurityBaseline(DEFAULT_SECURITY_BASELINE)).toEqual({ baseline: DEFAULT_SECURITY_BASELINE });
  });

  it('applies controls by risk tier and answers, including several-choice answers', () => {
    const ids = (tier: 'Low' | 'Medium' | 'High', answers: Record<string, unknown>) => configRequirementsFor(DEFAULT_SECURITY_BASELINE, tier, answers).map((c) => c.id);
    expect(ids('Low', {})).toEqual(['mfa', 'admin-roles', 'no-shared-accounts', 'integrations']);
    expect(ids('Medium', { platforms: ['Web', 'API'], personalData: 'Yes' })).toEqual(
      expect.arrayContaining(['sso', 'deprovisioning', 'api-keys', 'data-location', 'retention']),
    );
    expect(ids('High', { vendorUsesAi: 'Unknown', dataClassification: 'Restricted' })).toEqual(
      expect.arrayContaining(['ai-training', 'audit-logs', 'encryption', 'data-export']),
    );
    expect(configRequirementsFor(DEFAULT_SECURITY_BASELINE, 'Low', {})[0]).toMatchObject({ decision: null, configured: false });
  });

  it.each([
    [{ controls: 'x' }, /list of controls/],
    [{ controls: [{ ...DEFAULT_SECURITY_BASELINE.controls[0], id: 'Sso' }] }, /invalid key/],
    [{ controls: [DEFAULT_SECURITY_BASELINE.controls[0], DEFAULT_SECURITY_BASELINE.controls[0]] }, /Two controls use the key “sso”/],
    [{ controls: [{ ...DEFAULT_SECURITY_BASELINE.controls[0], requirement: ' ' }] }, /what must be configured/],
    [{ controls: [{ ...DEFAULT_SECURITY_BASELINE.controls[0], level: 'nice' }] }, /required or recommended/],
    [{ controls: [{ ...DEFAULT_SECURITY_BASELINE.controls[0], minTier: 'Huge' }] }, /risk level/],
    [{ controls: [{ ...DEFAULT_SECURITY_BASELINE.controls[0], when: { field: 'platforms', in: [] } }] }, /which answers/],
    [{ controls: [{ ...DEFAULT_SECURITY_BASELINE.controls[0], script: 1 }] }, /unknown setting/],
  ])('rejects a broken baseline #%#', (input, message) => {
    const result = parseSecurityBaseline(input);
    expect('error' in result && result.error).toMatch(message);
  });

  it('reads exceptions in a register', () => {
    expect(exceptionState({ status: 'approved', expires_on: '2026-12-31' }, '2026-11-21')).toBe('active');
    expect(exceptionState({ status: 'approved', expires_on: '2026-12-10' }, '2026-11-21')).toBe('expiring');
    expect(exceptionState({ status: 'approved', expires_on: '2026-11-20' }, '2026-11-21')).toBe('expired');
    expect(exceptionState({ status: 'pending', expires_on: '2026-11-20' }, '2026-11-21')).toBe('pending');
  });
});
