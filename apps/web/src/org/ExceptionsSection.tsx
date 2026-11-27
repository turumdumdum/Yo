import { exceptionState } from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { listOrgExceptions, type ReviewException } from '../requests/api';
import { ExceptionItem } from '../requests/ExceptionItem';
import type { Member } from './api';

type Filter = 'attention' | 'active' | 'closed';

/** The exception register: every accepted risk, what waits for a decision, and what runs out. */
export function ExceptionsSection({ supabase, orgId, userId, members }: { supabase: SupabaseClient; orgId: string; userId: string; members: Member[] }) {
  const [rows, setRows] = useState<ReviewException[] | null>(null);
  const [filter, setFilter] = useState<Filter>('attention');
  const [stage, setStage] = useState<string>('all');
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setRows(await listOrgExceptions(supabase, orgId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const today = new Date().toISOString().slice(0, 10);
  const groups: Record<Filter, ReviewException[]> = { attention: [], active: [], closed: [] };
  const stageNames = [...new Set((rows ?? []).map((r) => r.stage_name ?? 'Security review'))].sort();
  for (const r of (rows ?? []).filter((x) => stage === 'all' || (x.stage_name ?? 'Security review') === stage)) {
    const s = exceptionState(r, today);
    if (s === 'pending' || s === 'expiring' || s === 'expired') groups.attention.push(r);
    else if (s === 'active') groups.active.push(r);
    else groups.closed.push(r);
  }
  const labels: Record<Filter, string> = { attention: 'Needs attention', active: 'Accepted', closed: 'Refused or revoked' };
  const nameOf = (id: string | null) => (id === userId ? 'you' : (members.find((m) => m.user_id === id)?.email ?? 'a former member'));

  return (
    <section className="card" aria-labelledby="exceptions-heading">
      <h2 id="exceptions-heading">Exceptions</h2>
      <p className="field-hint">
        Every deviation accepted in a review, with the review it came from, its reason, compensating measures and end date.
        Exceptions that wait for a decision, end within 30 days or have expired need attention: accept or refuse them, or revoke
        them so that what they waived must be met.
      </p>
      <FormError message={error} />
      {stageNames.length > 1 && (
        <div className="field inline-field">
          <label htmlFor="exceptions-stage">Review</label>
          <select id="exceptions-stage" value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="all">All reviews</option>
            {stageNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="chips" role="group" aria-label="Show">
        {(Object.keys(labels) as Filter[]).map((f) => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {labels[f]} <span className="chip-count">{groups[f].length}</span>
          </button>
        ))}
      </div>
      {rows === null ? (
        <p role="status">Loading…</p>
      ) : groups[filter].length === 0 ? (
        <p className="empty">Nothing here.</p>
      ) : (
        <ul className="exception-list">
          {groups[filter].map((e) => (
            <ExceptionItem
              key={e.id}
              supabase={supabase}
              exception={e}
              userId={userId}
              isAdmin
              nameOf={nameOf}
              requestName={e.requests?.service_name || 'Untitled request'}
              onChanged={reload}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
