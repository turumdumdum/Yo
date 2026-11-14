import { ORG_ROLE_LABELS, ORG_ROLES, type OrgRole } from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import {
  changeRole,
  listDomains,
  listInvitations,
  removeMember,
  revokeInvitation,
  setAllowSelfReview,
  type Domain,
  type Invitation,
  type Member,
  type Organization,
} from './api';
import { DomainsSection } from './DomainsSection';
import { InviteSection } from './InviteSection';

interface Props {
  supabase: SupabaseClient;
  organization: Organization;
  userId: string;
  members: Member[];
  /** Reload members and organization settings after a change. */
  onChanged: () => Promise<void> | void;
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

/** Organization administration for org admins: members, invitations, domains and settings. */
export function Admin({ supabase, organization, userId, members, onChanged }: Props) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<OrgRole | ''>('');

  const reloadLocal = useCallback(async () => {
    try {
      const [inv, dom] = await Promise.all([listInvitations(supabase, organization.id), listDomains(supabase, organization.id)]);
      setInvitations(inv);
      setDomains(dom);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, organization.id]);

  useEffect(() => {
    void reloadLocal();
  }, [reloadLocal]);

  const reloadAll = useCallback(async () => {
    await Promise.all([onChanged(), reloadLocal()]);
  }, [onChanged, reloadLocal]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await reloadAll();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const query = search.trim().toLowerCase();
  const shown = members.filter(
    (m) => (!query || (m.email ?? '').toLowerCase().includes(query)) && (!roleFilter || m.role === roleFilter),
  );
  const counts = ORG_ROLES.map((r) => [r, members.filter((m) => m.role === r).length] as const).filter(([, n]) => n > 0);

  return (
    <>
      <FormError message={error} />

      <section className="card" aria-labelledby="members-heading">
        <h2 id="members-heading">Members ({members.length})</h2>
        <p className="field-hint">{counts.map(([r, n]) => `${ORG_ROLE_LABELS[r]}: ${n}`).join(' · ')}</p>
        <div className="filters">
          <div className="field">
            <label htmlFor="member-search">Search by email</label>
            <input id="member-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="member-role-filter">Role</label>
            <select id="member-role-filter" className="role-select" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as OrgRole | '')}>
              <option value="">All roles</option>
              {ORG_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ORG_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {shown.length === 0 && <p className="empty">No members match.</p>}
        <ul className="member-list">
          {shown.map((member) => (
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
                className="role-select"
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
        <p className="field-hint">An organization always keeps at least one org admin. Role changes are recorded in the audit log.</p>
      </section>

      <InviteSection
        supabase={supabase}
        orgId={organization.id}
        allowedDomains={organization.restrict_to_verified_domains ? domains.map((d) => d.domain) : null}
        onChanged={reloadAll}
      />

      {invitations.length > 0 && (
        <section className="card" aria-labelledby="pending-heading">
          <h2 id="pending-heading">Pending invitations ({invitations.length})</h2>
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
        </section>
      )}

      <DomainsSection supabase={supabase} organization={organization} domains={domains} members={members} onChanged={reloadAll} />

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
