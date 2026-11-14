import {
  createInvitationSchema,
  invitationLinksCsv,
  MAX_INVITATIONS_PER_IMPORT,
  ORG_ROLE_LABELS,
  ORG_ROLES,
  parseInviteImport,
  type InviteImportResult,
  type OrgRole,
} from '@app/shared';
import { useState, type ChangeEvent, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Field } from '../components/Field';
import { FormError } from '../components/FormError';
import { downloadText } from '../lib/download';
import { errorMessage } from '../lib/errors';
import { createInvitation, createInvitations, type BulkInvitationResult } from './api';

interface Props {
  supabase: SupabaseClient;
  orgId: string;
  /** Lower-case allowed domains when the organization is restricted to them, else null. */
  allowedDomains: string[] | null;
  onChanged: () => Promise<void> | void;
}

const MAX_FILE_BYTES = 1_000_000;
const linkFor = (token: string) => `${window.location.origin}/?invite=${token}`;

function RoleSelect({ id, value, onChange }: { id: string; value: OrgRole; onChange: (role: OrgRole) => void }) {
  return (
    <select id={id} className="role-select" value={value} onChange={(e) => onChange(e.target.value as OrgRole)}>
      {ORG_ROLES.map((r) => (
        <option key={r} value={r}>
          {ORG_ROLE_LABELS[r]}
        </option>
      ))}
    </select>
  );
}

/** Invite one person, or many at once from CSV or JSON. Emails are not sent yet: links are handed out. */
export function InviteSection({ supabase, orgId, allowedDomains, onChanged }: Props) {
  const [mode, setMode] = useState<'one' | 'many'>('one');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // One person
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('requester');
  const [emailError, setEmailError] = useState<string>();
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // Many people
  const [text, setText] = useState('');
  const [defaultRole, setDefaultRole] = useState<OrgRole>('requester');
  const [preview, setPreview] = useState<InviteImportResult | null>(null);
  const [results, setResults] = useState<BulkInvitationResult[] | null>(null);

  const outsideDomains = (address: string) =>
    allowedDomains !== null && !allowedDomains.includes(address.slice(address.lastIndexOf('@') + 1));

  async function inviteOne(event: FormEvent) {
    event.preventDefault();
    const parsed = createInvitationSchema.safeParse({ email, role });
    if (!parsed.success) {
      setEmailError('Enter a valid email address');
      return;
    }
    setEmailError(undefined);
    setCopied(false);
    setBusy(true);
    setError(null);
    try {
      const token = await createInvitation(supabase, orgId, parsed.data.email, parsed.data.role);
      setLink({ email: parsed.data.email, url: linkFor(token) });
      setEmail('');
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      setError('Could not copy. Select the link and copy it manually.');
    }
  }

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setError('The file is larger than 1 MB. Split it into smaller files.');
      return;
    }
    const content = await file.text();
    setText(content);
    setPreview(parseInviteImport(content, defaultRole));
    setResults(null);
  }

  async function createMany() {
    if (!preview || preview.rows.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await createInvitations(supabase, orgId, preview.rows));
      setPreview(null);
      setText('');
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const created = (results ?? []).filter((r): r is Extract<BulkInvitationResult, { token: string }> => 'token' in r);
  const failed = (results ?? []).filter((r): r is Extract<BulkInvitationResult, { error: string }> => 'error' in r);
  const outside = preview?.rows.filter((r) => outsideDomains(r.email)) ?? [];

  return (
    <section className="card" aria-labelledby="invite-heading">
      <h2 id="invite-heading">Invite people</h2>
      <div className="segmented" role="group" aria-label="How many people">
        <button type="button" aria-pressed={mode === 'one'} onClick={() => setMode('one')}>
          One person
        </button>
        <button type="button" aria-pressed={mode === 'many'} onClick={() => setMode('many')}>
          Many people (CSV or JSON)
        </button>
      </div>
      <p className="field-hint">
        Emails are not sent yet: you get a link per person to pass on. Each link works once, for 7 days, and only for an
        account with that email address.
        {allowedDomains && ` Only addresses at ${allowedDomains.join(', ')} can be invited.`}
      </p>
      <FormError message={error} />

      {mode === 'one' && (
        <>
          <form onSubmit={inviteOne} noValidate className="invite-form">
            <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={emailError} required />
            <div className="field">
              <label htmlFor="invite-role">Role</label>
              <RoleSelect id="invite-role" value={role} onChange={setRole} />
            </div>
            <button type="submit" className="button" disabled={busy}>
              Create invitation
            </button>
          </form>
          {link && (
            <div className="notice" role="status">
              <p>
                Invitation for <strong>{link.email}</strong> created. Copy the link and send it. It is not shown again.
              </p>
              <p>
                <code className="secret">{link.url}</code>
              </p>
              <button type="button" className="button button-secondary button-small" onClick={() => void copyLink()}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
            </div>
          )}
        </>
      )}

      {mode === 'many' && (
        <>
          <details className="format-help">
            <summary>File format</summary>
            <p>CSV with an <code>email</code> column and an optional <code>role</code> column (comma or semicolon separated):</p>
            <pre>{'email,role\nann@acme.com,Reviewer\nbo@acme.com,Requester'}</pre>
            <p>Or JSON:</p>
            <pre>{'[\n  { "email": "ann@acme.com", "role": "reviewer" },\n  "bo@acme.com"\n]'}</pre>
            <p>
              Roles: {ORG_ROLES.map((r) => ORG_ROLE_LABELS[r]).join(', ')}. Rows without a role get the default role. At most{' '}
              {MAX_INVITATIONS_PER_IMPORT} people at a time.
            </p>
          </details>
          <div className="field">
            <label htmlFor="import-file">Upload a file</label>
            <input id="import-file" type="file" accept=".csv,.json,.txt,text/csv,application/json" onChange={(e) => void readFile(e)} />
          </div>
          <div className="field">
            <label htmlFor="import-text">Or paste the list</label>
            <textarea
              id="import-text"
              rows={6}
              value={text}
              placeholder={'ann@acme.com,Reviewer\nbo@acme.com'}
              onChange={(e) => {
                setText(e.target.value);
                setPreview(null);
              }}
            />
          </div>
          <div className="field">
            <label htmlFor="import-role">Default role</label>
            <RoleSelect
              id="import-role"
              value={defaultRole}
              onChange={(r) => {
                setDefaultRole(r);
                if (text.trim()) setPreview(parseInviteImport(text, r));
              }}
            />
          </div>
          <button
            type="button"
            className="button button-secondary"
            disabled={text.trim() === ''}
            onClick={() => {
              setPreview(parseInviteImport(text, defaultRole));
              setResults(null);
            }}
          >
            Check the list
          </button>

          {preview && (
            <div className="import-preview" role="status">
              <p>
                <strong>{preview.rows.length}</strong> {preview.rows.length === 1 ? 'person' : 'people'} ready to invite
                {preview.problems.length > 0 && `, ${preview.problems.length} ${preview.problems.length === 1 ? 'row' : 'rows'} skipped`}.
              </p>
              {preview.problems.length > 0 && (
                <ul className="plain-list problems">
                  {preview.problems.map((p, i) => (
                    <li key={i}>
                      {p.line > 0 ? `Line ${p.line}: ` : ''}
                      {p.message}
                    </li>
                  ))}
                </ul>
              )}
              {outside.length > 0 && (
                <p className="field-error">
                  {outside.length} {outside.length === 1 ? 'address is' : 'addresses are'} outside the allowed domains and will be
                  refused.
                </p>
              )}
              {preview.rows.length > 0 && (
                <>
                  <table className="table">
                    <thead>
                      <tr>
                        <th scope="col">Email</th>
                        <th scope="col">Role</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.slice(0, 20).map((r) => (
                        <tr key={r.email}>
                          <td>{r.email}</td>
                          <td>{ORG_ROLE_LABELS[r.role]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.rows.length > 20 && <p className="field-hint">and {preview.rows.length - 20} more.</p>}
                  <button type="button" className="button" disabled={busy} onClick={() => void createMany()}>
                    {busy ? 'Creating…' : `Create ${preview.rows.length} ${preview.rows.length === 1 ? 'invitation' : 'invitations'}`}
                  </button>
                </>
              )}
            </div>
          )}

          {results && (
            <div className="notice" role="status">
              <p>
                <strong>{created.length}</strong> {created.length === 1 ? 'invitation' : 'invitations'} created
                {failed.length > 0 && `, ${failed.length} refused`}. Download the links now: they are not shown again.
              </p>
              {failed.length > 0 && (
                <ul className="plain-list problems">
                  {failed.map((r) => (
                    <li key={r.email}>
                      {r.email}: {r.error}
                    </li>
                  ))}
                </ul>
              )}
              {created.length > 0 && (
                <button
                  type="button"
                  className="button button-small"
                  onClick={() =>
                    downloadText(
                      'invitation-links.csv',
                      invitationLinksCsv(created.map((r) => ({ email: r.email, role: r.role, url: linkFor(r.token) }))),
                    )
                  }
                >
                  Download links (CSV)
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
