import { EXCEPTION_LIMITS, EXCEPTION_MAX_DAYS } from '@app/shared';
import { useId, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { raiseStageException } from './api';

const RISK_LEVELS = ['Low', 'Medium', 'High', 'Critical'] as const;
const isoIn = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

interface Props {
  supabase: SupabaseClient;
  stageId: string;
  stageName: string;
  /** Checklist items of the stage the exception may be tied to. */
  checklist: string[];
  onRaised: () => Promise<void> | void;
  onCancel: () => void;
}

/**
 * The reviewer asks to accept a deviation found in this review. An org admin other than
 * the reviewer decides; until then the review cannot be approved.
 */
export function RaiseException({ supabase, stageId, stageName, checklist, onRaised, onCancel }: Props) {
  const id = useId();
  const [title, setTitle] = useState('');
  const [checklistItem, setChecklistItem] = useState('');
  const [deviation, setDeviation] = useState('');
  const [justification, setJustification] = useState('');
  const [compensating, setCompensating] = useState('');
  const [riskLevel, setRiskLevel] = useState<string>('Medium');
  const [expiresOn, setExpiresOn] = useState(isoIn(90));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const missing = [
      !title.trim() && !checklistItem && 'a short title',
      !deviation.trim() && 'what deviates',
      !justification.trim() && 'why it is needed',
      !compensating.trim() && 'compensating measures',
    ].filter(Boolean);
    if (missing.length > 0) {
      setError(`Fill in ${missing.join(', ')}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await raiseStageException(supabase, stageId, {
        title: title.trim(),
        deviation: deviation.trim(),
        justification: justification.trim(),
        compensating: compensating.trim(),
        riskLevel,
        expiresOn,
        controlId: null,
        checklistItem: checklistItem || null,
      });
      await onRaised();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="raise-exception" onSubmit={(e) => void submit(e)} noValidate aria-labelledby={`${id}-heading`}>
      <h4 id={`${id}-heading`}>Raise an exception in the {stageName.toLowerCase()}</h4>
      <p className="field-hint">
        Use it when the service may be used although something found in this review is not met. An org admin other than you
        accepts or refuses the risk; until then this review cannot be approved.
      </p>
      <div className="field">
        <label htmlFor={`${id}-title`}>Short title</label>
        <input id={`${id}-title`} value={title} maxLength={120} placeholder="For example: more seats than the licence allows" onChange={(e) => setTitle(e.target.value)} />
      </div>
      {checklist.length > 0 && (
        <div className="field">
          <label htmlFor={`${id}-item`}>
            Checklist item it concerns <span className="optional">(optional)</span>
          </label>
          <select id={`${id}-item`} value={checklistItem} onChange={(e) => setChecklistItem(e.target.value)}>
            <option value="">None</option>
            {checklist.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor={`${id}-deviation`}>What deviates</label>
        <textarea id={`${id}-deviation`} rows={2} maxLength={EXCEPTION_LIMITS.deviation} value={deviation} onChange={(e) => setDeviation(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-why`}>Why it is needed</label>
        <textarea id={`${id}-why`} rows={2} maxLength={EXCEPTION_LIMITS.justification} value={justification} onChange={(e) => setJustification(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-measures`}>Compensating measures</label>
        <textarea id={`${id}-measures`} rows={2} maxLength={EXCEPTION_LIMITS.compensating} value={compensating} onChange={(e) => setCompensating(e.target.value)} />
      </div>
      <div className="editor-row">
        <div className="field">
          <label htmlFor={`${id}-risk`}>Remaining risk</label>
          <select id={`${id}-risk`} value={riskLevel} onChange={(e) => setRiskLevel(e.target.value)}>
            {RISK_LEVELS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-until`}>Valid until</label>
          <input id={`${id}-until`} type="date" min={isoIn(1)} max={isoIn(EXCEPTION_MAX_DAYS)} value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </div>
      </div>
      <FormError message={error} />
      <div className="form-actions">
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'Sending…' : 'Send for approval'}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
