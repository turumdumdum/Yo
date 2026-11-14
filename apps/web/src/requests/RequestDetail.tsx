import type { Answers } from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RequestStatusBadge, RiskBadge } from '../components/Badge';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { AnswerSummary } from './AnswerSummary';
import { listStages, loadRequest, requestReviewAnswers, type RequestRow, type StageRow } from './api';
import { StageList } from './StageList';
import type { ReviewContext } from './StagePanel';

const formatDate = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

interface Props {
  supabase: SupabaseClient;
  request: RequestRow;
  context: ReviewContext;
  initialStageId?: string;
  onClose: () => void;
}

const OUTCOME: Record<string, string> = {
  approved: 'All required stages are complete and the request is approved.',
  rejected: 'The request was rejected. See the stage decisions below for the reasons.',
};

export function RequestDetail({ supabase, request: initial, context, initialStageId, onClose }: Props) {
  const [request, setRequest] = useState(initial);
  const [stages, setStages] = useState<StageRow[] | null>(null);
  const [reviewAnswers, setReviewAnswers] = useState<Record<string, Answers>>({});
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      // The request itself too: the last stage decision changes its status.
      const [fresh, rows, review] = await Promise.all([
        loadRequest(supabase, initial.id),
        listStages(supabase, initial.id),
        requestReviewAnswers(supabase, initial.id),
      ]);
      if (fresh) setRequest(fresh);
      setStages(rows);
      setReviewAnswers(review);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, initial.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const requester = context.members.find((m) => m.user_id === request.requester_id)?.email;

  return (
    <div className="request-form">
      <div className="form-top">
        <button type="button" className="link-button" onClick={onClose}>
          ← Back
        </button>
      </div>
      <h1>{request.service_name || 'Untitled request'}</h1>
      <p className="badges">
        <RequestStatusBadge status={request.status} />
        {request.risk_tier && <RiskBadge tier={request.risk_tier} />}
      </p>
      {request.submitted_at && (
        <p className="lead">
          Submitted {formatDate(request.submitted_at)}
          {requester ? ` by ${requester}` : ''}.
        </p>
      )}
      {OUTCOME[request.status] && <p className={`notice notice-${request.status}`}>{OUTCOME[request.status]}</p>}
      <FormError message={error} />

      {request.status !== 'draft' && (
        <section className="card" aria-labelledby="stages-heading">
          <h2 id="stages-heading">Review stages</h2>
          {stages ? (
            <StageList
              supabase={supabase}
              stages={stages}
              answers={request.answers}
              reviewAnswers={reviewAnswers}
              requesterId={request.requester_id}
              context={context}
              initialStageId={initialStageId}
              onChanged={reload}
            />
          ) : (
            <p role="status">Loading…</p>
          )}
        </section>
      )}

      {request.risk_tier && (
        <section className="card" aria-labelledby="triage-heading">
          <h2 id="triage-heading">Triage</h2>
          <p>
            Risk tier <strong>{request.risk_tier}</strong> (score {request.risk_score}).
          </p>
          {request.risk_reasons && request.risk_reasons.length > 0 && (
            <ul className="plain-list">
              {request.risk_reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="card" aria-labelledby="details-heading">
        <h2 id="details-heading">Request details</h2>
        <AnswerSummary answers={request.answers} />
      </section>
    </div>
  );
}
