import {
  affectsRisk,
  computeRisk,
  DEFAULT_REQUEST_FORM,
  DEFAULT_RISK_LEVELS,
  FIELD_TYPE_LABELS,
  LIMITS,
  MAX_RISK_POINTS,
  nameNewQuestions,
  newFieldKey,
  optionsFromLines,
  parseRequestForm,
  questionsDependingOn,
  repairRequestForm,
  RISK_TIERS,
  titleFieldKey,
  validateAnswers,
  visibleFields,
  withRiskDefaults,
  type Answers,
  type FieldDef,
  type FieldType,
  type OptionRisk,
  type RequestFormDefinition,
  type RiskBand,
  type RiskLevels,
  type RiskTier,
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
const allQuestions = (form: RequestFormDefinition) => form.steps.flatMap((s) => s.fields);
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
    const risk = 'risk' in field ? field.risk : undefined;
    return { ...base, type, options, ...(risk ? { risk } : {}) } as FieldDef;
  }
  if (NUMBER_TYPES.includes(type)) {
    const kept = 'min' in field ? { min: field.min, max: field.max, riskBands: field.riskBands } : { min: 0 };
    return { ...base, type, ...kept } as FieldDef;
  }
  return { ...base, type } as FieldDef;
}

const RISK_POINT_CHOICES = [0, 1, 2, 3, 4, 5, 6, 8, 10, 15, MAX_RISK_POINTS];
const pointsLabel = (n: number) => (n === 0 ? 'No effect' : `+${n} ${n === 1 ? 'point' : 'points'}`);

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
  levels: RiskLevels;
  /** This question's answer names the request. */
  isTitle: boolean;
  onChange: (field: FieldDef) => void;
  onMakeTitle: () => void;
  onMoveToStep: (step: number) => void;
}

/** How each choice of a question changes the risk. */
function ChoiceRiskEditor({ field, levels, onChange }: { field: Extract<FieldDef, { options: unknown }>; levels: RiskLevels; onChange: (f: FieldDef) => void }) {
  const id = useId();
  const risk = field.risk ?? {};
  const set = (value: string, patch: OptionRisk) => {
    const merged = { ...risk[value], ...patch };
    const clean: OptionRisk = {
      ...(merged.points ? { points: merged.points } : {}),
      ...(merged.atLeast ? { atLeast: merged.atLeast } : {}),
    };
    const next = { ...risk };
    if (clean.points || clean.atLeast) next[value] = clean;
    else delete next[value];
    onChange({ ...field, risk: next } as FieldDef);
  };
  return (
    <fieldset className="field risk-editor">
      <legend>Effect on risk</legend>
      <RiskExplainer levels={levels} />
      <ul className="risk-rows">
        {field.options.map((o, i) => (
          <li key={o.value}>
            <span className="risk-answer">{o.label}</span>
            <label className="visually-hidden" htmlFor={`${id}-p${i}`}>
              Risk points for “{o.label}”
            </label>
            <select id={`${id}-p${i}`} value={risk[o.value]?.points ?? 0} onChange={(e) => set(o.value, { points: Number(e.target.value) })}>
              {RISK_POINT_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {pointsLabel(n)}
                </option>
              ))}
            </select>
            <label className="visually-hidden" htmlFor={`${id}-m${i}`}>
              Lowest risk level when “{o.label}” is chosen
            </label>
            <select
              id={`${id}-m${i}`}
              value={risk[o.value]?.atLeast ?? ''}
              onChange={(e) => set(o.value, { atLeast: (e.target.value || undefined) as RiskTier | undefined })}
            >
              <option value="">No minimum level</option>
              {RISK_TIERS.filter((t) => t !== 'Low').map((t) => (
                <option key={t} value={t}>
                  Always at least {t}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

/** Points added when a number reaches a threshold. */
function NumberRiskEditor({ field, levels, onChange }: { field: Extract<FieldDef, { min: number }>; levels: RiskLevels; onChange: (f: FieldDef) => void }) {
  const id = useId();
  const bands = field.riskBands ?? [];
  const setBands = (next: RiskBand[]) => onChange({ ...field, riskBands: next } as FieldDef);
  return (
    <fieldset className="field risk-editor">
      <legend>Effect on risk</legend>
      <RiskExplainer levels={levels} />
      {bands.length === 0 && <p className="field-hint">The answer does not change the risk.</p>}
      <ul className="risk-rows">
        {bands.map((band, i) => (
          <li key={i}>
            <label htmlFor={`${id}-f${i}`}>From</label>
            <input
              id={`${id}-f${i}`}
              type="number"
              value={band.from}
              onChange={(e) => setBands(bands.map((b, j) => (j === i ? { ...b, from: Number(e.target.value) || 0 } : b)))}
            />
            <label className="visually-hidden" htmlFor={`${id}-b${i}`}>
              Risk points from {band.from}
            </label>
            <select
              id={`${id}-b${i}`}
              value={band.points}
              onChange={(e) => setBands(bands.map((b, j) => (j === i ? { ...b, points: Number(e.target.value) } : b)))}
            >
              {RISK_POINT_CHOICES.map((n) => (
                <option key={n} value={n}>
                  {pointsLabel(n)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="button button-secondary button-small"
              aria-label={`Remove the threshold from ${band.from}`}
              onClick={() => setBands(bands.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {bands.length < 10 && (
        <button
          type="button"
          className="link-button"
          onClick={() => {
            const top = bands.reduce((m, b) => Math.max(m, b.from), field.min);
            setBands([...bands, { from: top > 0 ? top * 2 : 100, points: 1 }]);
          }}
        >
          + Add a threshold
        </button>
      )}
      <p className="field-hint">When the answer reaches several thresholds, only the highest one counts.</p>
    </fieldset>
  );
}

function RiskExplainer({ levels }: { levels: RiskLevels }) {
  return (
    <p className="field-hint">
      Each request gets a risk level from the points of its answers: {levels.Medium}+ points is Medium, {levels.High}+ is High,{' '}
      {levels.Critical}+ is Critical. Higher risk means more checks before approval.
    </p>
  );
}

function QuestionEditor({ field, earlierChoices, steps, stepIndex, levels, isTitle, onChange, onMakeTitle, onMoveToStep }: QuestionEditorProps) {
  const id = useId();
  const [choicesText, setChoicesText] = useState('options' in field ? field.options.map((o) => o.value).join('\n') : '');
  const controller = field.showWhen ? earlierChoices.find((f) => f.key === field.showWhen!.field) : undefined;

  return (
    <div className="question-editor">
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
          onChange={(e) => onChange({ ...field, optional: e.target.checked ? undefined : true })}
        />
        The requester must answer this question
      </label>
      {field.type === 'text' && (
        <label className="choice">
          <input type="checkbox" checked={isTitle} disabled={isTitle} onChange={onMakeTitle} />
          Use the answer as the name of the request in lists
        </label>
      )}

      {CHOICE_TYPES.includes(field.type) && (
        <div className="field">
          <label htmlFor={`${id}-choices`}>Choices, one per line</label>
          <textarea
            id={`${id}-choices`}
            rows={Math.min(10, Math.max(3, choicesText.split('\n').length + 1))}
            value={choicesText}
            onChange={(e) => {
              setChoicesText(e.target.value);
              onChange({ ...field, options: optionsFromLines(e.target.value) } as FieldDef);
            }}
          />
        </div>
      )}

      {'options' in field && <ChoiceRiskEditor field={field} levels={levels} onChange={onChange} />}

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
              onChange={(e) => {
                const n = Number(e.target.value);
                onChange({ ...field, max: e.target.value.trim() !== '' && Number.isFinite(n) ? n : undefined } as FieldDef);
              }}
            />
          </div>
        </div>
      )}
      {'min' in field && <NumberRiskEditor field={field} levels={levels} onChange={onChange} />}

      <fieldset className="field">
        <legend>When to ask</legend>
        <div className="editor-row">
          <div className="field">
            <label htmlFor={`${id}-when`}>Show this question</label>
            <select
              id={`${id}-when`}
              value={field.showWhen?.field ?? ''}
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
  const risk = computeRisk(validateAnswers(answers, undefined, form).cleaned, form);
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
      <div className="card preview-risk" role="status">
        <p>
          With these answers the request would get the risk level{' '}
          <span className="status-badge" data-tone={risk.tier === 'Low' ? 'approved' : risk.tier === 'Medium' ? 'review' : 'waiting'}>
            {risk.tier}
          </span>{' '}
          ({risk.score} {risk.score === 1 ? 'point' : 'points'}).
        </p>
        {risk.reasons.length > 0 && (
          <ul className="stage-meta">
            {risk.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </div>
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

  const levels = draft.definition.riskLevels ?? DEFAULT_RISK_LEVELS;
  const titleKey = draft.definition.titleField ?? (allQuestions(draft.definition).some((f) => f.key === 'serviceName' && f.type === 'text') ? titleFieldKey(draft.definition) : undefined);
  const textQuestions = allQuestions(draft.definition).filter((f) => f.type === 'text');
  const oneChoiceQuestions = allQuestions(draft.definition).filter((f) => f.type === 'radio' || f.type === 'select');
  const ownerQuestions = allQuestions(draft.definition).filter((f) => f.type === 'owner');
  const confidentialQuestion = oneChoiceQuestions.find((f) => f.key === draft.definition.confidential?.field);

  function setDefinition(next: RequestFormDefinition) {
    setDraft((d) => ({ ...d, definition: repairRequestForm(next) }));
    setDirty(true);
    setError(null);
  }
  const setSteps = (next: StepDef[]) => setDefinition({ ...draft.definition, steps: next });
  function removeQuestion(si: number, fi: number) {
    const field = steps[si]!.fields[fi]!;
    const dependents = questionsDependingOn(draft.definition, field.key);
    const extra = dependents.length
      ? `\n\n${dependents.map((f) => `“${f.label}”`).join(', ')} ${dependents.length === 1 ? 'is' : 'are'} shown only after an answer to it, and will then always be shown.`
      : '';
    const title = field.key === titleKey ? '\n\nIts answer names the request; choose another question for that in Form settings.' : '';
    if (window.confirm(`Remove “${field.label}”?${extra}${title}`)) {
      updateStep(si, { fields: steps[si]!.fields.filter((_, j) => j !== fi) });
    }
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

      <details className="form-settings">
        <summary>Form settings: request name, confidentiality and risk levels</summary>
        <div className="editor-row">
          <div className="field">
            <label htmlFor="form-title-field">Which answer names the request?</label>
            {textQuestions.length > 0 ? (
              <select
                id="form-title-field"
                value={titleKey ?? ''}
                onChange={(e) => setDefinition({ ...draft.definition, titleField: e.target.value })}
              >
                {!titleKey && <option value="">Choose a question</option>}
                {textQuestions.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label || 'Untitled question'}
                  </option>
                ))}
              </select>
            ) : (
              <p className="field-hint">Add a short-text question, for example “Service name”, to name requests in lists.</p>
            )}
          </div>
        </div>
        <div className="editor-row">
          <div className="field">
            <label htmlFor="form-confidential-field">Which answer keeps a request confidential?</label>
            <select
              id="form-confidential-field"
              value={draft.definition.confidential?.field ?? ''}
              onChange={(e) => {
                const { confidential: _old, ...rest } = draft.definition;
                setDefinition(e.target.value ? { ...rest, confidential: { field: e.target.value, in: [] } } : rest);
              }}
            >
              <option value="">No question (requests are never confidential)</option>
              {oneChoiceQuestions.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label || 'Untitled question'}
                </option>
              ))}
            </select>
            {confidentialQuestion && 'options' in confidentialQuestion && (
              <div className="choices" role="group" aria-label="Answers that make it confidential">
                {confidentialQuestion.options.map((o) => (
                  <label key={o.value} className="choice">
                    <input
                      type="checkbox"
                      checked={draft.definition.confidential!.in.includes(o.value)}
                      onChange={(e) => {
                        const current = draft.definition.confidential!.in;
                        const next = e.target.checked ? [...current, o.value] : current.filter((v) => v !== o.value);
                        setDefinition({ ...draft.definition, confidential: { field: confidentialQuestion.key, in: next } });
                      }}
                    />
                    {o.label}
                  </label>
                ))}
              </div>
            )}
            <p className="field-hint">A confidential request is seen only by the requester, org admins, the business owner and people an admin adds.</p>
          </div>
          <div className="field">
            <label htmlFor="form-owner-field">Who is the business owner?</label>
            <select
              id="form-owner-field"
              value={draft.definition.businessOwnerField ?? ''}
              onChange={(e) => {
                const { businessOwnerField: _old, ...rest } = draft.definition;
                setDefinition(e.target.value ? { ...rest, businessOwnerField: e.target.value } : rest);
              }}
            >
              <option value="">No question</option>
              {ownerQuestions.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label || 'Untitled question'}
                </option>
              ))}
            </select>
            <p className="field-hint">When the answer is a member’s email, that person can see the request.</p>
          </div>
        </div>
        <fieldset className="field">
          <legend>Risk levels</legend>
          <p className="field-hint">
            Answers can add risk points (set them on each question). The total decides the level; below {levels.Medium} points a
            request is Low risk.
          </p>
          <div className="editor-row risk-levels">
            {(['Medium', 'High', 'Critical'] as const).map((tier) => (
              <div className="field" key={tier}>
                <label htmlFor={`level-${tier}`}>{tier} from</label>
                <input
                  id={`level-${tier}`}
                  type="number"
                  min={1}
                  max={200}
                  value={levels[tier]}
                  onChange={(e) =>
                    setDefinition({ ...draft.definition, riskLevels: { ...levels, [tier]: Math.max(1, Math.round(Number(e.target.value) || 1)) } })
                  }
                />
              </div>
            ))}
          </div>
        </fieldset>
      </details>

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
                                {field.key === titleKey && <span className="lock-tag">Names the request</span>}
                                {affectsRisk(field) && <span className="lock-tag risk-tag">Affects risk</span>}
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
                                <button
                                  type="button"
                                  className="button button-secondary button-small"
                                  aria-label={`Remove “${field.label}”`}
                                  onClick={() => removeQuestion(si, fi)}
                                >
                                  Remove
                                </button>
                              </span>
                            </div>
                            {isOpen && (
                              <QuestionEditor
                                field={field}
                                earlierChoices={earlierChoices}
                                steps={steps}
                                stepIndex={si}
                                levels={levels}
                                isTitle={field.key === titleKey}
                                onMakeTitle={() => setDefinition({ ...draft.definition, titleField: field.key })}
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
                        disabled={steps.length === 1}
                        onClick={() => {
                          if (window.confirm(`Remove step “${step.title}” and its questions?`))
                            setSteps(steps.filter((_, j) => j !== si));
                        }}
                      >
                        Remove step
                      </button>
                    </div>
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
                  definition: withRiskDefaults(copy(DEFAULT_REQUEST_FORM)),
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
                      definition: withRiskDefaults(copy(form.definition)),
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
                      definition: withRiskDefaults(copy(form.definition)),
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
