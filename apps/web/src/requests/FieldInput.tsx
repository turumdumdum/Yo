import type { FieldDef, OwnerValue } from '@app/shared';
import { useId } from 'react';

interface Props {
  field: FieldDef;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
}

/** Renders one form field from its definition. */
export function FieldInput({ field, value, error, onChange }: Props) {
  const id = useId();
  const hintId = field.hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const label = (
    <>
      {field.label}
      {field.optional && <span className="optional"> (optional)</span>}
    </>
  );
  const hint = field.hint && (
    <p id={hintId} className="field-hint">
      {field.hint}
    </p>
  );
  const errorText = error && (
    <p id={errorId} className="field-error">
      {error}
    </p>
  );
  const common = { id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined } as const;

  if (field.type === 'radio' || field.type === 'multiselect') {
    const selected = field.type === 'multiselect' ? (Array.isArray(value) ? (value as string[]) : []) : [];
    return (
      <fieldset className="field" data-field={field.key} aria-describedby={describedBy}>
        <legend>{label}</legend>
        {hint}
        <div className="choices">
          {field.options.map((option) =>
            field.type === 'radio' ? (
              <label key={option.value} className="choice">
                <input
                  type="radio"
                  name={id}
                  checked={value === option.value}
                  onChange={() => onChange(option.value)}
                />
                {option.label}
              </label>
            ) : (
              <label key={option.value} className="choice">
                <input
                  type="checkbox"
                  checked={selected.includes(option.value)}
                  onChange={(e) =>
                    onChange(e.target.checked ? [...selected, option.value] : selected.filter((v) => v !== option.value))
                  }
                />
                {option.label}
              </label>
            ),
          )}
        </div>
        {errorText}
      </fieldset>
    );
  }

  if (field.type === 'owner') {
    const owner = (value && typeof value === 'object' ? value : {}) as OwnerValue;
    return (
      <fieldset className="field" data-field={field.key} aria-describedby={describedBy}>
        <legend>{label}</legend>
        <label htmlFor={id} className="sub-label">
          Name or email
        </label>
        <input
          {...common}
          type="text"
          value={owner.notRequired ? '' : (owner.name ?? '')}
          disabled={owner.notRequired === true}
          onChange={(e) => onChange({ name: e.target.value })}
        />
        <label className="choice">
          <input
            type="checkbox"
            checked={owner.notRequired === true}
            onChange={(e) => onChange(e.target.checked ? { notRequired: true } : { name: '' })}
          />
          Not required
        </label>
        {errorText}
      </fieldset>
    );
  }

  const text = value === undefined || value === null ? '' : String(value);
  let control;
  if (field.type === 'textarea') {
    control = <textarea {...common} rows={4} value={text} onChange={(e) => onChange(e.target.value)} />;
  } else if (field.type === 'select') {
    control = (
      <select {...common} value={text} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose…</option>
        {field.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  } else if (field.type === 'integer' || field.type === 'money') {
    control = (
      <input
        {...common}
        type="text"
        inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
        value={text}
        onChange={(e) => {
          // Keep what was typed; store a number as soon as it is one.
          const raw = e.target.value;
          const parsed = Number(raw.trim());
          onChange(raw.trim() !== '' && Number.isFinite(parsed) && String(parsed) === raw.trim() ? parsed : raw);
        }}
      />
    );
  } else {
    control = (
      <input
        {...common}
        type={field.type === 'date' ? 'date' : field.type === 'url' ? 'url' : 'text'}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <div className="field" data-field={field.key}>
      <label htmlFor={id}>{label}</label>
      {hint}
      {control}
      {errorText}
    </div>
  );
}
