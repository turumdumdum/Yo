import { DEFAULT_REQUEST_FORM, formatAnswer, visibleFields, type Answers, type RequestFormDefinition } from '@app/shared';

interface Props {
  answers: Answers;
  /** When given, each section gets an Edit button that jumps to its step. */
  onEdit?: (stepIndex: number) => void;
  /** The form the answers belong to; the standard form when null. */
  form?: RequestFormDefinition | null;
  /** Show only these fields (by key); steps without any of them are left out. */
  fields?: readonly string[];
}

const isEmpty = (value: unknown) =>
  value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);

/**
 * All answers grouped by form step. Read-only (no onEdit), unanswered optional questions
 * are listed in one quiet line instead of a row of dashes each.
 */
export function AnswerSummary({ answers, onEdit, form: ownForm, fields }: Props) {
  const form = ownForm ?? DEFAULT_REQUEST_FORM;
  const only = fields ? new Set(fields) : null;
  return (
    <>
      {form.steps.map((step, index) => {
        const all = visibleFields(index, answers, form).filter((f) => !only || only.has(f.key));
        const shown = onEdit ? all : all.filter((f) => !isEmpty(answers[f.key]));
        const unanswered = onEdit ? [] : all.filter((f) => isEmpty(answers[f.key]));
        return all.length === 0 ? null : (
        <section key={step.title} className="summary-section" aria-label={step.title}>
          <div className="summary-head">
            <h3>{step.title}</h3>
            {onEdit && (
              <button type="button" className="link-button" onClick={() => onEdit(index)}>
                Edit<span className="visually-hidden"> {step.title}</span>
              </button>
            )}
          </div>
          <dl className="details">
            {shown.map((field) => (
              <div key={field.key} className="details-row">
                <dt>{field.label}</dt>
                <dd>{formatAnswer(field, answers[field.key])}</dd>
              </div>
            ))}
          </dl>
          {unanswered.length > 0 && (
            <p className="field-hint summary-unanswered">Not answered: {unanswered.map((f) => f.label).join(', ')}</p>
          )}
        </section>
        );
      })}
    </>
  );
}
