import type { Answers, RequestFormDefinition } from '@app/shared';
import { useEffect, useState, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { StatusBadge } from '../components/StatusBadge';
import type { InfoRequest, ReviewException, StageRow } from './api';
import { inReviewScope } from '../org/api';
import { dueText, StagePanel, type ReviewContext, type StageTab } from './StagePanel';

const DONE = new Set(['Approved', 'Approved with conditions', 'Rejected']);
const OPEN = new Set(['In review', 'Waiting for requester']);

function slaText(stage: StageRow, now: number): string | null {
  if (!stage.sla_due_at || DONE.has(stage.status)) return null;
  if (stage.sla_paused) return 'Clock paused while waiting for the requester';
  const due = dueText(stage.sla_due_at, now).text;
  return due.charAt(0).toUpperCase() + due.slice(1);
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
  /** Configuration controls, shown inside the security review. */
  securityControls?: ReactNode;
  securityControlsOpen?: number;
  /** Exceptions of the request; each stage shows its own. */
  exceptions?: ReviewException[];
  /** Opens a stage from elsewhere on the page; a new `n` opens it again. */
  focus?: { stageId: string; n: number } | null;
  onChanged: () => Promise<void> | void;
}

/** Review stages of a submitted request, with progress, reviewer, SLA and the review itself. */
export function StageList({ supabase, stages, answers, form, reviewAnswers, questions, requesterId, context, initialStageId, securityControls, securityControlsOpen, exceptions = [], focus, onChanged }: Props) {
  const [expanded, setExpanded] = useState<string | null>(initialStageId ?? null);
  // The open tab of each stage, kept here: the panel is rebuilt after every decision or question.
  const [tabs, setTabs] = useState<Record<string, StageTab>>({});

  useEffect(() => {
    if (!focus) return;
    setExpanded(focus.stageId);
    setTabs((cur) => ({ ...cur, [focus.stageId]: 'exceptions' }));
    document.getElementById(`stage-${focus.stageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus]);

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
          const mine =
            OPEN.has(stage.status) &&
            (context.isManager || stage.reviewer_id === context.userId) &&
            inReviewScope(context.reviewScope, stage.name) &&
            !context.readOnly &&
            (requesterId !== context.userId || context.allowSelfReview);
          const yourTurn = mine && (stage.reviewer_id === context.userId || stage.reviewer_id === null);
          const meta = notRequired
            ? stage.note
            : [stage.reviewer_id ? `Reviewer: ${nameOf(stage.reviewer_id)}` : DONE.has(stage.status) ? null : 'No reviewer yet', slaText(stage, now)]
                .filter(Boolean)
                .join(' · ');
          return (
            <li key={stage.id} id={`stage-${stage.id}`} className={`stage-item${yourTurn ? ' your-turn' : ''}${isOpen ? ' is-open' : ''}`}>
              <div className="stage-row">
                <span className="stage-main">
                  <span className="stage-name">
                    {stage.name}
                    {yourTurn && <span className="your-turn-tag">Your review</span>}
                    {(() => {
                      const own = exceptions.filter((e) => e.stage_id === stage.id && (e.status === 'pending' || e.status === 'approved'));
                      if (own.length === 0) return null;
                      const waiting = own.some((e) => e.status === 'pending');
                      return (
                        <span className="status-badge exception-badge" data-tone="waiting">
                          {own.length} {own.length === 1 ? 'exception' : 'exceptions'}
                          {waiting ? ', waiting' : ''}
                        </span>
                      );
                    })()}
                  </span>
                  <span className="stage-meta">{meta}</span>
                </span>
                <StatusBadge status={stage.status} />
                {!notRequired && (
                  <button
                    type="button"
                    className={`button button-small${mine && !isOpen ? '' : ' button-secondary'}`}
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
                  initialTab={tabs[stage.id]}
                  onTabChange={(t) => setTabs((cur) => ({ ...cur, [stage.id]: t }))}
                  controls={stage.name === 'Security review' ? securityControls : undefined}
                  controlsOpen={stage.name === 'Security review' ? securityControlsOpen : undefined}
                  exceptions={exceptions.filter((e) => e.stage_id === stage.id)}
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
