import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { CredentialsForm } from './CredentialsForm';
import { MfaChallenge } from './MfaChallenge';
import { MfaEnroll } from './MfaEnroll';
import { authStep, type AuthStep } from './steps';

interface Props {
  supabase: SupabaseClient;
  /** Rendered only for a signed-in user whose session satisfies the MFA rule. */
  children: (user: User) => ReactNode;
  onStepChange?: (step: AuthStep) => void;
}

export function AuthGate({ supabase, children, onStepChange }: Props) {
  const [state, setState] = useState<{ step: AuthStep; user: User | null } | null>(null);

  const refresh = useCallback(async () => {
    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData.session;
    if (!session) {
      setState({ step: 'signed-out', user: null });
      return;
    }
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    setState({
      step: authStep({
        hasSession: true,
        currentLevel: aal?.currentLevel ?? null,
        nextLevel: aal?.nextLevel ?? null,
        methods: (aal?.currentAuthenticationMethods ?? []).map((m) => (typeof m === 'string' ? { method: m } : m)),
      }),
      user: session.user,
    });
  }, [supabase]);

  useEffect(() => {
    void refresh();
    // Supabase warns against awaiting its own calls inside this callback, hence the timeout.
    const { data } = supabase.auth.onAuthStateChange(() => {
      setTimeout(() => void refresh(), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [supabase, refresh]);

  useEffect(() => {
    if (state) onStepChange?.(state.step);
  }, [state, onStepChange]);

  if (!state) return <p role="status">Loading…</p>;

  switch (state.step) {
    case 'signed-out':
      return <CredentialsForm supabase={supabase} />;
    case 'enroll-mfa':
      return <MfaEnroll supabase={supabase} onVerified={refresh} />;
    case 'verify-mfa':
      return <MfaChallenge supabase={supabase} onVerified={refresh} />;
    case 'ready':
      return <>{children(state.user!)}</>;
  }
}
