import type { Answers, RequestFormDefinition } from '@app/shared';
import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { StatusBadge } from '../components/StatusBadge';
import type { InfoRequest, StageRow } from './api';
import { StagePanel, type ReviewContext } from './StagePanel';

const DONE = new Set(['Approved', 'Approved with conditions', 'Rejected']);
const OPEN = new Set(['In review', 'Waiting for requester']);

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

function slaText(stage: StageRow, now: number): string | null {
  if (!stage.sla_due_at || DONE.has(stage.status)) return null;
  if (stage.sla_paused) return 'SLA paused while waiting for the requester';
  const due = new Date(stage.sla_due_at);
  return due.getTime() < now ? `Overdue since ${formatDate(stage.sla_due_at)}` : `Due ${formatDate(stage.sla_due_at)}`;
}

interface Props {
  supabase: SupabaseClient;
  stages: StageRow[];
  answers: Answers;
  form: RequestFormDefinition | null;
  /** Review answers by stage id, for viewers who may see them. */
  reviewAnswers: Record<string, Answers>;
  questions: InfoRequest[];
  requesterId: string;
  context: ReviewContext;
  /** Stage to show expanded at first, for example when arriving from the review queue. */
  initialStageId?: string;
  onChanged: () => Promise<void> | void;
}

/** Review stages of a submitted request, with progress, reviewer, SLA and the review itself. */
export function StageList({ supabase, stages, answers, form, reviewAnswers, questions, requesterId, context, initialStageId, onChanged }: Props) {
  const [expanded, setExpanded] = useState<string | null>(initialStageId ?? null);

  if (stages.length === 0) {
    return <p className="empty">This request was submitted before review stages existed, so it has none.</p>;
  }

  const required = stages.filter((s) => s.status !== 'Not required');
  const done = required.filter((s) => DONE.has(s.status)).length;
  const now = Date.now();
  const nameOf = (userId: string) => context.members.find((m) => m.user_id === userId)?.email ?? 'a former member';

  return (
    <>
      <p className="progress-text">
        {done} of {required.length} checks done
      </p>
      <progress className="progress-line" max={required.length} value={done} aria-label="Review progress" />
      <ul className="stage-list">
        {stages.map((stage) => {
          const notRequired = stage.status === 'Not required';
          const isOpen = expanded === stage.id;
          const mine = OPEN.has(stage.status) && (context.isManager || stage.reviewer_id === context.userId);
          const meta = notRequired
            ? stage.note
            : [stage.reviewer_id ? `Reviewer: ${nameOf(stage.reviewer_id)}` : DONE.has(stage.status) ? null : 'No reviewer yet', slaText(stage, now)]
                .filter(Boolean)
                .join(' · ');
          return (
            <li key={stage.id} className="stage-item">
              <div className="stage-row">
                <span className="stage-main">
                  <span className="stage-name">{stage.name}</span>
                  <span className="stage-meta">{meta}</span>
                </span>
                <StatusBadge status={stage.status} />
                {!notRequired && (
                  <button
                    type="button"
                    className="button button-secondary button-small"
                    aria-expanded={isOpen}
                    aria-label={`${isOpen ? 'Close' : mine ? 'Review' : 'Details of'} ${stage.name}`}
                    onClick={() => setExpanded(isOpen ? null : stage.id)}
                  >
                    {isOpen ? 'Close' : mine ? 'Review' : 'Details'}
                  </button>
                )}
              </div>
              {isOpen && (
                <StagePanel
                  // A fresh panel after each decision, so typed text does not linger.
                  key={`${stage.id}-${stage.status}`}
                  supabase={supabase}
                  stage={stage}
                  answers={answers}
                  form={form}
                  reviewAnswers={reviewAnswers[stage.id]}
                  questions={questions.filter((q) => q.stage_id === stage.id)}
                  requesterId={requesterId}
                  context={context}
                  onChanged={onChanged}
                />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
