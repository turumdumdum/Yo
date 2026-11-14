import { createOrganizationSchema, ORG_ROLE_LABELS, type OrgRole } from '@app/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { Field } from '../components/Field';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';

interface Membership {
  role: OrgRole;
  organization: { id: string; name: string };
  memberCount: number;
}

async function loadMembership(supabase: SupabaseClient, userId: string): Promise<Membership | null> {
  const { data, error } = await supabase
    .from('memberships')
    .select('role, organizations(id, name)')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle<{ role: OrgRole; organizations: { id: string; name: string } }>();
  if (error) throw error;
  if (!data) return null;
  const { count, error: countError } = await supabase
    .from('memberships')
    .select('user_id', { count: 'exact', head: true })
    .eq('org_id', data.organizations.id);
  if (countError) throw countError;
  return { role: data.role, organization: data.organizations, memberCount: count ?? 0 };
}

export function OrgGate({ supabase, user }: { supabase: SupabaseClient; user: User }) {
  const [membership, setMembership] = useState<Membership | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setMembership(await loadMembership(supabase, user.id));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [supabase, user.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loadError) return <FormError message={loadError} />;
  if (membership === undefined) return <p role="status">Loading…</p>;
  if (membership === null) return <CreateOrganization supabase={supabase} onCreated={reload} />;

  return (
    <>
      <h1>{membership.organization.name}</h1>
      <p className="lead">
        Signed in as {user.email}. Your role: <strong>{ORG_ROLE_LABELS[membership.role]}</strong>.
      </p>
      <section className="card" aria-labelledby="org-heading">
        <h2 id="org-heading">Organization</h2>
        <dl className="details">
          <dt>Members</dt>
          <dd>{membership.memberCount}</dd>
        </dl>
        <p className="field-hint">Invitations, the request form and the tracker are not built yet.</p>
      </section>
    </>
  );
}

function CreateOrganization({ supabase, onCreated }: { supabase: SupabaseClient; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string>();
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = createOrganizationSchema.safeParse({ name });
    if (!parsed.success) {
      setNameError('Enter a name between 2 and 120 characters');
      return;
    }
    setNameError(undefined);
    setBusy(true);
    try {
      const { error } = await supabase.rpc('create_organization', { org_name: parsed.data.name });
      if (error) throw error;
      onCreated();
    } catch (error) {
      const message = errorMessage(error);
      setFormError(
        message.includes('only one organization')
          ? 'This installation already has an organization. Ask its admin for an invitation.'
          : message,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card auth-card" aria-labelledby="org-create-heading">
      <h1 id="org-create-heading">Create your organization</h1>
      <p>You are not a member of an organization yet. Create one to become its admin, or ask your admin for an invitation.</p>
      <form onSubmit={submit} noValidate>
        <Field
          label="Organization name"
          name="organization"
          autoComplete="organization"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={nameError}
          required
        />
        <FormError message={formError} />
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'Please wait…' : 'Create organization'}
        </button>
      </form>
    </section>
  );
}
