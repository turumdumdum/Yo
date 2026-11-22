import { DEFAULT_STAGES } from '@app/shared';
import { useState } from 'react';

/** "Reviews: All" or "Security review only" / "Security review, Legal review". */
export function scopeSummary(scope: string[] | null | undefined): string {
  if (!scope || scope.length === 0 || DEFAULT_STAGES.every((s) => scope.includes(s))) return 'Reviews: All';
  if (scope.length === 1) return `Reviews: ${scope[0]} only`;
  return `Reviews: ${scope.join(', ')}`;
}

interface Props {
  idPrefix: string;
  email: string;
  scope: string[] | null;
  disabled?: boolean;
  onSave: (stages: string[] | null) => Promise<void> | void;
}

/** Which reviews a member may act on. Empty means every review. */
export function ReviewScopeEditor({ idPrefix, email, scope, disabled, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(!scope || scope.length === 0);
  const [picked, setPicked] = useState<Set<string>>(new Set(scope ?? []));

  function reset() {
    setAll(!scope || scope.length === 0);
    setPicked(new Set(scope ?? []));
  }

  const legend = `${idPrefix}-legend`;
  return (
    <div className="scope-editor">
      <span className="scope-summary">{scopeSummary(scope)}</span>
      {!open ? (
        <button
          type="button"
          className="button button-secondary button-small"
          disabled={disabled}
          aria-label={`Edit which reviews ${email} can work on`}
          onClick={() => {
            reset();
            setOpen(true);
          }}
        >
          Edit reviews
        </button>
      ) : (
        <fieldset className="scope-form" aria-labelledby={legend}>
          <legend id={legend}>Reviews {email} can work on</legend>
          <label className="choice">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
            All reviews
          </label>
          {DEFAULT_STAGES.map((stage) => (
            <label key={stage} className="choice">
              <input
                type="checkbox"
                disabled={all}
                checked={all || picked.has(stage)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(stage);
                  else next.delete(stage);
                  setPicked(next);
                }}
              />
              {stage}
            </label>
          ))}
          <p className="field-hint">The member sees and acts only on the reviews ticked here. Admins keep access to settings.</p>
          <div className="actions">
            <button
              type="button"
              className="button button-small"
              disabled={disabled || (!all && picked.size === 0)}
              onClick={async () => {
                const stages = all ? null : DEFAULT_STAGES.filter((s) => picked.has(s));
                await onSave(stages && stages.length === DEFAULT_STAGES.length ? null : stages);
                setOpen(false);
              }}
            >
              Save
            </button>
            <button type="button" className="button button-secondary button-small" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </fieldset>
      )}
    </div>
  );
}
