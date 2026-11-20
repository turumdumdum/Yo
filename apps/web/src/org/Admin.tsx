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
  sendInvitations,
  setAllowSelfReview,
  type Domain,
  type Invitation,
  type Member,
  type Organization,
} from './api';
import { DomainsSection } from './DomainsSection';
import { InviteSection } from './InviteSection';
import { RequestFormsSection } from './RequestFormEditor';
import { ReviewsSection } from './ReviewsSection';
import { AiSettingsSection } from './AiSettingsSection';
import { IntegrationsSection } from './IntegrationsSection';
import { ExceptionsSection } from './ExceptionsSection';
import { SecurityBaselineSection } from './SecurityBaselineSection';

interface Props {
  supabase: SupabaseClient;
  organization: Organization;
  userId: string;
  members: Member[];
  /** Reload members and organization settings after a change. */
  onChanged: () => Promise<void> | void;
}

type AdminSection = 'people' | 'domains' | 'request-form' | 'review-forms' | 'baseline' | 'exceptions' | 'ai' | 'integrations' | 'settings';

const SECTIONS: { id: AdminSection; label: string; hint: string }[] = [
  { id: 'people', label: 'People', hint: 'Members, roles and invitations' },
  { id: 'domains', label: 'Email domains', hint: 'Who may be invited' },
  { id: 'request-form', label: 'Request form', hint: 'Questions requesters answer' },
  { id: 'review-forms', label: 'Reviews', hint: 'Which checks run, and their forms' },
  { id: 'baseline', label: 'Security baseline', hint: 'Configuration every service must have' },
  { id: 'exceptions', label: 'Exceptions', hint: 'Accepted risks and their end dates' },
  { id: 'ai', label: 'AI check', hint: 'Instructions and questions for the AI' },
  { id: 'integrations', label: 'Integrations', hint: 'Slack, UpGuard, external review' },
  { id: 'settings', label: 'Settings', hint: 'Review rules' },
];

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

/** Organization administration for org admins: members, invitations, domains and settings. */
export function Admin({ supabase, organization, userId, members, onChanged }: Props) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [domains, setDomains] = useState<Domain[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<OrgRole | ''>('');
  const [section, setSection] = useState<AdminSection>('people');

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

  async function run(action: () => Promise<void>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      if (done) setNotice(done);
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
    <div className="admin-layout">
      <nav className="admin-nav" aria-label="Admin sections">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={section === item.id ? 'page' : undefined}
            onClick={() => setSection(item.id)}
          >
            <span className="admin-nav-label">{item.label}</span>
            <span className="admin-nav-hint">{item.hint}</span>
          </button>
        ))}
      </nav>
      <div className="admin-content">
        <FormError message={error} />
        {notice && (
          <p className="notice notice-approved" role="status">
            {notice}
          </p>
        )}
        {section === 'people' && (
          <>
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
                  <select
                    id="member-role-filter"
                    className="role-select"
                    value={roleFilter}
                    onChange={(e) => setRoleFilter(e.target.value as OrgRole | '')}
                  >
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
                      onChange={(e) =>
                        void run(() => changeRole(supabase, organization.id, member.user_id, e.target.value as OrgRole))
                      }
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
              <p className="field-hint">
                An organization always keeps at least one org admin. Role changes are recorded in the audit log.
              </p>
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
                        {new Date(invitation.expires_at).getTime() < Date.now()
                          ? 'expired'
                          : `expires ${formatDate(invitation.expires_at)}`}
                      </span>
                      <button
                        type="button"
                        className="button button-secondary button-small"
                        disabled={busy}
                        aria-label={`Send the invitation for ${invitation.email} again`}
                        onClick={() =>
                          void run(async () => {
                            const [outcome] = await sendInvitations(supabase, [{ email: invitation.email, role: invitation.role }]);
                            if (outcome?.error) throw new Error(outcome.error);
                            if (outcome?.link) throw new Error(`The email was not sent (${outcome.emailError}). Use “Invite people” to get a link to share.`);
                          }, `A new invitation email is on its way to ${invitation.email}. The earlier link no longer works.`)
                        }
                      >
                        Send again
                      </button>
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
          </>
        )}

        {section === 'domains' && (
          <DomainsSection
            supabase={supabase}
            organization={organization}
            domains={domains}
            members={members}
            onChanged={reloadAll}
          />
        )}

        {section === 'request-form' && <RequestFormsSection supabase={supabase} orgId={organization.id} />}

        {section === 'review-forms' && <ReviewsSection supabase={supabase} orgId={organization.id} />}

        {section === 'baseline' && <SecurityBaselineSection supabase={supabase} orgId={organization.id} />}

        {section === 'exceptions' && <ExceptionsSection supabase={supabase} orgId={organization.id} userId={userId} members={members} />}

        {section === 'ai' && <AiSettingsSection supabase={supabase} orgId={organization.id} />}

        {section === 'integrations' && <IntegrationsSection supabase={supabase} />}

        {section === 'settings' && (
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
        )}
      </div>
    </div>
  );
}
