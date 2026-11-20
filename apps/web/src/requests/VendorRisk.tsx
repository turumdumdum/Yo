import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { checkUpguard, listVendorRiskChecks, type RequestRow, type VendorRiskCheck } from './api';

/** Host name of the vendor website answer, or null when it is not a plain https/http address. */
export function vendorHostname(answers: Record<string, unknown>): string | null {
  const raw = answers.vendorWebsite;
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^https?:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:[:/?#]|$)/i);
  return m ? m[1]!.toLowerCase() : null;
}

const formatDate = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

/** External views of the vendor: UpGuard rating (when connected) and a VirusTotal link. For reviewers and managers. */
export function VendorRisk({ supabase, request }: { supabase: SupabaseClient; request: RequestRow }) {
  const [checks, setChecks] = useState<VendorRiskCheck[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = vendorHostname(request.answers);

  const reload = useCallback(async () => {
    try {
      setChecks(await listVendorRiskChecks(supabase, request.id));
    } catch {
      // The table may not exist on an older database; the card still offers VirusTotal.
      setChecks([]);
    }
  }, [supabase, request.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const latest = checks[0];
  return (
    <section className="card vendor-risk" aria-labelledby="vendor-risk-heading">
      <h2 id="vendor-risk-heading">Vendor risk</h2>
      {!host && <p className="field-hint">The request has no vendor website, so external ratings cannot be looked up.</p>}
      {latest && (
        <div className="risk-snapshot">
          <p>
            <strong>UpGuard{latest.data.name ? `: ${latest.data.name}` : ''}</strong>
            {typeof latest.data.score === 'number' && (
              <>
                {' '}
                — score <span className="risk-score">{latest.data.score}</span> / 950
              </>
            )}
          </p>
          {latest.data.categories && latest.data.categories.length > 0 && (
            <ul className="risk-categories">
              {latest.data.categories.map((c) => (
                <li key={c.name}>
                  <span>{c.name}</span> <strong>{c.score ?? '—'}</strong>
                </li>
              ))}
            </ul>
          )}
          <p className="stage-meta">
            {latest.hostname} · fetched {formatDate(latest.fetched_at)}
          </p>
        </div>
      )}
      <FormError message={error} />
      <div className="form-actions">
        <button
          type="button"
          className="button button-secondary button-small"
          disabled={busy || !host}
          title={host ? undefined : 'Add the vendor website to the request first'}
          onClick={() => {
            setBusy(true);
            setError(null);
            checkUpguard(supabase, request.id)
              .then(() => reload())
              .catch((e: unknown) => setError(errorMessage(e)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Checking…' : 'Check in UpGuard'}
        </button>
        {host && (
          <a className="button button-secondary button-small" href={`https://www.virustotal.com/gui/domain/${encodeURIComponent(host)}`} target="_blank" rel="noopener noreferrer">
            Open {host} in VirusTotal
          </a>
        )}
      </div>
      {host && <p className="field-hint">VirusTotal opens on its own website in a new tab; only the domain name is in the link.</p>}
    </section>
  );
}
