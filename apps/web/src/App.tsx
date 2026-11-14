import { useState } from 'react';
import { AuthGate } from './auth/AuthGate';
import type { AuthStep } from './auth/steps';
import { supabase } from './lib/supabase';
import { OrgGate } from './org/OrgGate';

export function App() {
  const [step, setStep] = useState<AuthStep>('signed-out');

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="app-header">
        <span className="brand">[Product name]</span>
        {supabase && step !== 'signed-out' && (
          <button type="button" className="button button-secondary" onClick={() => void supabase!.auth.signOut()}>
            Sign out
          </button>
        )}
      </header>
      <main id="main" className="page">
        {supabase ? (
          <AuthGate supabase={supabase} onStepChange={setStep}>
            {(user) => <OrgGate supabase={supabase!} user={user} />}
          </AuthGate>
        ) : (
          <section className="card auth-card" aria-labelledby="setup-heading">
            <h1 id="setup-heading">Setup required</h1>
            <p>
              Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in <code>apps/web/.env</code>, then
              restart the dev server. See <code>.env.example</code>.
            </p>
          </section>
        )}
      </main>
    </>
  );
}
