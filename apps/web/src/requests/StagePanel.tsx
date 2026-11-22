import { focusFieldsForStage, validateReviewAnswers, type Answers, type RequestFormDefinition, type StageDecision } from '@app/shared';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { inReviewScope, type Member } from '../org/api';
import { AnswerSummary } from './AnswerSummary';
import { assignReviewer, decideStage, saveReviewAnswers, setChecklistItem, type InfoRequest, type StageRow } from './api';
import { AskForm, QuestionThread } from './Questions';
import { Guide } from './Guide';
import { ReviewForm } from './ReviewForm';

export interface ReviewContext {
  userId: string;
  /** Org admins and process managers may review any stage and assign reviewers. */
  isManager: boolean;
  allowSelfReview: boolean;
  members: Member[];
  /** Review guides by stage name, written by the organization. */
  guides?: Record<string, string>;
  /** Display name of the external review service, when one is connected. */
  externalServiceName?: string;
  /** Names of the organization's review services by id. */
  reviewServices?: Record<string, string>;
  /** Reviews the signed-in (or previewed) person works on; null or absent means all. */
  reviewScope?: string[] | null;
  /** An admin's "view as" preview: everything is shown, nothing can be changed. */
  readOnly?: boolean;
  /** In a preview: the requests the previewed member can see. Absent means no filter. */
  visibleRequestIds?: Set<string> | null;
}

interface Props {
  supabase: SupabaseClient;
  stage: StageRow;
  answers: Answers;
  /** The form the request was filled in with; null for the standard form. */
  form: RequestFormDefinition | null;
  /** This stage's review answers; undefined when the viewer may not see them. */
  reviewAnswers: Answers | undefined;
  /** Questions to the requester asked in this stage. */
  questions: InfoRequest[];
  requesterId: string;
  context: ReviewContext;
  /** Security review only: the configuration controls, shown in their own tab. */
  controls?: ReactNode;
  /** Required controls still without a decision; they block approval. */
  controlsOpen?: number;
  /** The tab to show first, kept by the parent so it survives the panel being rebuilt after a change. */
  initialTab?: Tab;
  onTabChange?: (tab: Tab) => void;
  /** Called after any change so the parent reloads the stages and the request. */
  onChanged: () => Promise<void> | void;
}

export type StageTab = 'guide' | 'request' | 'form' | 'checklist' | 'controls' | 'questions' | 'decision';
type Tab = StageTab;

const OPEN = new Set(['In review', 'Waiting for requester']);
const REVIEWER_ROLES = new Set(['org_admin', 'process_manager', 'reviewer']);

const formatDateTime = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

/** "due in 3 days", "due today", "2 days overdue". */
export function dueText(iso: string, now = Date.now()): { text: string; overdue: boolean } {
  const days = Math.round((new Date(iso).getTime() - now) / 86_400_000);
  if (days < 0) return { text: `${-days} ${days === -1 ? 'day' : 'days'} overdue (due ${formatDate(iso)})`, overdue: true };
  if (days === 0) return { text: `due today`, overdue: false };
  return { text: `due in ${days} ${days === 1 ? 'day' : 'days'} (${formatDate(iso)})`, overdue: false };
}

const DECISIONS: { value: StageDecision; title: string; text: string }[] = [
  { value: 'Approved', title: 'Approve', text: 'Everything is in order. The checklist is complete.' },
  {
    value: 'Approved with conditions',
    title: 'Approve with conditions',
    text: 'The service may be used if the conditions you write are met, for example “enable SSO before rollout”.',
  },
  { value: 'Rejected', title: 'Reject', text: 'The service must not be used. Explain why, so the requester can react.' },
];

/** Everything about one stage, in tabs: the request, the review form, the checklist, questions and the decision. */
export function StagePanel({ supabase, stage: raw, answers, form, reviewAnswers, questions, requesterId, context, controls, controlsOpen = 0, initialTab, onTabChange, onChanged }: Props) {
  // Older stages may lack the review form columns.
  const stage = { ...raw, review_fields: raw.review_fields ?? [], review_rules: raw.review_rules ?? [], checklist: raw.checklist ?? [] };
  const id = useId();
  const [comment, setComment] = useState('');
  const [conditions, setConditions] = useState('');
  const [choice, setChoice] = useState<StageDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Ticks show at once and are dropped again once the server answered, either way.
  const [ticking, setTicking] = useState<Record<number, boolean>>({});

  // Review form answers: kept here, saved shortly after each change.
  const [review, setReview] = useState<Answers>(reviewAnswers ?? {});
  const [reviewState, setReviewState] = useState<'saved' | 'saving' | 'unsaved' | 'error'>('saved');
  const [reviewError, setReviewError] = useState<string | null>(null);
  const storedReview = useRef(review);
  const latestReview = useRef(review);
  latestReview.current = review;

  async function flushReview(): Promise<boolean> {
    const snapshot = latestReview.current;
    if (snapshot === storedReview.current) return true;
    setReviewState('saving');
    try {
      await saveReviewAnswers(supabase, stage.id, snapshot);
      storedReview.current = snapshot;
      setReviewState(latestReview.current === snapshot ? 'saved' : 'unsaved');
      setReviewError(null);
      return true;
    } catch (e) {
      setReviewState('error');
      setReviewError(errorMessage(e));
      return false;
    }
  }

  useEffect(() => {
    if (review === storedReview.current) return;
    setReviewState('unsaved');
    const timer = setTimeout(() => void flushReview(), 800);
    return () => clearTimeout(timer);
    // flushReview only reads refs and stable props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [review]);

  const open = OPEN.has(stage.status);
  const external = stage.external === true;
  // Outside the person's review scope the stage is shown for information only.
  const mayReview = !external && inReviewScope(context.reviewScope, stage.name) && (context.isManager || stage.reviewer_id === context.userId);
  const ownRequest = requesterId === context.userId && !context.allowSelfReview;
  const canAct = open && mayReview && !ownRequest && !context.readOnly;
  const nameOf = (userId: string | null) => (userId ? (context.members.find((m) => m.user_id === userId)?.email ?? 'a former member') : null);
  const isChecked = (index: number) => ticking[index] ?? stage.checklist[index]!.checked;
  const checkedCount = stage.checklist.filter((_, i) => isChecked(i)).length;
  const allChecked = checkedCount === stage.checklist.length;
  const hasForm = stage.review_fields.length > 0 && (canAct || reviewAnswers !== undefined);
  const missing = validateReviewAnswers(stage.review_fields, review, true);
  const missingCount = Object.keys(missing).length;
  const requiredCount = stage.review_fields.filter((f) => f.required).length;
  const formComplete = missingCount === 0;
  const focus = focusFieldsForStage(stage.name);
  const openQuestions = questions.filter((q) => q.answered_at === null).length;

  // What blocks each decision, in words.
  const blockers: Record<StageDecision, string[]> = {
    Approved: [
      ...(allChecked ? [] : ['tick every checklist item']),
      ...(formComplete ? [] : ['answer the required questions of the review form']),
      ...(controlsOpen > 0 ? ['decide on every required configuration control'] : []),
    ],
    'Approved with conditions': [
      ...(formComplete ? [] : ['answer the required questions of the review form']),
      ...(controlsOpen > 0 ? ['decide on every required configuration control'] : []),
    ],
    Rejected: [],
  };

  const guide = context.guides?.[stage.name]?.trim() ?? '';
  const tabs: { id: Tab; label: string; badge?: string; done?: boolean }[] = external ? [] : [
    ...(guide && (canAct || mayReview) ? [{ id: 'guide' as const, label: 'Guide' }] : []),
    ...(focus.length > 0 ? [{ id: 'request' as const, label: 'Request' }] : []),
    ...(hasForm
      ? [{ id: 'form' as const, label: 'Review form', badge: requiredCount > 0 ? `${requiredCount - missingCount}/${requiredCount}` : undefined, done: formComplete }]
      : []),
    ...(stage.checklist.length > 0 ? [{ id: 'checklist' as const, label: 'Checklist', badge: `${checkedCount}/${stage.checklist.length}`, done: allChecked }] : []),
    ...(controls ? [{ id: 'controls' as const, label: 'Configuration', badge: controlsOpen > 0 ? `${controlsOpen} open` : undefined, done: controlsOpen === 0 }] : []),
    ...(questions.length > 0 || canAct ? [{ id: 'questions' as const, label: 'Questions', badge: questions.length > 0 ? String(questions.length) : undefined, done: questions.length > 0 && openQuestions === 0 }] : []),
    ...(canAct || stage.decided_at ? [{ id: 'decision' as const, label: 'Decision', done: !!stage.decided_at }] : []),
  ];
  const [tab, setTabState] = useState<Tab>(() => initialTab ?? (stage.decided_at ? 'decision' : (tabs[0]?.id ?? 'decision')));
  const setTab = (next: Tab) => {
    setTabState(next);
    onTabChange?.(next);
  };
  const current = tabs.some((t) => t.id === tab) ? tab : (tabs[0]?.id ?? 'decision');

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    setTab(next.id);
    document.getElementById(`${id}-tab-${next.id}`)?.focus();
  }

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

  function decide() {
    if (!choice) {
      setError('Choose a decision.');
      return;
    }
    if (choice === 'Approved with conditions' && conditions.trim() === '') {
      setError('Describe the conditions.');
      return;
    }
    if (choice === 'Rejected' && comment.trim() === '') {
      setError('Explain why the stage is rejected.');
      return;
    }
    void run(async () => {
      if (!(await flushReview())) throw new Error('Could not save the review form. Fix it before deciding.');
      await decideStage(supabase, stage.id, choice, comment, conditions);
    });
  }

  const goto = (t: Tab) => () => setTab(t);
  const readiness: { ok: boolean; text: string; tab?: Tab; note?: boolean }[] = [
    ...(stage.checklist.length > 0
      ? [{ ok: allChecked, text: allChecked ? 'Checklist complete' : `Checklist: ${checkedCount} of ${stage.checklist.length} ticked (needed to approve without conditions)`, tab: 'checklist' as const }]
      : []),
    ...(hasForm && requiredCount > 0
      ? [{ ok: formComplete, text: formComplete ? 'Review form: required questions answered' : `Review form: ${missingCount} required ${missingCount === 1 ? 'question' : 'questions'} open (needed to approve)`, tab: 'form' as const }]
      : []),
    ...(controls
      ? [{ ok: controlsOpen === 0, text: controlsOpen === 0 ? 'Configuration: every required control decided' : `Configuration: ${controlsOpen} required ${controlsOpen === 1 ? 'control' : 'controls'} without a decision (needed to approve)`, tab: 'controls' as const }]
      : []),
    ...(openQuestions > 0 ? [{ ok: false, note: true, text: `${openQuestions} ${openQuestions === 1 ? 'question waits' : 'questions wait'} for the requester’s answer`, tab: 'questions' as const }] : []),
  ];

  if (external) {
    const service = (stage.external_service && context.reviewServices?.[stage.external_service]) || context.externalServiceName || 'an external service';
    return (
      <div className="stage-panel external-stage">
        <p>
          <strong>Reviewed in {service}.</strong> The status here comes from that service: it changes when the reviewers there
          update it, and nobody can change it in this app.
        </p>
        <p className="stage-meta">
          Status: {stage.status}
          {stage.external_id ? ` · reference ${stage.external_id}` : ''}
          {open && stage.sla_due_at ? ` · ${dueText(stage.sla_due_at).text}` : ''}
        </p>
        {stage.external_url && (
          <a className="button button-secondary button-small" href={stage.external_url} target="_blank" rel="noopener noreferrer">
            Open in {service}
          </a>
        )}
        {stage.decided_at && (
          <div className="decision">
            <p>
              <strong>{stage.status}</strong> in {service} on {formatDateTime(stage.decided_at)}.
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
      </div>
    );
  }

  return (
    <div className="stage-panel">
      <div className="stage-panel-head">
        {open && context.isManager && !context.readOnly ? (
          <div className="field">
            <label htmlFor={`${id}-reviewer`}>Reviewer</label>
            <select id={`${id}-reviewer`} value={stage.reviewer_id ?? ''} disabled={busy} onChange={(e) => void run(() => assignReviewer(supabase, stage.id, e.target.value || null))}>
              <option value="">Not assigned (org admins and process managers can review)</option>
              {context.members
                // Only people whose review scope includes this review.
                .filter((m) => REVIEWER_ROLES.has(m.role) && inReviewScope(m.review_scope, stage.name))
                .map((m) => (
                  <option key={m.user_id} value={m.user_id}>
                    {m.email ?? m.user_id}
                  </option>
                ))}
            </select>
          </div>
        ) : (
          <p className="stage-meta">Reviewer: {nameOf(stage.reviewer_id) ?? 'not assigned yet'}</p>
        )}
        {open && stage.sla_due_at && (
          <p className={`stage-due${dueText(stage.sla_due_at).overdue ? ' overdue' : ''}`}>
            {stage.sla_paused ? 'Clock paused while the requester answers' : `Review ${dueText(stage.sla_due_at).text}`}
          </p>
        )}
      </div>

      {context.readOnly && open && <p className="notice">Preview: actions are switched off.</p>}
      {open && mayReview && ownRequest && !context.readOnly && <p className="notice">You cannot review your own request. An org admin can allow this in the Admin settings.</p>}

      {tabs.length > 0 && (
        <div className="stage-tabs" role="tablist" aria-label={`${stage.name} sections`}>
          {tabs.map((t, i) => (
            <button
              key={t.id}
              id={`${id}-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={current === t.id}
              aria-controls={`${id}-panel`}
              tabIndex={current === t.id ? 0 : -1}
              onKeyDown={(e) => onTabKey(e, i)}
              onClick={() => setTab(t.id)}
              data-done={t.done ? 'true' : undefined}
            >
              {t.done && <span aria-hidden="true">✓ </span>}
              {t.label}
              {t.badge && <span className="tab-badge">{t.badge}</span>}
            </button>
          ))}
        </div>
      )}

      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${current}`} className="stage-tab-panel">
        {current === 'guide' && <Guide text={guide} />}

        {current === 'request' && (
          <>
            <p className="field-hint">The answers that matter most for the {stage.name.toLowerCase()}. All answers are under “Request details” further down.</p>
            <AnswerSummary form={form} answers={answers} fields={focus} />
          </>
        )}

        {current === 'form' && hasForm && (
          <div className="stage-review-form">
            <div className="form-top">
              <p className="field-hint">
                {canAct ? 'Your answers save automatically. Sections with required answers still missing are open.' : 'The reviewer’s answers.'}
              </p>
              {canAct && (
                <p className="save-state" role="status" data-state={reviewState}>
                  {{ saved: 'Saved', saving: 'Saving…', unsaved: 'Unsaved changes', error: 'Not saved' }[reviewState]}
                </p>
              )}
            </div>
            <FormError message={reviewError} />
            <ReviewForm
              fields={stage.review_fields}
              rules={stage.review_rules}
              answers={review}
              requestAnswers={answers}
              onChange={canAct ? (key, value) => setReview((cur) => ({ ...cur, [key]: value })) : null}
              missing={canAct ? Object.fromEntries(Object.keys(missing).map((k) => [k, 'Answer this before approving.'])) : {}}
            />
          </div>
        )}

        {current === 'checklist' && (
          <fieldset className="field">
            <legend>What you confirm</legend>
            <div className="choices checklist-cards">
              {stage.checklist.map((item, index) => (
                <label key={item.label} className="choice">
                  <input
                    type="checkbox"
                    checked={isChecked(index)}
                    disabled={!canAct}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setTicking((cur) => ({ ...cur, [index]: checked }));
                      void run(() => setChecklistItem(supabase, stage.id, index, checked)).finally(() => setTicking(({ [index]: _done, ...rest }) => rest));
                    }}
                  />
                  {item.label}
                </label>
              ))}
            </div>
            {canAct && !allChecked && <p className="field-hint">Untick what you could not confirm; you can still approve with conditions.</p>}
          </fieldset>
        )}

        {current === 'controls' && (
          // In a read-only preview the controls are shown, every button inside disabled.
          <fieldset className="readonly-fieldset" disabled={!!context.readOnly}>
            {controls}
          </fieldset>
        )}

        {current === 'questions' && (
          <div className="stage-questions">
            {questions.length === 0 && <p className="empty">No questions yet. Ask the requester if something is unclear; the review clock pauses until they answer.</p>}
            <QuestionThread questions={questions} nameOf={(userId) => nameOf(userId) ?? 'A former member'} />
            {canAct && <AskForm supabase={supabase} stageId={stage.id} onAsked={onChanged} />}
          </div>
        )}

        {current === 'decision' && stage.decided_at && (
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

        {current === 'decision' && canAct && (
          <div className="decide">
            {readiness.length > 0 && (
              <>
                <h4>Before you decide</h4>
                <ul className="readiness">
                  {readiness.map((r) => (
                    <li key={r.text} className={r.ok ? 'ok' : r.note ? 'note' : 'todo'}>
                      <span aria-hidden="true">{r.ok ? '✓' : r.note ? 'i' : '!'}</span>
                      <span>{r.text}</span>
                      {!r.ok && r.tab && (
                        <button type="button" className="link-button" onClick={goto(r.tab)}>
                          Open
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
            <fieldset className="field">
              <legend>Your decision</legend>
              <div className="decision-cards">
                {DECISIONS.map((d) => {
                  const blocked = blockers[d.value];
                  return (
                    <label key={d.value} className={`decision-card${choice === d.value ? ' selected' : ''}${blocked.length ? ' blocked' : ''}`} data-decision={d.value}>
                      <input type="radio" name={`${id}-decision`} value={d.value} checked={choice === d.value} disabled={blocked.length > 0} onChange={() => setChoice(d.value)} />
                      <span>
                        <strong>{d.title}</strong>
                        <span className="decision-text">{blocked.length > 0 ? `First ${blocked.join(' and ')}.` : d.text}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            {choice === 'Approved with conditions' && (
              <div className="field">
                <label htmlFor={`${id}-conditions`}>Conditions the requester must meet</label>
                <textarea id={`${id}-conditions`} rows={3} maxLength={2000} value={conditions} onChange={(e) => setConditions(e.target.value)} />
              </div>
            )}
            {choice && (
              <div className="field">
                <label htmlFor={`${id}-comment`}>
                  Comment {choice === 'Rejected' ? <span className="optional">(required: why is it rejected?)</span> : <span className="optional">(optional)</span>}
                </label>
                <textarea id={`${id}-comment`} rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
              </div>
            )}
            <FormError message={error} />
            <button type="button" className={`button${choice === 'Rejected' ? ' button-danger' : ''}`} disabled={busy || !choice} onClick={decide}>
              {busy ? 'Saving…' : choice ? `Submit: ${DECISIONS.find((d) => d.value === choice)!.title.toLowerCase()}` : 'Choose a decision'}
            </button>
          </div>
        )}
        {current !== 'decision' && <FormError message={error} />}
      </div>
    </div>
  );
}
