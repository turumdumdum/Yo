import { useMemo, useState } from 'react';
import { RequestStatusBadge, RiskBadge } from '../components/Badge';
import type { RequestSummary } from './api';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
const DONE = new Set(['Approved', 'Approved with conditions', 'Rejected']);

/** The four views of the start screen. */
/** Work views. Approved vendors live in the vendor catalog (vendors/VendorCatalog.tsx). */
export type RequestView = 'mine' | 'review' | 'rejected' | 'archived' | 'trash';

interface Props {
  requests: RequestSummary[];
  userId: string;
  /** Requests where a reviewer waits for this person's answer. */
  awaitingMyAnswer: ReadonlySet<string>;
  nameOf: (userId: string) => string;
  busy: boolean;
  onOpen: (id: string) => void;
}

/** Archived and deleted requests leave the main views. */
const active = (r: RequestSummary) => !r.archived_at && !r.deleted_at;

const VIEWS: { id: RequestView; label: string; icon: string; empty: string; matches: (r: RequestSummary, userId: string) => boolean }[] = [
  {
    id: 'mine',
    label: 'My requests',
    icon: '✎',
    empty: 'You have not started any requests yet.',
    matches: (r, userId) => r.requester_id === userId && active(r),
  },
  {
    id: 'review',
    label: 'Being checked',
    icon: '⏳',
    empty: 'Nothing is being checked right now.',
    matches: (r) => (r.status === 'in_review' || r.status === 'submitted') && active(r),
  },
  {
    id: 'rejected',
    label: 'Rejected',
    icon: '✕',
    empty: 'No requests have been rejected.',
    matches: (r) => r.status === 'rejected' && active(r),
  },
  {
    id: 'archived',
    label: 'Archived',
    icon: '▤',
    empty: 'Nothing is archived.',
    matches: (r) => !!r.archived_at && !r.deleted_at,
  },
  {
    id: 'trash',
    label: 'Trash',
    icon: '🗑',
    empty: 'The trash is empty.',
    matches: (r) => !!r.deleted_at,
  },
];
const MAIN_VIEWS = VIEWS.slice(0, 3);

function isUrgent(request: RequestSummary, userId: string, awaiting: ReadonlySet<string>): boolean {
  return awaiting.has(request.id) || (request.status === 'draft' && request.requester_id === userId);
}

/** What the person should know about a request at a glance. */
function nextStep(request: RequestSummary, mine: boolean, waitingForMe: boolean): { text: string; urgent?: boolean } {
  if (waitingForMe) return { text: 'A reviewer asked you a question. Open it to answer.', urgent: true };
  const stages = (request.request_stages ?? []).filter((s) => s.status !== 'Not required');
  const done = stages.filter((s) => DONE.has(s.status)).length;
  switch (request.status) {
    case 'draft':
      return { text: mine ? 'Not sent yet. Open it to continue where you left off.' : 'Not sent yet.', urgent: mine };
    case 'approved':
      return { text: 'Approved. Open it to see any conditions.' };
    case 'rejected':
      return { text: 'Not approved. Open it to see why.' };
    default:
      return { text: stages.length > 0 ? `Being checked: ${done} of ${stages.length} checks done.` : 'Sent for review.' };
  }
}

/** The start screen: four views with counts, search, and request cards. */
export function RequestList({ requests, userId, awaitingMyAnswer, nameOf, busy, onOpen }: Props) {
  const [view, setView] = useState<RequestView>('mine');
  const [search, setSearch] = useState('');

  const counts = useMemo(
    () => Object.fromEntries(VIEWS.map((v) => [v.id, requests.filter((r) => v.matches(r, userId)).length])) as Record<RequestView, number>,
    [requests, userId],
  );

  const current = VIEWS.find((v) => v.id === view)!;
  const query = search.trim().toLowerCase();
  const shown = requests
    .filter((r) => current.matches(r, userId))
    .filter((r) => !query || `${r.service_name ?? ''} ${r.vendor_name ?? ''}`.toLowerCase().includes(query))
    // Requests that need the person come first.
    .sort((a, b) => Number(isUrgent(b, userId, awaitingMyAnswer)) - Number(isUrgent(a, userId, awaitingMyAnswer)));

  return (
    <>
      <div className="view-tiles" role="group" aria-label="Show" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
        {MAIN_VIEWS.map((v) => (
          <button key={v.id} type="button" className="view-tile" data-view={v.id} aria-pressed={view === v.id} onClick={() => setView(v.id)}>
            <span className="view-icon" aria-hidden="true">
              {v.icon}
            </span>
            <span className="view-count">{counts[v.id]}</span>
            <span className="view-label">{v.label}</span>
          </button>
        ))}
      </div>
      {(counts.archived > 0 || counts.trash > 0 || view === 'archived' || view === 'trash') && (
        <div className="view-more" role="group" aria-label="More">
          {VIEWS.slice(3)
            .filter((v) => counts[v.id] > 0 || view === v.id)
            .map((v) => (
              <button key={v.id} type="button" className="button button-secondary button-small" aria-pressed={view === v.id} onClick={() => setView(v.id)}>
                {v.label} <span className="chip-count">{counts[v.id]}</span>
              </button>
            ))}
        </div>
      )}
      {requests.length > 3 && (
        <div className="field search-field">
          <label htmlFor="request-search" className="visually-hidden">
            Search by service or vendor
          </label>
          <input
            id="request-search"
            type="search"
            placeholder="Search by service or vendor"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      )}
      <h3 className="view-heading">
        {current.label} <span className="chip-count">{shown.length}</span>
      </h3>
      {shown.length === 0 ? (
        <p className="empty">{query ? 'No requests match your search.' : current.empty}</p>
      ) : (
        <ul className="request-cards">
          {shown.map((request) => {
            const mine = request.requester_id === userId;
            const next = nextStep(request, mine, awaitingMyAnswer.has(request.id));
            return (
              <li key={request.id}>
                <button
                  type="button"
                  className={`request-card${next.urgent ? ' urgent' : ''}`}
                  disabled={busy}
                  onClick={() => onOpen(request.id)}
                >
                  <span className="request-card-top">
                    <span className="request-title">{request.service_name || 'Untitled request'}</span>
                    <span className="badges">
                      <RequestStatusBadge status={request.status} />
                      {request.risk_tier && <RiskBadge tier={request.risk_tier} />}
                      {request.is_confidential && <span className="status-badge confidential-badge">🔒 Confidential</span>}
                      {request.archived_at && !request.deleted_at && (
                        <span className="status-badge" data-tone="idle">
                          Archived
                        </span>
                      )}
                      {request.deleted_at && (
                        <span className="status-badge" data-tone="rejected">
                          In the trash
                        </span>
                      )}
                    </span>
                  </span>
                  <span className={`request-next${next.urgent ? ' urgent' : ''}`}>{next.text}</span>
                  <span className="request-meta">
                    {request.vendor_name ? `${request.vendor_name} · ` : ''}
                    {request.request_type ? `${request.request_type} · ` : ''}
                    {request.status === 'draft'
                      ? `Last edited ${formatDate(request.updated_at)}`
                      : `Sent ${formatDate(request.submitted_at ?? request.updated_at)}`}
                    {mine ? ' · by you' : ` · by ${nameOf(request.requester_id)}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
