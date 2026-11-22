import { DATA_CLASSIFICATIONS, DEFAULT_STAGES, RISK_TIERS } from '@app/shared';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { listMetricsData, type MetricsException, type MetricsRequest } from '../requests/api';
import './metrics.css';

// Process metrics for managers, admins and auditors. Everything is computed in the
// browser from rows the viewer can read, so Row Level Security decides what is counted.
// Charts are plain inline SVG: no chart library. Colors follow the dataviz palette
// (validated: categorical blue/orange/green, ordinal blue ramp 250→700 for ordered tiers).

const DAY = 86_400_000;
const PERIODS = [
  { id: '30', label: '30 days', days: 30 },
  { id: '90', label: '90 days', days: 90 },
  { id: '365', label: '12 months', days: 365 },
  { id: 'all', label: 'All time', days: null },
] as const;
type PeriodId = (typeof PERIODS)[number]['id'];

const OPEN_STAGE = new Set(['Not started', 'In review', 'Waiting for requester']);
const BLUE = '#2a78d6';
const ORANGE = '#eb6834';
const GREEN = '#1baf7a';
const NOT_SET = '#a9a8a1';
const ORDINAL = ['#86b6ef', '#3987e5', '#1c5cab', '#0d366b'];

interface Series {
  name: string;
  color: string;
}
interface Row {
  label: string;
  values: number[];
  /** Ordinal charts color each bar by its own position. */
  color?: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
const days = (from: string, to: string) => (new Date(to).getTime() - new Date(from).getTime()) / DAY;
const fmtDays = (d: number | null) => (d === null ? '—' : `${d < 10 ? d.toFixed(1) : Math.round(d)} ${d === 1 ? 'day' : 'days'}`);
const fmtInt = (n: number) => n.toLocaleString('en-US');
const decidedAt = (r: MetricsRequest) =>
  r.request_stages
    .map((s) => s.decided_at)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1) ?? null;
const stageOrder = (names: Iterable<string>) => {
  const all = [...new Set(names)];
  const known = DEFAULT_STAGES.filter((s) => all.includes(s));
  return [...known, ...all.filter((n) => !(DEFAULT_STAGES as readonly string[]).includes(n)).sort()];
};
const answerText = (r: MetricsRequest, key: string) => {
  const v = r.answers?.[key];
  return typeof v === 'string' && v.trim() ? v : null;
};

export function Metrics({ supabase, visibleIds = null }: { supabase: SupabaseClient; visibleIds?: ReadonlySet<string> | null }) {
  const [data, setData] = useState<{ requests: MetricsRequest[]; exceptions: MetricsException[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<PeriodId>('90');

  useEffect(() => {
    let cancelled = false;
    listMetricsData(supabase).then(
      (d) =>
        !cancelled &&
        setData(
          visibleIds
            ? { requests: d.requests.filter((r) => visibleIds.has(r.id)), exceptions: d.exceptions.filter((e) => visibleIds.has(e.request_id)) }
            : d,
        ),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [supabase, visibleIds]);

  const m = useMemo(() => (data ? compute(data, period) : null), [data, period]);

  return (
    <section className="card metrics" aria-labelledby="metrics-heading">
      <div className="card-head">
        <h2 id="metrics-heading">Metrics</h2>
      </div>
      <div className="chips" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button key={p.id} type="button" aria-pressed={period === p.id} onClick={() => setPeriod(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <FormError message={error} />
      {!m ? (
        !error && <p role="status">Loading…</p>
      ) : (
        <>
          <ul className="kpi-grid" aria-label="Key figures">
            <Kpi label="Submitted" value={fmtInt(m.submitted)} hint="in the period" />
            <Kpi label="Approved" value={fmtInt(m.approved)} hint="of those submitted" />
            <Kpi label="Rejected" value={fmtInt(m.rejected)} hint="of those submitted" />
            <Kpi label="Approval rate" value={m.approvalRate === null ? '—' : `${Math.round(m.approvalRate * 100)}%`} hint="approved ÷ decided" />
            <Kpi label="Median time to decision" value={fmtDays(m.medianDecision)} hint="submitted → final decision" />
            <Kpi label="Open reviews" value={fmtInt(m.openReviews)} hint="right now" />
            <Kpi label="Overdue reviews" value={fmtInt(m.overdueReviews)} hint="right now, past due date" alert={m.overdueReviews > 0} />
            <Kpi label="Active exceptions" value={fmtInt(m.activeExceptions)} hint="approved, not expired" />
            <Kpi label="Exceptions expiring" value={fmtInt(m.expiringSoon)} hint="in the next 30 days" alert={m.expiringSoon > 0} />
          </ul>

          {m.submitted === 0 ? (
            <div className="empty-state">
              <p>No request was submitted in this period. Pick a longer period to see charts.</p>
            </div>
          ) : (
            <div className="chart-grid">
              <ChartCard
                title="Requests per month by outcome"
                summary={`${m.submitted} requests over ${m.months.length} months; ${m.approved} approved, ${m.rejected} rejected, ${m.submitted - m.approved - m.rejected} in progress.`}
                series={OUTCOMES}
                rows={m.months}
                wide
              >
                {(w) => <ColumnChart width={w} rows={m.months} series={OUTCOMES} />}
              </ChartCard>
              <ChartCard title="Risk tier" summary={listSummary(m.risk)} series={[{ name: 'Requests', color: BLUE }]} rows={m.risk}>
                {(w) => <BarList width={w} rows={m.risk} series={[{ name: 'Requests', color: BLUE }]} />}
              </ChartCard>
              <ChartCard title="Data classification" summary={listSummary(m.classification)} series={[{ name: 'Requests', color: BLUE }]} rows={m.classification}>
                {(w) => <BarList width={w} rows={m.classification} series={[{ name: 'Requests', color: BLUE }]} />}
              </ChartCard>
              <ChartCard
                title="Median decision time per review"
                summary={m.stageTime.length ? m.stageTime.map((r) => `${r.label}: ${fmtDays(r.values[0] ?? 0)}`).join('; ') : 'No review was decided in this period.'}
                series={[{ name: 'Median days', color: BLUE }]}
                rows={m.stageTime}
                format={fmtDays}
              >
                {(w) => <BarList width={w} rows={m.stageTime} series={[{ name: 'Median days', color: BLUE }]} format={fmtDays} />}
              </ChartCard>
              <ChartCard
                title="Reviews on time vs overdue"
                summary={m.sla.length ? m.sla.map((r) => `${r.label}: ${r.values[0]} on time, ${r.values[1]} overdue`).join('; ') : 'No review with a due date in this period.'}
                series={SLA}
                rows={m.sla}
              >
                {(w) => <BarList width={w} rows={m.sla} series={SLA} />}
              </ChartCard>
              <ChartCard title="Top categories" summary={listSummary(m.categories)} series={[{ name: 'Requests', color: BLUE }]} rows={m.categories}>
                {(w) => <BarList width={w} rows={m.categories} series={[{ name: 'Requests', color: BLUE }]} />}
              </ChartCard>
              <ChartCard
                title={`Annual cost of approved vendors by category${m.currency ? ` (${m.currency})` : ''}`}
                summary={m.cost.length ? m.cost.map((r) => `${r.label}: ${fmtInt(r.values[0] ?? 0)}`).join('; ') : 'No approved vendor with a cost in this period.'}
                series={[{ name: 'Annual cost', color: BLUE }]}
                rows={m.cost}
                format={fmtInt}
                note={m.otherCurrencies > 0 ? `${m.otherCurrencies} approved ${m.otherCurrencies === 1 ? 'vendor has' : 'vendors have'} a cost in another currency and ${m.otherCurrencies === 1 ? 'is' : 'are'} not included.` : undefined}
              >
                {(w) => <BarList width={w} rows={m.cost} series={[{ name: 'Annual cost', color: BLUE }]} format={fmtInt} />}
              </ChartCard>
            </div>
          )}
          <p className="field-hint metrics-footnote">
            Counts include only requests and reviews you are allowed to see; access rules decide what is counted. Confidential requests are counted only
            for people who can open them. Drafts and deleted requests are left out.
          </p>
        </>
      )}
    </section>
  );
}

const OUTCOMES: Series[] = [
  { name: 'In progress', color: BLUE },
  { name: 'Rejected', color: ORANGE },
  { name: 'Approved', color: GREEN },
];
const SLA: Series[] = [
  { name: 'On time', color: BLUE },
  { name: 'Overdue', color: ORANGE },
];

const listSummary = (rows: Row[]) => (rows.length ? rows.map((r) => `${r.label}: ${r.values[0]}`).join('; ') : 'No data in this period.');

function compute(data: { requests: MetricsRequest[]; exceptions: MetricsException[] }, period: PeriodId) {
  const now = Date.now();
  const spec = PERIODS.find((p) => p.id === period)!;
  const cutoff = spec.days === null ? null : now - spec.days * DAY;
  const inPeriod = data.requests.filter((r) => r.submitted_at && (cutoff === null || new Date(r.submitted_at).getTime() >= cutoff));

  const approved = inPeriod.filter((r) => r.status === 'approved');
  const rejected = inPeriod.filter((r) => r.status === 'rejected');
  const decisionDays = [...approved, ...rejected].flatMap((r) => {
    const end = decidedAt(r);
    return end && r.submitted_at ? [Math.max(0, days(r.submitted_at, end))] : [];
  });

  // Live workload, independent of the period.
  const live = data.requests.filter((r) => r.status === 'submitted' || r.status === 'in_review').flatMap((r) => r.request_stages.filter((s) => OPEN_STAGE.has(s.status)));
  const overdue = live.filter((s) => s.status !== 'Waiting for requester' && s.sla_due_at && new Date(s.sla_due_at).getTime() < now);
  const today = new Date(now).toISOString().slice(0, 10);
  const in30 = new Date(now + 30 * DAY).toISOString().slice(0, 10);
  const active = data.exceptions.filter((e) => e.status === 'approved' && e.expires_on >= today);

  // Months: from the period start (or first request) to this month, at most 36.
  const first = cutoff ?? Math.min(now, ...inPeriod.map((r) => new Date(r.submitted_at!).getTime()));
  const start = new Date(first);
  const months: Row[] = [];
  const index = new Map<string, number>();
  for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d.getTime() <= now; d.setMonth(d.getMonth() + 1)) {
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    index.set(key, months.length);
    months.push({ label: d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }), values: [0, 0, 0] });
  }
  for (const r of inPeriod) {
    const d = new Date(r.submitted_at!);
    const row = months[index.get(`${d.getFullYear()}-${d.getMonth()}`) ?? -1];
    if (row) row.values[r.status === 'approved' ? 2 : r.status === 'rejected' ? 1 : 0]! += 1;
  }

  const countBy = (order: readonly string[], value: (r: MetricsRequest) => string | null): Row[] => {
    const counts = new Map<string, number>();
    for (const r of inPeriod) {
      const v = value(r) ?? 'Not set';
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const labels = [...order.filter((o) => counts.has(o)), ...[...counts.keys()].filter((k) => !order.includes(k) && k !== 'Not set').sort(), ...(counts.has('Not set') ? ['Not set'] : [])];
    return labels.map((label) => {
      const i = order.indexOf(label);
      return { label, values: [counts.get(label) ?? 0], color: label === 'Not set' ? NOT_SET : i >= 0 ? ORDINAL[i] : BLUE };
    });
  };

  const stages = inPeriod.flatMap((r) => r.request_stages.filter((s) => s.status !== 'Not required'));
  const stageNames = stageOrder(stages.map((s) => s.name));
  const stageTime: Row[] = stageNames.flatMap((name) => {
    const med = median(stages.filter((s) => s.name === name && s.decided_at).map((s) => Math.max(0, days(s.created_at, s.decided_at!))));
    return med === null ? [] : [{ label: name, values: [med] }];
  });
  const sla: Row[] = stageNames.flatMap((name) => {
    let onTime = 0;
    let late = 0;
    for (const s of stages) {
      if (s.name !== name || !s.sla_due_at) continue;
      const due = new Date(s.sla_due_at).getTime();
      if (s.decided_at) new Date(s.decided_at).getTime() <= due ? onTime++ : late++;
      else if (OPEN_STAGE.has(s.status) && due < now) late++;
    }
    return onTime + late ? [{ label: name, values: [onTime, late] }] : [];
  });

  const byCategory = countBy([], (r) => answerText(r, 'category')).sort((a, b) => (b.values[0] ?? 0) - (a.values[0] ?? 0));
  const categories = byCategory.length > 8 ? [...byCategory.slice(0, 7), { label: 'Other', values: [byCategory.slice(7).reduce((n, r) => n + (r.values[0] ?? 0), 0)] }] : byCategory;

  const priced = approved.filter((r) => typeof r.answers?.annualCost === 'number');
  const currencies = new Map<string, number>();
  for (const r of priced) {
    const c = answerText(r, 'currency') ?? '';
    currencies.set(c, (currencies.get(c) ?? 0) + 1);
  }
  const currency = [...currencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  const costTotals = new Map<string, number>();
  for (const r of priced.filter((r) => (answerText(r, 'currency') ?? '') === currency)) {
    const cat = answerText(r, 'category') ?? 'Not set';
    costTotals.set(cat, (costTotals.get(cat) ?? 0) + (r.answers.annualCost as number));
  }
  const cost = [...costTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, v]) => ({ label, values: [v] }));

  return {
    submitted: inPeriod.length,
    approved: approved.length,
    rejected: rejected.length,
    approvalRate: approved.length + rejected.length ? approved.length / (approved.length + rejected.length) : null,
    medianDecision: median(decisionDays),
    openReviews: live.length,
    overdueReviews: overdue.length,
    activeExceptions: active.length,
    expiringSoon: active.filter((e) => e.expires_on <= in30).length,
    months: months.slice(-36),
    risk: countBy(RISK_TIERS, (r) => r.risk_tier),
    classification: countBy(DATA_CLASSIFICATIONS, (r) => answerText(r, 'dataClassification')),
    stageTime,
    sla,
    categories,
    cost,
    currency,
    otherCurrencies: priced.length - (currencies.get(currency) ?? 0),
  };
}

function Kpi({ label, value, hint, alert }: { label: string; value: string; hint: string; alert?: boolean }) {
  return (
    <li className={`kpi${alert ? ' alert' : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">
        {alert && <span aria-hidden="true">⚠ </span>}
        {value}
      </span>
      <span className="kpi-hint">{hint}</span>
    </li>
  );
}

// ---- Chart shell: title, legend, chart or table, tooltip ----

interface Tip {
  x: number;
  y: number;
  lines: string[];
}

function ChartCard(props: {
  title: string;
  summary: string;
  series: Series[];
  rows: Row[];
  format?: (n: number) => string;
  note?: string;
  wide?: boolean;
  children: (width: number) => ReactNode;
}) {
  const id = useId();
  const [table, setTable] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState<Tip | null>(null);
  const fmt = props.format ?? fmtInt;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.floor(el.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [table]);

  // Marks publish hover text through data attributes; one handler serves every chart.
  const onMove = (e: React.MouseEvent) => {
    const target = (e.target as Element).closest('[data-tip]');
    const box = ref.current?.getBoundingClientRect();
    if (!target || !box) return setTip(null);
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, lines: target.getAttribute('data-tip')!.split('\n') });
  };

  return (
    <figure className={`chart-card${props.wide ? ' wide' : ''}`} aria-labelledby={`${id}-t`}>
      <div className="chart-head">
        <h3 id={`${id}-t`}>{props.title}</h3>
        {props.rows.length > 0 && (
          <button type="button" className="link-button" aria-pressed={table} onClick={() => setTable((t) => !t)}>
            {table ? 'Show chart' : 'Show table'}
          </button>
        )}
      </div>
      {props.series.length > 1 && (
        <ul className="chart-legend" aria-label="Legend">
          {props.series.map((s) => (
            <li key={s.name}>
              <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      {props.rows.length === 0 ? (
        <p className="empty">{props.summary}</p>
      ) : table ? (
        <div className="chart-table-wrap">
          <table className="chart-table">
            <caption className="visually-hidden">{props.title}</caption>
            <thead>
              <tr>
                <th scope="col">{props.wide ? 'Month' : 'Item'}</th>
                {props.series.map((s) => (
                  <th scope="col" key={s.name} className="num">
                    {s.name}
                  </th>
                ))}
                {props.series.length > 1 && (
                  <th scope="col" className="num">
                    Total
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {props.rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row">{r.label}</th>
                  {r.values.map((v, i) => (
                    <td key={i} className="num">
                      {fmt(v)}
                    </td>
                  ))}
                  {props.series.length > 1 && <td className="num">{fmt(r.values.reduce((a, b) => a + b, 0))}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="chart-plot" onMouseMove={onMove} onMouseLeave={() => setTip(null)}>
          <p className="visually-hidden">{props.summary}</p>
          {width > 0 && props.children(width)}
          {tip && (
            <div className="chart-tip" style={{ left: Math.min(tip.x + 12, Math.max(0, width - 180)), top: tip.y + 12 }} aria-hidden="true">
              {tip.lines.map((l, i) => (
                <div key={i} className={i === 0 ? 'chart-tip-title' : undefined}>
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {props.note && <figcaption className="field-hint">{props.note}</figcaption>}
    </figure>
  );
}

/** A bar whose data end (right or top) has 4px rounded corners; the baseline end stays square. */
function barPath(x: number, y: number, w: number, h: number, horizontal: boolean, rounded: boolean) {
  const r = rounded ? Math.min(4, horizontal ? w : h, horizontal ? h / 2 : w / 2) : 0;
  if (horizontal)
    return `M${x},${y}h${w - r}${r ? `a${r},${r} 0 0 1 ${r},${r}` : ''}v${h - 2 * r}${r ? `a${r},${r} 0 0 1 ${-r},${r}` : ''}h${-(w - r)}z`;
  return `M${x},${y + h}v${-(h - r)}${r ? `a${r},${r} 0 0 1 ${r},${-r}` : ''}h${w - 2 * r}${r ? `a${r},${r} 0 0 1 ${r},${r}` : ''}v${h - r}z`;
}

const tipText = (label: string, series: Series[], values: number[], fmt: (n: number) => string) =>
  [label, ...values.map((v, i) => `${series[i]?.name ?? ''}: ${fmt(v)}`), ...(values.length > 1 ? [`Total: ${fmt(values.reduce((a, b) => a + b, 0))}`] : [])].join('\n');

/** Horizontal bars, one row per item; stacked when there are several series. */
function BarList({ width, rows, series, format = fmtInt }: { width: number; rows: Row[]; series: Series[]; format?: (n: number) => string }) {
  const ROW = 30;
  const BAR = 16;
  const labelW = Math.min(150, Math.round(width * 0.38));
  const valueW = 64;
  const plotW = Math.max(40, width - labelW - valueW);
  const max = Math.max(...rows.map((r) => r.values.reduce((a, b) => a + b, 0)), 1);
  const height = rows.length * ROW;
  const clip = (s: string) => (s.length * 7 > labelW - 8 ? `${s.slice(0, Math.max(3, Math.floor((labelW - 8) / 7) - 1))}…` : s);
  return (
    <svg width={width} height={height} aria-hidden="true" className="chart-svg">
      <line x1={labelW} x2={labelW} y1={0} y2={height} className="chart-baseline" />
      {rows.map((r, i) => {
        const y = i * ROW + (ROW - BAR) / 2;
        const total = r.values.reduce((a, b) => a + b, 0);
        const last = r.values.reduce((acc, v, j) => (v > 0 ? j : acc), -1);
        let x = labelW;
        return (
          <g key={r.label} data-tip={tipText(r.label, series, r.values, format)}>
            <rect x={0} y={i * ROW} width={width} height={ROW} fill="transparent" />
            <text x={labelW - 8} y={i * ROW + ROW / 2} textAnchor="end" dominantBaseline="central" className="chart-label">
              {clip(r.label)}
            </text>
            {r.values.map((v, j) => {
              if (v <= 0) return null;
              const w = Math.max(2, (v / max) * plotW - (j < last ? 2 : 0));
              const path = barPath(x, y, w, BAR, true, j === last);
              x += w + (j < last ? 2 : 0);
              return <path key={j} d={path} fill={series.length > 1 ? series[j]!.color : (r.color ?? series[0]!.color)} />;
            })}
            <text x={labelW + (total / max) * plotW + 6} y={i * ROW + ROW / 2} dominantBaseline="central" className="chart-value">
              {format(total)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** Vertical stacked columns over time, with a light value grid. */
function ColumnChart({ width, rows, series }: { width: number; rows: Row[]; series: Series[] }) {
  const H = 200;
  const left = 32;
  const bottom = 24;
  const plotH = H - bottom - 8;
  const totals = rows.map((r) => r.values.reduce((a, b) => a + b, 0));
  const rawMax = Math.max(...totals, 1);
  const step = Math.max(1, Math.ceil(rawMax / 4));
  const max = step * 4;
  const slot = (width - left) / rows.length;
  const colW = Math.max(4, Math.min(28, slot * 0.6));
  const labelEvery = Math.ceil(36 / slot);
  const yOf = (v: number) => 8 + plotH - (v / max) * plotH;
  return (
    <svg width={width} height={H} aria-hidden="true" className="chart-svg">
      {[1, 2, 3, 4].map((k) => (
        <g key={k}>
          <line x1={left} x2={width} y1={yOf(k * step)} y2={yOf(k * step)} className="chart-gridline" />
          <text x={left - 6} y={yOf(k * step)} textAnchor="end" dominantBaseline="central" className="chart-axis">
            {k * step}
          </text>
        </g>
      ))}
      <line x1={left} x2={width} y1={yOf(0)} y2={yOf(0)} className="chart-baseline" />
      {rows.map((r, i) => {
        const cx = left + slot * i + slot / 2;
        const last = r.values.reduce((acc, v, j) => (v > 0 ? j : acc), -1);
        let acc = 0;
        return (
          <g key={r.label + i} data-tip={tipText(r.label, series, r.values, fmtInt)}>
            <rect x={cx - slot / 2} y={0} width={slot} height={H} fill="transparent" />
            {r.values.map((v, j) => {
              if (v <= 0) return null;
              const top = yOf(acc + v);
              const h = yOf(acc) - top - (j < last ? 2 : 0);
              acc += v;
              return <path key={j} d={barPath(cx - colW / 2, top, colW, Math.max(1, h), false, j === last)} fill={series[j]!.color} />;
            })}
            {i % labelEvery === 0 && (
              <text x={cx} y={H - 6} textAnchor="middle" className="chart-axis">
                {r.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
