import { DEFAULT_STAGES } from '@app/shared';
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RiskBadge } from '../components/Badge';
import { FormError } from '../components/FormError';
import { StatusBadge } from '../components/StatusBadge';
import { errorMessage } from '../lib/errors';
import { listOpenStages, type QueueItem } from './api';
import { dueText, type ReviewContext } from './StagePanel';

interface Props {
  supabase: SupabaseClient;
  context: ReviewContext;
  onOpen: (requestId: string, stageId: string) => void;
}

type Group = 'overdue' | 'mine' | 'waiting' | 'unassigned';

const GROUPS: { id: Group; title: string; hint: string; empty: string }[] = [
  { id: 'overdue', title: 'Overdue', hint: 'Past their due date. Start with these.', empty: 'Nothing is overdue.' },
  { id: 'mine', title: 'Your reviews', hint: 'Assigned to you and waiting for your decision.', empty: 'Nothing is waiting for you.' },
  { id: 'waiting', title: 'Waiting for the requester', hint: 'You asked a question; the clock is paused until they answer.', empty: 'No open questions.' },
  { id: 'unassigned', title: 'No reviewer yet', hint: 'Assign a reviewer, or review them yourself.', empty: 'Every review has a reviewer.' },
];

function groupOf(item: QueueItem, now: number): Group {
  if (item.status === 'Waiting for requester') return 'waiting';
  if (item.sla_due_at && new Date(item.sla_due_at).getTime() < now) return 'overdue';
  return item.reviewer_id === null ? 'unassigned' : 'mine';
}

/** Open reviews for the signed-in person, grouped by what they need, with a filter by kind of review. */
export function ReviewQueue({ supabase, context, onOpen }: Props) {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<string>('all');

  useEffect(() => {
    let cancelled = false;
    listOpenStages(supabase).then(
      (rows) => !cancelled && setItems(rows),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  if (error) return <FormError message={error} />;
  if (!items) return <p role="status">Loading…</p>;

  // Assigned to me; managers also get stages nobody is assigned to. Never my own requests,
  // unless the organization allows reviewing them.
  // External stages are reviewed in another service: nothing to do here.
  const externalCount = items.filter((i) => i.external).length;
  const mine = items.filter(
    (item) =>
      !item.external &&
      (item.reviewer_id === context.userId || (context.isManager && item.reviewer_id === null)) &&
      (context.allowSelfReview || item.requests.requester_id !== context.userId),
  );
  const now = Date.now();
  const kinds = DEFAULT_STAGES.filter((s) => mine.some((i) => i.name === s));
  const shown = mine.filter((i) => kind === 'all' || i.name === kind);
  const byGroup = Object.fromEntries(GROUPS.map((g) => [g.id, shown.filter((i) => groupOf(i, now) === g.id)])) as Record<Group, QueueItem[]>;

  return (
    <section className="card review-queue" aria-labelledby="queue-heading">
      <h2 id="queue-heading">To review</h2>
      {externalCount > 0 && (
        <p className="field-hint">
          {externalCount} {externalCount === 1 ? 'review runs' : 'reviews run'} in an external service and {externalCount === 1 ? 'is' : 'are'} not listed here.
        </p>
      )}
      {mine.length === 0 ? (
        <div className="empty-state">
          <p>Nothing is waiting for your review. New reviews appear here when a request is submitted.</p>
        </div>
      ) : (
        <>
          <div className="queue-summary" role="group" aria-label="Summary">
            {GROUPS.filter((g) => g.id !== 'unassigned' || context.isManager).map((g) => (
              <a key={g.id} href={`#queue-${g.id}`} className={`queue-stat${g.id === 'overdue' && byGroup.overdue.length > 0 ? ' alert' : ''}`}>
                <span className="queue-stat-count">{byGroup[g.id].length}</span>
                <span className="queue-stat-label">{g.title}</span>
              </a>
            ))}
          </div>
          {kinds.length > 1 && (
            <div className="chips" role="group" aria-label="Kind of review">
              <button type="button" aria-pressed={kind === 'all'} onClick={() => setKind('all')}>
                All <span className="chip-count">{mine.length}</span>
              </button>
              {kinds.map((k) => (
                <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {k} <span className="chip-count">{mine.filter((i) => i.name === k).length}</span>
                </button>
              ))}
            </div>
          )}
          {GROUPS.map((g) => {
            const list = byGroup[g.id];
            if (list.length === 0 && (g.id === 'unassigned' || g.id === 'waiting' || g.id === 'overdue')) return null;
            return (
              <section key={g.id} id={`queue-${g.id}`} className={`queue-group group-${g.id}`} aria-labelledby={`queue-${g.id}-heading`}>
                <h3 id={`queue-${g.id}-heading`}>
                  {g.title} <span className="chip-count">{list.length}</span>
                </h3>
                <p className="field-hint">{list.length === 0 ? g.empty : g.hint}</p>
                {list.length > 0 && (
                  <ul className="request-cards">
                    {list.map((item) => {
                      const due = item.sla_due_at ? dueText(item.sla_due_at, now) : null;
                      return (
                        <li key={item.id}>
                          <button type="button" className={`request-card${due?.overdue ? ' urgent' : ''}`} onClick={() => onOpen(item.request_id, item.id)}>
                            <span className="request-card-top">
                              <span className="request-title">{item.requests.service_name || 'Untitled request'}</span>
                              <span className="badges">
                                <StatusBadge status={item.status} />
                                {item.requests.risk_tier && <RiskBadge tier={item.requests.risk_tier} />}
                              </span>
                            </span>
                            <span className={`request-next${due?.overdue ? ' urgent' : ''}`}>
                              {item.name}
                              {due ? ` · ${due.text}` : ''}
                            </span>
                            <span className="request-meta">{item.reviewer_id ? 'Assigned to you' : 'No reviewer yet'}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </>
      )}
    </section>
  );
}
