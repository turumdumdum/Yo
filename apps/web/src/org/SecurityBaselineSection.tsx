import {
  allFields,
  CONTROL_CATEGORIES,
  DEFAULT_REQUEST_FORM,
  DEFAULT_SECURITY_BASELINE,
  parseSecurityBaseline,
  RISK_TIERS,
  type BaselineControl,
  type FieldDef,
  type RiskTier,
  type SecurityBaseline,
} from '@app/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { listRequestForms, loadSecurityBaseline, resetSecurityBaseline, saveSecurityBaseline } from '../requests/api';

type Choice = Extract<FieldDef, { options: unknown }>;
const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function newKey(title: string, taken: Set<string>): string {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'control';
  let key = /^[a-z0-9]/.test(base) ? base : `c-${base}`;
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
  return key;
}

function appliesText(c: BaselineControl, labelOf: (k: string) => string): string {
  const tier = c.minTier === 'Low' ? 'every request' : `${c.minTier} risk and higher`;
  return c.when ? `${tier}, when “${labelOf(c.when.field)}” is ${c.when.in.join(' or ')}` : tier;
}

function ControlEditor({ control, questions, onChange }: { control: BaselineControl; questions: Choice[]; onChange: (c: BaselineControl) => void }) {
  const id = useId();
  const condition = control.when ? questions.find((q) => q.key === control.when!.field) : undefined;
  return (
    <div className="control-editor">
      <div className="field">
        <label htmlFor={`${id}-t`}>Title</label>
        <input id={`${id}-t`} maxLength={120} value={control.title} onChange={(e) => onChange({ ...control, title: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-r`}>What must be configured</label>
        <textarea id={`${id}-r`} rows={3} maxLength={600} value={control.requirement} onChange={(e) => onChange({ ...control, requirement: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor={`${id}-v`}>How to verify it (evidence)</label>
        <input id={`${id}-v`} maxLength={400} value={control.verification} onChange={(e) => onChange({ ...control, verification: e.target.value })} />
      </div>
      <div className="editor-row">
        <div className="field">
          <label htmlFor={`${id}-c`}>Category</label>
          <select id={`${id}-c`} value={control.category} onChange={(e) => onChange({ ...control, category: e.target.value as BaselineControl['category'] })}>
            {CONTROL_CATEGORIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-l`}>Level</label>
          <select id={`${id}-l`} value={control.level} onChange={(e) => onChange({ ...control, level: e.target.value as BaselineControl['level'] })}>
            <option value="required">Required: needs a decision, or an exception</option>
            <option value="recommended">Recommended: good practice</option>
          </select>
        </div>
      </div>
      <div className="editor-row">
        <div className="field">
          <label htmlFor={`${id}-m`}>Applies to</label>
          <select id={`${id}-m`} value={control.minTier} onChange={(e) => onChange({ ...control, minTier: e.target.value as RiskTier })}>
            {RISK_TIERS.map((t) => (
              <option key={t} value={t}>
                {t === 'Low' ? 'Every request' : `${t} risk and higher`}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-w`}>Only when an answer is…</label>
          <select
            id={`${id}-w`}
            value={control.when?.field ?? ''}
            onChange={(e) => onChange({ ...control, when: e.target.value ? { field: e.target.value, in: [] } : null })}
          >
            <option value="">No condition</option>
            {control.when && !condition && <option value={control.when.field}>{control.when.field} (not in the form in use)</option>}
            {questions.map((q) => (
              <option key={q.key} value={q.key}>
                {q.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      {condition && (
        <div className="choices" role="group" aria-label={`Answers to “${condition.label}” that make it apply`}>
          {condition.options.map((o) => (
            <label key={o.value} className="choice">
              <input
                type="checkbox"
                checked={control.when!.in.includes(o.value)}
                onChange={(e) => {
                  const cur = control.when!.in;
                  onChange({ ...control, when: { field: condition.key, in: e.target.checked ? [...cur, o.value] : cur.filter((v) => v !== o.value) } });
                }}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Admin: the configuration every approved service must have, tailored by risk and answers. */
export function SecurityBaselineSection({ supabase, orgId }: { supabase: SupabaseClient; orgId: string }) {
  const [baseline, setBaseline] = useState<SecurityBaseline | null>(null);
  const [isCustom, setIsCustom] = useState(false);
  const [questions, setQuestions] = useState<Choice[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [stored, forms] = await Promise.all([loadSecurityBaseline(supabase, orgId), listRequestForms(supabase, orgId)]);
      const parsed = stored === null ? null : parseSecurityBaseline(stored);
      setBaseline(parsed && 'baseline' in parsed ? parsed.baseline : copy(DEFAULT_SECURITY_BASELINE));
      setIsCustom(parsed !== null && 'baseline' in parsed);
      const form = forms.find((f) => f.is_active)?.definition ?? DEFAULT_REQUEST_FORM;
      setQuestions(allFields(form).filter((f): f is Choice => 'options' in f));
      setDirty(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const labelOf = (key: string) => questions.find((q) => q.key === key)?.label ?? key;
  const update = (controls: BaselineControl[]) => {
    setBaseline({ controls });
    setDirty(true);
    setNotice(null);
    setError(null);
  };

  async function save() {
    if (!baseline) return;
    const parsed = parseSecurityBaseline(baseline);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    try {
      await saveSecurityBaseline(supabase, parsed.baseline);
      setNotice('Saved. Requests submitted from now on get these controls; earlier requests keep theirs.');
      setIsCustom(true);
      setDirty(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="baseline-heading">
      <h2 id="baseline-heading">Security baseline</h2>
      <p className="field-hint">
        The configuration a service must have to be approved, such as single sign-on, MFA and audit logs. Each control applies by
        risk level and, if you like, by an answer in the request form. The security reviewer decides on every required control:
        it must be configured, it does not apply (with a reason), or an exception is accepted for a limited time. After approval the
        required controls become configuration tasks. The standard controls are a starting point, not a certification guarantee.
      </p>
      <FormError message={error} />
      {notice && (
        <p className="notice notice-approved" role="status">
          {notice}
        </p>
      )}
      {!baseline ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          {CONTROL_CATEGORIES.map((category) => {
            const list = baseline.controls.filter((c) => c.category === category);
            if (list.length === 0) return null;
            return (
              <div key={category} className="config-group">
                <h3>{category}</h3>
                <ul className="config-list">
                  {list.map((c) => {
                    const index = baseline.controls.indexOf(c);
                    const isOpen = open === c.id;
                    return (
                      <li key={c.id} className="config-item">
                        <div className="config-head">
                          <strong>{c.title || 'Untitled control'}</strong>
                          <span className="status-badge" data-tone={c.level === 'required' ? 'review' : 'idle'}>
                            {c.level === 'required' ? 'Required' : 'Recommended'}
                          </span>
                        </div>
                        <p className="stage-meta">Applies to {appliesText(c, labelOf)}.</p>
                        <div className="question-actions">
                          <button type="button" className="button button-secondary button-small" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : c.id)}>
                            {isOpen ? 'Done' : 'Edit'}
                            <span className="visually-hidden"> {c.title}</span>
                          </button>
                          <button
                            type="button"
                            className="button button-secondary button-small"
                            aria-label={`Remove ${c.title}`}
                            onClick={() => {
                              if (window.confirm(`Remove “${c.title}” from the baseline?`)) update(baseline.controls.filter((_, i) => i !== index));
                            }}
                          >
                            Remove
                          </button>
                        </div>
                        {isOpen && (
                          <ControlEditor control={c} questions={questions} onChange={(next) => update(baseline.controls.map((x, i) => (i === index ? next : x)))} />
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              const key = newKey('New control', new Set(baseline.controls.map((c) => c.id)));
              update([
                ...baseline.controls,
                { id: key, title: 'New control', requirement: 'Describe what must be configured.', verification: '', category: 'Identity & access', level: 'required', minTier: 'Low', when: null },
              ]);
              setOpen(key);
            }}
          >
            + Add a control
          </button>
          <div className="form-actions sticky-actions">
            <button type="button" className="button" disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save baseline'}
            </button>
            {isCustom && (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm('Go back to the standard baseline? Your controls are removed.')) return;
                  void (async () => {
                    try {
                      await resetSecurityBaseline(supabase);
                      await reload();
                      setNotice('The standard baseline applies again to new requests.');
                    } catch (e) {
                      setError(errorMessage(e));
                    }
                  })();
                }}
              >
                Use the standard baseline
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
