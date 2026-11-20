import { CONFIG_DECISION_LABELS, CONTROL_CATEGORIES, EXCEPTION_MAX_DAYS, isConfigTask, RISK_TIERS, type ConfigRequirement } from '@app/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { confirmConfiguration, listExceptions, requestException, setConfigDecision, type RequestRow, type ReviewException, type StageRow } from './api';
import { ExceptionItem } from './ExceptionItem';
import type { ReviewContext } from './StagePanel';

const addDays = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const DECISION_TONE: Record<string, string> = { required: 'review', not_applicable: 'idle', exception: 'waiting' };

function ExceptionForm({ onSubmit, onCancel }: { onSubmit: (v: { deviation: string; justification: string; compensating: string; riskLevel: string; expiresOn: string }) => Promise<void>; onCancel: () => void }) {
  const id = useId();
  const [v, setV] = useState({ deviation: '', justification: '', compensating: '', riskLevel: 'Medium', expiresOn: addDays(90) });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="exception-form">
      <p className="field-hint">
        An exception accepts a risk for a limited time. An org admin other than you must accept it before the security review can be
        approved.
      </p>
      <div className="field">
        <label htmlFor={`${id}-dev`}>What deviates from the control?</label>
        <textarea id={`${id}-dev`} rows={2} maxLength={1000} value={v.deviation} onChange={(e) => setV({ ...v, deviation: e.target.value })} placeholder="For example: SSO is only available in the enterprise plan." />
      </div>
      <div className="field">
        <label htmlFor={`${id}-why`}>Why is it acceptable for now? (business reason)</label>
        <textarea id={`${id}-why`} rows={2} maxLength={1000} value={v.justification} onChange={(e) => setV({ ...v, justification: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-comp`}>Compensating measures</label>
        <textarea id={`${id}-comp`} rows={2} maxLength={1000} value={v.compensating} onChange={(e) => setV({ ...v, compensating: e.target.value })} placeholder="For example: MFA for every account and a monthly access review." />
      </div>
      <div className="editor-row">
        <div className="field">
          <label htmlFor={`${id}-risk`}>Remaining risk</label>
          <select id={`${id}-risk`} value={v.riskLevel} onChange={(e) => setV({ ...v, riskLevel: e.target.value })}>
            {RISK_TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-until`}>Valid until (at most a year)</label>
          <input id={`${id}-until`} type="date" min={addDays(1)} max={addDays(EXCEPTION_MAX_DAYS)} value={v.expiresOn} onChange={(e) => setV({ ...v, expiresOn: e.target.value })} />
        </div>
      </div>
      <FormError message={error} />
      <div className="form-actions">
        <button
          type="button"
          className="button button-small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            onSubmit(v)
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Sending…' : 'Ask for the exception'}
        </button>
        <button type="button" className="button button-secondary button-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface Props {
  supabase: SupabaseClient;
  request: RequestRow;
  stages: StageRow[] | null;
  context: ReviewContext;
  onChanged: () => Promise<void> | void;
  /** Shown inside the security review's tab instead of as its own card. */
  embedded?: boolean;
}

/** Required controls still without a decision; they block approving the security review. */
export function openControls(request: RequestRow): number {
  return (request.config_requirements ?? []).filter((i) => i.level === 'required' && !i.decision).length;
}

/**
 * The security baseline of one request: during the security review the reviewer decides on
 * each control and can ask for exceptions; after approval the required controls become
 * configuration tasks.
 */
export function SecurityConfig({ supabase, request, stages, context, onChanged, embedded = false }: Props) {
  const items = request.config_requirements ?? [];
  const [exceptions, setExceptions] = useState<ReviewException[]>([]);
  const [open, setOpen] = useState<{ id: string; mode: 'na' | 'exception' } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reloadExceptions = useCallback(async () => {
    try {
      setExceptions(await listExceptions(supabase, request.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, request.id]);

  useEffect(() => {
    void reloadExceptions();
  }, [reloadExceptions, request.config_requirements]);

  if (items.length === 0 && exceptions.length === 0) return null;

  const me = context.members.find((m) => m.user_id === context.userId);
  const isAdmin = me?.role === 'org_admin';
  const security = stages?.find((s) => s.name === 'Security review');
  const reviewOpen = !!security && (security.status === 'In review' || security.status === 'Waiting for requester');
  const canReview =
    reviewOpen && (context.isManager || security!.reviewer_id === context.userId) && (request.requester_id !== context.userId || context.allowSelfReview);
  const approved = request.status === 'approved';
  const canConfirm = approved && (request.requester_id === context.userId || context.isManager);
  const nameOf = (userId: string | null) => (userId === context.userId ? 'you' : (context.members.find((m) => m.user_id === userId)?.email ?? 'a former member'));

  const undecided = items.filter((i) => i.level === 'required' && !i.decision).length;
  const tasks = items.filter(isConfigTask);
  const configured = tasks.filter((i) => i.configured).length;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setOpen(null);
      setNote('');
      await onChanged();
      await reloadExceptions();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const row = (item: ConfigRequirement) => {
    const isOpen = open?.id === item.id;
    const covered = exceptions.find((e) => e.control_id === item.id && (e.status === 'pending' || e.status === 'approved'));
    return (
      <li key={item.id} className={`config-item${item.configured ? ' is-done' : ''}`}>
        <div className="config-head">
          <span className="config-title">
            {approved && isConfigTask(item) && (
              <input
                type="checkbox"
                aria-label={`${item.title}: configured`}
                checked={item.configured}
                disabled={!canConfirm || busy}
                onChange={(e) => void run(() => confirmConfiguration(supabase, request.id, item.id, e.target.checked))}
              />
            )}
            <strong>{item.title}</strong>
          </span>
          <span className="badges">
            <span className="status-badge" data-tone={item.level === 'required' ? 'review' : 'idle'}>
              {item.level === 'required' ? 'Required' : 'Recommended'}
            </span>
            {item.decision && (
              <span className="status-badge" data-tone={DECISION_TONE[item.decision]}>
                {CONFIG_DECISION_LABELS[item.decision]}
              </span>
            )}
            {!item.decision && item.level === 'required' && reviewOpen && (
              <span className="status-badge" data-tone="waiting">
                To decide
              </span>
            )}
          </span>
        </div>
        <p className="config-text">{item.requirement}</p>
        {item.verification && <p className="stage-meta">How to verify: {item.verification}</p>}
        {item.note && <p className="stage-meta">Note: {item.note}</p>}
        {item.configured && item.configured_at && (
          <p className="stage-meta">
            Configured, confirmed by {nameOf(item.configured_by)} on {new Date(item.configured_at).toLocaleDateString('en-GB', { dateStyle: 'medium' })}
          </p>
        )}
        {canReview && !covered && (
          <div className="form-actions config-actions">
            <button
              type="button"
              className="button button-secondary button-small"
              aria-pressed={item.decision === 'required'}
              disabled={busy}
              onClick={() => void run(() => setConfigDecision(supabase, request.id, item.id, 'required', null))}
            >
              Must be configured
            </button>
            <button type="button" className="button button-secondary button-small" aria-pressed={item.decision === 'not_applicable'} disabled={busy} onClick={() => setOpen({ id: item.id, mode: 'na' })}>
              Not applicable
            </button>
            <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => setOpen({ id: item.id, mode: 'exception' })}>
              Ask for an exception
            </button>
          </div>
        )}
        {isOpen && open.mode === 'na' && (
          <div className="exception-form">
            <div className="field">
              <label htmlFor={`na-${item.id}`}>Why does “{item.title}” not apply?</label>
              <input id={`na-${item.id}`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="form-actions">
              <button type="button" className="button button-small" disabled={busy} onClick={() => void run(() => setConfigDecision(supabase, request.id, item.id, 'not_applicable', note))}>
                Save
              </button>
              <button type="button" className="button button-secondary button-small" onClick={() => setOpen(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {isOpen && open.mode === 'exception' && (
          <ExceptionForm
            onCancel={() => setOpen(null)}
            onSubmit={async (v) => {
              await requestException(supabase, request.id, { controlId: item.id, ...v });
              setOpen(null);
              await onChanged();
              await reloadExceptions();
            }}
          />
        )}
      </li>
    );
  };

  return (
    <section className={`security-config${embedded ? '' : ' card'}`} aria-labelledby="security-config-heading">
      {embedded ? (
        <h4 id="security-config-heading">Security configuration</h4>
      ) : (
        <h2 id="security-config-heading">Security configuration</h2>
      )}
      <p>
        {approved
          ? `What must be configured in the service. ${configured} of ${tasks.length} confirmed.`
          : reviewOpen
            ? undecided > 0
              ? `The security reviewer decides on each control: ${undecided} required ${undecided === 1 ? 'control is' : 'controls are'} still open.`
              : 'Every required control has a decision.'
            : 'The controls from the security baseline that apply to this request.'}
      </p>
      {approved && tasks.length > 0 && (
        <div className="progress-track" role="progressbar" aria-label="Controls configured" aria-valuemin={0} aria-valuemax={tasks.length} aria-valuenow={configured}>
          <span style={{ width: `${Math.round((configured * 100) / tasks.length)}%` }} />
        </div>
      )}
      <FormError message={error} />
      {canReview && undecided > 0 && (
        <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void run(() => setConfigDecision(supabase, request.id, null, 'required', null))}>
          Mark the {undecided} open {undecided === 1 ? 'control' : 'controls'} as “must be configured”
        </button>
      )}
      {CONTROL_CATEGORIES.map((category) => {
        const inCategory = items.filter((i) => i.category === category);
        if (inCategory.length === 0) return null;
        return (
          <div key={category} className="config-group">
            <h3>{category}</h3>
            <ul className="config-list">{inCategory.map(row)}</ul>
          </div>
        );
      })}

      {exceptions.length > 0 && (
        <div className="config-group">
          <h3>Exceptions</h3>
          <ul className="exception-list">
            {exceptions.map((e) => (
              <ExceptionItem key={e.id} supabase={supabase} exception={e} userId={context.userId} isAdmin={isAdmin} nameOf={nameOf} onChanged={async () => {
                await onChanged();
                await reloadExceptions();
              }} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
