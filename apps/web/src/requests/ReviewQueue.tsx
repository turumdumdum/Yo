import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RiskBadge } from '../components/Badge';
import { FormError } from '../components/FormError';
import { StatusBadge } from '../components/StatusBadge';
import { errorMessage } from '../lib/errors';
import { listOpenStages, type QueueItem } from './api';
import type { ReviewContext } from './StagePanel';

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

interface Props {
  supabase: SupabaseClient;
  context: ReviewContext;
  onOpen: (requestId: string, stageId: string) => void;
}

/** Open stages waiting for the signed-in person. */
export function ReviewQueue({ supabase, context, onOpen }: Props) {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  const mine = items.filter(
    (item) =>
      (item.reviewer_id === context.userId || (context.isManager && item.reviewer_id === null)) &&
      (context.allowSelfReview || item.requests.requester_id !== context.userId),
  );
  const now = Date.now();

  return (
    <section className="card" aria-labelledby="queue-heading">
      <div className="card-head">
        <h2 id="queue-heading">To review</h2>
      </div>
      {context.isManager && <p className="field-hint">Stages assigned to you, and stages that have no reviewer yet.</p>}
      {mine.length === 0 ? (
        <p className="empty">Nothing is waiting for your review.</p>
      ) : (
        <ul className="request-list">
          {mine.map((item) => {
            const overdue = item.sla_due_at !== null && new Date(item.sla_due_at).getTime() < now;
            return (
              <li key={item.id}>
                <button type="button" className="request-row" onClick={() => onOpen(item.request_id, item.id)}>
                  <span className="request-title">
                    {item.name}: {item.requests.service_name || 'Untitled request'}
                  </span>
                  <span className="request-meta">
                    {item.reviewer_id ? 'Assigned to you' : 'No reviewer yet'}
                    {item.sla_due_at ? ` · ${overdue ? 'Overdue since' : 'Due'} ${formatDate(item.sla_due_at)}` : ''}
                  </span>
                  <span className="badges">
                    <StatusBadge status={item.status} />
                    {item.requests.risk_tier && <RiskBadge tier={item.requests.risk_tier} />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
