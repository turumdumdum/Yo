import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { StatusBadge } from '../components/StatusBadge';
import { errorMessage } from '../lib/errors';
import { listStages, type StageRow } from './api';

const DONE = new Set(['Approved', 'Approved with conditions', 'Rejected']);

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

function slaText(stage: StageRow, now: number): string | null {
  if (!stage.sla_due_at || DONE.has(stage.status)) return null;
  if (stage.sla_paused) return 'SLA paused while waiting for the requester';
  const due = new Date(stage.sla_due_at);
  return due.getTime() < now ? `Overdue since ${formatDate(stage.sla_due_at)}` : `Due ${formatDate(stage.sla_due_at)}`;
}

/** Review stages of a submitted request, with progress, reviewer and SLA. */
export function StageList({ supabase, requestId }: { supabase: SupabaseClient; requestId: string }) {
  const [stages, setStages] = useState<StageRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listStages(supabase, requestId).then(
      (rows) => !cancelled && setStages(rows),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [supabase, requestId]);

  if (error) return <FormError message={error} />;
  if (!stages) return <p role="status">Loading…</p>;
  if (stages.length === 0) {
    return <p className="empty">This request was submitted before review stages existed, so it has none.</p>;
  }

  const required = stages.filter((s) => s.status !== 'Not required');
  const done = required.filter((s) => DONE.has(s.status)).length;
  const now = Date.now();

  return (
    <>
      <p className="progress-text">
        {done} of {required.length} required stages completed
      </p>
      <progress className="progress-line" max={required.length} value={done} aria-label="Review progress" />
      <ul className="stage-list">
        {stages.map((stage) => {
          const sla = slaText(stage, now);
          return (
            <li key={stage.id}>
              <span className="stage-main">
                <span className="stage-name">{stage.name}</span>
                <span className="stage-meta">
                  {stage.status === 'Not required'
                    ? stage.note
                    : [stage.reviewer_id ? 'Reviewer assigned' : 'No reviewer yet', sla].filter(Boolean).join(' · ')}
                </span>
              </span>
              <StatusBadge status={stage.status} />
            </li>
          );
        })}
      </ul>
    </>
  );
}
