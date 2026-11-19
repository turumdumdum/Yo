import { totpCodeSchema } from '@app/shared';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Field } from '../components/Field';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { enrollTotp, isFactorGone, type Enrollment } from './enrollTotp';

/** Mandatory for email + password accounts: scan the QR code, then confirm with a code. */
export function MfaEnroll({ supabase, onVerified }: { supabase: SupabaseClient; onVerified: () => void }) {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string>();
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // One enrolment per screen. React runs effects twice in development, and two parallel
  // enrolments would race: the second one used to fail with "factor already exists".
  const started = useRef<Promise<Enrollment> | null>(null);

  useEffect(() => {
    let active = true;
    started.current ??= enrollTotp(supabase.auth.mfa);
    started.current.then(
      (result) => active && setEnrollment(result),
      (error: unknown) => active && setFormError(errorMessage(error)),
    );
    return () => {
      active = false;
    };
  }, [supabase]);

  /**
   * The QR code on this screen stopped working, usually because the setup was opened in
   * another tab. If that tab finished the setup, continue to the code prompt; otherwise
   * start a fresh setup here with a new QR code.
   */
  async function recover() {
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) throw error;
    if (data.totp.length > 0) {
      onVerified();
      return;
    }
    setEnrollment(null);
    setCode('');
    started.current = enrollTotp(supabase.auth.mfa);
    setEnrollment(await started.current);
    setNotice(
      'The setup was started again in another tab or window, so the previous QR code no longer works. Delete the entry you just added in your authenticator app, scan this new QR code, and enter the code it shows. Keep only this tab open.',
    );
  }

  // Coming back to this tab after using another one: check that this QR code still works.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible' || !enrollment) return;
      void supabase.auth.mfa.listFactors().then(({ data }) => {
        if (data && !data.all.some((f) => f.id === enrollment.factorId)) {
          void recover().catch((e: unknown) => setFormError(errorMessage(e)));
        }
      });
    };
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!enrollment) return;
    setFormError(null);
    const parsed = totpCodeSchema.safeParse(code);
    if (!parsed.success) {
      setCodeError(parsed.error.issues[0]?.message);
      return;
    }
    setCodeError(undefined);
    setBusy(true);
    try {
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enrollment.factorId, code: parsed.data });
      if (error && isFactorGone(error)) {
        await recover();
        return;
      }
      if (error) throw error;
      onVerified();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card auth-card" aria-labelledby="auth-heading">
      <h1 id="auth-heading">Set up two-step verification</h1>
      <p>Accounts with a password must use an authenticator app. Scan the QR code, then enter the 6-digit code it shows.</p>
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {enrollment && (
        <>
          <img className="qr-code" src={enrollment.qrCode} alt="QR code for your authenticator app" width={200} height={200} />
          <p className="field-hint">
            Cannot scan it? Enter this key in the app instead: <code className="secret">{enrollment.secret}</code>
          </p>
        </>
      )}
      <form onSubmit={submit} noValidate>
        <Field
          label="Verification code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={codeError}
          required
        />
        <FormError message={formError} />
        <button type="submit" className="button" disabled={busy || !enrollment}>
          {busy ? 'Please wait…' : 'Verify and continue'}
        </button>
      </form>
    </section>
  );
}
