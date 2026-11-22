import {
  allFields,
  DEFAULT_REQUEST_FORM,
  DEFAULT_REVIEW_GUIDES,
  DEFAULT_STAGES,
  defaultWorkflowSettings,
  describeRequirement,
  parseWorkflowSettings,
  RISK_TIERS,
  STAGE_LIMITS,
  type FieldDef,
  type RaisedTier,
  type StageSettings,
  type WorkflowSettings,
} from '@app/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import {
  customizedReviewForms,
  listRequestForms,
  loadWorkflowSettings,
  resetWorkflowSettings,
  saveWorkflowSettings,
  listReviewServiceNames,
  loadIntegrations,
  type IntegrationsStatus,
} from '../requests/api';
import { ReviewFormEditor } from './ReviewFormEditor';
import { ConnectGuideLink, ReviewServicesCard } from './ReviewServicesCard';

// One card per review: when it is needed, how long the reviewer has, what they confirm,
// and the form they fill in. Changes apply to requests submitted afterwards.

type OneChoice = Extract<FieldDef, { options: unknown }>;

const TONE: Record<StageSettings['requirement'], string> = { always: 'approved', by_risk: 'review', never: 'idle' };
const SHORT: Record<StageSettings['requirement'], string> = { always: 'Always', by_risk: 'By risk', never: 'Off' };

function StageSettingsEditor({
  stage,
  initial,
  questions,
  services,
  onOpenIntegrations,
  onSave,
  onCancel,
}: {
  stage: string;
  initial: StageSettings;
  questions: OneChoice[];
  services: { id: string; name: string }[] | null;
  onOpenIntegrations?: () => void;
  onSave: (next: StageSettings) => Promise<void>;
  onCancel: () => void;
}) {
  const id = useId();
  const [s, setS] = useState<StageSettings>(initial);
  const [checklistText, setChecklistText] = useState(initial.checklist.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const condition = s.onlyWhen ? questions.find((q) => q.key === s.onlyWhen!.field) : undefined;

  async function save() {
    if (s.handledBy === 'external' && !(services ?? []).some((sv) => sv.id === s.serviceId)) {
      setError('Choose a connected review service, or let the review happen here.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave({ ...s, checklist: checklistText.split('\n').map((l) => l.trim()).filter(Boolean) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stage-settings">
      <fieldset className="field">
        <legend>When is the {stage.toLowerCase()} needed?</legend>
        <div className="choices">
          <label className="choice">
            <input type="radio" name={`${id}-req`} checked={s.requirement === 'always'} onChange={() => setS({ ...s, requirement: 'always' })} />
            Always, for every request
          </label>
          <label className="choice">
            <input type="radio" name={`${id}-req`} checked={s.requirement === 'by_risk'} onChange={() => setS({ ...s, requirement: 'by_risk' })} />
            Only for riskier requests
          </label>
          {s.requirement === 'by_risk' && (
            <div className="field nested">
              <label htmlFor={`${id}-tier`}>Needed from risk level</label>
              <select id={`${id}-tier`} value={s.minTier} onChange={(e) => setS({ ...s, minTier: e.target.value as RaisedTier })}>
                {RISK_TIERS.filter((t) => t !== 'Low').map((t) => (
                  <option key={t} value={t}>
                    {t} and higher
                  </option>
                ))}
              </select>
            </div>
          )}
          <label className="choice">
            <input type="radio" name={`${id}-req`} checked={s.requirement === 'never'} onChange={() => setS({ ...s, requirement: 'never' })} />
            Never: turn this review off
          </label>
        </div>
      </fieldset>

      {s.requirement !== 'never' && (
        <fieldset className="field">
          <legend>Extra condition (optional)</legend>
          <label className="choice">
            <input
              type="checkbox"
              checked={s.onlyWhen !== null}
              onChange={(e) => {
                const first = questions[0];
                setS({ ...s, onlyWhen: e.target.checked && first ? { field: first.key, in: [] } : null });
              }}
              disabled={questions.length === 0 && s.onlyWhen === null}
            />
            Only when an answer in the request form matches
          </label>
          {s.onlyWhen && (
            <div className="field nested">
              <label htmlFor={`${id}-q`}>Question</label>
              <select id={`${id}-q`} value={s.onlyWhen.field} onChange={(e) => setS({ ...s, onlyWhen: { field: e.target.value, in: [] } })}>
                {!condition && <option value={s.onlyWhen.field}>{s.onlyWhen.field} (not in the form in use)</option>}
                {questions.map((q) => (
                  <option key={q.key} value={q.key}>
                    {q.label}
                  </option>
                ))}
              </select>
              {condition && (
                <div className="choices" role="group" aria-label="Answers that need this review">
                  {condition.options.map((o) => (
                    <label key={o.value} className="choice">
                      <input
                        type="checkbox"
                        checked={s.onlyWhen!.in.includes(o.value)}
                        onChange={(e) => {
                          const current = s.onlyWhen!.in;
                          setS({ ...s, onlyWhen: { field: condition.key, in: e.target.checked ? [...current, o.value] : current.filter((v) => v !== o.value) } });
                        }}
                      />
                      {o.label}
                    </label>
                  ))}
                </div>
              )}
              <p className="field-hint">If a request’s form does not ask this question, the condition is skipped and the review runs.</p>
            </div>
          )}
        </fieldset>
      )}

      <fieldset className="field">
        <legend>Where does this review happen?</legend>
        <div className="choices">
          <label className="choice">
            <input type="radio" name={`${id}-where`} checked={s.handledBy === 'here'} onChange={() => setS({ ...s, handledBy: 'here' })} />
            Here: reviewers use the checklist and review form in this app
          </label>
          <label className="choice">
            <input
              type="radio"
              name={`${id}-where`}
              checked={s.handledBy === 'external'}
              onChange={() => setS({ ...s, handledBy: 'external', serviceId: s.serviceId ?? services?.[0]?.id ?? null })}
            />
            In an external service: this app sends the review there and shows the status it reports back
          </label>
        </div>
        {s.handledBy === 'external' && (
          <div className="field nested">
            {services === null ? (
              <p role="status">Loading the services…</p>
            ) : services.length === 0 ? (
              <p className="notice">
                No review service is connected yet. Add one in Admin → Integrations → Review services, then come back.{' '}
                {onOpenIntegrations && (
                  <button type="button" className="link-button" onClick={onOpenIntegrations}>
                    Open Integrations
                  </button>
                )}
              </p>
            ) : (
              <>
                <label htmlFor={`${id}-service`}>Review service</label>
                <select id={`${id}-service`} value={s.serviceId ?? ''} onChange={(e) => setS({ ...s, serviceId: e.target.value || null })}>
                  {!services.some((sv) => sv.id === s.serviceId) && <option value={s.serviceId ?? ''}>{s.serviceId ? `${s.serviceId} (not connected)` : 'Choose a service'}</option>}
                  {services.map((sv) => (
                    <option key={sv.id} value={sv.id}>
                      {sv.name}
                    </option>
                  ))}
                </select>
              </>
            )}
            <p className="field-hint">The checklist and review form below are not used for an external review.</p>
            <ConnectGuideLink />
          </div>
        )}
      </fieldset>

      <div className="editor-row">
        <div className="field">
          <label htmlFor={`${id}-sla`}>Time to review (business days)</label>
          <input
            id={`${id}-sla`}
            type="number"
            min={STAGE_LIMITS.slaMin}
            max={STAGE_LIMITS.slaMax}
            value={s.slaBusinessDays}
            onChange={(e) => setS({ ...s, slaBusinessDays: Math.round(Number(e.target.value) || 0) })}
          />
        </div>
      </div>
      <div className="field">
        <label htmlFor={`${id}-check`}>Checklist: what the reviewer confirms, one item per line</label>
        <textarea id={`${id}-check`} rows={Math.min(10, Math.max(3, checklistText.split('\n').length + 1))} value={checklistText} onChange={(e) => setChecklistText(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor={`${id}-guide`}>Guide for reviewers</label>
        <textarea id={`${id}-guide`} rows={10} maxLength={STAGE_LIMITS.guide} value={s.guide} onChange={(e) => setS({ ...s, guide: e.target.value })} />
        <p className="field-hint">
          Shown in the Guide tab of this review. Start a line with “## ” for a heading and “- ” for a list item; https links
          become clickable.{' '}
          {DEFAULT_REVIEW_GUIDES[stage] && s.guide !== DEFAULT_REVIEW_GUIDES[stage] && (
            <button type="button" className="link-button" onClick={() => setS({ ...s, guide: DEFAULT_REVIEW_GUIDES[stage]! })}>
              Use the standard guide
            </button>
          )}
        </p>
      </div>

      <FormError message={error} />
      <div className="form-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Where one review happens, right on its card: on this platform, or in a connected
 * service. Saves at once; connecting a new service opens the services panel.
 */
function WhereControl({
  stage,
  settings,
  services,
  onChange,
  onConnect,
}: {
  stage: string;
  settings: StageSettings;
  services: { id: string; name: string }[] | null;
  onChange: (next: StageSettings) => Promise<void>;
  onConnect: () => void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Another service" picked but not saved yet, because no service is chosen.
  const [choosing, setChoosing] = useState(false);
  const external = settings.handledBy === 'external' || choosing;

  async function apply(next: StageSettings) {
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
      setChoosing(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function pickExternal() {
    const first = services?.[0];
    if (services && services.length === 1 && first) void apply({ ...settings, handledBy: 'external', serviceId: first.id });
    else setChoosing(true);
  }

  return (
    <div className="where-control">
      <span className="where-label" id={`${id}-label`}>
        Done
      </span>
      <div className="segmented" role="group" aria-labelledby={`${id}-label`}>
        <button type="button" aria-pressed={!external} disabled={busy} onClick={() => void apply({ ...settings, handledBy: 'here' })}>
          On this platform<span className="visually-hidden"> ({stage})</span>
        </button>
        <button type="button" aria-pressed={external} disabled={busy} onClick={pickExternal}>
          In another service<span className="visually-hidden"> ({stage})</span>
        </button>
      </div>
      {external && (
        <div className="where-service">
          {services === null ? (
            <p role="status">Loading the services…</p>
          ) : services.length === 0 ? (
            <p className="field-hint">
              No service is connected yet.{' '}
              <button type="button" className="link-button" onClick={onConnect}>
                Connect a service
              </button>
            </p>
          ) : (
            <>
              <label htmlFor={`${id}-service`}>Service</label>
              <select
                id={`${id}-service`}
                value={settings.handledBy === 'external' ? settings.serviceId ?? '' : ''}
                disabled={busy}
                onChange={(e) => e.target.value && void apply({ ...settings, handledBy: 'external', serviceId: e.target.value })}
              >
                {(settings.handledBy !== 'external' || !services.some((sv) => sv.id === settings.serviceId)) && (
                  <option value="">{settings.serviceId && settings.handledBy === 'external' ? `${settings.serviceId} (not connected)` : 'Choose a service'}</option>
                )}
                {services.map((sv) => (
                  <option key={sv.id} value={sv.id}>
                    {sv.name}
                  </option>
                ))}
              </select>
              <button type="button" className="link-button" onClick={onConnect}>
                Connect another service
              </button>
            </>
          )}
          {choosing && settings.handledBy !== 'external' && (
            <button type="button" className="link-button" onClick={() => setChoosing(false)}>
              Cancel
            </button>
          )}
        </div>
      )}
      <FormError message={error} />
    </div>
  );
}

/** Connected review services, managed from the Reviews page as well as Integrations. */
function ServicesPanel({ supabase, onChanged, onClose }: { supabase: SupabaseClient; onChanged: () => void; onClose: () => void }) {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setStatus(await loadIntegrations(supabase));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="services-panel">
      <FormError message={error} />
      {!status && !error && <p role="status">Loading…</p>}
      {status && (
        <ReviewServicesCard
          supabase={supabase}
          services={status.reviewServices ?? []}
          encryptionReady={status.encryptionReady}
          onChanged={async () => {
            await load();
            onChanged();
          }}
        />
      )}
      <button type="button" className="button button-secondary button-small" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

export function ReviewsSection({ supabase, orgId, onOpenIntegrations }: { supabase: SupabaseClient; orgId: string; onOpenIntegrations?: () => void }) {
  const [services, setServices] = useState<{ id: string; name: string }[] | null>(null);
  const loadServices = useCallback(() => {
    listReviewServiceNames(supabase).then(setServices, () => setServices([]));
  }, [supabase]);
  useEffect(loadServices, [loadServices]);
  const [servicesOpen, setServicesOpen] = useState(false);
  const [settings, setSettings] = useState<WorkflowSettings | null>(null);
  const [isCustom, setIsCustom] = useState(false);
  const [customForms, setCustomForms] = useState<string[]>([]);
  const [questions, setQuestions] = useState<OneChoice[]>([]);
  const [open, setOpen] = useState<{ stage: string; panel: 'settings' | 'form' } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [stored, forms, saved] = await Promise.all([loadWorkflowSettings(supabase, orgId), customizedReviewForms(supabase, orgId), listRequestForms(supabase, orgId)]);
      const parsed = stored === null ? null : parseWorkflowSettings(stored);
      setSettings(parsed && 'settings' in parsed ? parsed.settings : defaultWorkflowSettings());
      setIsCustom(parsed !== null && 'settings' in parsed);
      setCustomForms(forms);
      // Conditions point at questions of the form new requests use.
      const inUse = saved.find((f) => f.is_active)?.definition ?? DEFAULT_REQUEST_FORM;
      setQuestions(allFields(inUse).filter((f): f is OneChoice => f.type === 'radio' || f.type === 'select'));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const labelOf = (key: string) => questions.find((q) => q.key === key)?.label ?? key;

  async function saveStage(stage: string, next: StageSettings, keepOpen = false) {
    if (!settings) return;
    await saveWorkflowSettings(supabase, { ...settings, [stage]: next });
    if (!keepOpen) setOpen(null);
    const where = next.handledBy === 'external' ? ` It now runs in ${services?.find((sv) => sv.id === next.serviceId)?.name ?? 'another service'}.` : '';
    setNotice(`${stage} saved.${where} Requests submitted from now on follow it; requests already sent keep their checks.`);
    await reload();
  }

  return (
    <section className="card" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading">Reviews</h2>
      <p className="field-hint">
        Each request goes through these checks. For each one, choose where it is done (on this platform or in another
        service), when it is needed, how long the reviewer has, what they confirm and what they fill in. Changes apply to
        requests submitted afterwards.
      </p>
      <div className="question-actions">
        <button type="button" className="button button-secondary button-small" aria-expanded={servicesOpen} onClick={() => setServicesOpen(!servicesOpen)}>
          Connected services{services && services.length > 0 ? ` (${services.length})` : ''}
        </button>
        <ConnectGuideLink />
      </div>
      {servicesOpen && <ServicesPanel supabase={supabase} onChanged={loadServices} onClose={() => setServicesOpen(false)} />}
      <FormError message={error} />
      {notice && (
        <p className="notice notice-approved" role="status">
          {notice}
        </p>
      )}
      {!settings ? (
        <p role="status">Loading…</p>
      ) : (
        <ul className="review-cards">
          {DEFAULT_STAGES.map((stage) => {
            const s = settings[stage]!;
            const isOpen = open?.stage === stage;
            return (
              <li key={stage} className={`review-card${s.requirement === 'never' ? ' is-off' : ''}`}>
                <div className="review-card-head">
                  <h3>{stage}</h3>
                  <span className="badges">
                    {s.handledBy === 'external' && s.requirement !== 'never' && (
                      <span className="status-badge" data-tone="waiting">
                        {services?.find((sv) => sv.id === s.serviceId)?.name ?? 'External service'}
                      </span>
                    )}
                    <span className="status-badge" data-tone={TONE[s.requirement]}>
                      {SHORT[s.requirement]}
                    </span>
                  </span>
                </div>
                <p className="review-card-summary">{describeRequirement(s, labelOf)}.</p>
                {s.requirement !== 'never' && (
                  <WhereControl
                    stage={stage}
                    settings={s}
                    services={services}
                    onChange={(next) => saveStage(stage, next, true)}
                    onConnect={() => setServicesOpen(true)}
                  />
                )}
                <ul className="review-card-facts">
                  <li>{s.requirement === 'never' ? '—' : `${s.slaBusinessDays} business ${s.slaBusinessDays === 1 ? 'day' : 'days'} to review`}</li>
                  {s.handledBy === 'external' ? (
                    <li>Checklist and form: in {services?.find((sv) => sv.id === s.serviceId)?.name ?? 'the service'}</li>
                  ) : (
                    <>
                      <li>
                        {s.checklist.length} checklist {s.checklist.length === 1 ? 'item' : 'items'}
                      </li>
                      <li>{customForms.includes(stage) ? 'Own review form' : 'Standard review form'}</li>
                    </>
                  )}
                </ul>
                <div className="question-actions">
                  <button
                    type="button"
                    className="button button-secondary button-small"
                    aria-expanded={isOpen && open.panel === 'settings'}
                    onClick={() => setOpen(isOpen && open.panel === 'settings' ? null : { stage, panel: 'settings' })}
                  >
                    {s.handledBy === 'external' ? 'When needed' : 'When needed and checklist'}
                    <span className="visually-hidden"> for {stage}</span>
                  </button>
                  {s.handledBy !== 'external' && (
                  <button
                    type="button"
                    className="button button-secondary button-small"
                    aria-expanded={isOpen && open.panel === 'form'}
                    onClick={() => setOpen(isOpen && open.panel === 'form' ? null : { stage, panel: 'form' })}
                  >
                    Review form<span className="visually-hidden"> for {stage}</span>
                  </button>
                  )}
                </div>
                {isOpen && open.panel === 'settings' && (
                  <StageSettingsEditor
                    stage={stage}
                    initial={s}
                    questions={questions}
                    services={services}
                    onOpenIntegrations={onOpenIntegrations}
                    onSave={(next) => saveStage(stage, next)}
                    onCancel={() => setOpen(null)}
                  />
                )}
                {isOpen && open.panel === 'form' && <ReviewFormEditor supabase={supabase} orgId={orgId} stage={stage} onSaved={() => void reload()} />}
              </li>
            );
          })}
        </ul>
      )}
      {isCustom && (
        <button
          type="button"
          className="link-button"
          onClick={() => {
            if (!window.confirm('Go back to the standard settings for all reviews? Review forms are not changed.')) return;
            void (async () => {
              try {
                await resetWorkflowSettings(supabase);
                setNotice('All reviews follow the standard settings again.');
                await reload();
              } catch (e) {
                setError(errorMessage(e));
              }
            })();
          }}
        >
          Reset all reviews to the standard settings
        </button>
      )}
    </section>
  );
}
