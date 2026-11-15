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
              The app was started without its Supabase settings. Missing:{' '}
              {[
                ['VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL],
                ['VITE_SUPABASE_ANON_KEY', import.meta.env.VITE_SUPABASE_ANON_KEY],
              ]
                .filter(([, value]) => !value)
                .map(([name]) => name)
                .join(', ')}
              .
            </p>
            <p>
              Put them in <code>apps/web/.env</code> (see <code>apps/web/.env.example</code>) and restart the dev server. The
              terminal shows which file was read, in lines starting with <code>[env]</code>.
            </p>
          </section>
        )}
      </main>
    </>
  );
}
