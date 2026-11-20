import { defaultWorkflowSettings, ORG_ROLE_LABELS, parseWorkflowSettings } from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { Admin } from '../org/Admin';
import { listMembers, type Member, type Membership } from '../org/api';
import {
  createDraft,
  listOpenQuestions,
  listOpenStages,
  listRequests,
  loadRequest,
  type OpenQuestion,
  type RequestRow,
  type RequestSummary,
} from './api';
import { HowItWorks } from './HowItWorks';
import { RequestList } from './RequestList';
import { RequestDetail } from './RequestDetail';
import { RequestForm } from './RequestForm';
import { ReviewQueue } from './ReviewQueue';
import type { ReviewContext } from './StagePanel';
import { loadWorkflowSettings } from './api';

interface Props {
  supabase: SupabaseClient;
  user: User;
  membership: Membership;
  /** Reload the organization, for example after a settings change. */
  onOrganizationChanged: () => Promise<void> | void;
}

type Tab = 'requests' | 'reviews' | 'admin';

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
  // Open review stages waiting for this person, for the count on the tab.
  const [toReview, setToReview] = useState(0);
  const [open, setOpen] = useState<{ request: RequestRow; stageId?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [rows, people, questions, stages] = await Promise.all([
        listRequests(supabase),
        listMembers(supabase, organization.id),
        listOpenQuestions(supabase),
        canReview ? listOpenStages(supabase) : Promise.resolve([]),
      ]);
      // Same rule as the review queue: assigned to me, or unassigned for managers; not my own requests.
      setToReview(
        stages.filter(
          (st) =>
            (st.reviewer_id === user.id || (isManager && st.reviewer_id === null)) &&
            (organization.allow_self_review || st.requests.requester_id !== user.id),
        ).length,
      );
      setMyQuestions(questions.filter((q) => q.requests.requester_id === user.id));
      setRequests(rows);
      setMembers(people);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, organization.id, organization.allow_self_review, user.id, canReview, isManager]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Review guides by stage, from the organization's review settings (or the standard ones).
  const [guides, setGuides] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(defaultWorkflowSettings()).map(([k, v]) => [k, v.guide])));
  useEffect(() => {
    let cancelled = false;
    loadWorkflowSettings(supabase, organization.id).then(
      (stored) => {
        if (cancelled || stored === null) return;
        const parsed = parseWorkflowSettings(stored);
        if ('settings' in parsed) setGuides(Object.fromEntries(Object.entries(parsed.settings).map(([k, v]) => [k, v.guide])));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [supabase, organization.id]);
  const context: ReviewContext = { userId: user.id, isManager, allowSelfReview: organization.allow_self_review, members, guides };

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
        userId={user.id}
        initialAnswers={open.request.answers}
        form={open.request.form}
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

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'requests', label: 'Requests', count: myQuestions.length || undefined },
    ...(canReview ? [{ id: 'reviews' as const, label: 'To review', count: toReview || undefined }] : []),
    ...(role === 'org_admin' ? [{ id: 'admin' as const, label: 'Admin' }] : []),
  ];
  const awaitingMyAnswer = new Set(myQuestions.map((q) => q.request_id));
  const nameOf = (userId: string) => members.find((m) => m.user_id === userId)?.email ?? 'a former member';

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
              {t.count !== undefined && (
                <span className="tab-count" aria-label={`, ${t.count} waiting`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </nav>
      )}
      <FormError message={error} />

      {tab === 'reviews' && (
        <ReviewQueue supabase={supabase} context={context} onOpen={(id, stageId) => void openRequest(id, stageId)} />
      )}

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
            <h2 id="requests-heading">Vendors and requests</h2>
            {canCreate && requests !== null && requests.length > 0 && (
              <button type="button" className="button" disabled={busy} onClick={() => void startRequest()}>
                + New request
              </button>
            )}
          </div>
          {requests === null ? (
            <p role="status">Loading…</p>
          ) : requests.length === 0 ? (
            <div className="empty-state">
              <p>{canCreate ? 'You have no requests yet.' : 'There are no requests to look at yet.'}</p>
              {canCreate && (
                <button type="button" className="button button-large" disabled={busy} onClick={() => void startRequest()}>
                  Start a new request
                </button>
              )}
            </div>
          ) : (
            <RequestList
              requests={requests}
              userId={user.id}
              awaitingMyAnswer={awaitingMyAnswer}
              nameOf={nameOf}
              busy={busy}
              onOpen={(id) => void openRequest(id)}
            />
          )}
        </section>
      )}

      {tab === 'requests' && requests !== null && <HowItWorks compact={requests.length > 0} />}
    </>
  );
}
