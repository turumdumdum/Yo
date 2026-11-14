import { totpCodeSchema } from '@app/shared';
import { useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Field } from '../components/Field';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';

/** Second step of every email + password sign-in. */
export function MfaChallenge({ supabase, onVerified }: { supabase: SupabaseClient; onVerified: () => void }) {
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string>();
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = totpCodeSchema.safeParse(code);
    if (!parsed.success) {
      setCodeError(parsed.error.issues[0]?.message);
      return;
    }
    setCodeError(undefined);
    setBusy(true);
    try {
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError) throw listError;
      const factor = factors.totp[0];
      if (!factor) throw new Error('No authenticator app is set up for this account.');
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: parsed.data });
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
      <h1 id="auth-heading">Two-step verification</h1>
      <p>Enter the 6-digit code from your authenticator app.</p>
      <form onSubmit={submit} noValidate>
        <Field
          label="Verification code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={codeError}
          required
        />
        <FormError message={formError} />
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'Please wait…' : 'Verify'}
        </button>
      </form>
    </section>
  );
}
