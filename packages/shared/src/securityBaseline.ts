import { RISK_TIERS, type RiskTier } from './domain';
import type { Answers } from './requestForm';

// Security baseline: the configuration a service must have before and while it is used
// (CLAUDE.md §7, compliance as data). An organization edits the catalog; at submission
// the controls that apply to the request are copied into it. The security reviewer
// decides on each one (required, not applicable, or an exception), and after approval
// the required ones become configuration tasks that are confirmed one by one.
//
// The default controls are our own wording of common practice for SaaS vendors. They are
// a starting point, not a certification guarantee, and cite no clause numbers.

export const CONTROL_CATEGORIES = ['Identity & access', 'Data protection', 'Logging & monitoring', 'AI & integrations', 'Resilience & exit'] as const;
export type ControlCategory = (typeof CONTROL_CATEGORIES)[number];

export const CONTROL_LEVELS = ['required', 'recommended'] as const;
export type ControlLevel = (typeof CONTROL_LEVELS)[number];

export interface BaselineControl {
  /** Stable key, also used to link exceptions. */
  id: string;
  title: string;
  /** What must be configured, in plain words. */
  requirement: string;
  /** How the reviewer or owner can verify it. */
  verification: string;
  category: ControlCategory;
  level: ControlLevel;
  /** Applies from this risk tier upwards ('Low' = every request). */
  minTier: RiskTier;
  /** Applies only when an answer has one of these values (any of them for several choices). */
  when: { field: string; in: string[] } | null;
}

export interface SecurityBaseline {
  controls: BaselineControl[];
}

/** Reviewer decision on a control for one request. */
export const CONFIG_DECISIONS = ['required', 'not_applicable', 'exception'] as const;
export type ConfigDecision = (typeof CONFIG_DECISIONS)[number];

export const CONFIG_DECISION_LABELS: Record<ConfigDecision, string> = {
  required: 'Must be configured',
  not_applicable: 'Not applicable',
  exception: 'Exception',
};

/** A control as copied into a request. */
export interface ConfigRequirement {
  id: string;
  title: string;
  requirement: string;
  verification: string;
  category: ControlCategory;
  level: ControlLevel;
  /** Null until the security reviewer decides. */
  decision: ConfigDecision | null;
  note: string | null;
  configured: boolean;
  configured_by: string | null;
  configured_at: string | null;
}

export const BASELINE_LIMITS = { controls: 60, title: 120, requirement: 600, verification: 400, conditionValues: 50 } as const;

const control = (c: BaselineControl) => c;

export const DEFAULT_SECURITY_BASELINE: SecurityBaseline = {
  controls: [
    control({
      id: 'sso',
      title: 'Sign-in through our identity provider (SSO)',
      requirement: 'People sign in through our identity provider (SAML or OpenID Connect). Local passwords are switched off where the vendor allows it.',
      verification: 'Screenshot or export of the SSO settings; a test sign-in through the identity provider.',
      category: 'Identity & access',
      level: 'required',
      minTier: 'Medium',
      when: null,
    }),
    control({
      id: 'mfa',
      title: 'Multi-factor authentication for every account',
      requirement: 'Every account that does not sign in through SSO, and every administrator, uses multi-factor authentication.',
      verification: 'Account list or policy screen showing MFA enforced.',
      category: 'Identity & access',
      level: 'required',
      minTier: 'Low',
      when: null,
    }),
    control({
      id: 'deprovisioning',
      title: 'Access removed when people leave',
      requirement: 'Accounts are removed automatically (SCIM or identity-provider sync), or within one working day through the offboarding process.',
      verification: 'SCIM settings, or the offboarding step that lists this service.',
      category: 'Identity & access',
      level: 'required',
      minTier: 'Medium',
      when: null,
    }),
    control({
      id: 'admin-roles',
      title: 'Few, named administrators',
      requirement: 'Only named people hold administrator rights, no more than needed, and the list is reviewed at least every six months.',
      verification: 'List of administrators with names and the date of the last review.',
      category: 'Identity & access',
      level: 'required',
      minTier: 'Low',
      when: null,
    }),
    control({
      id: 'no-shared-accounts',
      title: 'No shared accounts',
      requirement: 'Every person has their own account. If a shared or service account cannot be avoided, its credentials live in the company password vault with a named owner.',
      verification: 'Account list; vault entry and owner for any shared account.',
      category: 'Identity & access',
      level: 'required',
      minTier: 'Low',
      when: null,
    }),
    control({
      id: 'api-keys',
      title: 'API keys scoped, stored safely and rotated',
      requirement: 'API keys and tokens have the narrowest scope that works, are stored in the company secret manager, have a named owner and are rotated at least once a year.',
      verification: 'Key list with scopes, owner and creation date.',
      category: 'Identity & access',
      level: 'required',
      minTier: 'Low',
      when: { field: 'platforms', in: ['API'] },
    }),
    control({
      id: 'audit-logs',
      title: 'Audit logs on and kept',
      requirement: 'The audit or activity log is switched on and kept for at least 90 days, or sent to our log platform.',
      verification: 'Audit log settings and retention; a sample log entry.',
      category: 'Logging & monitoring',
      level: 'required',
      minTier: 'Low',
      when: { field: 'dataClassification', in: ['Confidential', 'Restricted'] },
    }),
    control({
      id: 'encryption',
      title: 'Encryption in transit and at rest',
      requirement: 'Data is encrypted in transit (TLS 1.2 or newer) and at rest, as stated in the vendor security documentation.',
      verification: 'Vendor security documentation or report section on encryption.',
      category: 'Data protection',
      level: 'required',
      minTier: 'Low',
      when: { field: 'dataClassification', in: ['Confidential', 'Restricted'] },
    }),
    control({
      id: 'data-location',
      title: 'Data stored in the approved location',
      requirement: 'The data region chosen in the service matches the location approved in this request.',
      verification: 'Region setting in the admin console or the vendor’s written confirmation.',
      category: 'Data protection',
      level: 'required',
      minTier: 'Low',
      when: { field: 'personalData', in: ['Yes'] },
    }),
    control({
      id: 'retention',
      title: 'Retention and deletion set',
      requirement: 'Data is kept only as long as our policy allows, and the vendor deletes our data when the contract ends.',
      verification: 'Retention settings; deletion clause in the contract or DPA.',
      category: 'Data protection',
      level: 'required',
      minTier: 'Low',
      when: { field: 'personalData', in: ['Yes'] },
    }),
    control({
      id: 'ai-training',
      title: 'Our data is not used to train AI models',
      requirement: 'Training or improving the vendor’s AI models on our data is switched off, or excluded in the contract.',
      verification: 'Setting or contract clause that excludes training on our data.',
      category: 'AI & integrations',
      level: 'required',
      minTier: 'Low',
      when: { field: 'vendorUsesAi', in: ['Yes', 'Unknown'] },
    }),
    control({
      id: 'integrations',
      title: 'Only approved integrations, with minimal permissions',
      requirement: 'Only the integrations named in this request are connected, each with the smallest set of permissions it needs.',
      verification: 'List of connected apps and their permissions.',
      category: 'AI & integrations',
      level: 'recommended',
      minTier: 'Low',
      when: null,
    }),
    control({
      id: 'data-export',
      title: 'We can export our data',
      requirement: 'We know how to export all our data in a usable format, for backup and for leaving the vendor.',
      verification: 'Export tested once, or documented export procedure.',
      category: 'Resilience & exit',
      level: 'recommended',
      minTier: 'High',
      when: null,
    }),
  ],
};

const KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FIELD_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const text = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;

/** Checks a baseline an admin edited. Returns the cleaned baseline or the first problem. */
export function parseSecurityBaseline(input: unknown): { baseline: SecurityBaseline } | { error: string } {
  const raw = (input as { controls?: unknown } | null)?.controls;
  if (!Array.isArray(raw)) return { error: 'Expected a list of controls' };
  if (raw.length > BASELINE_LIMITS.controls) return { error: `Use at most ${BASELINE_LIMITS.controls} controls` };
  const seen = new Set<string>();
  const controls: BaselineControl[] = [];
  for (const [i, item] of raw.entries()) {
    const c = item as Partial<BaselineControl> | null;
    const where = c && typeof c.title === 'string' && c.title.trim() ? `“${c.title.trim()}”` : `Control ${i + 1}`;
    if (!c || typeof c !== 'object') return { error: `${where} is malformed` };
    const unknown = Object.keys(c).find((k) => !['id', 'title', 'requirement', 'verification', 'category', 'level', 'minTier', 'when'].includes(k));
    if (unknown) return { error: `${where} has an unknown setting “${unknown}”` };
    if (typeof c.id !== 'string' || !KEY.test(c.id)) return { error: `${where} has an invalid key` };
    if (seen.has(c.id)) return { error: `Two controls use the key “${c.id}”` };
    seen.add(c.id);
    if (!text(c.title, BASELINE_LIMITS.title)) return { error: `${where}: the title needs 1 to ${BASELINE_LIMITS.title} characters` };
    if (!text(c.requirement, BASELINE_LIMITS.requirement)) return { error: `${where}: describe what must be configured (at most ${BASELINE_LIMITS.requirement} characters)` };
    if (typeof c.verification !== 'string' || c.verification.trim().length > BASELINE_LIMITS.verification) {
      return { error: `${where}: the verification is longer than ${BASELINE_LIMITS.verification} characters` };
    }
    if (!(CONTROL_CATEGORIES as readonly unknown[]).includes(c.category)) return { error: `${where}: choose a category` };
    if (!(CONTROL_LEVELS as readonly unknown[]).includes(c.level)) return { error: `${where}: choose required or recommended` };
    if (!(RISK_TIERS as readonly unknown[]).includes(c.minTier)) return { error: `${where}: choose the risk level it applies from` };
    let when: BaselineControl['when'] = null;
    if (c.when !== null && c.when !== undefined) {
      const w = c.when as { field?: unknown; in?: unknown };
      if (typeof w.field !== 'string' || !FIELD_KEY.test(w.field)) return { error: `${where}: choose the question of the condition` };
      if (!Array.isArray(w.in) || w.in.length === 0 || w.in.length > BASELINE_LIMITS.conditionValues || w.in.some((v) => typeof v !== 'string' || v.length > 120)) {
        return { error: `${where}: choose which answers make it apply` };
      }
      when = { field: w.field, in: [...new Set(w.in as string[])] };
    }
    controls.push({
      id: c.id,
      title: c.title!.trim(),
      requirement: c.requirement!.trim(),
      verification: c.verification.trim(),
      category: c.category as ControlCategory,
      level: c.level as ControlLevel,
      minTier: c.minTier as RiskTier,
      when,
    });
  }
  return { baseline: { controls } };
}

/** Whether a control applies to a request with this risk tier and these answers. */
export function controlApplies(c: BaselineControl, tier: RiskTier, answers: Answers): boolean {
  if (RISK_TIERS.indexOf(tier) < RISK_TIERS.indexOf(c.minTier)) return false;
  if (!c.when) return true;
  const value = answers[c.when.field];
  if (Array.isArray(value)) return value.some((v) => typeof v === 'string' && c.when!.in.includes(v));
  return typeof value === 'string' && c.when.in.includes(value);
}

/** The controls copied into a request at submission, all still undecided. */
export function configRequirementsFor(baseline: SecurityBaseline, tier: RiskTier, answers: Answers): ConfigRequirement[] {
  return baseline.controls
    .filter((c) => controlApplies(c, tier, answers))
    .map((c) => ({
      id: c.id,
      title: c.title,
      requirement: c.requirement,
      verification: c.verification,
      category: c.category,
      level: c.level,
      decision: null,
      note: null,
      configured: false,
      configured_by: null,
      configured_at: null,
    }));
}

/** A control the owners must configure after approval: required (or undecided) and not waived. */
export function isConfigTask(r: ConfigRequirement): boolean {
  return r.decision === 'required' || (r.decision === null && r.level === 'required') || (r.decision === null && r.level === 'recommended');
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

export const EXCEPTION_STATUSES = ['pending', 'approved', 'rejected', 'revoked'] as const;
export type ExceptionStatus = (typeof EXCEPTION_STATUSES)[number];

/** Longest an exception may run before it must be reviewed again. */
export const EXCEPTION_MAX_DAYS = 365;
export const EXCEPTION_LIMITS = { deviation: 1000, justification: 1000, compensating: 1000, comment: 1000 } as const;

/** How an exception reads in a register, given today's date (YYYY-MM-DD). */
export function exceptionState(e: { status: ExceptionStatus; expires_on: string }, today: string): 'pending' | 'active' | 'expiring' | 'expired' | 'rejected' | 'revoked' {
  if (e.status !== 'approved') return e.status;
  if (e.expires_on < today) return 'expired';
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + 30);
  return e.expires_on <= soon.toISOString().slice(0, 10) ? 'expiring' : 'active';
}
