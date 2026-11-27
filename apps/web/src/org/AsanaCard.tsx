import { useCallback, useEffect, useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { listAsanaWorkspaces, loadAsanaStatus, removeAsana, saveAsana, testAsana, type AsanaPlace, type AsanaStatus } from '../requests/api';
import { SecretField } from './IntegrationsSection';

// Admin → Integrations → Asana. The token is checked with Asana before it is saved, stored
// encrypted on the server and never shown again. Used to import project fields into the
// request form (Admin → Request form → Import from Asana).

export function AsanaCard({ supabase, onChanged }: { supabase: SupabaseClient; onChanged?: (connected: boolean) => void }) {
  const id = useId();
  const [status, setStatus] = useState<AsanaStatus | null>(null);
  const [token, setToken] = useState('');
  const [workspaces, setWorkspaces] = useState<AsanaPlace[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const s = await loadAsanaStatus(supabase);
      setStatus(s);
      onChanged?.(s.configured);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, onChanged]);
  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const done = await action();
      setNotice(done || null);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const connected = !!status?.configured;
  return (
    <section className="integration-card" aria-labelledby={`${id}-title`}>
      <div className="review-card-head">
        <h3 id={`${id}-title`}>Asana</h3>
        <span className="status-badge" data-tone={connected ? 'approved' : 'idle'}>
          {connected ? 'Connected' : 'Not connected'}
        </span>
      </div>
      <p className="field-hint">
        Import the custom fields of an Asana project, with all their values, as questions of the request form (Admin → Request form → Import
        from Asana). Uses a personal access token of an Asana user who can see the project; it is stored encrypted and only sent to Asana.
      </p>
      <details className="format-help">
        <summary>How to create a token</summary>
        <ol>
          <li>
            In Asana, open the{' '}
            <a href="https://app.asana.com/0/my-apps" target="_blank" rel="noreferrer noopener">
              developer console
            </a>{' '}
            (profile picture → Settings → Apps → Developer apps).
          </li>
          <li>Choose “Create new token”, name it for example “[Product name] form import”, and copy it.</li>
          <li>Paste it below and save. Asana shows the token only once; if it is lost, create a new one.</li>
        </ol>
        <p className="field-hint">The token can read everything its user can see in Asana. Use an account that only sees the projects you import from.</p>
      </details>
      {status && !status.encryptionReady && <p className="notice">Saving a token needs INTEGRATION_ENCRYPTION_KEY on the API server.</p>}
      <SecretField label="Personal access token" saved={connected} value={token} onChange={setToken} />
      {connected && (
        <p className="field-hint">
          Default workspace: <strong>{status?.workspaceName ?? 'none chosen'}</strong>
          {!workspaces && (
            <>
              {' '}
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    setWorkspaces((await listAsanaWorkspaces(supabase)).workspaces);
                    return '';
                  })
                }
              >
                Change
              </button>
            </>
          )}
        </p>
      )}
      {workspaces && workspaces.length > 0 && (
        <div className="field">
          <label htmlFor={`${id}-ws`}>Default workspace for imports</label>
          <select
            id={`${id}-ws`}
            value={status?.workspaceGid ?? ''}
            disabled={busy}
            onChange={(e) => {
              const gid = e.target.value || null;
              void run(async () => {
                await saveAsana(supabase, { workspaceGid: gid });
                return 'Default workspace saved.';
              });
            }}
          >
            <option value="">No default</option>
            {workspaces.map((w) => (
              <option key={w.gid} value={w.gid}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <FormError message={error} />
      {notice && (
        <p className="notice notice-approved" role="status">
          {notice}
        </p>
      )}
      <div className="question-actions">
        <button
          type="button"
          className="button"
          disabled={busy || (!connected && token.trim() === '') || (connected && token.trim() === '')}
          onClick={() =>
            void run(async () => {
              const result = await saveAsana(supabase, { token: token.trim() });
              setToken('');
              setWorkspaces(result.workspaces);
              // One workspace: make it the default straight away.
              if (result.workspaces.length === 1 && result.workspaces[0]) await saveAsana(supabase, { workspaceGid: result.workspaces[0].gid });
              return `Connected as ${result.user || 'the token’s user'}.`;
            })
          }
        >
          {busy ? 'Checking…' : 'Save and check token'}
        </button>
        {connected && (
          <>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await testAsana(supabase);
                  return `Asana answers: signed in as ${result.user || 'the token’s user'}, ${result.workspaces} ${result.workspaces === 1 ? 'workspace' : 'workspaces'}.`;
                })
              }
            >
              Test connection
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Disconnect Asana? The token is deleted here; questions imported before stay in your forms.')) return;
                void run(async () => {
                  await removeAsana(supabase);
                  setWorkspaces(null);
                  return 'Asana is disconnected.';
                });
              }}
            >
              Disconnect
            </button>
          </>
        )}
      </div>
    </section>
  );
}
