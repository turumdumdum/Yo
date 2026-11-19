import { exceptionState } from '@app/shared';
import { useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { decideException, revokeException, type ReviewException } from './api';

const formatDate = (iso: string) => new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
const today = () => new Date().toISOString().slice(0, 10);

const STATE_LABEL = {
  pending: ['Waiting for an org admin', 'waiting'],
  active: ['Accepted', 'approved'],
  expiring: ['Accepted, ends soon', 'waiting'],
  expired: ['Expired: review again', 'rejected'],
  rejected: ['Refused', 'rejected'],
  revoked: ['Revoked', 'idle'],
} as const;

interface Props {
  supabase: SupabaseClient;
  exception: ReviewException;
  userId: string;
  isAdmin: boolean;
  nameOf: (userId: string | null) => string;
  /** Shown in the register, where exceptions of many requests are listed. */
  requestName?: string;
  onChanged: () => Promise<void> | void;
}

/** One exception with what it waives, why, the measures that make up for it, and its decision. */
export function ExceptionItem({ supabase, exception: e, userId, isAdmin, nameOf, requestName, onChanged }: Props) {
  const id = useId();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = exceptionState(e, today());
  const [label, tone] = STATE_LABEL[state];
  const canDecide = isAdmin && e.status === 'pending' && e.requested_by !== userId;
  const canRevoke = (isAdmin && (e.status === 'approved' || e.status === 'pending')) || (e.status === 'pending' && e.requested_by === userId);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setComment('');
      await onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`exception-item state-${state}`}>
      <div className="exception-head">
        <strong>
          {requestName ? `${requestName}: ` : ''}
          {e.control_title}
        </strong>
        <span className="badges">
          <span className="status-badge" data-tone={tone}>
            {label}
          </span>
          <span className="status-badge" data-tone={e.risk_level === 'Low' ? 'idle' : e.risk_level === 'Medium' ? 'review' : 'waiting'}>
            {e.risk_level} risk
          </span>
        </span>
      </div>
      <dl className="exception-facts">
        <dt>What deviates</dt>
        <dd>{e.deviation}</dd>
        <dt>Why</dt>
        <dd>{e.justification}</dd>
        <dt>Compensating measures</dt>
        <dd>{e.compensating_controls}</dd>
        <dt>Valid until</dt>
        <dd>{formatDate(e.expires_on)}</dd>
        <dt>Asked by</dt>
        <dd>
          {nameOf(e.requested_by)} on {formatDate(e.created_at)}
        </dd>
        {e.decided_by && (
          <>
            <dt>{e.status === 'approved' ? 'Risk accepted by' : e.status === 'rejected' ? 'Refused by' : 'Closed by'}</dt>
            <dd>
              {nameOf(e.decided_by)} on {formatDate(e.decided_at!)}
              {e.decision_comment ? ` — ${e.decision_comment}` : ''}
            </dd>
          </>
        )}
      </dl>
      <FormError message={error} />
      {(canDecide || canRevoke) && (
        <div className="exception-actions">
          <div className="field">
            <label htmlFor={`${id}-comment`}>{canDecide ? 'Comment (required to refuse)' : 'Comment (optional)'}</label>
            <input id={`${id}-comment`} value={comment} maxLength={1000} onChange={(ev) => setComment(ev.target.value)} />
          </div>
          <div className="form-actions">
            {canDecide && (
              <>
                <button type="button" className="button button-small" disabled={busy} onClick={() => void run(() => decideException(supabase, e.id, true, comment || null))}>
                  Accept the risk
                </button>
                <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void run(() => decideException(supabase, e.id, false, comment || null))}>
                  Refuse
                </button>
              </>
            )}
            {canRevoke && (
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(e.status === 'pending' && !isAdmin ? 'Withdraw this exception?' : 'Revoke this exception? The control must then be met.')) {
                    void run(() => revokeException(supabase, e.id, comment || null));
                  }
                }}
              >
                {e.status === 'pending' && e.requested_by === userId ? 'Withdraw' : 'Revoke'}
              </button>
            )}
          </div>
          {isAdmin && e.status === 'pending' && e.requested_by === userId && (
            <p className="field-hint">You asked for this exception, so another org admin must accept or refuse it.</p>
          )}
        </div>
      )}
    </li>
  );
}
