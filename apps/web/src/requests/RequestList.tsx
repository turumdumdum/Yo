import { useMemo, useState } from 'react';
import { RequestStatusBadge, RiskBadge } from '../components/Badge';
import type { RequestSummary } from './api';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
const DONE = new Set(['Approved', 'Approved with conditions', 'Rejected']);

type Filter = 'all' | 'action' | 'draft' | 'review' | 'decided';

interface Props {
  requests: RequestSummary[];
  userId: string;
  /** Requests where a reviewer waits for this person's answer. */
  awaitingMyAnswer: ReadonlySet<string>;
  nameOf: (userId: string) => string;
  busy: boolean;
  onOpen: (id: string) => void;
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

/** The list of requests with quick filters and search. */
export function RequestList({ requests, userId, awaitingMyAnswer, nameOf, busy, onOpen }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');

  const counts = useMemo(
    () => ({
      all: requests.length,
      action: requests.filter((r) => awaitingMyAnswer.has(r.id) || (r.status === 'draft' && r.requester_id === userId)).length,
      draft: requests.filter((r) => r.status === 'draft').length,
      review: requests.filter((r) => r.status === 'in_review' || r.status === 'submitted').length,
      decided: requests.filter((r) => r.status === 'approved' || r.status === 'rejected').length,
    }),
    [requests, awaitingMyAnswer, userId],
  );

  const query = search.trim().toLowerCase();
  const shown = requests.filter((r) => {
    if (query && !(r.service_name ?? '').toLowerCase().includes(query)) return false;
    switch (filter) {
      case 'action':
        return awaitingMyAnswer.has(r.id) || (r.status === 'draft' && r.requester_id === userId);
      case 'draft':
        return r.status === 'draft';
      case 'review':
        return r.status === 'in_review' || r.status === 'submitted';
      case 'decided':
        return r.status === 'approved' || r.status === 'rejected';
      default:
        return true;
    }
  });

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'action', label: 'Needs you' },
    { id: 'draft', label: 'Drafts' },
    { id: 'review', label: 'Being checked' },
    { id: 'decided', label: 'Decided' },
  ];

  return (
    <>
      {requests.length > 3 && (
        <div className="list-tools">
          <div className="chips" role="group" aria-label="Show">
            {filters.map((f) => (
              <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} <span className="chip-count">{counts[f.id]}</span>
              </button>
            ))}
          </div>
          <div className="field search-field">
            <label htmlFor="request-search" className="visually-hidden">
              Search by service name
            </label>
            <input
              id="request-search"
              type="search"
              placeholder="Search by service name"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      )}
      {shown.length === 0 ? (
        <p className="empty">No requests match.</p>
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
                    </span>
                  </span>
                  <span className={`request-next${next.urgent ? ' urgent' : ''}`}>{next.text}</span>
                  <span className="request-meta">
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
