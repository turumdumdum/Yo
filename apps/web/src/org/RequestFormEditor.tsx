import {
  DEFAULT_REQUEST_FORM,
  FIELD_TYPE_LABELS,
  isSystemField,
  LIMITS,
  nameNewQuestions,
  newFieldKey,
  optionsFromLines,
  parseRequestForm,
  visibleFields,
  type Answers,
  type FieldDef,
  type FieldType,
  type RequestFormDefinition,
  type StepDef,
} from '@app/shared';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import {
  activateRequestForm,
  deleteRequestForm,
  listRequestForms,
  saveRequestForm,
  type SavedRequestForm,
} from '../requests/api';
import { FieldInput } from '../requests/FieldInput';

// Request form management for administrators: pick the standard form, build your own,
// keep several saved forms and choose which one new requests use.

type Draft = { id: string | null; name: string; description: string; definition: RequestFormDefinition };

const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

const CHOICE_TYPES: readonly FieldType[] = ['radio', 'select', 'multiselect'];
const TEXT_TYPES: readonly FieldType[] = ['text', 'textarea', 'email', 'phone', 'url', 'date'];
const NUMBER_TYPES: readonly FieldType[] = ['integer', 'money'];
const TYPE_HELP: Record<FieldType, string> = {
  text: 'One line, for example a name.',
  textarea: 'Several lines, for example an explanation.',
  email: 'Checked to look like name@company.com.',
  phone: 'Digits, spaces and + only.',
  url: 'https:// is added for the requester.',
  date: 'A calendar to pick a day.',
  integer: 'Numbers without decimals, for example a number of users.',
  money: 'An amount, decimals allowed.',
  radio: 'Buttons; best for up to about 6 choices.',
  select: 'A drop-down list; best for long lists.',
  multiselect: 'Tick boxes; the requester can choose several.',
  owner: 'A colleague’s name or email, or “Not required”.',
};

/** Turns a question into another type, keeping what still applies. */
function changeType(field: FieldDef, type: FieldType): FieldDef {
  const base = {
    key: field.key,
    label: field.label,
    hint: field.hint,
    placeholder: field.placeholder,
    optional: field.optional,
    showWhen: field.showWhen,
  };
  if (CHOICE_TYPES.includes(type)) {
    const options = 'options' in field ? field.options : optionsFromLines('Option 1\nOption 2');
    return { ...base, type, options } as FieldDef;
  }
  if (NUMBER_TYPES.includes(type)) return { ...base, type, min: 0 } as FieldDef;
  return { ...base, type } as FieldDef;
}

function describeField(field: FieldDef, form: RequestFormDefinition): string {
  const parts = [FIELD_TYPE_LABELS[field.type], field.optional ? 'optional' : 'required'];
  if (field.showWhen) {
    const controller = form.steps.flatMap((s) => s.fields).find((f) => f.key === field.showWhen!.field);
    parts.push(`only if “${controller?.label ?? field.showWhen.field}” is ${field.showWhen.in.join(' or ')}`);
  }
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// One question
// ---------------------------------------------------------------------------

interface QuestionEditorProps {
  field: FieldDef;
  /** Questions before this one that it may depend on. */
  earlierChoices: FieldDef[];
  steps: readonly StepDef[];
  stepIndex: number;
  onChange: (field: FieldDef) => void;
  onMoveToStep: (step: number) => void;
}

function QuestionEditor({ field, earlierChoices, steps, stepIndex, onChange, onMoveToStep }: QuestionEditorProps) {
  const id = useId();
  const locked = isSystemField(field.key);
  const [choicesText, setChoicesText] = useState('options' in field ? field.options.map((o) => o.value).join('\n') : '');
  const controller = field.showWhen ? earlierChoices.find((f) => f.key === field.showWhen!.field) : undefined;

  return (
    <div className="question-editor">
      {locked && (
        <p className="notice">
          This question is used to work out the risk of a request, so it cannot be removed and its answer type and choices are
          fixed. You can change its wording, help text, example and position.
        </p>
      )}
      <div className="editor-row">
        <div className="field">
          <label htmlFor={`${id}-label`}>Question</label>
          <input
            id={`${id}-label`}
            maxLength={LIMITS.label}
            value={field.label}
            onChange={(e) => onChange({ ...field, label: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-type`}>Answer type</label>
          <select
            id={`${id}-type`}
            value={field.type}
            disabled={locked}
            onChange={(e) => onChange(changeType(field, e.target.value as FieldType))}
          >
            {(Object.keys(FIELD_TYPE_LABELS) as FieldType[]).map((t) => (
              <option key={t} value={t}>
                {FIELD_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <p className="field-hint">{TYPE_HELP[field.type]}</p>
        </div>
      </div>
      <div className="editor-row">
        <div className="field">
          <label htmlFor={`${id}-hint`}>Help text</label>
          <input
            id={`${id}-hint`}
            maxLength={LIMITS.hint}
            value={field.hint ?? ''}
            placeholder="Shown under the question"
            onChange={(e) => onChange({ ...field, hint: e.target.value || undefined })}
          />
        </div>
        {field.type !== 'owner' && !CHOICE_TYPES.includes(field.type) && field.type !== 'date' && (
          <div className="field">
            <label htmlFor={`${id}-placeholder`}>Example answer</label>
            <input
              id={`${id}-placeholder`}
              maxLength={LIMITS.placeholder}
              value={field.placeholder ?? ''}
              placeholder="Shown in grey inside the empty box"
              onChange={(e) => onChange({ ...field, placeholder: e.target.value || undefined })}
            />
          </div>
        )}
      </div>

      <label className="choice">
        <input
          type="checkbox"
          checked={!field.optional}
          disabled={locked}
          onChange={(e) => onChange({ ...field, optional: e.target.checked ? undefined : true })}
        />
        The requester must answer this question
      </label>

      {CHOICE_TYPES.includes(field.type) && (
        <div className="field">
          <label htmlFor={`${id}-choices`}>Choices, one per line</label>
          <textarea
            id={`${id}-choices`}
            rows={Math.min(10, Math.max(3, choicesText.split('\n').length + 1))}
            value={choicesText}
            disabled={locked}
            onChange={(e) => {
              setChoicesText(e.target.value);
              onChange({ ...field, options: optionsFromLines(e.target.value) } as FieldDef);
            }}
          />
        </div>
      )}

      {TEXT_TYPES.includes(field.type) && field.type !== 'date' && (
        <div className="field narrow">
          <label htmlFor={`${id}-max`}>Longest answer (characters)</label>
          <input
            id={`${id}-max`}
            inputMode="numeric"
            value={'maxLength' in field && field.maxLength !== undefined ? field.maxLength : ''}
            placeholder={field.type === 'textarea' ? '2000' : '200'}
            onChange={(e) => {
              const n = Number.parseInt(e.target.value, 10);
              onChange({
                ...field,
                maxLength: Number.isFinite(n) && n > 0 ? Math.min(n, LIMITS.textMax) : undefined,
              } as FieldDef);
            }}
          />
        </div>
      )}

      {NUMBER_TYPES.includes(field.type) && 'min' in field && (
        <div className="editor-row">
          <div className="field">
            <label htmlFor={`${id}-min`}>Smallest allowed</label>
            <input
              id={`${id}-min`}
              inputMode="decimal"
              value={field.min}
              disabled={locked}
              onChange={(e) => {
                const n = Number(e.target.value);
                onChange({ ...field, min: Number.isFinite(n) ? n : 0 } as FieldDef);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor={`${id}-maxn`}>Largest allowed (optional)</label>
            <input
              id={`${id}-maxn`}
              inputMode="decimal"
              value={field.max ?? ''}
              disabled={locked}
              onChange={(e) => {
                const n = Number(e.target.value);
                onChange({ ...field, max: e.target.value.trim() !== '' && Number.isFinite(n) ? n : undefined } as FieldDef);
              }}
            />
          </div>
        </div>
      )}

      <fieldset className="field">
        <legend>When to ask</legend>
        <div className="editor-row">
          <div className="field">
            <label htmlFor={`${id}-when`}>Show this question</label>
            <select
              id={`${id}-when`}
              value={field.showWhen?.field ?? ''}
              disabled={locked}
              onChange={(e) =>
                onChange({ ...field, showWhen: e.target.value ? { field: e.target.value, in: [] } : undefined } as FieldDef)
              }
            >
              <option value="">Always</option>
              {earlierChoices.map((f) => (
                <option key={f.key} value={f.key}>
                  Only when “{f.label}” is…
                </option>
              ))}
            </select>
            {earlierChoices.length === 0 && !field.showWhen && (
              <p className="field-hint">To show it only sometimes, put a one-choice question before it.</p>
            )}
          </div>
          {controller && 'options' in controller && (
            <div className="choices">
              {controller.options.map((o) => (
                <label key={o.value} className="choice">
                  <input
                    type="checkbox"
                    disabled={locked}
                    checked={field.showWhen!.in.includes(o.value)}
                    onChange={(e) => {
                      const current = field.showWhen!.in;
                      const next = e.target.checked ? [...current, o.value] : current.filter((v) => v !== o.value);
                      onChange({ ...field, showWhen: { field: controller.key, in: next } } as FieldDef);
                    }}
                  />
                  {o.label}
                </label>
              ))}
            </div>
          )}
        </div>
      </fieldset>

      {steps.length > 1 && (
        <div className="field narrow">
          <label htmlFor={`${id}-step`}>Step</label>
          <select id={`${id}-step`} value={stepIndex} onChange={(e) => onMoveToStep(Number(e.target.value))}>
            {steps.map((s, i) => (
              <option key={i} value={i}>
                {i + 1}. {s.title || 'Untitled step'}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview: the form as a requester sees it
// ---------------------------------------------------------------------------

function Preview({ form }: { form: RequestFormDefinition }) {
  const [answers, setAnswers] = useState<Answers>({});
  return (
    <div className="form-preview">
      <p className="notice">
        This is what requesters will see. Try answering: questions that depend on others appear and disappear. Nothing is saved.
      </p>
      {form.steps.map((step, i) => (
        <section key={i} className="card form-card preview-step" aria-label={`Step ${i + 1}`}>
          <p className="step-count">
            Step {i + 1} of {form.steps.length}
          </p>
          <h3>{step.title}</h3>
          {step.description && <p className="step-description">{step.description}</p>}
          {visibleFields(i, answers, form).map((field) => (
            <FieldInput
              key={field.key}
              field={field}
              value={answers[field.key]}
              onChange={(v) => setAnswers((a) => ({ ...a, [field.key]: v }))}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editing a whole form
// ---------------------------------------------------------------------------

interface FormEditorProps {
  supabase: SupabaseClient;
  initial: Draft;
  onDone: (message: string) => void;
  onCancel: () => void;
}

function FormEditor({ supabase, initial, onDone, onCancel }: FormEditorProps) {
  const [draft, setDraft] = useState<Draft>(initial);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [open, setOpen] = useState<string | null>(null);
  const [dirty, setDirty] = useState(initial.id === null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const steps = draft.definition.steps;
  // Steps shown open; the others show only their title and number of questions.
  const [openSteps, setOpenSteps] = useState<Set<number>>(() => new Set([0]));
  const toggleStep = (i: number) =>
    setOpenSteps((cur) => {
      const next = new Set(cur);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  const [initialKeys] = useState(() => new Set(initial.definition.steps.flatMap((s) => s.fields.map((f) => f.key))));
  const problem = useMemo(() => {
    const result = parseRequestForm(draft.definition);
    return 'error' in result ? result.error : null;
  }, [draft.definition]);

  function setSteps(next: StepDef[]) {
    setDraft((d) => ({ ...d, definition: { steps: next } }));
    setDirty(true);
    setError(null);
  }
  const updateStep = (i: number, patch: Partial<StepDef>) => setSteps(steps.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const updateField = (si: number, fi: number, field: FieldDef) =>
    updateStep(si, { fields: steps[si]!.fields.map((f, j) => (j === fi ? field : f)) });
  const move = <T,>(list: readonly T[], from: number, to: number): T[] => {
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    return next;
  };
  const taken = () => new Set(steps.flatMap((s) => s.fields.map((f) => f.key)));

  async function save() {
    if (draft.name.trim() === '') {
      setError('Give the form a name.');
      return;
    }
    if (problem) {
      setError(`Fix this first: ${problem}.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveRequestForm(supabase, draft.id, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        definition: nameNewQuestions(draft.definition, initialKeys),
      });
      onDone(`“${draft.name.trim()}” is saved.`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="form-editor-heading">
      <div className="card-head">
        <h2 id="form-editor-heading">{draft.id ? 'Edit request form' : 'New request form'}</h2>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            if (!dirty || window.confirm('Leave without saving your changes?')) onCancel();
          }}
        >
          ← Back to forms
        </button>
      </div>

      <div className="editor-row">
        <div className="field">
          <label htmlFor="form-name">Name of this form</label>
          <input
            id="form-name"
            maxLength={80}
            value={draft.name}
            placeholder="For example Short form for free tools"
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
              setDirty(true);
            }}
          />
        </div>
        <div className="field">
          <label htmlFor="form-description">Note for admins (optional)</label>
          <input
            id="form-description"
            maxLength={400}
            value={draft.description}
            placeholder="When to use this form"
            onChange={(e) => {
              setDraft({ ...draft, description: e.target.value });
              setDirty(true);
            }}
          />
        </div>
      </div>

      <div className="segmented" role="group" aria-label="Edit or preview">
        <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
          Edit
        </button>
        <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
          Preview
        </button>
      </div>

      {mode === 'preview' ? (
        <Preview form={draft.definition} />
      ) : (
        <ol className="form-steps-editor">
          {steps.map((step, si) => {
            const hasSystem = step.fields.some((f) => isSystemField(f.key));
            return (
              <li key={si} className="step-editor">
                <div className="step-editor-head">
                  <span className="step-number">{si + 1}</span>
                  <div className="field grow">
                    <label htmlFor={`step-${si}-title`}>Step title</label>
                    <input
                      id={`step-${si}-title`}
                      maxLength={LIMITS.title}
                      value={step.title}
                      onChange={(e) => updateStep(si, { title: e.target.value })}
                    />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor={`step-${si}-desc`}>Short explanation for the requester (optional)</label>
                  <input
                    id={`step-${si}-desc`}
                    maxLength={LIMITS.description}
                    value={step.description ?? ''}
                    onChange={(e) => updateStep(si, { description: e.target.value || undefined })}
                  />
                </div>

                <button
                  type="button"
                  className="link-button step-toggle"
                  aria-expanded={openSteps.has(si)}
                  onClick={() => toggleStep(si)}
                >
                  {openSteps.has(si)
                    ? 'Hide questions'
                    : `Show ${step.fields.length} ${step.fields.length === 1 ? 'question' : 'questions'}`}
                </button>
                {openSteps.has(si) && (
                  <>
                    <ul className="question-list">
                      {step.fields.map((field, fi) => {
                        const isOpen = open === field.key;
                        const earlierChoices = steps
                          .flatMap((s, i) => (i < si ? s.fields : i === si ? s.fields.slice(0, fi) : []))
                          .filter((f) => f.type === 'radio' || f.type === 'select');
                        return (
                          <li key={field.key} className={`question-row${isOpen ? ' open' : ''}`}>
                            <div className="question-summary">
                              <span className="question-text">
                                <strong>{field.label || 'Untitled question'}</strong>
                                {isSystemField(field.key) && <span className="lock-tag">Used for risk</span>}
                                <span className="stage-meta">{describeField(field, draft.definition)}</span>
                              </span>
                              <span className="question-actions">
                                <button
                                  type="button"
                                  className="button button-secondary button-small"
                                  aria-expanded={isOpen}
                                  onClick={() => setOpen(isOpen ? null : field.key)}
                                >
                                  {isOpen ? 'Done' : 'Edit'}
                                  <span className="visually-hidden"> {field.label}</span>
                                </button>
                                <button
                                  type="button"
                                  className="button button-secondary button-small"
                                  disabled={fi === 0}
                                  aria-label={`Move “${field.label}” up`}
                                  onClick={() => updateStep(si, { fields: move(step.fields, fi, fi - 1) })}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className="button button-secondary button-small"
                                  disabled={fi === step.fields.length - 1}
                                  aria-label={`Move “${field.label}” down`}
                                  onClick={() => updateStep(si, { fields: move(step.fields, fi, fi + 1) })}
                                >
                                  ↓
                                </button>
                                {!isSystemField(field.key) && (
                                  <button
                                    type="button"
                                    className="button button-secondary button-small"
                                    aria-label={`Remove “${field.label}”`}
                                    onClick={() => {
                                      if (window.confirm(`Remove “${field.label}”?`))
                                        updateStep(si, { fields: step.fields.filter((_, j) => j !== fi) });
                                    }}
                                  >
                                    Remove
                                  </button>
                                )}
                              </span>
                            </div>
                            {isOpen && (
                              <QuestionEditor
                                field={field}
                                earlierChoices={earlierChoices}
                                steps={steps}
                                stepIndex={si}
                                onChange={(next) => updateField(si, fi, next)}
                                onMoveToStep={(target) => {
                                  if (target === si) return;
                                  setSteps(
                                    steps.map((s, j) =>
                                      j === si
                                        ? { ...s, fields: s.fields.filter((_, k) => k !== fi) }
                                        : j === target
                                          ? { ...s, fields: [...s.fields, field] }
                                          : s,
                                    ),
                                  );
                                }}
                              />
                            )}
                          </li>
                        );
                      })}
                    </ul>

                    <div className="editor-actions">
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        onClick={() => {
                          const key = newFieldKey('New question', taken());
                          updateStep(si, { fields: [...step.fields, { key, label: 'New question', type: 'text' }] });
                          setOpenSteps((cur) => new Set(cur).add(si));
                          setOpen(key);
                        }}
                      >
                        + Add a question
                      </button>
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={si === 0}
                        onClick={() => setSteps(move(steps, si, si - 1))}
                      >
                        Move step up
                      </button>
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={si === steps.length - 1}
                        onClick={() => setSteps(move(steps, si, si + 1))}
                      >
                        Move step down
                      </button>
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={hasSystem || steps.length === 1}
                        title={hasSystem ? 'Move the questions used for risk to another step first' : undefined}
                        onClick={() => {
                          if (window.confirm(`Remove step “${step.title}” and its questions?`))
                            setSteps(steps.filter((_, j) => j !== si));
                        }}
                      >
                        Remove step
                      </button>
                    </div>
                    {hasSystem && steps.length > 1 && (
                      <p className="field-hint">This step has questions used for risk, so it cannot be removed.</p>
                    )}
                  </>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {mode === 'edit' && (
        <button
          type="button"
          className="button button-secondary"
          disabled={steps.length >= LIMITS.steps}
          onClick={() => {
            const key = newFieldKey('New question', taken());
            setSteps([...steps, { title: 'New step', fields: [{ key, label: 'New question', type: 'text' }] }]);
            setOpenSteps((cur) => new Set(cur).add(steps.length));
            setOpen(key);
          }}
        >
          + Add a step
        </button>
      )}

      {problem && dirty && (
        <p className="notice notice-rejected" role="status">
          To fix before saving: {problem}.
        </p>
      )}
      <FormError message={error} />
      <div className="form-actions sticky-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save form'}
        </button>
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            if (!dirty || window.confirm('Leave without saving your changes?')) onCancel();
          }}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The list of forms
// ---------------------------------------------------------------------------

export function RequestFormsSection({ supabase, orgId }: { supabase: SupabaseClient; orgId: string }) {
  const [forms, setForms] = useState<SavedRequestForm[] | null>(null);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      setForms(await listRequestForms(supabase, orgId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await reload();
      setNotice(message);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const uniqueName = (base: string) => {
    const names = new Set((forms ?? []).map((f) => f.name));
    let name = base;
    for (let i = 2; names.has(name); i++) name = `${base} ${i}`;
    return name;
  };

  if (editing) {
    return (
      <FormEditor
        supabase={supabase}
        initial={editing}
        onCancel={() => setEditing(null)}
        onDone={(message) => {
          setEditing(null);
          setNotice(message);
          void reload();
        }}
      />
    );
  }

  const anyActive = (forms ?? []).some((f) => f.is_active);

  return (
    <section className="card" aria-labelledby="request-forms-heading">
      <h2 id="request-forms-heading">Request form</h2>
      <p className="field-hint">
        The questions people answer when they ask for a new vendor or service. Start from the standard form, change it, and keep
        as many versions as you like. The form marked “In use” is the one new requests get; requests already started keep the form
        they began with.
      </p>
      <FormError message={error} />
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <ul className="form-list">
        <li className={!anyActive ? 'in-use' : undefined}>
          <div>
            <strong>Standard form</strong>{' '}
            {!anyActive && (
              <span className="status-badge" data-tone="approved">
                In use
              </span>
            )}
            <p className="stage-meta">
              Built in. {DEFAULT_REQUEST_FORM.steps.length} steps, {DEFAULT_REQUEST_FORM.steps.flatMap((s) => s.fields).length}{' '}
              questions.
            </p>
          </div>
          <div className="question-actions">
            <button
              type="button"
              className="button button-small"
              disabled={busy}
              onClick={() =>
                setEditing({
                  id: null,
                  name: uniqueName('My request form'),
                  description: '',
                  definition: copy(DEFAULT_REQUEST_FORM),
                })
              }
            >
              Make my own version
            </button>
            {anyActive && (
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={busy}
                onClick={() => void run(() => activateRequestForm(supabase, null), 'New requests now use the standard form.')}
              >
                Use this form
              </button>
            )}
          </div>
        </li>

        {forms === null ? (
          <li>
            <p role="status">Loading…</p>
          </li>
        ) : (
          forms.map((form) => (
            <li key={form.id} className={form.is_active ? 'in-use' : undefined}>
              <div>
                <strong>{form.name}</strong>{' '}
                {form.is_active && (
                  <span className="status-badge" data-tone="approved">
                    In use
                  </span>
                )}
                {form.description && <p className="stage-meta">{form.description}</p>}
                <p className="stage-meta">
                  {form.definition.steps.length} steps, {form.definition.steps.flatMap((s) => s.fields).length} questions ·
                  changed {formatDate(form.updated_at)}
                </p>
              </div>
              <div className="question-actions">
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={busy}
                  onClick={() =>
                    setEditing({
                      id: form.id,
                      name: form.name,
                      description: form.description ?? '',
                      definition: copy(form.definition),
                    })
                  }
                >
                  Edit<span className="visually-hidden"> {form.name}</span>
                </button>
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={busy}
                  onClick={() =>
                    setEditing({
                      id: null,
                      name: uniqueName(`${form.name} (copy)`),
                      description: form.description ?? '',
                      definition: copy(form.definition),
                    })
                  }
                >
                  Duplicate<span className="visually-hidden"> {form.name}</span>
                </button>
                {!form.is_active && (
                  <button
                    type="button"
                    className="button button-small"
                    disabled={busy}
                    onClick={() => void run(() => activateRequestForm(supabase, form.id), `New requests now use “${form.name}”.`)}
                  >
                    Use this form<span className="visually-hidden">: {form.name}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={busy}
                  onClick={() => {
                    const extra = form.is_active ? ' New requests will use the standard form again.' : '';
                    if (window.confirm(`Delete “${form.name}”?${extra}`))
                      void run(() => deleteRequestForm(supabase, form.id), `“${form.name}” is deleted.`);
                  }}
                >
                  Delete<span className="visually-hidden"> {form.name}</span>
                </button>
              </div>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
