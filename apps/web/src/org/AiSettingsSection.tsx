import {
  AI_CHECK_RULES,
  AI_SETTINGS_LIMITS,
  DEFAULT_AI_CHECK_SETTINGS,
  DEFAULT_REQUEST_FORM,
  parseAiCheckSettings,
  type AiCheckSettings,
  type RequestFormDefinition,
} from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { aiStatus, listRequestForms, loadAiSettings, resetAiSettings, saveAiSettings } from '../requests/api';

const EXAMPLES = [
  'Treat any tool without SSO as a warning and suggest SSO when the vendor offers it.',
  'Our data must stay in the EU: flag any other data location.',
  'Explain remarks in simple words; requesters are not security experts.',
];

/** Admin settings for the optional AI check at the end of the request form. */
export function AiSettingsSection({ supabase, orgId }: { supabase: SupabaseClient; orgId: string }) {
  const [settings, setSettings] = useState<AiCheckSettings | null>(null);
  const [form, setForm] = useState<RequestFormDefinition>(DEFAULT_REQUEST_FORM);
  const [provider, setProvider] = useState<string | null | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [stored, forms, status] = await Promise.all([loadAiSettings(supabase, orgId), listRequestForms(supabase, orgId), aiStatus(supabase)]);
      const parsed = stored === null ? null : parseAiCheckSettings(stored);
      setSettings(parsed && 'settings' in parsed ? parsed.settings : DEFAULT_AI_CHECK_SETTINGS);
      setForm(forms.find((f) => f.is_active)?.definition ?? DEFAULT_REQUEST_FORM);
      setProvider(status.enabled ? status.provider : null);
      setDirty(false);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, orgId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const update = (patch: Partial<AiCheckSettings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    setDirty(true);
    setNotice(null);
  };

  async function save() {
    if (!settings) return;
    setBusy(true);
    setError(null);
    try {
      await saveAiSettings(supabase, settings);
      setDirty(false);
      setNotice('Saved. The next AI check uses these settings.');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const allKeys = form.steps.flatMap((s) => s.fields.map((f) => f.key));
  const everything = settings !== null && (settings.fields.length === 0 || allKeys.every((k) => settings.fields.includes(k)));
  const toggle = (key: string, on: boolean) => {
    if (!settings) return;
    const base = settings.fields.length === 0 ? allKeys : settings.fields;
    const next = on ? [...new Set([...base, key])] : base.filter((k) => k !== key);
    update({ fields: next.length === allKeys.length ? [] : next });
  };

  return (
    <section className="card" aria-labelledby="ai-settings-heading">
      <h2 id="ai-settings-heading">AI check</h2>
      <p className="field-hint">
        At the end of the request form, requesters can ask the AI to check their answers. It points out problems and can propose
        a corrected answer that the requester accepts with one click, or ignores. It never changes answers by itself.
      </p>
      {provider === null && (
        <p className="notice">
          AI is off on this server, so requesters do not see the check. These settings are kept for when it is turned on
          (AI_PROVIDER in apps/api/.env).
        </p>
      )}
      {provider && <p className="field-hint">Provider: {provider}. Only the answers to the questions chosen below are sent to it.</p>}
      <FormError message={error} />
      {notice && (
        <p className="notice notice-approved" role="status">
          {notice}
        </p>
      )}
      {!settings ? (
        <p role="status">Loading…</p>
      ) : (
        <>
          <label className="choice">
            <input type="checkbox" checked={settings.proposeFixes} onChange={(e) => update({ proposeFixes: e.target.checked })} />
            Propose corrected answers the requester can accept
          </label>

          <div className="field">
            <label htmlFor="ai-instructions">Your instructions for the AI (optional)</label>
            <textarea
              id="ai-instructions"
              rows={6}
              maxLength={AI_SETTINGS_LIMITS.instructions}
              value={settings.instructions}
              placeholder={EXAMPLES.join('\n')}
              onChange={(e) => update({ instructions: e.target.value })}
            />
            <p className="field-hint">
              Write in plain words what matters in your organization. {settings.instructions.length} of {AI_SETTINGS_LIMITS.instructions}{' '}
              characters. Do not put secrets or personal data here: the text is sent to the AI provider.
            </p>
            <details className="format-help">
              <summary>What the AI is always told</summary>
              <p>{AI_CHECK_RULES}</p>
              <p>
                Your instructions are added after these rules. They cannot change the format of the answer, and proposed answers are
                always checked against the form before the requester sees them.
              </p>
            </details>
          </div>

          <fieldset className="field">
            <legend>Questions to check</legend>
            <p className="field-hint">From the request form in use. Answers to other questions are not sent to the AI.</p>
            <label className="choice">
              <input type="checkbox" checked={everything} disabled={everything} onChange={(e) => e.target.checked && update({ fields: [] })} />
              <strong>All questions</strong>
              {everything && <span className="stage-meta"> (untick the questions to leave out)</span>}
            </label>
            <div className="ai-field-groups">
              {form.steps.map((step, i) => (
                <div key={i} className="ai-field-group" role="group" aria-label={step.title}>
                  <p className="ai-field-step">{step.title}</p>
                  {step.fields.map((f) => (
                    <label key={f.key} className="choice">
                      <input
                        type="checkbox"
                        // At least one question stays chosen.
                        disabled={settings.fields.length === 1 && settings.fields[0] === f.key}
                        checked={settings.fields.length === 0 || settings.fields.includes(f.key)}
                        onChange={(e) => toggle(f.key, e.target.checked)}
                      />
                      {f.label}
                      {f.type === 'owner' && <span className="stage-meta"> (only whether it is filled in)</span>}
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </fieldset>

          <div className="form-actions">
            <button type="button" className="button" disabled={busy || !dirty} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save AI settings'}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Go back to the standard AI settings?')) return;
                void (async () => {
                  try {
                    await resetAiSettings(supabase);
                    await reload();
                    setNotice('The standard AI settings apply again.');
                  } catch (e) {
                    setError(errorMessage(e));
                  }
                })();
              }}
            >
              Use standard settings
            </button>
          </div>
        </>
      )}
    </section>
  );
}
