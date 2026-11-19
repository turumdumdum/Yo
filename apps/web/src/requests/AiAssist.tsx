import { allFields, fieldLabel, formatAnswer, stepOfField, type AiRemark, type AiSuggestion, type Answers, type RequestFormDefinition } from '@app/shared';
import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { aiCheck, aiSuggestions } from './api';


interface Props {
  supabase: SupabaseClient;
  requestId: string;
  /** Name of the AI provider, shown so people know where their data goes. */
  provider: string;
  mode: 'suggest' | 'check';
  form: RequestFormDefinition;
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
export function AiAssist({ supabase, requestId, provider, mode, form, answers, save, onApply, onSuggestions }: Props) {
  const FIELDS = new Map(allFields(form).map((f) => [f.key, f]));
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
      else {
        setFixState({});
        setRemarks(await aiCheck(supabase, requestId));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const dismiss = (field: string) => setSuggestions((current) => current?.filter((s) => s.field !== field) ?? null);
  // Proposed fixes from the check, by remark index: accepted ones are marked, dismissed ones hidden.
  const [fixState, setFixState] = useState<Record<number, 'accepted' | 'dismissed'>>({});
  const openFixes = (remarks ?? []).map((r, i) => ({ r, i })).filter(({ r, i }) => r.field && r.suggestion !== undefined && !fixState[i]);
  const acceptFix = (i: number) => {
    const r = remarks?.[i];
    if (!r?.field || r.suggestion === undefined) return;
    onApply(r.field, r.suggestion);
    setFixState((s) => ({ ...s, [i]: 'accepted' }));
  };
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
          : `Optional. Sends your answers, without the names of owners, to ${provider}. You decide which proposed fixes to accept.`}
        {busy && ' This can take up to two minutes; you can keep filling in the form meanwhile.'}
      </p>
      <FormError message={error} />

      <div role="status">
        {suggestions && suggestions.length === 0 && <p className="empty">No new suggestions.</p>}
        {onSuggestions && suggestions && suggestions.length > 0 && (
          <p className="empty">
            {suggestions.length} {suggestions.length === 1 ? 'suggestion is' : 'suggestions are'} shown under the fields
            {suggestions.some((sg) => stepOfField(sg.field, form) > 0) ? ', on this step and on later steps' : ''}. Use
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

      {openFixes.length > 1 && (
        <div className="ai-accept-all">
          <p>
            The AI proposes {openFixes.length} corrected answers. Check them below, or accept them all at once; you can still edit
            every answer afterwards.
          </p>
          <button type="button" className="button button-small" onClick={() => openFixes.forEach(({ i }) => acceptFix(i))}>
            Accept all {openFixes.length} fixes
          </button>
        </div>
      )}
      {remarks && remarks.length > 0 && (
        <ul className="ai-list">
          {remarks.map((r, i) => {
            const field = r.field ? FIELDS.get(r.field) : undefined;
            const state = fixState[i];
            return (
              <li key={i} className={r.severity === 'warning' ? 'ai-warning' : undefined}>
                <p>
                  <span className="suggested-tag">{r.severity === 'warning' ? 'AI warning' : 'AI tip'}</span>{' '}
                  {r.field && <strong>{fieldLabel(r.field, form)}: </strong>}
                  {r.message}
                </p>
                {field && r.suggestion !== undefined && state !== 'dismissed' && (
                  <div className="ai-fix">
                    <p>
                      <span className="stage-meta">Your answer:</span> {formatAnswer(field, answers[field.key])}
                      <br />
                      <span className="stage-meta">Proposed:</span> <strong>{formatAnswer(field, r.suggestion)}</strong>
                    </p>
                    {state === 'accepted' ? (
                      <p className="ai-accepted" role="status">
                        ✓ Accepted. Go to step {stepOfField(field.key, form) + 1} to change it again.
                      </p>
                    ) : (
                      <div className="form-actions">
                        <button type="button" className="button button-small" aria-label={`Accept the proposed ${field.label}`} onClick={() => acceptFix(i)}>
                          Accept
                        </button>
                        <button
                          type="button"
                          className="button button-secondary button-small"
                          aria-label={`Keep my ${field.label}`}
                          onClick={() => setFixState((s) => ({ ...s, [i]: 'dismissed' }))}
                        >
                          Keep mine
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {suggestions?.length || remarks?.length ? (
        <p className="field-hint">Generated by AI and may be wrong. Check before relying on it.</p>
      ) : null}
    </section>
  );
}
