import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { RequestStatusBadge, RiskBadge } from '../components/Badge';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { createDraft, listRequests, loadRequest, type RequestRow, type RequestSummary } from './api';
import { RequestDetail } from './RequestDetail';
import { RequestForm } from './RequestForm';

interface Props {
  supabase: SupabaseClient;
  user: User;
  orgId: string;
  /** The read-only auditor cannot start requests. */
  canCreate: boolean;
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

export function Workspace({ supabase, user, orgId, canCreate }: Props) {
  const [requests, setRequests] = useState<RequestSummary[] | null>(null);
  const [open, setOpen] = useState<RequestRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setRequests(await listRequests(supabase));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function openRequest(id: string) {
    setBusy(true);
    try {
      const request = await loadRequest(supabase, id);
      if (!request) throw new Error('This request is no longer available.');
      setOpen(request);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function startRequest() {
    setBusy(true);
    try {
      await openRequest(await createDraft(supabase, orgId));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  function close() {
    setOpen(null);
    void reload();
  }

  if (open && open.status === 'draft' && open.requester_id === user.id) {
    return (
      <RequestForm
        key={open.id}
        supabase={supabase}
        requestId={open.id}
        initialAnswers={open.answers}
        onSubmitted={() => void openRequest(open.id)}
        onClose={close}
      />
    );
  }
  if (open) return <RequestDetail request={open} onClose={close} />;

  return (
    <section className="card" aria-labelledby="requests-heading">
      <div className="card-head">
        <h2 id="requests-heading">Requests</h2>
        {canCreate && (
          <button type="button" className="button" disabled={busy} onClick={() => void startRequest()}>
            New request
          </button>
        )}
      </div>
      <FormError message={error} />
      {requests === null ? (
        <p role="status">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="empty">No requests yet.{canCreate && ' Start one with “New request”.'}</p>
      ) : (
        <ul className="request-list">
          {requests.map((request) => (
            <li key={request.id}>
              <button type="button" className="request-row" disabled={busy} onClick={() => void openRequest(request.id)}>
                <span className="request-title">{request.service_name || 'Untitled request'}</span>
                <span className="request-meta">
                  {request.request_type ? `${request.request_type} · ` : ''}
                  {request.status === 'draft'
                    ? `Edited ${formatDate(request.updated_at)}`
                    : `Submitted ${formatDate(request.submitted_at ?? request.updated_at)}`}
                  {request.requester_id === user.id ? ' · by you' : ''}
                </span>
                <span className="badges">
                  <RequestStatusBadge status={request.status} />
                  {request.risk_tier && <RiskBadge tier={request.risk_tier} />}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
