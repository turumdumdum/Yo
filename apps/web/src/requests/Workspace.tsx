import { ORG_ROLE_LABELS } from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { RequestStatusBadge, RiskBadge } from '../components/Badge';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { Admin } from '../org/Admin';
import { listMembers, type Member, type Membership } from '../org/api';
import { createDraft, listOpenQuestions, listRequests, loadRequest, type OpenQuestion, type RequestRow, type RequestSummary } from './api';
import { RequestDetail } from './RequestDetail';
import { RequestForm } from './RequestForm';
import { ReviewQueue } from './ReviewQueue';
import type { ReviewContext } from './StagePanel';

interface Props {
  supabase: SupabaseClient;
  user: User;
  membership: Membership;
  /** Reload the organization, for example after a settings change. */
  onOrganizationChanged: () => Promise<void> | void;
}

type Tab = 'requests' | 'reviews' | 'admin';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

export function Workspace({ supabase, user, membership, onOrganizationChanged }: Props) {
  const { role, organization } = membership;
  const isManager = role === 'org_admin' || role === 'process_manager';
  const canReview = isManager || role === 'reviewer';
  // The read-only auditor cannot start requests.
  const canCreate = role !== 'auditor';

  const [tab, setTab] = useState<Tab>('requests');
  const [requests, setRequests] = useState<RequestSummary[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  // Unanswered reviewer questions on my own requests.
  const [myQuestions, setMyQuestions] = useState<OpenQuestion[]>([]);
  const [open, setOpen] = useState<{ request: RequestRow; stageId?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [rows, people, questions] = await Promise.all([
        listRequests(supabase),
        listMembers(supabase, organization.id),
        listOpenQuestions(supabase),
      ]);
      setMyQuestions(questions.filter((q) => q.requests.requester_id === user.id));
      setRequests(rows);
      setMembers(people);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, organization.id, user.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const context: ReviewContext = { userId: user.id, isManager, allowSelfReview: organization.allow_self_review, members };

  async function openRequest(id: string, stageId?: string) {
    setBusy(true);
    try {
      const request = await loadRequest(supabase, id);
      if (!request) throw new Error('This request is no longer available.');
      setOpen({ request, stageId });
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
      await openRequest(await createDraft(supabase, organization.id));
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  }

  function close() {
    setOpen(null);
    void reload();
  }

  if (open && open.request.status === 'draft' && open.request.requester_id === user.id) {
    return (
      <RequestForm
        key={open.request.id}
        supabase={supabase}
        requestId={open.request.id}
        initialAnswers={open.request.answers}
        onSubmitted={() => void openRequest(open.request.id)}
        onClose={close}
      />
    );
  }
  if (open) {
    return (
      <RequestDetail
        key={open.request.id}
        supabase={supabase}
        request={open.request}
        context={context}
        initialStageId={open.stageId}
        onClose={close}
      />
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'requests', label: 'Requests' },
    ...(canReview ? [{ id: 'reviews' as const, label: 'To review' }] : []),
    ...(role === 'org_admin' ? [{ id: 'admin' as const, label: 'Admin' }] : []),
  ];

  return (
    <>
      <p className="org-line">
        <strong>{organization.name}</strong> · {ORG_ROLE_LABELS[role]} · {user.email}
      </p>
      {tabs.length > 1 && (
        <nav aria-label="Sections" className="tabs">
          {tabs.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
      )}
      <FormError message={error} />

      {tab === 'reviews' && <ReviewQueue supabase={supabase} context={context} onOpen={(id, stageId) => void openRequest(id, stageId)} />}

      {tab === 'admin' && (
        <Admin
          supabase={supabase}
          organization={organization}
          userId={user.id}
          members={members}
          onChanged={async () => {
            await Promise.all([reload(), onOrganizationChanged()]);
          }}
        />
      )}

      {tab === 'requests' && myQuestions.length > 0 && (
        <section className="action-required" aria-labelledby="action-list-heading">
          <h2 id="action-list-heading">Action required from you</h2>
          <p>Reviewers are waiting for your answer:</p>
          <ul className="plain-list">
            {[...new Map(myQuestions.map((q) => [q.request_id, q])).values()].map((q) => (
              <li key={q.request_id}>
                <button type="button" className="link-button" disabled={busy} onClick={() => void openRequest(q.request_id)}>
                  {q.requests.service_name || 'Untitled request'}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === 'requests' && (
        <section className="card" aria-labelledby="requests-heading">
          <div className="card-head">
            <h2 id="requests-heading">Requests</h2>
            {canCreate && (
              <button type="button" className="button" disabled={busy} onClick={() => void startRequest()}>
                New request
              </button>
            )}
          </div>
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
      )}
    </>
  );
}
