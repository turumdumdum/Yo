import {
  completenessHints,
  DEFAULT_REQUEST_FORM,
  firstStepWithErrors,
  validateAnswers,
  visibleFields,
  type AiSuggestion,
  type Answers,
  type RequestFormDefinition,
} from '@app/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { AiAssist } from './AiAssist';
import { AnswerSummary } from './AnswerSummary';
import { Attachments } from './Attachments';
import { aiStatus, deleteDraft, saveAnswers, submitRequest, SubmitError } from './api';
import { FieldInput } from './FieldInput';

const AUTOSAVE_DELAY_MS = 1500;

type SaveState = 'saved' | 'unsaved' | 'saving' | 'error';

const SAVE_LABELS: Record<SaveState, string> = {
  saved: 'Draft saved',
  unsaved: 'Unsaved changes',
  saving: 'Saving…',
  error: 'Not saved yet. Your changes stay on this page; we will try again on your next change.',
};

interface Props {
  supabase: SupabaseClient;
  requestId: string;
  userId: string;
  initialAnswers: Answers;
  /** The form this draft was started with; null for the standard form. */
  form: RequestFormDefinition | null;
  onSubmitted: () => void;
  onClose: () => void;
}

export function RequestForm({ supabase, requestId, userId, initialAnswers, form: ownForm, onSubmitted, onClose }: Props) {
  const form = ownForm ?? DEFAULT_REQUEST_FORM;
  const steps = form.steps;
  const LAST_STEP = steps.length - 1;
  const [answers, setAnswers] = useState<Answers>(initialAnswers);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Name of the AI provider when the optional plugin is configured; null means no AI buttons.
  const [aiProvider, setAiProvider] = useState<string | null>(null);
  // AI proposals by field, shown under each field until used or dismissed.
  const [suggestions, setSuggestions] = useState<Record<string, AiSuggestion>>({});
  const dismissSuggestion = (key: string) => setSuggestions(({ [key]: _gone, ...rest }) => rest);

  useEffect(() => {
    let cancelled = false;
    void aiStatus(supabase).then((status) => {
      if (!cancelled && status.enabled) setAiProvider(status.provider ?? 'the AI provider');
    });
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // The latest answers and the last version known to be stored, for the autosave timer.
  const latest = useRef(answers);
  const stored = useRef(initialAnswers);
  latest.current = answers;

  const save = useCallback(async (): Promise<boolean> => {
    const snapshot = latest.current;
    if (snapshot === stored.current) return true;
    setSaveState('saving');
    try {
      await saveAnswers(supabase, requestId, snapshot);
      stored.current = snapshot;
      setSaveState(latest.current === snapshot ? 'saved' : 'unsaved');
      return true;
    } catch {
      setSaveState('error');
      return false;
    }
  }, [supabase, requestId]);

  useEffect(() => {
    if (answers === stored.current) return;
    setSaveState('unsaved');
    const timer = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [answers, save]);

  // Warn before leaving the page with changes that have not reached the server.
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (latest.current !== stored.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  function change(key: string, value: unknown) {
    setAnswers((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors(({ [key]: _removed, ...rest }) => rest);
  }

  /** Moves the keyboard and the screen to the first field with a problem, once it is rendered. */
  function focusFirstError() {
    requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        '.form-card [aria-invalid="true"], .form-card fieldset:has(.field-error) input',
      );
      target?.focus();
      target?.scrollIntoView({ block: 'center' });
    });
  }

  async function goTo(next: number) {
    setFormError(null);
    setStep(next);
    await save();
    headingRef.current?.focus();
  }

  async function next() {
    const result = validateAnswers(answers, [step], form);
    setErrors(result.errors);
    if (Object.keys(result.errors).length > 0) {
      const count = Object.keys(result.errors).length;
      setFormError(`${count} ${count === 1 ? 'answer needs' : 'answers need'} your attention. The first one is selected.`);
      focusFirstError();
      return;
    }
    await goTo(step + 1);
  }

  async function submit() {
    const result = validateAnswers(answers, undefined, form);
    if (Object.keys(result.errors).length > 0) {
      setErrors(result.errors);
      const target = firstStepWithErrors(result.errors, form);
      setStep(target);
      setFormError(
        `Some answers are missing or invalid in step ${target + 1} (${steps[target]?.title}). The first one is selected.`,
      );
      focusFirstError();
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      if (!(await save())) throw new Error('Could not save your answers. Check your connection and try again.');
      await submitRequest(supabase, requestId);
      onSubmitted();
    } catch (error) {
      if (error instanceof SubmitError && Object.keys(error.fields).length > 0) {
        setErrors(error.fields);
        setStep(Math.max(0, firstStepWithErrors(error.fields, form)));
      }
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveAndClose() {
    if (await save()) onClose();
  }

  async function discard() {
    if (!window.confirm('Delete this draft? This cannot be undone.')) return;
    try {
      await deleteDraft(supabase, requestId);
      onClose();
    } catch (error) {
      setFormError(errorMessage(error));
    }
  }

  const current = steps[step]!;
  const hints = step === LAST_STEP ? completenessHints(validateAnswers(answers, undefined, form).cleaned) : [];
  const hasOptional = visibleFields(step, answers, form).some((f) => f.optional);

  return (
    <div className="request-form">
      <div className="form-top">
        <button type="button" className="link-button" onClick={() => void saveAndClose()}>
          ← Save and close
        </button>
        <p className="save-state" role="status" data-state={saveState}>
          {SAVE_LABELS[saveState]}
        </p>
      </div>

      <nav aria-label="Form steps">
        <ol className="stepper">
          {steps.map((s, index) => (
            <li key={s.title} data-state={index === step ? 'current' : index < step ? 'done' : 'todo'}>
              <button
                type="button"
                // The title is hidden on narrow screens, so the name must not depend on it.
                aria-label={`Step ${index + 1}: ${s.title}`}
                aria-current={index === step ? 'step' : undefined}
                onClick={() => void goTo(index)}
              >
                <span className="step-number">{index + 1}</span>
                <span className="step-title">{s.title}</span>
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <section className="card form-card" aria-labelledby="step-heading">
        <p className="step-count">
          Step {step + 1} of {steps.length}
        </p>
        <h1 id="step-heading" ref={headingRef} tabIndex={-1}>
          {current.title}
        </h1>
        {current.description && <p className="step-description">{current.description}</p>}
        {hasOptional && <p className="field-hint">All questions need an answer unless marked optional.</p>}

        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void (step === LAST_STEP ? submit() : next());
          }}
        >
          {aiProvider && step <= 1 && (
            <AiAssist
              supabase={supabase}
              requestId={requestId}
              provider={aiProvider}
              mode="suggest"
              form={form}
              answers={answers}
              save={save}
              onApply={change}
              onSuggestions={(found) => setSuggestions(Object.fromEntries(found.map((sg) => [sg.field, sg])))}
            />
          )}

          {visibleFields(step, answers, form).map((field) => (
            <FieldInput
              key={field.key}
              field={field}
              value={answers[field.key]}
              error={errors[field.key]}
              onChange={(value) => change(field.key, value)}
              suggestion={suggestions[field.key]}
              onDismissSuggestion={() => dismissSuggestion(field.key)}
            />
          ))}

          {step === LAST_STEP && (
            <>
              <h2>Attachments</h2>
              <p className="field-hint">
                Optional: the quote, contract draft, DPA, SOC 2 or ISO report, security questionnaire. Reviewers will see them.
              </p>
              <Attachments
                supabase={supabase}
                requestId={requestId}
                userId={userId}
                canUpload
                canRemoveOwn
                nameOf={() => 'you'}
              />
              {hints.length > 0 && (
                <section className="hints" aria-labelledby="hints-heading">
                  <h2 id="hints-heading">Before you submit</h2>
                  <ul>
                    {hints.map((hint) => (
                      <li key={hint}>{hint}</li>
                    ))}
                  </ul>
                </section>
              )}
              {aiProvider && (
                <AiAssist
                  supabase={supabase}
                  requestId={requestId}
                  provider={aiProvider}
                  mode="check"
                  form={form}
                  answers={answers}
                  save={save}
                  onApply={change}
                />
              )}
              <h2>Your answers</h2>
              <AnswerSummary form={form} answers={answers} onEdit={(index) => void goTo(index)} />
            </>
          )}

          <FormError message={formError} />
          <div className="form-actions sticky-actions">
            {step > 0 && (
              <button type="button" className="button button-secondary" onClick={() => void goTo(step - 1)}>
                Back
              </button>
            )}
            <button type="submit" className="button" disabled={busy}>
              {step === LAST_STEP ? (busy ? 'Submitting…' : 'Submit request') : 'Save and continue'}
            </button>
          </div>
        </form>
      </section>

      <button type="button" className="link-button danger" onClick={() => void discard()}>
        Delete draft
      </button>
    </div>
  );
}
