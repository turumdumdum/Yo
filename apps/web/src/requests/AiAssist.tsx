import { fieldLabel, formatAnswer, REQUEST_FORM_STEPS, type AiRemark, type AiSuggestion, type Answers } from '@app/shared';
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { aiCheck, aiSuggestions } from './api';

const FIELDS = new Map(REQUEST_FORM_STEPS.flatMap((s) => s.fields).map((f) => [f.key, f]));
const STEP_OF = new Map(REQUEST_FORM_STEPS.flatMap((s, i) => s.fields.map((f) => [f.key, i] as const)));

interface Props {
  supabase: SupabaseClient;
  requestId: string;
  /** Name of the AI provider, shown so people know where their data goes. */
  provider: string;
  mode: 'suggest' | 'check';
  answers: Answers;
  /** Stores the latest answers; the AI reads the saved draft. Resolves to false when saving failed. */
  save: () => Promise<boolean>;
  onApply: (field: string, value: unknown) => void;
  /** Suggest mode: receives the proposals, which the form shows under each field. */
  onSuggestions?: (suggestions: AiSuggestion[]) => void;
}

/**
 * Optional AI help inside the request form. Suggestions are labelled "Suggested" and
 * change nothing until the requester applies them; remarks never block submission.
 */
export function AiAssist({ supabase, requestId, provider, mode, answers, save, onApply, onSuggestions }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<AiSuggestion[] | null>(null);
  const [remarks, setRemarks] = useState<AiRemark[] | null>(null);
  const [seconds, setSeconds] = useState(0);

  // Show that something is happening while the provider works.
  useEffect(() => {
    if (!busy) return;
    setSeconds(0);
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      if (!(await save())) throw new Error('Could not save your answers. Check your connection and try again.');
      if (mode === 'suggest') {
        const found = await aiSuggestions(supabase, requestId);
        setSuggestions(found);
        onSuggestions?.(found);
      }
      else setRemarks(await aiCheck(supabase, requestId));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const dismiss = (field: string) => setSuggestions((current) => current?.filter((s) => s.field !== field) ?? null);
  const suggest = mode === 'suggest';

  return (
    <section className="ai-assist" aria-labelledby={`ai-${mode}-heading`}>
      <div className="ai-head">
        <h2 id={`ai-${mode}-heading`}>{suggest ? 'Look up the vendor with AI' : 'Check the answers with AI'}</h2>
        <button type="button" className="button button-secondary button-small" disabled={busy} onClick={() => void ask()}>
          {busy ? `Working… ${seconds}s` : suggest ? 'Suggest vendor details' : 'Check with AI'}
        </button>
      </div>
      <p className="field-hint">
        {suggest
          ? `Optional. Sends the service name, vendor and website to ${provider} and proposes values you can accept or ignore.`
          : `Optional. Sends your answers, without the names of owners, to ${provider}. Remarks are advice only.`}
        {busy && ' This can take up to two minutes; you can keep filling in the form meanwhile.'}
      </p>
      <FormError message={error} />

      <div role="status">
        {suggestions && suggestions.length === 0 && <p className="empty">No new suggestions.</p>}
        {onSuggestions && suggestions && suggestions.length > 0 && (
          <p className="empty">
            {suggestions.length} {suggestions.length === 1 ? 'suggestion is' : 'suggestions are'} shown under the fields
            {suggestions.some((sg) => STEP_OF.get(sg.field) === 1) ? ', on this step and on “Entities & geography”' : ''}. Use
            one to fill the field, edit it as you like, or type your own answer.
          </p>
        )}
        {remarks && remarks.length === 0 && <p className="empty">Nothing stood out.</p>}
      </div>

      {!onSuggestions && suggestions && suggestions.length > 0 && (
        <ul className="ai-list">
          {suggestions.map((s) => {
            const field = FIELDS.get(s.field);
            if (!field) return null;
            const current = answers[s.field];
            return (
              <li key={s.field}>
                <p>
                  <span className="suggested-tag">Suggested</span> <strong>{field.label}:</strong> {formatAnswer(field, s.value)}
                </p>
                {current !== undefined && current !== '' && (
                  <p className="stage-meta">Your current answer: {formatAnswer(field, current)}</p>
                )}
                {s.reason && <p className="stage-meta">{s.reason}</p>}
                {s.sources.length > 0 && (
                  <p className="stage-meta">
                    Sources:{' '}
                    {s.sources.map((source, i) => (
                      <span key={source.url}>
                        {i > 0 && ', '}
                        <a href={source.url} target="_blank" rel="noreferrer noopener">
                          {source.title || new URL(source.url).hostname}
                        </a>
                      </span>
                    ))}
                  </p>
                )}
                <div className="form-actions">
                  <button
                    type="button"
                    className="button button-small"
                    aria-label={`Apply suggested ${field.label}`}
                    onClick={() => {
                      onApply(s.field, s.value);
                      dismiss(s.field);
                    }}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="button button-secondary button-small"
                    aria-label={`Dismiss suggested ${field.label}`}
                    onClick={() => dismiss(s.field)}
                  >
                    Dismiss
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {remarks && remarks.length > 0 && (
        <ul className="ai-list">
          {remarks.map((r, i) => (
            <li key={i}>
              <p>
                <span className="suggested-tag">{r.severity === 'warning' ? 'AI warning' : 'AI tip'}</span>{' '}
                {r.field && <strong>{fieldLabel(r.field)}: </strong>}
                {r.message}
              </p>
            </li>
          ))}
        </ul>
      )}
      {suggestions?.length || remarks?.length ? (
        <p className="field-hint">Generated by AI and may be wrong. Check before relying on it.</p>
      ) : null}
    </section>
  );
}
