import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { loadIntegrations, saveExternal, saveSlack, saveUpguard, SLACK_EVENTS, testSlack, type IntegrationsStatus } from '../requests/api';

const SavedTag = ({ on }: { on: boolean }) => (
  <span className="status-badge" data-tone={on ? 'approved' : 'idle'}>
    {on ? 'Secret saved' : 'No secret yet'}
  </span>
);

/** Admin: Slack notifications, UpGuard ratings and an external review service. Secrets are write-only. */
export function IntegrationsSection({ supabase }: { supabase: SupabaseClient }) {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [slack, setSlack] = useState({ enabled: false, events: [] as string[], webhookUrl: '' });
  const [upguard, setUpguard] = useState({ enabled: false, apiKey: '' });
  const [external, setExternal] = useState({ enabled: false, name: '', outboundUrl: '', sendAllAnswers: false });
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    try {
      const s = await loadIntegrations(supabase);
      setStatus(s);
      setSlack({ enabled: s.slack.enabled, events: s.slack.events, webhookUrl: '' });
      setUpguard({ enabled: s.upguard.enabled, apiKey: '' });
      setExternal({ enabled: s.external.enabled, name: s.external.name, outboundUrl: s.external.outboundUrl, sendAllAnswers: s.external.sendAllAnswers });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<void>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(done);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="integrations-heading">
      <h2 id="integrations-heading">Integrations</h2>
      <p className="field-hint">
        Connect other services. Keys and webhook addresses are stored encrypted on the server and are never shown again after
        saving: to change one, type a new one.
      </p>
      <FormError message={error} />
      {notice && (
        <p className="notice notice-approved" role="status">
          {notice}
        </p>
      )}
      {status && !status.encryptionReady && (
        <p className="notice">
          The server has no encryption key yet (INTEGRATION_ENCRYPTION_KEY in apps/api/.env), so keys cannot be saved. Settings
          without secrets still work.
        </p>
      )}
      {!status ? (
        <p role="status">Loading…</p>
      ) : (
        <div className="integration-cards">
          <section className="integration-card" aria-labelledby="int-slack">
            <div className="review-card-head">
              <h3 id="int-slack">Slack notifications</h3>
              <SavedTag on={status.slack.configured} />
            </div>
            <p className="field-hint">
              Posts short messages to a Slack channel through an incoming webhook (Slack → Apps → Incoming Webhooks). Messages
              hold the request name, the event and the risk level, never answers or files. Confidential requests are posted
              without their name.
            </p>
            <label className="choice">
              <input type="checkbox" checked={slack.enabled} onChange={(e) => setSlack({ ...slack, enabled: e.target.checked })} />
              Send notifications to Slack
            </label>
            <div className="field">
              <label htmlFor="slack-url">Webhook address {status.slack.configured && <span className="optional">(leave empty to keep the saved one)</span>}</label>
              <input id="slack-url" type="password" autoComplete="off" placeholder="https://hooks.slack.com/services/…" value={slack.webhookUrl} onChange={(e) => setSlack({ ...slack, webhookUrl: e.target.value })} />
            </div>
            <fieldset className="field">
              <legend>Which events</legend>
              <div className="choices">
                {SLACK_EVENTS.map((ev) => (
                  <label key={ev.key} className="choice">
                    <input
                      type="checkbox"
                      checked={slack.events.includes(ev.key)}
                      onChange={(e) => setSlack({ ...slack, events: e.target.checked ? [...slack.events, ev.key] : slack.events.filter((k) => k !== ev.key) })}
                    />
                    {ev.label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="form-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => saveSlack(supabase, { enabled: slack.enabled, events: slack.events, ...(slack.webhookUrl.trim() ? { webhookUrl: slack.webhookUrl.trim() } : {}) }),
                    'Slack settings saved.',
                  )
                }
              >
                Save Slack settings
              </button>
              <button type="button" className="button button-secondary" disabled={busy || !status.slack.configured} onClick={() => void run(() => testSlack(supabase), 'A test message was sent to Slack.')}>
                Send a test message
              </button>
            </div>
          </section>

          <section className="integration-card" aria-labelledby="int-upguard">
            <div className="review-card-head">
              <h3 id="int-upguard">UpGuard vendor ratings</h3>
              <SavedTag on={status.upguard.configured} />
            </div>
            <p className="field-hint">
              Lets reviewers fetch the vendor’s UpGuard security rating from the vendor website in the request. Only the
              website’s host name is sent to UpGuard. Needs an UpGuard API key from your UpGuard account.
            </p>
            <label className="choice">
              <input type="checkbox" checked={upguard.enabled} onChange={(e) => setUpguard({ ...upguard, enabled: e.target.checked })} />
              Use UpGuard
            </label>
            <div className="field">
              <label htmlFor="upguard-key">API key {status.upguard.configured && <span className="optional">(leave empty to keep the saved one)</span>}</label>
              <input id="upguard-key" type="password" autoComplete="off" value={upguard.apiKey} onChange={(e) => setUpguard({ ...upguard, apiKey: e.target.value })} />
            </div>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void run(() => saveUpguard(supabase, { enabled: upguard.enabled, ...(upguard.apiKey.trim() ? { apiKey: upguard.apiKey.trim() } : {}) }), 'UpGuard settings saved.')}
            >
              Save UpGuard settings
            </button>
          </section>

          <section className="integration-card" aria-labelledby="int-external">
            <div className="review-card-head">
              <h3 id="int-external">External review service</h3>
              <SavedTag on={status.external.configured} />
            </div>
            <p className="field-hint">
              Run a review, for example the security review, in another tool. When such a review starts, this app sends a signed
              JSON message to your address; the other tool reports the status back to this app’s API, signed with the same
              secret. The message format, signature and retries are described in docs/external-review.md in the repository.
              Choose which reviews happen there in Admin → Reviews.
            </p>
            <label className="choice">
              <input type="checkbox" checked={external.enabled} onChange={(e) => setExternal({ ...external, enabled: e.target.checked })} />
              Use an external review service
            </label>
            <div className="editor-row">
              <div className="field">
                <label htmlFor="ext-name">Name shown to people</label>
                <input id="ext-name" maxLength={80} placeholder="For example ServiceNow VRM" value={external.name} onChange={(e) => setExternal({ ...external, name: e.target.value })} />
              </div>
              <div className="field">
                <label htmlFor="ext-url">Address that receives reviews (https)</label>
                <input id="ext-url" type="url" placeholder="https://vrm.example.com/hooks/vendor-reviews" value={external.outboundUrl} onChange={(e) => setExternal({ ...external, outboundUrl: e.target.value })} />
              </div>
            </div>
            <label className="choice">
              <input type="checkbox" checked={external.sendAllAnswers} onChange={(e) => setExternal({ ...external, sendAllAnswers: e.target.checked })} />
              Send all answers (otherwise only the answers relevant to that review). Names of owners are never sent.
            </label>
            {secret && (
              <div className="notice" role="status">
                <p>
                  <strong>Signing secret — copy it now, it is not shown again.</strong> Store it only in the other tool’s secret
                  settings.
                </p>
                <p>
                  <code className="secret">{secret}</code>
                </p>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  onClick={() => {
                    void navigator.clipboard.writeText(secret).then(
                      () => setCopied(true),
                      () => setError('Could not copy. Select the secret and copy it manually.'),
                    );
                  }}
                >
                  {copied ? 'Copied' : 'Copy secret'}
                </button>
              </div>
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await saveExternal(supabase, { ...external, rotateSecret: !status.external.configured });
                    if (r.secret) {
                      setSecret(r.secret);
                      setCopied(false);
                    }
                  }, 'External review settings saved.')
                }
              >
                Save external review settings
              </button>
              {status.external.configured && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm('Create a new signing secret? The old one stops working at once; update the other tool right away.')) return;
                    void run(async () => {
                      const r = await saveExternal(supabase, { ...external, rotateSecret: true });
                      if (r.secret) {
                        setSecret(r.secret);
                        setCopied(false);
                      }
                    }, 'A new signing secret was created.');
                  }}
                >
                  New signing secret
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
