import { formatAnswer, REQUEST_FORM_STEPS, visibleFields, type Answers } from '@app/shared';

interface Props {
  answers: Answers;
  /** When given, each section gets an Edit button that jumps to its step. */
  onEdit?: (stepIndex: number) => void;
}

/** All answers grouped by form step. */
export function AnswerSummary({ answers, onEdit }: Props) {
  return (
    <>
      {REQUEST_FORM_STEPS.map((step, index) => (
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
            {visibleFields(index, answers).map((field) => (
              <div key={field.key} className="details-row">
                <dt>{field.label}</dt>
                <dd>{formatAnswer(field, answers[field.key])}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </>
  );
}
