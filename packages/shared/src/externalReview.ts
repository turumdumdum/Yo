// Exchange format with an external review service (for example a security review tool).
// This app sends a signed "stage.started" event when an external stage starts; the
// service sends signed status updates back. See docs/external-review.md.

export const EXTERNAL_STATUSES = ['in_review', 'waiting_for_requester', 'approved', 'approved_with_conditions', 'rejected'] as const;
export type ExternalStatus = (typeof EXTERNAL_STATUSES)[number];

export interface ExternalStatusUpdate {
  /** Unique per update; repeating an event_id changes nothing. */
  event_id: string;
  org_id: string;
  status: ExternalStatus;
  comment?: string;
  conditions?: string;
  /** The item's id in the external service. */
  external_id?: string;
  /** Link to the item in the external service (https). */
  external_url?: string;
}

export interface ExternalAnswer {
  label: string;
  value: unknown;
}

export interface ExternalStageStarted {
  type: 'stage.started';
  event_id: string;
  created_at: string;
  organization: { id: string };
  request: {
    id: string;
    title: string | null;
    vendor: string | null;
    website: string | null;
    request_type: string | null;
    risk_tier: string;
    risk_score: number;
    risk_reasons: string[];
    confidential: boolean;
    submitted_at: string;
    answers: Record<string, ExternalAnswer>;
    config_requirements: unknown[];
  };
  stage: { id: string; name: string; due_at: string | null };
  callback: { status_url: string | null; stage_url: string | null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const optText = (v: unknown, max: number) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);

/** Checks a status update from the external service. */
export function parseExternalStatusUpdate(input: unknown): { update: ExternalStatusUpdate } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Expected a JSON object' };
  const b = input as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => !['event_id', 'org_id', 'status', 'comment', 'conditions', 'external_id', 'external_url'].includes(k));
  if (extra) return { error: `Unknown field "${extra}"` };
  if (typeof b.event_id !== 'string' || b.event_id.length < 1 || b.event_id.length > 200) return { error: 'event_id must be 1 to 200 characters' };
  if (typeof b.org_id !== 'string' || !UUID.test(b.org_id)) return { error: 'org_id must be a UUID' };
  if (!(EXTERNAL_STATUSES as readonly unknown[]).includes(b.status)) return { error: `status must be one of ${EXTERNAL_STATUSES.join(', ')}` };
  if (!optText(b.comment, 2000) || !optText(b.conditions, 2000)) return { error: 'comment and conditions must be text of at most 2000 characters' };
  if (!optText(b.external_id, 200)) return { error: 'external_id must be text of at most 200 characters' };
  if (!optText(b.external_url, 2000) || (typeof b.external_url === 'string' && !/^https:\/\/\S+$/.test(b.external_url))) {
    return { error: 'external_url must be an https URL' };
  }
  const update: ExternalStatusUpdate = { event_id: b.event_id, org_id: b.org_id, status: b.status as ExternalStatus };
  if (typeof b.comment === 'string') update.comment = b.comment;
  if (typeof b.conditions === 'string') update.conditions = b.conditions;
  if (typeof b.external_id === 'string') update.external_id = b.external_id;
  if (typeof b.external_url === 'string') update.external_url = b.external_url;
  return { update };
}
