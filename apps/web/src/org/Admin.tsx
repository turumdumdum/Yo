import { createInvitationSchema, ORG_ROLE_LABELS, ORG_ROLES, type OrgRole } from '@app/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Field } from '../components/Field';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import {
  changeRole,
  createInvitation,
  listInvitations,
  removeMember,
  revokeInvitation,
  setAllowSelfReview,
  type Invitation,
  type Member,
  type Organization,
} from './api';

interface Props {
  supabase: SupabaseClient;
  organization: Organization;
  userId: string;
  members: Member[];
  /** Reload members and organization settings after a change. */
  onChanged: () => Promise<void> | void;
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

/** Organization administration for org admins: members, invitations and settings. */
export function Admin({ supabase, organization, userId, members, onChanged }: Props) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('requester');
  const [emailError, setEmailError] = useState<string>();
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const reloadInvitations = useCallback(async () => {
    try {
      setInvitations(await listInvitations(supabase, organization.id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, organization.id]);

  useEffect(() => {
    void reloadInvitations();
  }, [reloadInvitations]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await Promise.all([onChanged(), reloadInvitations()]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function invite(event: FormEvent) {
    event.preventDefault();
    const parsed = createInvitationSchema.safeParse({ email, role });
    if (!parsed.success) {
      setEmailError('Enter a valid email address');
      return;
    }
    setEmailError(undefined);
    setCopied(false);
    void run(async () => {
      const token = await createInvitation(supabase, organization.id, parsed.data.email, parsed.data.role);
      setLink({ email: parsed.data.email, url: `${window.location.origin}/?invite=${token}` });
      setEmail('');
    });
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

  return (
    <>
      <FormError message={error} />

      <section className="card" aria-labelledby="members-heading">
        <h2 id="members-heading">Members</h2>
        <ul className="member-list">
          {members.map((member) => (
            <li key={member.user_id}>
              <span className="member-email">
                {member.email ?? member.user_id}
                {member.user_id === userId && <span className="optional"> (you)</span>}
              </span>
              <label className="visually-hidden" htmlFor={`role-${member.user_id}`}>
                Role of {member.email}
              </label>
              <select
                id={`role-${member.user_id}`}
                value={member.role}
                disabled={busy}
                onChange={(e) => void run(() => changeRole(supabase, organization.id, member.user_id, e.target.value as OrgRole))}
              >
                {ORG_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ORG_ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={busy || member.user_id === userId}
                aria-label={`Remove ${member.email}`}
                onClick={() => {
                  if (window.confirm(`Remove ${member.email} from ${organization.name}?`)) {
                    void run(() => removeMember(supabase, organization.id, member.user_id));
                  }
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <p className="field-hint">An organization always keeps at least one org admin.</p>
      </section>

      <section className="card" aria-labelledby="invite-heading">
        <h2 id="invite-heading">Invite a person</h2>
        <form onSubmit={invite} noValidate className="invite-form">
          <Field label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} error={emailError} required />
          <div className="field">
            <label htmlFor="invite-role">Role</label>
            <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>
              {ORG_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ORG_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="button" disabled={busy}>
            Create invitation
          </button>
        </form>

        {link && (
          <div className="notice" role="status">
            <p>
              Invitation for <strong>{link.email}</strong> created. Emails are not sent yet: copy this link and send it yourself.
              It works once, for 7 days, and only for an account with that email address. It is not shown again.
            </p>
            <p>
              <code className="secret">{link.url}</code>
            </p>
            <button type="button" className="button button-secondary button-small" onClick={() => void copyLink()}>
              {copied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        )}

        {invitations.length > 0 && (
          <>
            <h3>Pending invitations</h3>
            <ul className="member-list">
              {invitations.map((invitation) => (
                <li key={invitation.id}>
                  <span className="member-email">{invitation.email}</span>
                  <span className="stage-meta">
                    {ORG_ROLE_LABELS[invitation.role]} ·{' '}
                    {new Date(invitation.expires_at).getTime() < Date.now() ? 'expired' : `expires ${formatDate(invitation.expires_at)}`}
                  </span>
                  <button
                    type="button"
                    className="button button-secondary button-small"
                    disabled={busy}
                    aria-label={`Revoke invitation for ${invitation.email}`}
                    onClick={() => void run(() => revokeInvitation(supabase, invitation.id))}
                  >
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card" aria-labelledby="settings-heading">
        <h2 id="settings-heading">Review settings</h2>
        <label className="choice">
          <input
            type="checkbox"
            checked={organization.allow_self_review}
            disabled={busy}
            onChange={(e) => void run(() => setAllowSelfReview(supabase, organization.id, e.target.checked))}
          />
          Allow people to review their own requests
        </label>
        <p className="field-hint">
          Off by default so that nobody approves their own request. Turn it on only for very small teams. The change is
          recorded in the audit log.
        </p>
      </section>
    </>
  );
}
