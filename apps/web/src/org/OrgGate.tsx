import { createOrganizationSchema } from '@app/shared';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { Field } from '../components/Field';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { clearPendingInvitation, pendingInvitation } from '../lib/invite';
import { Workspace } from '../requests/Workspace';
import { acceptInvitation, loadMembership, type Membership } from './api';

export function OrgGate({ supabase, user }: { supabase: SupabaseClient; user: User }) {
  const [membership, setMembership] = useState<Membership | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const token = pendingInvitation();
      if (token) {
        // One attempt per link: a failed invitation is not retried on every page load.
        clearPendingInvitation();
        try {
          await acceptInvitation(supabase, token);
        } catch (error) {
          setInviteError(`The invitation could not be accepted. ${errorMessage(error)}`);
        }
      }
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
  if (membership === null) {
    return (
      <>
        <FormError message={inviteError} />
        <CreateOrganization supabase={supabase} onCreated={reload} />
      </>
    );
  }

  return (
    <>
      <FormError message={inviteError} />
      <Workspace supabase={supabase} user={user} membership={membership} onOrganizationChanged={reload} />
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
