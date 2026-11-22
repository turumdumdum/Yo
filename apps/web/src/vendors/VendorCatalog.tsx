import { allFields, DEFAULT_REQUEST_FORM, formatAnswer, RISK_TIERS, type Answers, type FieldDef, type OwnerValue, type RequestFormDefinition } from '@app/shared';
import { useEffect, useId, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RiskBadge } from '../components/Badge';
import { FormError } from '../components/FormError';
import { downloadText } from '../lib/download';
import { errorMessage } from '../lib/errors';
import type { Member } from '../org/api';
import { listVendors, type VendorRow } from '../requests/api';
import './vendors.css';

// The vendor catalog: approved vendors only, to find one quickly by what matters.
// Requests in progress stay on the Requests tab. RLS decides which vendors a viewer sees.

interface Props {
  supabase: SupabaseClient;
  context: { userId: string; members: Member[]; isManager: boolean };
  onOpen: (requestId: string) => void;
  /** "View as" preview: only these requests are shown. Null shows everything the viewer can read. */
  visibleIds?: ReadonlySet<string> | null;
}

interface Vendor {
  id: string;
  service: string;
  vendor: string;
  legalEntity: string;
  category: string;
  risk: string;
  classification: string;
  personalData: string;
  country: string;
  payment: string;
  signIn: string;
  autoRenewal: string;
  annualCost: number | null;
  currency: string;
  businessOwner: string;
  confidential: boolean;
  archived: boolean;
  approvedAt: string;
}

type SortKey = 'service' | 'risk' | 'approvedAt' | 'annualCost';

const EMPTY = '—';

function toVendor(row: VendorRow): Vendor {
  const form: RequestFormDefinition = row.form ?? DEFAULT_REQUEST_FORM;
  const fields = new Map<string, FieldDef>(allFields(form).map((f) => [f.key, f]));
  const answers: Answers = row.answers ?? {};
  // Custom forms may not ask a question: show a dash.
  const text = (key: string) => {
    const field = fields.get(key);
    const value = answers[key];
    if (!field || value === undefined || value === null || value === '') return EMPTY;
    return formatAnswer(field, value);
  };
  const owner = answers.businessOwner as OwnerValue | undefined;
  const decided = (row.request_stages ?? []).map((s) => s.decided_at).filter((d): d is string => !!d).sort();
  const cost = answers.annualCost;
  return {
    id: row.id,
    service: row.service_name || 'Untitled request',
    vendor: text('vendorName'),
    legalEntity: text('vendorLegalEntity'),
    category: text('category'),
    risk: row.risk_tier ?? EMPTY,
    classification: text('dataClassification'),
    personalData: text('personalData'),
    country: text('countryOfUse'),
    payment: text('paymentType'),
    signIn: text('signInMethod'),
    autoRenewal: text('autoRenewal'),
    annualCost: typeof cost === 'number' ? cost : null,
    currency: typeof answers.currency === 'string' ? answers.currency : '',
    businessOwner: owner?.notRequired ? 'Not required' : owner?.name?.trim() || EMPTY,
    confidential: row.is_confidential,
    archived: row.archived_at !== null,
    approvedAt: decided.at(-1) ?? row.updated_at,
  };
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });
const formatCost = (v: Vendor) => (v.annualCost === null ? EMPTY : `${v.annualCost.toLocaleString('en-US')}${v.currency ? ` ${v.currency}` : ''}`);
const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** Filters on a single answer: each lists the values present in the data. */
const SELECT_FILTERS: { key: keyof Vendor; label: string }[] = [
  { key: 'category', label: 'Category' },
  { key: 'risk', label: 'Risk' },
  { key: 'classification', label: 'Data classification' },
  { key: 'personalData', label: 'Personal data' },
  { key: 'country', label: 'Country of use' },
  { key: 'payment', label: 'Paid or free' },
  { key: 'signIn', label: 'Sign-in' },
  { key: 'autoRenewal', label: 'Auto-renewal' },
];

interface Filters {
  query: string;
  owner: string;
  values: Partial<Record<keyof Vendor, string>>;
  confidential: '' | 'yes' | 'no';
  from: string;
  to: string;
  includeArchived: boolean;
}

const NO_FILTERS: Filters = { query: '', owner: '', values: {}, confidential: '', from: '', to: '', includeArchived: false };

export function VendorCatalog({ supabase, onOpen, visibleIds = null }: Props) {
  const id = useId();
  const [rows, setRows] = useState<Vendor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'service', dir: 1 });
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listVendors(supabase).then(
      (data) => !cancelled && setRows(data.filter((r) => !visibleIds || visibleIds.has(r.id)).map(toVendor)),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [supabase, visibleIds]);

  const base = useMemo(() => (rows ?? []).filter((v) => filters.includeArchived || !v.archived), [rows, filters.includeArchived]);
  const options = useMemo(() => {
    const out: Partial<Record<keyof Vendor, string[]>> = {};
    for (const f of SELECT_FILTERS) {
      const set = new Set(base.map((v) => String(v[f.key])));
      out[f.key] = f.key === 'risk' ? RISK_TIERS.filter((t) => set.has(t)) : [...set].filter((x) => x !== EMPTY).sort();
    }
    return out;
  }, [base]);

  const shown = useMemo(() => {
    const q = filters.query.trim().toLowerCase();
    const owner = filters.owner.trim().toLowerCase();
    const list = base.filter((v) => {
      if (q && !`${v.service} ${v.vendor} ${v.legalEntity}`.toLowerCase().includes(q)) return false;
      if (owner && !v.businessOwner.toLowerCase().includes(owner)) return false;
      for (const [key, want] of Object.entries(filters.values)) if (want && String(v[key as keyof Vendor]) !== want) return false;
      if (filters.confidential && v.confidential !== (filters.confidential === 'yes')) return false;
      const day = v.approvedAt.slice(0, 10);
      if (filters.from && day < filters.from) return false;
      if (filters.to && day > filters.to) return false;
      return true;
    });
    const value = (v: Vendor): string | number => {
      switch (sort.key) {
        case 'risk':
          return RISK_TIERS.indexOf(v.risk as (typeof RISK_TIERS)[number]);
        case 'annualCost':
          return v.annualCost ?? -1;
        case 'approvedAt':
          return v.approvedAt;
        default:
          return v.service.toLowerCase();
      }
    };
    return [...list].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const c = typeof x === 'string' && typeof y === 'string' ? x.localeCompare(y, 'en', { numeric: true }) : x < y ? -1 : x > y ? 1 : 0;
      return c * sort.dir;
    });
  }, [base, filters, sort]);

  const chips: { label: string; clear: () => void }[] = [
    ...(filters.query ? [{ label: `Search: ${filters.query}`, clear: () => setFilters((f) => ({ ...f, query: '' })) }] : []),
    ...(filters.owner ? [{ label: `Business owner: ${filters.owner}`, clear: () => setFilters((f) => ({ ...f, owner: '' })) }] : []),
    ...SELECT_FILTERS.filter((f) => filters.values[f.key]).map((f) => ({
      label: `${f.label}: ${filters.values[f.key]}`,
      clear: () => setFilters((cur) => ({ ...cur, values: { ...cur.values, [f.key]: '' } })),
    })),
    ...(filters.confidential ? [{ label: `Confidential: ${filters.confidential}`, clear: () => setFilters((f) => ({ ...f, confidential: '' })) }] : []),
    ...(filters.from ? [{ label: `Approved from ${filters.from}`, clear: () => setFilters((f) => ({ ...f, from: '' })) }] : []),
    ...(filters.to ? [{ label: `Approved until ${filters.to}`, clear: () => setFilters((f) => ({ ...f, to: '' })) }] : []),
    ...(filters.includeArchived ? [{ label: 'Including archived', clear: () => setFilters((f) => ({ ...f, includeArchived: false })) }] : []),
  ];

  function exportCsv() {
    const header = ['Service', 'Vendor', 'Vendor legal entity', 'Category', 'Risk', 'Data classification', 'Personal data', 'Country of use', 'Paid or free', 'Sign-in', 'Auto-renewal', 'Annual cost', 'Currency', 'Business owner', 'Confidential', 'Archived', 'Approved'];
    const lines = shown.map((v) =>
      [v.service, v.vendor, v.legalEntity, v.category, v.risk, v.classification, v.personalData, v.country, v.payment, v.signIn, v.autoRenewal, v.annualCost === null ? '' : String(v.annualCost), v.currency, v.businessOwner, v.confidential ? 'yes' : 'no', v.archived ? 'yes' : 'no', v.approvedAt.slice(0, 10)]
        .map((cell) => csvCell(cell === EMPTY ? '' : cell))
        .join(','),
    );
    downloadText('vendors.csv', [header.join(','), ...lines].join('\n') + '\n');
  }

  const sortButton = (key: SortKey, label: string) => (
    <button
      type="button"
      className="sort-button"
      aria-label={`Sort by ${label}${sort.key === key ? (sort.dir === 1 ? ', ascending' : ', descending') : ''}`}
      onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'approvedAt' || key === 'annualCost' ? -1 : 1 }))}
    >
      {label}
      <span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</span>
    </button>
  );
  const ariaSort = (key: SortKey) => (sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined);

  return (
    <section className="card vendor-catalog" aria-labelledby={`${id}-heading`}>
      <div className="card-head">
        <h2 id={`${id}-heading`}>Vendor catalog</h2>
        {rows && rows.length > 0 && (
          <button type="button" className="button button-secondary button-small" onClick={exportCsv} disabled={shown.length === 0}>
            Export {shown.length} to CSV
          </button>
        )}
      </div>
      <p className="field-hint">Vendors whose request was approved. Requests still in review are on the Requests tab.</p>
      <FormError message={error} />

      {rows === null ? (
        !error && <p role="status">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="empty-state">
          <p>No vendor has been approved yet. Approved requests appear here automatically.</p>
        </div>
      ) : (
        <>
          <div className="catalog-search">
            <div className="field">
              <label htmlFor={`${id}-q`}>Search</label>
              <input
                id={`${id}-q`}
                type="search"
                placeholder="Service, vendor or legal entity"
                value={filters.query}
                onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
              />
            </div>
            <button type="button" className="button button-secondary" aria-expanded={showFilters} aria-controls={`${id}-filters`} onClick={() => setShowFilters((s) => !s)}>
              Filters{chips.length > 0 ? ` (${chips.length})` : ''}
            </button>
          </div>

          {showFilters && (
            <div id={`${id}-filters`} className="catalog-filters">
              {SELECT_FILTERS.map((f) => (
                <div className="field" key={f.key}>
                  <label htmlFor={`${id}-${f.key}`}>{f.label}</label>
                  <select
                    id={`${id}-${f.key}`}
                    value={filters.values[f.key] ?? ''}
                    onChange={(e) => setFilters((cur) => ({ ...cur, values: { ...cur.values, [f.key]: e.target.value } }))}
                  >
                    <option value="">Any</option>
                    {(options[f.key] ?? []).map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </div>
              ))}
              <div className="field">
                <label htmlFor={`${id}-owner`}>Business owner</label>
                <input id={`${id}-owner`} value={filters.owner} onChange={(e) => setFilters((f) => ({ ...f, owner: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor={`${id}-conf`}>Confidential</label>
                <select id={`${id}-conf`} value={filters.confidential} onChange={(e) => setFilters((f) => ({ ...f, confidential: e.target.value as Filters['confidential'] }))}>
                  <option value="">Any</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor={`${id}-from`}>Approved from</label>
                <input id={`${id}-from`} type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
              </div>
              <div className="field">
                <label htmlFor={`${id}-to`}>Approved until</label>
                <input id={`${id}-to`} type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
              </div>
              <label className="choice">
                <input type="checkbox" checked={filters.includeArchived} onChange={(e) => setFilters((f) => ({ ...f, includeArchived: e.target.checked }))} />
                Include archived vendors
              </label>
            </div>
          )}

          <div className="catalog-summary">
            <p role="status">
              {shown.length} of {base.length} {base.length === 1 ? 'vendor' : 'vendors'}
            </p>
            {chips.length > 0 && (
              <ul className="filter-chips" aria-label="Active filters">
                {chips.map((c) => (
                  <li key={c.label}>
                    <button type="button" onClick={c.clear} aria-label={`Remove filter ${c.label}`}>
                      {c.label} <span aria-hidden="true">×</span>
                    </button>
                  </li>
                ))}
                <li>
                  <button type="button" className="link-button" onClick={() => setFilters(NO_FILTERS)}>
                    Clear all
                  </button>
                </li>
              </ul>
            )}
          </div>

          {shown.length === 0 ? (
            <p className="empty">No vendor matches these filters.</p>
          ) : (
            <>
              <div className="catalog-table-wrap">
                <table className="catalog-table">
                  <caption className="visually-hidden">Approved vendors, {shown.length} shown</caption>
                  <thead>
                    <tr>
                      <th scope="col" aria-sort={ariaSort('service')}>
                        {sortButton('service', 'Service')}
                      </th>
                      <th scope="col">Vendor</th>
                      <th scope="col">Category</th>
                      <th scope="col" aria-sort={ariaSort('risk')}>
                        {sortButton('risk', 'Risk')}
                      </th>
                      <th scope="col">Data</th>
                      <th scope="col">Country</th>
                      <th scope="col" aria-sort={ariaSort('annualCost')} className="num">
                        {sortButton('annualCost', 'Annual cost')}
                      </th>
                      <th scope="col">Business owner</th>
                      <th scope="col" aria-sort={ariaSort('approvedAt')}>
                        {sortButton('approvedAt', 'Approved')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((v) => (
                      <tr key={v.id} onClick={() => onOpen(v.id)}>
                        <th scope="row">
                          <button type="button" className="link-button catalog-open" onClick={(e) => (e.stopPropagation(), onOpen(v.id))}>
                            {v.service}
                          </button>
                          {v.confidential && <span className="status-badge confidential-badge">🔒 Confidential</span>}
                          {v.archived && (
                            <span className="status-badge" data-tone="idle">
                              Archived
                            </span>
                          )}
                        </th>
                        <td>{v.vendor}</td>
                        <td>{v.category}</td>
                        <td>{v.risk === EMPTY ? EMPTY : <RiskBadge tier={v.risk} />}</td>
                        <td>{v.classification}</td>
                        <td>{v.country}</td>
                        <td className="num">{formatCost(v)}</td>
                        <td>{v.businessOwner}</td>
                        <td>{formatDate(v.approvedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <ul className="catalog-cards">
                {shown.map((v) => (
                  <li key={v.id}>
                    <button type="button" className="request-card" onClick={() => onOpen(v.id)}>
                      <span className="request-card-top">
                        <span className="request-title">{v.service}</span>
                        <span className="badges">
                          {v.risk !== EMPTY && <RiskBadge tier={v.risk} />}
                          {v.confidential && <span className="status-badge confidential-badge">🔒 Confidential</span>}
                          {v.archived && (
                            <span className="status-badge" data-tone="idle">
                              Archived
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="request-next">
                        {[v.vendor, v.category].filter((x) => x !== EMPTY).join(' · ') || EMPTY}
                      </span>
                      <span className="request-meta">
                        {[v.classification === EMPTY ? EMPTY : `${v.classification} data`, v.country, formatCost(v), `approved ${formatDate(v.approvedAt)}`].filter((x) => x !== EMPTY).join(' · ')}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
