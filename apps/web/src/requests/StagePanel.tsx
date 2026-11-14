import { focusStepsForStage, type Answers, type StageDecision } from '@app/shared';
import { useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import type { Member } from '../org/api';
import { AnswerSummary } from './AnswerSummary';
import { assignReviewer, decideStage, setChecklistItem, type StageRow } from './api';

export interface ReviewContext {
  userId: string;
  /** Org admins and process managers may review any stage and assign reviewers. */
  isManager: boolean;
  allowSelfReview: boolean;
  members: Member[];
}

interface Props {
  supabase: SupabaseClient;
  stage: StageRow;
  answers: Answers;
  requesterId: string;
  context: ReviewContext;
  /** Called after any change so the parent reloads the stages and the request. */
  onChanged: () => Promise<void> | void;
}

const OPEN = new Set(['In review', 'Waiting for requester']);
const REVIEWER_ROLES = new Set(['org_admin', 'process_manager', 'reviewer']);

const formatDateTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** Everything about one stage: who reviews it, the checklist, and the decision. */
export function StagePanel({ supabase, stage, answers, requesterId, context, onChanged }: Props) {
  const id = useId();
  const [comment, setComment] = useState('');
  const [conditions, setConditions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Ticks show at once and are dropped again once the server answered, either way.
  const [ticking, setTicking] = useState<Record<number, boolean>>({});

  const open = OPEN.has(stage.status);
  const mayReview = context.isManager || stage.reviewer_id === context.userId;
  const ownRequest = requesterId === context.userId && !context.allowSelfReview;
  const canAct = open && mayReview && !ownRequest;
  const nameOf = (userId: string | null) =>
    userId ? (context.members.find((m) => m.user_id === userId)?.email ?? 'a former member') : null;
  const isChecked = (index: number) => ticking[index] ?? stage.checklist[index]!.checked;
  const allChecked = stage.checklist.every((_, index) => isChecked(index));
  const focus = focusStepsForStage(stage.name);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function decide(decision: StageDecision) {
    if (decision === 'Approved with conditions' && conditions.trim() === '') {
      setError('Describe the conditions.');
      return;
    }
    if (decision === 'Rejected' && comment.trim() === '') {
      setError('Explain in the comment why the stage is rejected.');
      return;
    }
    void run(() => decideStage(supabase, stage.id, decision, comment, conditions));
  }

  return (
    <div className="stage-panel">
      {stage.decided_at && (
        <div className="decision">
          <p>
            <strong>{stage.status}</strong> by {nameOf(stage.decided_by) ?? 'a former member'} on {formatDateTime(stage.decided_at)}.
          </p>
          {stage.conditions && (
            <p>
              <strong>Conditions:</strong> {stage.conditions}
            </p>
          )}
          {stage.decision_comment && (
            <p>
              <strong>Comment:</strong> {stage.decision_comment}
            </p>
          )}
        </div>
      )}

      {open && (
        <div className="field">
          {context.isManager ? (
            <>
              <label htmlFor={`${id}-reviewer`}>Reviewer</label>
              <select
                id={`${id}-reviewer`}
                value={stage.reviewer_id ?? ''}
                disabled={busy}
                onChange={(e) => void run(() => assignReviewer(supabase, stage.id, e.target.value || null))}
              >
                <option value="">Not assigned (org admins and process managers can review)</option>
                {context.members
                  .filter((m) => REVIEWER_ROLES.has(m.role))
                  .map((m) => (
                    <option key={m.user_id} value={m.user_id}>
                      {m.email ?? m.user_id}
                    </option>
                  ))}
              </select>
            </>
          ) : (
            <p className="field-hint">Reviewer: {nameOf(stage.reviewer_id) ?? 'not assigned yet'}</p>
          )}
        </div>
      )}

      {open && mayReview && ownRequest && (
        <p className="notice">You cannot review your own request. An org admin can allow this in the Admin settings.</p>
      )}

      {canAct && focus.length > 0 && (
        <details className="focus-answers" open>
          <summary>Answers relevant to this review</summary>
          <AnswerSummary answers={answers} steps={focus} />
        </details>
      )}

      {stage.checklist.length > 0 && (
        <fieldset className="field">
          <legend>Checklist</legend>
          <div className="choices">
            {stage.checklist.map((item, index) => (
              <label key={item.label} className="choice">
                <input
                  type="checkbox"
                  checked={isChecked(index)}
                  disabled={!canAct}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setTicking((current) => ({ ...current, [index]: checked }));
                    void run(() => setChecklistItem(supabase, stage.id, index, checked)).finally(() =>
                      setTicking(({ [index]: _done, ...rest }) => rest),
                    );
                  }}
                />
                {item.label}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {canAct && (
        <>
          <div className="field">
            <label htmlFor={`${id}-comment`}>
              Comment <span className="optional">(required to reject)</span>
            </label>
            <textarea id={`${id}-comment`} rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-conditions`}>
              Conditions <span className="optional">(required to approve with conditions)</span>
            </label>
            <textarea
              id={`${id}-conditions`}
              rows={3}
              maxLength={2000}
              value={conditions}
              onChange={(e) => setConditions(e.target.value)}
            />
          </div>
          <FormError message={error} />
          {!allChecked && <p className="field-hint">Tick every checklist item to approve without conditions.</p>}
          <div className="form-actions">
            <button type="button" className="button" disabled={busy || !allChecked} onClick={() => decide('Approved')}>
              Approve
            </button>
            <button type="button" className="button button-secondary" disabled={busy} onClick={() => decide('Approved with conditions')}>
              Approve with conditions
            </button>
            <button type="button" className="button button-danger" disabled={busy} onClick={() => decide('Rejected')}>
              Reject
            </button>
          </div>
        </>
      )}
      {!canAct && <FormError message={error} />}
    </div>
  );
}
