import type { Answers } from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RequestStatusBadge, RiskBadge } from '../components/Badge';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { AnswerSummary } from './AnswerSummary';
import { Attachments } from './Attachments';
import { listInfoRequests, listStages, loadRequest, requestReviewAnswers, type InfoRequest, type RequestRow, type StageRow } from './api';
import { ActionRequired } from './Questions';
import { RequestProgress } from './RequestProgress';
import { StageList } from './StageList';
import type { ReviewContext } from './StagePanel';
import { Visibility } from './Visibility';
import { VendorRisk } from './VendorRisk';
import { Lifecycle } from './Lifecycle';
import { openControls, SecurityConfig } from './SecurityConfig';

const formatDate = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

interface Props {
  supabase: SupabaseClient;
  request: RequestRow;
  context: ReviewContext;
  initialStageId?: string;
  onClose: () => void;
}


export function RequestDetail({ supabase, request: initial, context, initialStageId, onClose }: Props) {
  const [request, setRequest] = useState(initial);
  const [stages, setStages] = useState<StageRow[] | null>(null);
  const [reviewAnswers, setReviewAnswers] = useState<Record<string, Answers>>({});
  const [questions, setQuestions] = useState<InfoRequest[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      // The request itself too: the last stage decision changes its status.
      const [fresh, rows, review, asked] = await Promise.all([
        loadRequest(supabase, initial.id),
        listStages(supabase, initial.id),
        requestReviewAnswers(supabase, initial.id),
        listInfoRequests(supabase, initial.id),
      ]);
      setQuestions(asked);
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
  const open = questions.filter((q) => q.answered_at === null);
  const securityStage = stages?.find((s) => s.name === 'Security review');
  const securityOpen = !!securityStage && (securityStage.status === 'In review' || securityStage.status === 'Waiting for requester');

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
      </p>
      {request.submitted_at && (
        <p className="lead">
          Submitted {formatDate(request.submitted_at)}
          {requester ? ` by ${requester}` : ''}.
        </p>
      )}
      {request.status !== 'draft' && (
        <RequestProgress request={request} stages={stages} questions={questions} isRequester={request.requester_id === context.userId} />
      )}
      <FormError message={error} />
      <Lifecycle supabase={supabase} request={request} context={context} onChanged={reload} onDeleted={onClose} />

      {request.requester_id === context.userId && open.length > 0 && (
        <ActionRequired
          supabase={supabase}
          questions={open}
          stageName={(stageId) => stages?.find((st) => st.id === stageId)?.name ?? 'Review'}
          nameOf={(userId) => context.members.find((m) => m.user_id === userId)?.email ?? 'A reviewer'}
          onAnswered={reload}
        />
      )}

      {request.status !== 'draft' && (
        <section className="card" aria-labelledby="stages-heading">
          <h2 id="stages-heading">Checks</h2>
          {stages ? (
            <StageList
              supabase={supabase}
              stages={stages}
              answers={request.answers}
              form={request.form}
              reviewAnswers={reviewAnswers}
              questions={questions}
              requesterId={request.requester_id}
              context={context}
              initialStageId={initialStageId}
              securityControls={
                securityOpen && (request.config_requirements ?? []).length > 0 ? <SecurityConfig supabase={supabase} request={request} stages={stages} context={context} onChanged={reload} embedded /> : undefined
              }
              securityControlsOpen={openControls(request)}
              onChanged={reload}
            />
          ) : (
            <p role="status">Loading…</p>
          )}
        </section>
      )}

      {/* While the security review is open, the controls live in its Configuration tab. */}
      {request.status !== 'draft' && !securityOpen && <SecurityConfig supabase={supabase} request={request} stages={stages} context={context} onChanged={reload} />}

      {request.status !== 'draft' && (context.isManager || (stages ?? []).some((st) => st.reviewer_id === context.userId)) && (
        <VendorRisk supabase={supabase} request={request} />
      )}

      {request.status !== 'draft' && <Visibility supabase={supabase} request={request} context={context} onChanged={reload} />}

      <section className="card" aria-labelledby="attachments-heading">
        <h2 id="attachments-heading">Attachments</h2>
        <Attachments
          supabase={supabase}
          requestId={request.id}
          userId={context.userId}
          // While in review: the requester, managers and reviewers of this request.
          canUpload={
            (request.status === 'in_review' || request.status === 'submitted') &&
            (request.requester_id === context.userId ||
              context.isManager ||
              (stages ?? []).some((st) => st.reviewer_id === context.userId))
          }
          canRemoveOwn={false}
          nameOf={(userId) => (userId === context.userId ? 'you' : (context.members.find((m) => m.user_id === userId)?.email ?? 'a former member'))}
        />
      </section>

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
        <AnswerSummary form={request.form} answers={request.answers} />
      </section>
    </div>
  );
}
