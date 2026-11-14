import { reviewConcerns, type Answers, type ReviewFieldDef, type ReviewRule } from '@app/shared';
import { useId } from 'react';

interface Props {
  fields: ReviewFieldDef[];
  rules: ReviewRule[];
  answers: Answers;
  requestAnswers: Answers;
  /** Null shows the answers read-only. */
  onChange: ((key: string, value: unknown) => void) | null;
  /** Fields that must be answered before approving, by key. */
  missing: Record<string, string>;
}

const RADIO_MAX_OPTIONS = 5;

function display(field: ReviewFieldDef, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  return String(value);
}

function FieldControl({ field, value, onChange, missing }: { field: ReviewFieldDef; value: unknown; onChange: (v: unknown) => void; missing?: string }) {
  const id = useId();
  const helpId = field.help ? `${id}-help` : undefined;
  const missingId = missing ? `${id}-missing` : undefined;
  const describedBy = [helpId, missingId].filter(Boolean).join(' ') || undefined;
  const label = (
    <>
      {field.label}
      {field.required && <span className="optional"> (required to approve)</span>}
    </>
  );
  const help = field.help && (
    <p id={helpId} className="field-hint">
      {field.help}
    </p>
  );
  const note = missing && (
    <p id={missingId} className="field-hint missing">
      {missing}
    </p>
  );
  const options = field.options ?? [];

  if (field.type === 'multiselect' || (field.type === 'select' && options.length <= RADIO_MAX_OPTIONS)) {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="field" aria-describedby={describedBy}>
        <legend>{label}</legend>
        {help}
        <div className={`choices${options.length > 6 ? ' choices-columns' : ''}`}>
          {options.map((option) =>
            field.type === 'multiselect' ? (
              <label key={option} className="choice">
                <input
                  type="checkbox"
                  checked={selected.includes(option)}
                  onChange={(e) => onChange(e.target.checked ? options.filter((o) => o === option || selected.includes(o)) : selected.filter((o) => o !== option))}
                />
                {option}
              </label>
            ) : (
              <label key={option} className="choice">
                <input type="radio" name={id} checked={value === option} onChange={() => onChange(option)} />
                {option}
              </label>
            ),
          )}
        </div>
        {note}
      </fieldset>
    );
  }

  const text = typeof value === 'string' ? value : '';
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {help}
      {field.type === 'select' ? (
        <select id={id} aria-describedby={describedBy} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : field.type === 'textarea' ? (
        <textarea id={id} aria-describedby={describedBy} rows={4} maxLength={2000} value={text} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          id={id}
          aria-describedby={describedBy}
          type={field.type === 'date' ? 'date' : 'text'}
          maxLength={2000}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {note}
    </div>
  );
}

/** A stage's review form: grouped by section, with concerns listed on top. */
export function ReviewForm({ fields, rules, answers, requestAnswers, onChange, missing }: Props) {
  const concerns = reviewConcerns({ fields, rules }, answers, requestAnswers);
  const sections: { title: string; fields: ReviewFieldDef[] }[] = [];
  for (const field of fields) {
    const title = field.section || 'Review';
    const last = sections.at(-1);
    if (last && last.title === title) last.fields.push(field);
    else sections.push({ title, fields: [field] });
  }

  return (
    <div className="review-form">
      {concerns.length > 0 && (
        <div className="hints" role="status">
          <h4>Look at these before deciding</h4>
          <ul>
            {concerns.map((c, i) => (
              <li key={i}>{c.message}</li>
            ))}
          </ul>
        </div>
      )}
      {sections.map((section) => (
        <section key={section.title} className="review-section" aria-label={section.title}>
          <h4>{section.title}</h4>
          {onChange ? (
            section.fields.map((field) => (
              <FieldControl
                key={field.key}
                field={field}
                value={answers[field.key]}
                missing={missing[field.key]}
                onChange={(value) => onChange(field.key, value)}
              />
            ))
          ) : (
            <dl className="details">
              {section.fields.map((field) => (
                <div key={field.key} className="details-row">
                  <dt>{field.label}</dt>
                  <dd>{display(field, answers[field.key])}</dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      ))}
    </div>
  );
}
