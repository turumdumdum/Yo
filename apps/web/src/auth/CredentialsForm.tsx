import { PASSWORD_MIN_LENGTH, signInSchema, signUpSchema } from '@app/shared';
import { useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Field } from '../components/Field';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { pendingInvitation } from '../lib/invite';

type Mode = 'sign-in' | 'sign-up';

export function CredentialsForm({ supabase }: { supabase: SupabaseClient }) {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<{ email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmationSentTo, setConfirmationSentTo] = useState<string | null>(null);

  const signingUp = mode === 'sign-up';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = (signingUp ? signUpSchema : signInSchema).safeParse({ email, password });
    if (!parsed.success) {
      const errors: typeof fieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if ((key === 'email' || key === 'password') && !errors[key]) errors[key] = issue.message;
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    setBusy(true);
    try {
      if (signingUp) {
        const { data, error } = await supabase.auth.signUp({
          ...parsed.data,
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
        // Without a session the address still has to be confirmed by email.
        if (!data.session) setConfirmationSentTo(parsed.data.email);
      } else {
        const { error } = await supabase.auth.signInWithPassword(parsed.data);
        if (error) throw error;
      }
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setFieldErrors({});
    setFormError(null);
    setConfirmationSentTo(null);
  }

  if (confirmationSentTo) {
    return (
      <section className="card auth-card" aria-labelledby="auth-heading">
        <h1 id="auth-heading">Check your email</h1>
        <p>
          If <strong>{confirmationSentTo}</strong> can be registered, we have sent it a confirmation link. Open the link to
          continue.
        </p>
        <button type="button" className="button button-secondary" onClick={() => switchMode('sign-in')}>
          Back to sign in
        </button>
      </section>
    );
  }

  return (
    <section className="card auth-card" aria-labelledby="auth-heading">
      <h1 id="auth-heading">{signingUp ? 'Create your account' : 'Sign in'}</h1>
      {pendingInvitation() && (
        <p className="notice">
          You have been invited to an organization. Sign in or create an account with the email address the invitation was
          sent to.
        </p>
      )}
      <form onSubmit={submit} noValidate>
        <Field
          label="Work email"
          type="email"
          name="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={fieldErrors.email}
          required
        />
        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete={signingUp ? 'new-password' : 'current-password'}
          hint={signingUp ? `At least ${PASSWORD_MIN_LENGTH} characters.` : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={fieldErrors.password}
          required
        />
        <FormError message={formError} />
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'Please wait…' : signingUp ? 'Create account' : 'Sign in'}
        </button>
      </form>
      <p className="auth-switch">
        {signingUp ? 'Already have an account?' : 'New here?'}{' '}
        <button type="button" className="link-button" onClick={() => switchMode(signingUp ? 'sign-in' : 'sign-up')}>
          {signingUp ? 'Sign in' : 'Create an account'}
        </button>
      </p>
      {signingUp && <p className="field-hint">After confirming your email you will set up two-step verification.</p>}
    </section>
  );
}
