import { useCallback, useEffect, useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { addViewer, listViewers, removeViewer, setConfidential, type RequestRow, type RequestViewer } from './api';
import type { ReviewContext } from './StagePanel';

interface Props {
  supabase: SupabaseClient;
  request: RequestRow;
  context: ReviewContext;
  onChanged: () => Promise<void> | void;
}

/**
 * Who can see a request. Everyone sees whether it is confidential; org admins can switch
 * it and choose extra people. The database enforces all of it.
 */
export function Visibility({ supabase, request, context, onChanged }: Props) {
  const id = useId();
  const isAdmin = context.members.some((m) => m.user_id === context.userId && m.role === 'org_admin');
  const [viewers, setViewers] = useState<RequestViewer[]>([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setViewers(await listViewers(supabase, request.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, request.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  if (!request.is_confidential && !isAdmin) return null;

  const emailOf = (userId: string) => context.members.find((m) => m.user_id === userId)?.email ?? 'a former member';
  const candidates = context.members.filter(
    (m) => m.user_id !== request.requester_id && m.role !== 'org_admin' && !viewers.some((v) => v.user_id === m.user_id),
  );
  const hasBusinessOwner = viewers.some((v) => v.reason === 'business_owner');

  return (
    <section className={`card visibility${request.is_confidential ? ' is-confidential' : ''}`} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>
        {request.is_confidential ? (
          <>
            <span aria-hidden="true">🔒 </span>Confidential request
          </>
        ) : (
          'Who can see this request'
        )}
      </h2>
      <p>
        {request.is_confidential
          ? 'Only the requester, org admins, the business owner and the people listed here can see it. Reviewers see it once an org admin assigns them to a check.'
          : 'Org admins, process managers, auditors and assigned reviewers can see it.'}
      </p>
      <FormError message={error} />

      {request.is_confidential && (
        <>
          {viewers.length > 0 ? (
            <ul className="member-list">
              {viewers.map((v) => (
                <li key={v.user_id}>
                  <span className="member-email">{emailOf(v.user_id)}</span>
                  <span className="stage-meta">{v.reason === 'business_owner' ? 'Business owner' : 'Added by an org admin'}</span>
                  {isAdmin && (
                    <button
                      type="button"
                      className="button button-secondary button-small"
                      disabled={busy}
                      aria-label={`Remove ${emailOf(v.user_id)} from the people who can see this request`}
                      onClick={() => void run(() => removeViewer(supabase, request.id, v.user_id))}
                    >
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="field-hint">Nobody else has been added yet.</p>
          )}
          {isAdmin && !hasBusinessOwner && (
            <p className="field-hint">
              The business owner’s answer did not match a member’s email, so they cannot see this request yet. Add them below if
              they should.
            </p>
          )}
        </>
      )}

      {isAdmin && (
        <div className="visibility-actions">
          {request.is_confidential && candidates.length > 0 && (
            <div className="invite-form">
              <div className="field">
                <label htmlFor={`${id}-pick`}>Let someone else see it</label>
                <select id={`${id}-pick`} value={pick} onChange={(e) => setPick(e.target.value)}>
                  <option value="">Choose a member</option>
                  {candidates.map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.email ?? m.user_id}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                className="button"
                disabled={busy || !pick}
                onClick={() =>
                  void run(async () => {
                    await addViewer(supabase, request.id, pick);
                    setPick('');
                  })
                }
              >
                Add
              </button>
            </div>
          )}
          <button
            type="button"
            className="button button-secondary"
            disabled={busy}
            onClick={() => {
              const message = request.is_confidential
                ? 'Make this request visible to process managers and auditors again?'
                : 'Make this request confidential? Process managers and auditors will no longer see it.';
              if (window.confirm(message)) void run(() => setConfidential(supabase, request.id, !request.is_confidential));
            }}
          >
            {request.is_confidential ? 'Stop keeping it confidential' : 'Make it confidential'}
          </button>
        </div>
      )}
    </section>
  );
}
