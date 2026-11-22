import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import {
  loadIntegrations,
  saveAiProvider,
  saveEmailSettings,
  saveServerSettings,
  saveSlack,
  saveUpguard,
  SLACK_EVENTS,
  testEmail,
  testSlack,
  type IntegrationsStatus,
  type SettingSource,
} from '../requests/api';
import { ReviewServicesCard } from './ReviewServicesCard';

// Admin → Integrations. Everything can be set here; values from the server's .env file are
// used only when nothing is set here. Secrets are write-only: the API stores them encrypted
// and never sends them back, so the page only shows whether one is saved.

const SOURCE_TEXT: Record<SettingSource, [string, string]> = {
  settings: ['Set here', 'approved'],
  env: ['From server file (.env)', 'review'],
  none: ['Not set', 'idle'],
};

export function SourceBadge({ source }: { source: SettingSource }) {
  const [text, tone] = SOURCE_TEXT[source] ?? SOURCE_TEXT.none;
  return (
    <span className="status-badge" data-tone={tone}>
      {text}
    </span>
  );
}

/**
 * A write-only secret input. When a secret is saved it shows "Saved" and a Replace button;
 * the typed value is kept only until the parent saves and clears it.
 */
export function SecretField({ label, saved, value, onChange, placeholder, hint }: { label: string; saved: boolean; value: string; onChange: (v: string) => void; placeholder?: string; hint?: string }) {
  const id = useId();
  const [replacing, setReplacing] = useState(false);
  const editing = !saved || replacing || value !== '';
  return (
    <div className="field secret-field">
      <label htmlFor={id}>{label}</label>
      {editing ? (
        <div className="secret-row">
          <input
            id={id}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          {saved && (
            <button
              type="button"
              className="button button-secondary button-small"
              onClick={() => {
                onChange('');
                setReplacing(false);
              }}
            >
              Keep saved
            </button>
          )}
        </div>
      ) : (
        <div className="secret-row">
          <span className="status-badge" data-tone="approved" id={id}>
            Saved
          </span>
          <button type="button" className="button button-secondary button-small" onClick={() => setReplacing(true)}>
            Replace<span className="visually-hidden"> {label}</span>
          </button>
        </div>
      )}
      {hint && <p className="field-hint">{hint}</p>}
    </div>
  );
}

function Card({ id, title, badge, children }: { id: string; title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <section className="integration-card" aria-labelledby={id}>
      <div className="review-card-head">
        <h3 id={id}>{title}</h3>
        {badge}
      </div>
      {children}
    </section>
  );
}

export function IntegrationsSection({ supabase }: { supabase: SupabaseClient }) {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [server, setServer] = useState({ publicApiUrl: '' });
  const [email, setEmail] = useState({ provider: 'off', from: '', resendApiKey: '', smtpUrl: '' });
  const [ai, setAi] = useState({ provider: 'off', processor: 'base', apiKey: '' });
  const [slack, setSlack] = useState({ enabled: false, events: [] as string[], webhookUrl: '' });
  const [upguard, setUpguard] = useState({ enabled: false, apiKey: '' });

  const reload = useCallback(async () => {
    try {
      const s = await loadIntegrations(supabase);
      setStatus(s);
      setServer({ publicApiUrl: s.server?.publicApiUrl ?? '' });
      setEmail({ provider: s.email?.provider ?? 'off', from: s.email?.from ?? '', resendApiKey: '', smtpUrl: '' });
      setAi({ provider: s.ai?.provider ?? 'off', processor: s.ai?.processor || 'base', apiKey: '' });
      setSlack({ enabled: s.slack.enabled, events: s.slack.events, webhookUrl: '' });
      setUpguard({ enabled: s.upguard.enabled, apiKey: '' });
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<unknown>, done: string) {
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

  const secret = (v: string) => (v.trim() ? v.trim() : undefined);

  return (
    <section className="card" aria-labelledby="integrations-heading">
      <h2 id="integrations-heading">Integrations</h2>
      <p className="field-hint">
        Everything the server needs can be set here. Keys, passwords and webhook addresses are stored encrypted on the server and
        are never shown again: to change one, choose Replace and type a new one. A value set here wins over the server’s .env file.
      </p>
      <FormError message={error} />
      {notice && (
        <p className="notice notice-approved" role="status">
          {notice}
        </p>
      )}
      {status && !status.encryptionReady && (
        <p className="notice">
          The server has no encryption key yet, so keys and passwords cannot be saved. Restart the API once: it creates the key in
          apps/api/.env by itself (on Cloudflare Workers, set INTEGRATION_ENCRYPTION_KEY as a secret). Settings without secrets
          still work.
        </p>
      )}
      {!status ? (
        <p role="status">Loading…</p>
      ) : (
        <div className="integration-cards">
          <Card id="int-server" title="Server address" badge={<SourceBadge source={status.server?.source ?? 'none'} />}>
            <p className="field-hint">
              The public address of the API. Review services use it to send their results back and to read request data.
            </p>
            <div className="field">
              <label htmlFor="server-url">API address</label>
              <input id="server-url" type="url" placeholder="https://api.your-company.com" value={server.publicApiUrl} onChange={(e) => setServer({ publicApiUrl: e.target.value })} />
            </div>
            <button type="button" className="button" disabled={busy} onClick={() => void run(() => saveServerSettings(supabase, { publicApiUrl: server.publicApiUrl.trim() }), 'Server address saved.')}>
              Save address
            </button>
          </Card>

          <Card id="int-email" title="Email" badge={<SourceBadge source={status.email?.source ?? 'none'} />}>
            <p className="field-hint">Invitations are sent by email. Without email, you get each invitation link to pass on yourself.</p>
            <div className="editor-row">
              <div className="field">
                <label htmlFor="email-provider">How to send</label>
                <select id="email-provider" value={email.provider} onChange={(e) => setEmail({ ...email, provider: e.target.value })}>
                  <option value="off">Off</option>
                  <option value="resend">Resend</option>
                  <option value="smtp">SMTP server (for example Gmail)</option>
                  <option value="log">Write to the server log (testing)</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="email-from">Sender</label>
                <input id="email-from" placeholder="[Product name] <invites@your-company.com>" value={email.from} onChange={(e) => setEmail({ ...email, from: e.target.value })} />
              </div>
            </div>
            {email.provider === 'resend' && (
              <SecretField label="Resend API key" saved={status.email?.provider === 'resend' && status.email.configured} value={email.resendApiKey} onChange={(v) => setEmail({ ...email, resendApiKey: v })} placeholder="re_…" />
            )}
            {email.provider === 'smtp' && (
              <SecretField
                label="SMTP address"
                saved={status.email?.provider === 'smtp' && status.email.configured}
                value={email.smtpUrl}
                onChange={(v) => setEmail({ ...email, smtpUrl: v })}
                placeholder="smtps://user%40gmail.com:app-password@smtp.gmail.com:465"
                hint="Contains the password. Write @ in the user name as %40."
              />
            )}
            <div className="form-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => saveEmailSettings(supabase, { provider: email.provider, from: email.from.trim(), resendApiKey: secret(email.resendApiKey), smtpUrl: secret(email.smtpUrl) }),
                    'Email settings saved.',
                  )
                }
              >
                Save email
              </button>
              <button type="button" className="button button-secondary" disabled={busy || email.provider === 'off'} onClick={() => void run(() => testEmail(supabase), 'Test email sent to your address.')}>
                Send a test email
              </button>
            </div>
          </Card>

          <Card id="int-ai" title="AI assistant" badge={<SourceBadge source={status.ai?.source ?? 'none'} />}>
            <p className="field-hint">Optional. Suggests vendor details and checks answers. The product works fully without it.</p>
            <div className="editor-row">
              <div className="field">
                <label htmlFor="ai-provider">Provider</label>
                <select id="ai-provider" value={ai.provider} onChange={(e) => setAi({ ...ai, provider: e.target.value })}>
                  <option value="off">Off</option>
                  <option value="parallel">Parallel</option>
                </select>
              </div>
              {ai.provider === 'parallel' && (
                <div className="field">
                  <label htmlFor="ai-processor">Depth</label>
                  <select id="ai-processor" value={ai.processor} onChange={(e) => setAi({ ...ai, processor: e.target.value })}>
                    <option value="lite">Lite (fast)</option>
                    <option value="base">Base</option>
                    <option value="core">Core (thorough, slower)</option>
                  </select>
                </div>
              )}
            </div>
            {ai.provider === 'parallel' && (
              <SecretField label="Parallel API key" saved={status.ai?.provider === 'parallel' && status.ai.configured} value={ai.apiKey} onChange={(v) => setAi({ ...ai, apiKey: v })} />
            )}
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() =>
                void run(() => saveAiProvider(supabase, { provider: ai.provider, ...(ai.provider === 'parallel' ? { processor: ai.processor } : {}), apiKey: secret(ai.apiKey) }), 'AI settings saved.')
              }
            >
              Save AI settings
            </button>
          </Card>

          <Card id="int-slack" title="Slack notifications" badge={<SourceBadge source={status.slack.configured ? 'settings' : 'none'} />}>
            <p className="field-hint">
              Posts short messages to a Slack channel through an incoming webhook (Slack → Apps → Incoming Webhooks). Messages hold
              the request name, the event and the risk level, never answers or files. Confidential requests are posted without
              their name.
            </p>
            <label className="choice">
              <input type="checkbox" checked={slack.enabled} onChange={(e) => setSlack({ ...slack, enabled: e.target.checked })} />
              Send notifications to Slack
            </label>
            <SecretField label="Webhook address" saved={status.slack.configured} value={slack.webhookUrl} onChange={(v) => setSlack({ ...slack, webhookUrl: v })} placeholder="https://hooks.slack.com/services/…" />
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
                onClick={() => void run(() => saveSlack(supabase, { enabled: slack.enabled, events: slack.events, ...(secret(slack.webhookUrl) ? { webhookUrl: secret(slack.webhookUrl) } : {}) }), 'Slack settings saved.')}
              >
                Save Slack
              </button>
              <button type="button" className="button button-secondary" disabled={busy || !status.slack.configured} onClick={() => void run(() => testSlack(supabase), 'Test message sent to Slack.')}>
                Send a test message
              </button>
            </div>
          </Card>

          <Card id="int-upguard" title="UpGuard vendor ratings" badge={<SourceBadge source={status.upguard.configured ? 'settings' : 'none'} />}>
            <p className="field-hint">Shows the vendor’s UpGuard security rating on the request page. Needs an UpGuard API key.</p>
            <label className="choice">
              <input type="checkbox" checked={upguard.enabled} onChange={(e) => setUpguard({ ...upguard, enabled: e.target.checked })} />
              Use UpGuard
            </label>
            <SecretField label="UpGuard API key" saved={status.upguard.configured} value={upguard.apiKey} onChange={(v) => setUpguard({ ...upguard, apiKey: v })} />
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => void run(() => saveUpguard(supabase, { enabled: upguard.enabled, ...(secret(upguard.apiKey) ? { apiKey: secret(upguard.apiKey) } : {}) }), 'UpGuard settings saved.')}
            >
              Save UpGuard
            </button>
          </Card>

          <ReviewServicesCard supabase={supabase} services={status.reviewServices ?? []} encryptionReady={status.encryptionReady} onChanged={reload} />
        </div>
      )}
    </section>
  );
}
