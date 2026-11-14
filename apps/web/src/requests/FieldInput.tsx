import { formatAnswer, withHttps, type AiSuggestion, type FieldDef, type OwnerValue } from '@app/shared';
import { useId } from 'react';

interface Props {
  field: FieldDef;
  value: unknown;
  error?: string;
  onChange: (value: unknown) => void;
  /** An AI proposal for this field, shown under it until the requester uses or dismisses it. */
  suggestion?: AiSuggestion;
  onDismissSuggestion?: () => void;
}

/** A proposed value under a field. Using it fills the field, which stays editable. */
function Suggestion({ field, suggestion, onUse, onDismiss }: { field: FieldDef; suggestion: AiSuggestion; onUse: () => void; onDismiss: () => void }) {
  return (
    <div className="suggestion" role="group" aria-label={`Suggested ${field.label}`}>
      <p>
        <span className="suggested-tag">Suggested</span> {formatAnswer(field, suggestion.value)}
      </p>
      {suggestion.reason && <p className="stage-meta">{suggestion.reason}</p>}
      {suggestion.sources.length > 0 && (
        <p className="stage-meta">
          Sources:{' '}
          {suggestion.sources.map((source, i) => (
            <span key={source.url}>
              {i > 0 && ', '}
              <a href={source.url} target="_blank" rel="noreferrer noopener">
                {source.title || new URL(source.url).hostname}
              </a>
            </span>
          ))}
        </p>
      )}
      <div className="suggestion-actions">
        <button type="button" className="button button-small" aria-label={`Use suggested ${field.label}`} onClick={onUse}>
          Use
        </button>
        <button
          type="button"
          className="button button-secondary button-small"
          aria-label={`Dismiss suggested ${field.label}`}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** Renders one form field from its definition. */
export function FieldInput({ field, value, error, onChange, suggestion, onDismissSuggestion }: Props) {
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
  const suggested = suggestion && (
    <Suggestion
      field={field}
      suggestion={suggestion}
      onUse={() => {
        onChange(suggestion.value);
        onDismissSuggestion?.();
      }}
      onDismiss={() => onDismissSuggestion?.()}
    />
  );

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
        {suggested}
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
        {suggested}
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
        // Not type="url": the browser would reject an address typed without https://.
        type={field.type === 'date' ? 'date' : 'text'}
        inputMode={field.type === 'url' ? 'url' : undefined}
        autoCapitalize={field.type === 'url' ? 'none' : undefined}
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onBlur={field.type === 'url' ? (e) => e.target.value.trim() !== '' && onChange(withHttps(e.target.value)) : undefined}
      />
    );
  }

  return (
    <div className="field" data-field={field.key}>
      <label htmlFor={id}>{label}</label>
      {hint}
      {control}
      {suggested}
      {errorText}
    </div>
  );
}
