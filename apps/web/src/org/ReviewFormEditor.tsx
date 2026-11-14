import {
  DEFAULT_STAGES,
  defaultReviewTemplate,
  parseReviewTemplate,
  REVIEW_FIELD_KEY,
  ruleConditionFields,
  type ReviewFieldDef,
  type ReviewFieldType,
  type ReviewRule,
  type ReviewTemplate,
} from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { loadReviewTemplate, resetReviewTemplate, saveReviewTemplate } from '../requests/api';

const TYPE_LABELS: Record<ReviewFieldType, string> = {
  select: 'One choice',
  multiselect: 'Several choices',
  date: 'Date',
  text: 'Short text',
  textarea: 'Long text',
};

const CONDITIONS = ruleConditionFields();

/** A key that does not change when the label does, so stored answers stay attached. */
function newKey(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : ''))
      .replace(/^[^a-z]+/, '')
      .slice(0, 30) || 'field';
  let key = base;
  for (let i = 2; taken.has(key) || !REVIEW_FIELD_KEY.test(key); i++) key = `${base}${i}`;
  return key;
}

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

function FieldEditor({
  field,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  field: ReviewFieldDef;
  index: number;
  count: number;
  onChange: (field: ReviewFieldDef) => void;
  onMove: (delta: number) => void;
  onRemove: () => void;
}) {
  const id = `field-${field.key}`;
  const choice = field.type === 'select' || field.type === 'multiselect';
  // Options are edited as text so that blank lines can be typed; empty ones are dropped on save.
  const [optionsText, setOptionsText] = useState((field.options ?? []).join('\n'));
  const options = field.options ?? [];

  return (
    <li className="editor-field">
      <div className="editor-row">
        <div className="field">
          <label htmlFor={`${id}-label`}>Question</label>
          <input id={`${id}-label`} maxLength={120} value={field.label} onChange={(e) => onChange({ ...field, label: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-type`}>Answer type</label>
          <select
            id={`${id}-type`}
            value={field.type}
            onChange={(e) => {
              const type = e.target.value as ReviewFieldType;
              const keepsOptions = type === 'select' || type === 'multiselect';
              onChange({
                ...field,
                type,
                options: keepsOptions ? options : undefined,
                concernValues: keepsOptions ? field.concernValues : undefined,
                maxAgeMonths: type === 'date' ? field.maxAgeMonths : undefined,
              });
              if (!keepsOptions) setOptionsText('');
            }}
          >
            {Object.entries(TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="editor-row">
        <div className="field">
          <label htmlFor={`${id}-section`}>Section</label>
          <input id={`${id}-section`} maxLength={60} value={field.section ?? ''} onChange={(e) => onChange({ ...field, section: e.target.value || undefined })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-help`}>Help text</label>
          <input id={`${id}-help`} maxLength={300} value={field.help ?? ''} onChange={(e) => onChange({ ...field, help: e.target.value || undefined })} />
        </div>
      </div>
      <label className="choice">
        <input type="checkbox" checked={field.required} onChange={(e) => onChange({ ...field, required: e.target.checked })} />
        Required to approve
      </label>

      {choice && (
        <div className="editor-row">
          <div className="field">
            <label htmlFor={`${id}-options`}>Options, one per line</label>
            <textarea
              id={`${id}-options`}
              rows={Math.min(10, Math.max(3, options.length + 1))}
              value={optionsText}
              onChange={(e) => {
                setOptionsText(e.target.value);
                const next = lines(e.target.value);
                onChange({ ...field, options: next, concernValues: (field.concernValues ?? []).filter((v) => next.includes(v)) });
              }}
            />
          </div>
          {options.length > 0 && (
            <fieldset className="field">
              <legend>Flag as a concern</legend>
              <div className="choices">
                {options.map((option) => (
                  <label key={option} className="choice">
                    <input
                      type="checkbox"
                      checked={(field.concernValues ?? []).includes(option)}
                      onChange={(e) => {
                        const current = field.concernValues ?? [];
                        const next = e.target.checked ? [...current, option] : current.filter((v) => v !== option);
                        onChange({ ...field, concernValues: next.length > 0 ? next : undefined });
                      }}
                    />
                    {option}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        </div>
      )}

      {field.type === 'date' && (
        <div className="field narrow">
          <label htmlFor={`${id}-age`}>Flag when older than (months)</label>
          <input
            id={`${id}-age`}
            inputMode="numeric"
            value={field.maxAgeMonths ?? ''}
            onChange={(e) => {
              const months = Number.parseInt(e.target.value, 10);
              onChange({ ...field, maxAgeMonths: Number.isFinite(months) && months > 0 ? Math.min(months, 120) : undefined });
            }}
          />
        </div>
      )}

      <div className="editor-actions">
        <button type="button" className="button button-secondary button-small" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move "${field.label}" up`}>
          Up
        </button>
        <button
          type="button"
          className="button button-secondary button-small"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
          aria-label={`Move "${field.label}" down`}
        >
          Down
        </button>
        <button type="button" className="button button-secondary button-small" onClick={onRemove} aria-label={`Remove "${field.label}"`}>
          Remove
        </button>
      </div>
    </li>
  );
}

function RuleEditor({
  rule,
  index,
  fields,
  onChange,
  onRemove,
}: {
  rule: ReviewRule;
  index: number;
  fields: ReviewFieldDef[];
  onChange: (rule: ReviewRule) => void;
  onRemove: () => void;
}) {
  const condition = CONDITIONS.find((c) => c.key === rule.when.field);
  const multi = fields.filter((f) => f.type === 'multiselect');
  const target = multi.find((f) => f.key === rule.field);
  const toggle = (list: string[], value: string, on: boolean) => (on ? [...list, value] : list.filter((v) => v !== value));
  const id = `rule-${index}`;

  return (
    <li className="editor-field">
      <div className="editor-row">
        <div className="field">
          <label htmlFor={`${id}-when`}>When the request answer to</label>
          <select id={`${id}-when`} value={rule.when.field} onChange={(e) => onChange({ ...rule, when: { field: e.target.value, in: [] } })}>
            {CONDITIONS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-field`}>the answer to</label>
          <select id={`${id}-field`} value={rule.field} onChange={(e) => onChange({ ...rule, field: e.target.value, anyOf: [] })}>
            {multi.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="editor-row">
        <fieldset className="field">
          <legend>is one of</legend>
          <div className="choices">
            {condition?.options.map((o) => (
              <label key={o} className="choice">
                <input type="checkbox" checked={rule.when.in.includes(o)} onChange={(e) => onChange({ ...rule, when: { ...rule.when, in: toggle(rule.when.in, o, e.target.checked) } })} />
                {o}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="field">
          <legend>should include at least one of</legend>
          <div className="choices">
            {target?.options?.map((o) => (
              <label key={o} className="choice">
                <input type="checkbox" checked={rule.anyOf.includes(o)} onChange={(e) => onChange({ ...rule, anyOf: toggle(rule.anyOf, o, e.target.checked) })} />
                {o}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="field">
        <label htmlFor={`${id}-message`}>Message to the reviewer</label>
        <input id={`${id}-message`} maxLength={300} value={rule.message} onChange={(e) => onChange({ ...rule, message: e.target.value })} />
      </div>
      <div className="editor-actions">
        <button type="button" className="button button-secondary button-small" onClick={onRemove} aria-label={`Remove rule ${index + 1}`}>
          Remove rule
        </button>
      </div>
    </li>
  );
}

/** Lets org admins configure the review form of each stage. */
export function ReviewFormEditor({ supabase, orgId }: { supabase: SupabaseClient; orgId: string }) {
  const [stage, setStage] = useState<string>('Security review');
  const [template, setTemplate] = useState<ReviewTemplate | null>(null);
  const [custom, setCustom] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped on load so that per-field editors start from the loaded options.
  const [version, setVersion] = useState(0);

  const load = useCallback(
    async (name: string) => {
      setTemplate(null);
      setError(null);
      try {
        const stored = await loadReviewTemplate(supabase, orgId, name);
        setTemplate(stored ?? defaultReviewTemplate(name));
        setCustom(stored !== null);
        setDirty(false);
        setVersion((v) => v + 1);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [supabase, orgId],
  );

  useEffect(() => {
    void load(stage);
  }, [load, stage]);

  function update(next: ReviewTemplate) {
    setTemplate(next);
    setDirty(true);
    setNotice(null);
    setError(null);
  }

  async function save() {
    if (!template) return;
    const cleaned: ReviewTemplate = {
      fields: template.fields.map((f) => ({ ...f, label: f.label.trim(), section: f.section?.trim() || undefined, help: f.help?.trim() || undefined })),
      rules: template.rules.map((r) => ({ ...r, message: r.message.trim() })),
    };
    const parsed = parseReviewTemplate(cleaned);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveReviewTemplate(supabase, stage, parsed.template);
      setCustom(true);
      setDirty(false);
      setNotice('Saved. Requests submitted from now on use this form; reviews already started keep theirs.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    if (!window.confirm(`Go back to the default ${stage} form? Your changes to this form are removed.`)) return;
    setBusy(true);
    setError(null);
    try {
      await resetReviewTemplate(supabase, stage);
      await load(stage);
      setNotice('The default form applies again to new requests.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const fields = template?.fields ?? [];
  const rules = template?.rules ?? [];
  const multi = fields.filter((f) => f.type === 'multiselect');

  return (
    <section className="card" aria-labelledby="forms-heading">
      <h2 id="forms-heading">Review forms</h2>
      <p className="field-hint">
        Questions the reviewer answers for a stage, in addition to its checklist. Required questions must be answered before
        approving. The default security review form follows common vendor-assessment practice; adapt it to your policy. It is a
        starting point, not a certification guarantee.
      </p>
      <div className="field narrow">
        <label htmlFor="form-stage">Stage</label>
        <select
          id="form-stage"
          value={stage}
          onChange={(e) => {
            if (dirty && !window.confirm('Discard unsaved changes?')) return;
            setStage(e.target.value);
          }}
        >
          {DEFAULT_STAGES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {template && (
        <p className="badges">
          <span className="status-badge" data-tone={custom ? 'review' : 'idle'}>
            {custom ? 'Customized for your organization' : 'Default form'}
          </span>
          {dirty && (
            <span className="status-badge" data-tone="waiting">
              Unsaved changes
            </span>
          )}
        </p>
      )}
      <FormError message={error} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      {!template ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          <h3>Questions ({fields.length})</h3>
          {fields.length === 0 && <p className="empty">This stage has no form; reviewers only use the checklist.</p>}
          <ol className="editor-list">
            {fields.map((field, i) => (
              <FieldEditor
                key={`${version}-${field.key}`}
                field={field}
                index={i}
                count={fields.length}
                onChange={(next) => update({ ...template, fields: fields.map((f, j) => (j === i ? next : f)) })}
                onMove={(delta) => {
                  const next = [...fields];
                  const [moved] = next.splice(i, 1);
                  next.splice(i + delta, 0, moved!);
                  update({ ...template, fields: next });
                }}
                onRemove={() => {
                  if (!window.confirm(`Remove "${field.label}"?`)) return;
                  update({ fields: fields.filter((_, j) => j !== i), rules: rules.filter((r) => r.field !== field.key) });
                }}
              />
            ))}
          </ol>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              const label = 'New question';
              const key = newKey(label, new Set(fields.map((f) => f.key)));
              update({ ...template, fields: [...fields, { key, label, type: 'select', required: false, options: ['Yes', 'No'], section: fields.at(-1)?.section }] });
            }}
          >
            Add a question
          </button>

          <h3>Rules ({rules.length})</h3>
          <p className="field-hint">
            Rules flag a concern when a request needs more assurance, for example “Restricted data needs SOC 2 Type II or ISO/IEC
            27001”. They do not block a decision: the reviewer can approve with conditions.
          </p>
          <ol className="editor-list">
            {rules.map((rule, i) => (
              <RuleEditor
                key={`${version}-${i}`}
                rule={rule}
                index={i}
                fields={fields}
                onChange={(next) => update({ ...template, rules: rules.map((r, j) => (j === i ? next : r)) })}
                onRemove={() => update({ ...template, rules: rules.filter((_, j) => j !== i) })}
              />
            ))}
          </ol>
          <button
            type="button"
            className="button button-secondary"
            disabled={multi.length === 0}
            onClick={() =>
              update({
                ...template,
                rules: [...rules, { when: { field: CONDITIONS[0]!.key, in: [] }, field: multi[0]!.key, anyOf: [], message: '' }],
              })
            }
          >
            Add a rule
          </button>
          {multi.length === 0 && <p className="field-hint">Rules need a question with several choices, such as certifications.</p>}

          <div className="form-actions sticky-actions">
            <button type="button" className="button" disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save form'}
            </button>
            {custom && (
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => void reset()}>
                Reset to default
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
