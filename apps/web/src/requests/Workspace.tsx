import { defaultWorkflowSettings, ORG_ROLE_LABELS, parseWorkflowSettings } from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { Admin } from '../org/Admin';
import { inReviewScope, listMembers, previewVisibleRequests, type Member, type Membership } from '../org/api';
import {
  createDraft,
  listOpenQuestions,
  listOpenStages,
  listRequests,
  loadRequest,
  type OpenQuestion,
  type QueueItem,
  type RequestRow,
  type RequestSummary,
  listReviewServiceNames,
} from './api';
import { HowItWorks } from './HowItWorks';
import { RequestList } from './RequestList';
import { RequestDetail } from './RequestDetail';
import { RequestForm } from './RequestForm';
import { ReviewQueue } from './ReviewQueue';
import { VendorCatalog } from '../vendors/VendorCatalog';
import { Metrics } from '../metrics/Metrics';
import type { ReviewContext } from './StagePanel';
import { loadWorkflowSettings } from './api';

interface Props {
  supabase: SupabaseClient;
  user: User;
  membership: Membership;
  /** Reload the organization, for example after a settings change. */
  onOrganizationChanged: () => Promise<void> | void;
}

/**
 * Workspace sections. Extra sections (for example 'catalog' for the vendor catalog and
 * 'metrics') are added to this union and to the `tabs` array below.
 */
type Tab = 'requests' | 'catalog' | 'metrics' | 'reviews' | 'admin';

/** "View as" preview: the member being previewed and the requests they can see. */
interface Preview {
  member: Member;
  visible: Set<string>;
}

const isManagerRole = (r: string) => r === 'org_admin' || r === 'process_manager';

export function Workspace({ supabase, user, membership, onOrganizationChanged }: Props) {
  const { organization } = membership;
  const ownCanReview = isManagerRole(membership.role) || membership.role === 'reviewer';

  // Preview lives in component state only: the session and token never change.
  const [preview, setPreview] = useState<Preview | null>(null);
  const readOnly = preview !== null;
  const role = preview ? preview.member.role : membership.role;
  const viewerId = preview ? preview.member.user_id : user.id;
  const viewerEmail = preview ? preview.member.email : user.email;
  const isManager = isManagerRole(role);
  const canReview = isManager || role === 'reviewer';
  // The read-only auditor cannot start requests; nobody can in a preview.
  const canCreate = role !== 'auditor' && !readOnly;

  const [tab, setTab] = useState<Tab>('requests');
  const [allRequests, setAllRequests] = useState<RequestSummary[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [allQuestions, setAllQuestions] = useState<OpenQuestion[]>([]);
  const [allStages, setAllStages] = useState<QueueItem[]>([]);
  const [open, setOpen] = useState<{ request: RequestRow; stageId?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickedId, setPickedId] = useState('');

  const reload = useCallback(async () => {
    try {
      const [rows, people, questions, stages] = await Promise.all([
        listRequests(supabase),
        listMembers(supabase, organization.id),
        listOpenQuestions(supabase),
        ownCanReview ? listOpenStages(supabase) : Promise.resolve([]),
      ]);
      setAllRequests(rows);
      setMembers(people);
      setAllQuestions(questions);
      setAllStages(stages);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, organization.id, ownCanReview]);

  const reviewScope = preview ? preview.member.review_scope : (members.find((m) => m.user_id === user.id)?.review_scope ?? null);
  const seen = (requestId: string) => !preview || preview.visible.has(requestId);
  // In a preview, only what the previewed member can see (ids from the server, filtered against our rows).
  const requests = allRequests && allRequests.filter((r) => seen(r.id));
  // Unanswered reviewer questions on the viewer's own requests.
  const myQuestions = allQuestions.filter((q) => q.requests.requester_id === viewerId && seen(q.request_id));
  // Same rule as the review queue: assigned to me, or unassigned for managers; in my review scope; not my own requests.
  const toReview = canReview
    ? allStages.filter(
        (st) =>
          !st.external &&
          seen(st.request_id) &&
          inReviewScope(reviewScope, st.name) &&
          (st.reviewer_id === viewerId || (isManager && st.reviewer_id === null)) &&
          (organization.allow_self_review || st.requests.requester_id !== viewerId),
      ).length
    : 0;

  async function startPreview(member: Member) {
    setBusy(true);
    try {
      const visible = await previewVisibleRequests(supabase, member.user_id);
      setOpen(null);
      setTab('requests');
      setPickerOpen(false);
      setPreview({ member, visible });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function exitPreview() {
    setPreview(null);
    setOpen(null);
    setTab('requests');
  }

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
  // Names of review services, to show which service handles an external review.
  const [reviewServices, setReviewServices] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    listReviewServiceNames(supabase).then(
      (rows) => !cancelled && setReviewServices(Object.fromEntries(rows.map((r) => [r.id, r.name]))),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [supabase]);
  const context: ReviewContext = {
    userId: viewerId,
    isManager,
    allowSelfReview: organization.allow_self_review,
    members,
    guides,
    reviewServices,
    reviewScope,
    readOnly,
    visibleRequestIds: preview?.visible ?? null,
  };

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

  const banner = preview && (
    <div className="preview-banner" role="status">
      <span>
        Viewing as <strong>{preview.member.email ?? preview.member.user_id}</strong> ({ORG_ROLE_LABELS[preview.member.role]}) — read-only
        preview
      </span>
      <button type="button" className="button button-small" onClick={exitPreview}>
        Exit preview
      </button>
    </div>
  );

  if (open && !readOnly && open.request.status === 'draft' && open.request.requester_id === user.id) {
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
      <>
        {banner}
        <RequestDetail
          key={open.request.id}
          supabase={supabase}
          request={open.request}
          context={context}
          initialStageId={open.stageId}
          onClose={close}
        />
      </>
    );
  }

  const seesMetrics = role === 'org_admin' || role === 'process_manager' || role === 'auditor';
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'requests', label: 'Requests', count: myQuestions.length || undefined },
    { id: 'catalog', label: 'Vendor catalog' },
    ...(seesMetrics ? [{ id: 'metrics' as const, label: 'Metrics' }] : []),
    ...(canReview ? [{ id: 'reviews' as const, label: 'To review', count: toReview || undefined }] : []),
    ...(role === 'org_admin' ? [{ id: 'admin' as const, label: 'Admin' }] : []),
  ];
  const awaitingMyAnswer = new Set(myQuestions.map((q) => q.request_id));
  const nameOf = (userId: string) => members.find((m) => m.user_id === userId)?.email ?? 'a former member';
  const canPreview = membership.role === 'org_admin' && !readOnly;
  const others = members.filter((m) => m.user_id !== user.id);

  return (
    <>
      <div className="workspace-bar">
        {banner}
        <div className="org-line">
          <span>
            <strong>{organization.name}</strong> · {ORG_ROLE_LABELS[role]} · {viewerEmail}
          </span>
          {canPreview && others.length > 0 && (
            <span className="view-as">
              {!pickerOpen ? (
                <button type="button" className="button button-secondary button-small" onClick={() => setPickerOpen(true)}>
                  View as…
                </button>
              ) : (
                <form
                  className="view-as-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const member = others.find((m) => m.user_id === pickedId);
                    if (member) void startPreview(member);
                  }}
                >
                  <label htmlFor="view-as-member">See the workspace as</label>
                  <select id="view-as-member" className="role-select" value={pickedId} onChange={(e) => setPickedId(e.target.value)}>
                    <option value="">Choose a member</option>
                    {others.map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {m.email ?? m.user_id} ({ORG_ROLE_LABELS[m.role]})
                      </option>
                    ))}
                  </select>
                  <button type="submit" className="button button-small" disabled={!pickedId || busy}>
                    Preview
                  </button>
                  <button type="button" className="button button-secondary button-small" onClick={() => setPickerOpen(false)}>
                    Cancel
                  </button>
                </form>
              )}
            </span>
          )}
        </div>
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
      </div>
      <FormError message={error} />

      {tab === 'catalog' && (
        <VendorCatalog
          supabase={supabase}
          context={{ userId: context.userId, members, isManager: context.isManager }}
          visibleIds={context.visibleRequestIds}
          onOpen={(id) => void openRequest(id)}
        />
      )}

      {tab === 'metrics' && seesMetrics && <Metrics supabase={supabase} visibleIds={context.visibleRequestIds} />}

      {tab === 'reviews' && (
        <ReviewQueue supabase={supabase} context={context} onOpen={(id, stageId) => void openRequest(id, stageId)} />
      )}

      {tab === 'admin' && (
        <Admin
          supabase={supabase}
          organization={organization}
          userId={user.id}
          members={members}
          readOnly={readOnly}
          onViewAs={readOnly ? undefined : (m) => void startPreview(m)}
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
              userId={viewerId}
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
