import { asanaMapping, FIELD_TYPE_LABELS, importAsanaField, type AsanaField, type RequestFormDefinition } from '@app/shared';
import { useEffect, useId, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { listAsanaFields, listAsanaProjects, listAsanaWorkspaces, type AsanaPlace } from '../requests/api';

// "Import from Asana" in the request form editor: pick a workspace and project, tick its
// custom fields, and they become questions with all their values as choices. Nothing is
// saved until the admin saves the form. A field imported before updates its choices.

interface Props {
  supabase: SupabaseClient;
  form: RequestFormDefinition;
  onImport: (next: RequestFormDefinition, summary: string) => void;
  onClose: () => void;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function AsanaImport({ supabase, form, onImport, onClose }: Props) {
  const id = useId();
  const [workspaces, setWorkspaces] = useState<AsanaPlace[] | null>(null);
  const [workspace, setWorkspace] = useState('');
  const [projects, setProjects] = useState<AsanaPlace[] | null>(null);
  const [project, setProject] = useState('');
  const [fields, setFields] = useState<AsanaField[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState<string | null>('Loading your Asana workspaces…');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listAsanaWorkspaces(supabase).then(
      (r) => {
        if (!live) return;
        setWorkspaces(r.workspaces);
        setWorkspace(r.selected ?? (r.workspaces.length === 1 ? r.workspaces[0]!.gid : ''));
        setLoading(null);
      },
      (e) => {
        if (!live) return;
        setError(errorMessage(e));
        setLoading(null);
      },
    );
    return () => {
      live = false;
    };
  }, [supabase]);

  useEffect(() => {
    setProjects(null);
    setProject('');
    setFields(null);
    if (!workspace) return;
    let live = true;
    setLoading('Loading projects…');
    setError(null);
    listAsanaProjects(supabase, workspace).then(
      (list) => live && (setProjects(list), setLoading(null)),
      (e) => live && (setError(errorMessage(e)), setLoading(null)),
    );
    return () => {
      live = false;
    };
  }, [supabase, workspace]);

  useEffect(() => {
    setFields(null);
    if (!project) return;
    let live = true;
    setLoading('Loading the project’s fields…');
    setError(null);
    listAsanaFields(supabase, project).then(
      (list) => {
        if (!live) return;
        setFields(list);
        // Tick everything that can be imported.
        setPicked(new Set(list.filter((f) => asanaMapping(f).type).map((f) => f.gid)));
        setLoading(null);
      },
      (e) => live && (setError(errorMessage(e)), setLoading(null)),
    );
    return () => {
      live = false;
    };
  }, [supabase, project]);

  const inForm = new Set(form.steps.flatMap((s) => s.fields).flatMap((f) => (f.source?.system === 'asana' ? [f.source.fieldGid] : [])));

  function runImport() {
    let next = form;
    const counts = { added: 0, updated: 0, unchanged: 0 };
    const problems: string[] = [];
    for (const field of fields ?? []) {
      if (!picked.has(field.gid)) continue;
      const result = importAsanaField(next, step, field, includeDisabled);
      if ('error' in result) {
        problems.push(`${field.name}: ${result.error}`);
        continue;
      }
      next = result.form;
      counts[result.result]++;
    }
    const parts = [
      counts.added && `${plural(counts.added, 'question', 'questions')} added`,
      counts.updated && `${plural(counts.updated, 'question', 'questions')} updated with Asana’s current values`,
      counts.unchanged && `${counts.unchanged} already up to date`,
      problems.length && `skipped ${problems.join('; ')}`,
    ].filter(Boolean);
    onImport(next, `From Asana: ${parts.join(', ') || 'nothing to import'}. Review them, then save the form.`);
  }

  const importable = (fields ?? []).filter((f) => asanaMapping(f, includeDisabled).type);
  return (
    <section className="asana-import" aria-labelledby={`${id}-title`}>
      <div className="review-card-head">
        <h3 id={`${id}-title`}>Import from Asana</h3>
        <button type="button" className="button button-secondary button-small" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="field-hint">
        The custom fields of a project become questions, with all their values as choices. A field imported before is updated instead of added
        again. Nothing is saved until you save the form.
      </p>
      <FormError message={error} />
      <div className="editor-row">
        <div className="field">
          <label htmlFor={`${id}-ws`}>Workspace</label>
          <select id={`${id}-ws`} value={workspace} disabled={!workspaces} onChange={(e) => setWorkspace(e.target.value)}>
            <option value="">{workspaces ? 'Choose a workspace' : '…'}</option>
            {(workspaces ?? []).map((w) => (
              <option key={w.gid} value={w.gid}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-project`}>Project</label>
          <select id={`${id}-project`} value={project} disabled={!projects} onChange={(e) => setProject(e.target.value)}>
            <option value="">{projects ? (projects.length ? 'Choose a project' : 'No projects in this workspace') : '…'}</option>
            {(projects ?? []).map((p) => (
              <option key={p.gid} value={p.gid}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {loading && <p role="status">{loading}</p>}

      {fields && (
        <>
          {fields.length === 0 ? (
            <p className="empty-state">This project has no custom fields.</p>
          ) : (
            <fieldset className="field">
              <legend>Fields to import</legend>
              <ul className="asana-fields">
                {fields.map((f) => {
                  const mapping = asanaMapping(f, includeDisabled);
                  const values = f.options.filter((o) => includeDisabled || o.enabled);
                  return (
                    <li key={f.gid}>
                      <label className="choice">
                        <input
                          type="checkbox"
                          disabled={!mapping.type}
                          checked={!!mapping.type && picked.has(f.gid)}
                          onChange={(e) =>
                            setPicked((cur) => {
                              const next = new Set(cur);
                              if (e.target.checked) next.add(f.gid);
                              else next.delete(f.gid);
                              return next;
                            })
                          }
                        />
                        <span>
                          <strong>{f.name}</strong>
                          {inForm.has(f.gid) && (
                            <span className="status-badge" data-tone="review">
                              In the form: updates its values
                            </span>
                          )}
                          <span className="field-hint asana-field-meta">
                            {[mapping.type ? FIELD_TYPE_LABELS[mapping.type] : '', mapping.note].filter(Boolean).join(' · ')}
                            {values.length > 0 && `: ${values.slice(0, 6).map((o) => o.name).join(', ')}${values.length > 6 ? `, +${values.length - 6} more` : ''}`}
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          )}
          {fields.some((f) => f.options.some((o) => !o.enabled)) && (
            <label className="choice">
              <input type="checkbox" checked={includeDisabled} onChange={(e) => setIncludeDisabled(e.target.checked)} />
              Also import values that are turned off in Asana
            </label>
          )}
          {importable.length > 0 && (
            <div className="editor-row">
              <div className="field">
                <label htmlFor={`${id}-step`}>Add new questions to</label>
                <select id={`${id}-step`} value={step} onChange={(e) => setStep(Number(e.target.value))}>
                  {form.steps.map((s, i) => (
                    <option key={i} value={i}>
                      Step {i + 1}: {s.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
          <div className="question-actions">
            <button type="button" className="button" disabled={!importable.some((f) => picked.has(f.gid))} onClick={runImport}>
              Import {plural(importable.filter((f) => picked.has(f.gid)).length, 'field', 'fields')}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
