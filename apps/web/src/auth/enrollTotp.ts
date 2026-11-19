import type { SupabaseClient } from '@supabase/supabase-js';

export interface Enrollment {
  factorId: string;
  qrCode: string;
  secret: string;
}

type MfaApi = Pick<SupabaseClient['auth']['mfa'], 'listFactors' | 'unenroll' | 'enroll'>;

/**
 * Starts a fresh TOTP enrolment. Unverified factors left by an abandoned setup are removed
 * first, and every factor gets a unique name: Supabase refuses a second factor with the
 * same name, which is what an empty name amounts to.
 */
export async function enrollTotp(mfa: MfaApi, now: Date = new Date()): Promise<Enrollment> {
  const { data: factors, error: listError } = await mfa.listFactors();
  if (listError) throw listError;
  for (const factor of factors.all.filter((f) => f.factor_type === 'totp' && f.status === 'unverified')) {
    const { error } = await mfa.unenroll({ factorId: factor.id });
    if (error) throw error;
  }
  const { data, error } = await mfa.enroll({
    factorType: 'totp',
    friendlyName: `Authenticator app ${now.toISOString()}`,
  });
  if (error) throw error;
  return { factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret };
}

/**
 * True when Supabase no longer knows the factor being verified. That happens when the
 * setup was opened again in another tab or window (for example from the confirmation
 * email after an invitation): each setup removes unfinished ones, so the older QR code
 * stops working.
 */
export function isFactorGone(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { code?: unknown; status?: unknown; message?: unknown };
  return e.code === 'mfa_factor_not_found' || (typeof e.message === 'string' && /factor not found/i.test(e.message));
}
