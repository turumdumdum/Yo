import { emailDomain, normalizeDomain } from '@app/shared';
import { useState, type FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Field } from '../components/Field';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { addDomain, removeDomain, setRestrictToDomains, type Domain, type Member, type Organization } from './api';

interface Props {
  supabase: SupabaseClient;
  organization: Organization;
  domains: Domain[];
  members: Member[];
  onChanged: () => Promise<void> | void;
}

/** The organization's email domains, and whether only those may be invited. */
export function DomainsSection({ supabase, organization, domains, members, onChanged }: Props) {
  const [input, setInput] = useState('');
  const [inputError, setInputError] = useState<string>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function add(event: FormEvent) {
    event.preventDefault();
    const domain = normalizeDomain(input);
    if (!domain) {
      setInputError('Enter a domain such as acme.com');
      return;
    }
    setInputError(undefined);
    void run(async () => {
      await addDomain(supabase, organization.id, domain);
      setInput('');
    });
  }

  const allowed = new Set(domains.map((d) => d.domain));
  const outside = members.filter((m) => m.email && !allowed.has(emailDomain(m.email)));
  const restricted = organization.restrict_to_verified_domains;

  return (
    <section className="card" aria-labelledby="domains-heading">
      <h2 id="domains-heading">Email domains</h2>
      <p className="field-hint">
        Your company’s email domains, for example acme.com. A subdomain such as eu.acme.com is a separate domain and must be
        added on its own.
      </p>
      <FormError message={error} />

      {domains.length > 0 ? (
        <ul className="member-list">
          {domains.map((d) => (
            <li key={d.id}>
              <span className="member-email">{d.domain}</span>
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={busy}
                aria-label={`Remove ${d.domain}`}
                onClick={() => void run(() => removeDomain(supabase, d.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No domains yet.</p>
      )}

      <form onSubmit={add} noValidate className="domain-form">
        <Field label="Add a domain" value={input} onChange={(e) => setInput(e.target.value)} error={inputError} placeholder="acme.com" />
        <button type="submit" className="button button-secondary" disabled={busy}>
          Add
        </button>
      </form>

      <label className="choice">
        <input
          type="checkbox"
          checked={restricted}
          disabled={busy || (!restricted && domains.length === 0)}
          onChange={(e) => void run(() => setRestrictToDomains(supabase, organization.id, e.target.checked))}
        />
        Only allow people with an email address at these domains
      </label>
      <p className="field-hint">
        When on, invitations to other domains are refused, and so is accepting an invitation sent earlier to another domain.
        Existing members are not removed. {domains.length === 0 && 'Add a domain first.'}
      </p>
      {restricted && outside.length > 0 && (
        <p className="notice">
          {outside.length === 1 ? 'This member is' : 'These members are'} outside the allowed domains and stay members until you
          remove them: {outside.map((m) => m.email).join(', ')}.
        </p>
      )}
    </section>
  );
}
