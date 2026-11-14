import type { SupabaseClient } from '@supabase/supabase-js';
import { RequestStatusBadge, RiskBadge } from '../components/Badge';
import { AnswerSummary } from './AnswerSummary';
import type { RequestRow } from './api';
import { StageList } from './StageList';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

interface Props {
  supabase: SupabaseClient;
  request: RequestRow;
  onClose: () => void;
}

export function RequestDetail({ supabase, request, onClose }: Props) {
  return (
    <div className="request-form">
      <div className="form-top">
        <button type="button" className="link-button" onClick={onClose}>
          ← All requests
        </button>
      </div>
      <h1>{request.service_name || 'Untitled request'}</h1>
      <p className="badges">
        <RequestStatusBadge status={request.status} />
        {request.risk_tier && <RiskBadge tier={request.risk_tier} />}
      </p>
      {request.submitted_at && <p className="lead">Submitted {formatDate(request.submitted_at)}.</p>}

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

      {request.status !== 'draft' && (
        <section className="card" aria-labelledby="stages-heading">
          <h2 id="stages-heading">Review stages</h2>
          <StageList supabase={supabase} requestId={request.id} />
          <p className="field-hint">Reviewers cannot record decisions yet; the reviewer queue is the next step.</p>
        </section>
      )}

      <section className="card" aria-labelledby="details-heading">
        <h2 id="details-heading">Request details</h2>
        <AnswerSummary answers={request.answers} />
      </section>
    </div>
  );
}
