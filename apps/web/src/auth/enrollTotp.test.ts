import { describe, expect, it } from 'vitest';
import { enrollTotp } from './enrollTotp';

function fakeMfa(factors: { id: string; factor_type: string; status: string }[]) {
  const calls: string[] = [];
  const names: (string | undefined)[] = [];
  const mfa = {
    async listFactors() {
      calls.push('list');
      return { data: { all: factors, totp: [], phone: [], webauthn: [] }, error: null };
    },
    async unenroll({ factorId }: { factorId: string }) {
      calls.push(`unenroll ${factorId}`);
      return { data: { id: factorId }, error: null };
    },
    async enroll(params: { factorType: string; friendlyName?: string }) {
      calls.push('enroll');
      if (names.includes(params.friendlyName)) {
        return { data: null, error: { message: `A factor with the friendly name "${params.friendlyName ?? ''}" for this user already exists` } };
      }
      names.push(params.friendlyName);
      return { data: { id: 'new', type: 'totp', totp: { qr_code: 'data:qr', secret: 'SECRET', uri: 'otpauth://' } }, error: null };
    },
  };
  return { mfa: mfa as never, calls, names };
}

describe('enrollTotp', () => {
  it('removes unverified TOTP factors before enrolling, and keeps verified ones', async () => {
    const { mfa, calls } = fakeMfa([
      { id: 'old', factor_type: 'totp', status: 'unverified' },
      { id: 'kept', factor_type: 'totp', status: 'verified' },
      { id: 'phone', factor_type: 'phone', status: 'unverified' },
    ]);
    expect(await enrollTotp(mfa)).toEqual({ factorId: 'new', qrCode: 'data:qr', secret: 'SECRET' });
    expect(calls).toEqual(['list', 'unenroll old', 'enroll']);
  });

  it('gives each factor a unique name, so a second enrolment is not refused', async () => {
    const { mfa, names } = fakeMfa([]);
    await enrollTotp(mfa, new Date('2026-11-14T10:00:00.000Z'));
    await enrollTotp(mfa, new Date('2026-11-14T10:00:00.001Z'));
    expect(names).toEqual(['Authenticator app 2026-11-14T10:00:00.000Z', 'Authenticator app 2026-11-14T10:00:00.001Z']);
  });
});
