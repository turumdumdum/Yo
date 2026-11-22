import { isServiceUrl } from '@app/shared';
import { useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import {
  createReviewService,
  deleteReviewService,
  externalSpecUrl,
  listDeliveries,
  rotateReviewServiceSecret,
  testReviewService,
  updateReviewService,
  type Delivery,
  type ReviewServiceInput,
  type ReviewServiceStatus,
} from '../requests/api';

// Review services: each review stage can run in its own microservice. This card lists the
// services, adds and edits them, tests the connection, shows the delivery log and explains
// how to build a service. The signing secret is shown once, right after it is created.

const formatTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** Link to the in-app connection guide and the machine-readable format. */
export function ConnectGuideLink() {
  const spec = externalSpecUrl();
  return (
    <p className="field-hint">
      How to connect a service: Admin → Integrations → Review services → “How to connect a service”.
      {spec && (
        <>
          {' '}
          <a href={spec} target="_blank" rel="noopener noreferrer">
            Download the format (OpenAPI)
          </a>
          .
        </>
      )}
    </p>
  );
}

function ConnectGuide() {
  const spec = externalSpecUrl();
  return (
    <details className="format-help connect-guide">
      <summary>How to connect a service</summary>
      <ol>
        <li>
          <strong>Add the service here</strong> with the HTTPS address that receives our events. Copy the signing secret: it is
          shown once.
        </li>
        <li>
          <strong>Choose the service for a review</strong>: Admin → Reviews → the review → “In an external service”.
        </li>
        <li>
          <strong>Receive events.</strong> When a request needs that review, we POST <code>stage.started</code> to the address.
          With “Send the data” it holds the answers; with “Service reads the data from us” it holds only ids and a link, and the
          service fetches the data with a signed GET. The service keeps its own review data in its own database.
        </li>
        <li>
          <strong>Report the result</strong> with a signed POST to <code>callback.status_url</code>:{' '}
          <code>in_review</code>, <code>waiting_for_requester</code>, <code>approved</code>, <code>approved_with_conditions</code> or{' '}
          <code>rejected</code>. Use “Test connection” to check the address.
        </li>
      </ol>
      <p>
        <strong>Signature</strong> (both directions): header <code>X-Signature: t=&lt;unix seconds&gt;,v1=&lt;hex&gt;</code> where{' '}
        <code>hex = HMAC-SHA256(secret, t + "." + raw body)</code>. Refuse messages older than 5 minutes, and treat a repeated{' '}
        <code>event_id</code> as already done. We also send <code>X-Service-Id</code>.
      </p>
      <pre>{`{
  "type": "stage.started",
  "event_id": "…",
  "data_mode": "pull",
  "request": { "id": "…" },
  "stage": { "id": "…", "name": "Security review", "due_at": "…" },
  "callback": { "status_url": "…/status", "stage_url": "…" }
}`}</pre>
      <p>
        {spec && (
          <>
            <a href={spec} target="_blank" rel="noopener noreferrer">
              Download the format (OpenAPI)
            </a>
            {' · '}
          </>
        )}
        Full guide with examples: <code>docs/external-review.md</code> in the repository.
      </p>
    </details>
  );
}

function SecretOnce({ secret, onClose }: { secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice secret-once" role="status">
      <p>
        <strong>Signing secret</strong> — copy it into the service now. It is not shown again; if it is lost, create a new one.
      </p>
      <p>
        <code className="secret">{secret}</code>
      </p>
      <div className="form-actions">
        <button
          type="button"
          className="button button-small"
          onClick={() =>
            void navigator.clipboard.writeText(secret).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? 'Copied' : 'Copy secret'}
        </button>
        <button type="button" className="button button-secondary button-small" onClick={onClose}>
          I have saved it
        </button>
      </div>
    </div>
  );
}

function ServiceForm({ initial, onSave, onCancel }: { initial: ReviewServiceInput; onSave: (v: ReviewServiceInput) => Promise<void>; onCancel: () => void }) {
  const id = useId();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="service-form">
      <div className="editor-row">
        <div className="field">
          <label htmlFor={`${id}-name`}>Name</label>
          <input id={`${id}-name`} maxLength={60} placeholder="For example Security review service" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-url`}>Address that receives our events</label>
          <input id={`${id}-url`} type="url" placeholder="https://review.your-company.com/events" value={v.url} onChange={(e) => setV({ ...v, url: e.target.value })} />
        </div>
      </div>
      <fieldset className="field">
        <legend>How does the service get the request data?</legend>
        <div className="choices">
          <label className="choice">
            <input type="radio" name={`${id}-mode`} checked={v.dataMode === 'push'} onChange={() => setV({ ...v, dataMode: 'push' })} />
            <span>
              <strong>Send the data</strong> — the event carries the answers the review needs.
            </span>
          </label>
          <label className="choice">
            <input type="radio" name={`${id}-mode`} checked={v.dataMode === 'pull'} onChange={() => setV({ ...v, dataMode: 'pull' })} />
            <span>
              <strong>Service reads the data from us</strong> — the event carries only ids and a link; the service fetches the data
              with a signed request when it needs it.
            </span>
          </label>
        </div>
      </fieldset>
      <label className="choice">
        <input type="checkbox" checked={v.sendAllAnswers} onChange={(e) => setV({ ...v, sendAllAnswers: e.target.checked })} />
        Include every answer, not only the ones relevant to the review (names of people are never sent)
      </label>
      <label className="choice">
        <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} />
        Active: send new reviews to this service
      </label>
      <FormError message={error} />
      <div className="form-actions">
        <button
          type="button"
          className="button button-small"
          disabled={busy}
          onClick={() => {
            if (!v.name.trim()) return setError('Give the service a name.');
            if (!isServiceUrl(v.url.trim())) return setError('The address must start with https://. Local and private network addresses work only when the server allows them (ALLOW_LOCAL_SERVICE_URLS).');
            setBusy(true);
            setError(null);
            onSave({ ...v, name: v.name.trim(), url: v.url.trim() })
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Saving…' : 'Save service'}
        </button>
        <button type="button" className="button button-secondary button-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function DeliveryLog({ supabase, serviceId }: { supabase: SupabaseClient; serviceId: string }) {
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setError(null);
    listDeliveries(supabase, serviceId).then(setRows, (e: unknown) => setError(errorMessage(e)));
  };
  return (
    <details
      className="delivery-log"
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open && rows === null) load();
      }}
    >
      <summary>Delivery log</summary>
      <FormError message={error} />
      {rows === null ? (
        !error && <p role="status">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty">Nothing sent yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Event</th>
                <th scope="col">Status</th>
                <th scope="col">Attempts</th>
                <th scope="col">Created</th>
                <th scope="col">Last error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const state = r.delivered_at ? ['Delivered', 'approved'] : r.failed_at ? ['Failed', 'rejected'] : ['Retrying', 'waiting'];
                return (
                  <tr key={r.id}>
                    <td>{r.type}</td>
                    <td>
                      <span className="status-badge" data-tone={state[1]}>
                        {state[0]}
                      </span>
                      {!r.delivered_at && !r.failed_at && r.next_attempt_at && <span className="stage-meta"> next {formatTime(r.next_attempt_at)}</span>}
                    </td>
                    <td>{r.attempts}</td>
                    <td>{formatTime(r.created_at)}</td>
                    <td>{r.last_error ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <button type="button" className="link-button" onClick={load}>
        Refresh
      </button>
    </details>
  );
}

const EMPTY: ReviewServiceInput = { name: '', url: '', dataMode: 'push', sendAllAnswers: false, enabled: true };

export function ReviewServicesCard({ supabase, services, encryptionReady, onChanged }: { supabase: SupabaseClient; services: ReviewServiceStatus[]; encryptionReady: boolean; onChanged: () => Promise<void> | void }) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [secret, setSecret] = useState<{ service: string; value: string } | null>(null);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="integration-card" aria-labelledby="int-services">
      <div className="review-card-head">
        <h3 id="int-services">Review services</h3>
        <span className="status-badge" data-tone={services.length ? 'approved' : 'idle'}>
          {services.length} connected
        </span>
      </div>
      <p className="field-hint">
        A review can run in its own service, for example the security review at a security team’s tool. Here you only see its
        status; the service does the review and keeps its own data.
      </p>
      <ConnectGuide />
      <FormError message={error} />
      {secret && <SecretOnce secret={secret.value} onClose={() => setSecret(null)} />}

      {services.length > 0 && (
        <ul className="config-list service-list">
          {services.map((s) => (
            <li key={s.id} className="config-item">
              <div className="config-head">
                <strong>{s.name}</strong>
                <span className="badges">
                  <span className="status-badge" data-tone={s.enabled ? 'approved' : 'idle'}>
                    {s.enabled ? 'Active' : 'Paused'}
                  </span>
                  <span className="status-badge" data-tone={s.hasSecret ? 'review' : 'waiting'}>
                    {s.hasSecret ? 'Secret saved' : 'No secret'}
                  </span>
                </span>
              </div>
              <p className="stage-meta">
                {s.url} · {s.dataMode === 'push' ? 'Sends the data' : 'Service reads the data from us'} · key <code>{s.id}</code>
              </p>
              <p className="stage-meta">Used by: {s.usedBy.length ? s.usedBy.join(', ') : 'no review yet (choose it in Admin → Reviews)'}</p>
              {tests[s.id] && (
                <p className="field-hint" role="status">
                  {tests[s.id]}
                </p>
              )}
              <div className="question-actions">
                <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => setEditing(editing === s.id ? null : s.id)}>
                  {editing === s.id ? 'Close' : 'Edit'}
                  <span className="visually-hidden"> {s.name}</span>
                </button>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      setTests((t) => ({ ...t, [s.id]: 'Testing…' }));
                      const r = await testReviewService(supabase, s.id);
                      setTests((t) => ({
                        ...t,
                        [s.id]: r.ok ? `Connection works: answered ${r.status ?? ''} in ${r.ms ?? '?'} ms.` : `Connection failed${r.status ? ` (${r.status})` : ''}: ${r.error ?? 'no answer'}.`,
                      }));
                    })
                  }
                >
                  Test connection<span className="visually-hidden"> {s.name}</span>
                </button>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={busy || !encryptionReady}
                  onClick={() => {
                    if (!window.confirm(`Create a new signing secret for “${s.name}”? The current one stops working at once.`)) return;
                    void run(async () => {
                      const r = await rotateReviewServiceSecret(supabase, s.id);
                      setSecret({ service: s.id, value: r.secret });
                    });
                  }}
                >
                  New secret<span className="visually-hidden"> for {s.name}</span>
                </button>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete “${s.name}”?`)) void run(() => deleteReviewService(supabase, s.id).then(() => undefined));
                  }}
                >
                  Delete<span className="visually-hidden"> {s.name}</span>
                </button>
              </div>
              {editing === s.id && (
                <ServiceForm
                  initial={{ name: s.name, url: s.url, dataMode: s.dataMode, sendAllAnswers: s.sendAllAnswers, enabled: s.enabled }}
                  onCancel={() => setEditing(null)}
                  onSave={async (v) => {
                    await updateReviewService(supabase, s.id, v);
                    setEditing(null);
                    await onChanged();
                  }}
                />
              )}
              <DeliveryLog supabase={supabase} serviceId={s.id} />
            </li>
          ))}
        </ul>
      )}

      {editing === 'new' ? (
        <ServiceForm
          initial={EMPTY}
          onCancel={() => setEditing(null)}
          onSave={async (v) => {
            const r = await createReviewService(supabase, v);
            setEditing(null);
            setSecret({ service: r.service.id, value: r.secret });
            await onChanged();
          }}
        />
      ) : (
        <button type="button" className="button button-secondary" disabled={!encryptionReady} onClick={() => setEditing('new')}>
          + Add a review service
        </button>
      )}
      {!encryptionReady && <p className="field-hint">Adding a service needs the server’s encryption key (see the note above).</p>}
    </section>
  );
}
