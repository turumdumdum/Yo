// External review services ("connections"): each review stage can be handled by its own
// microservice. An organization lists its services; a stage set to "external" names one.
// Non-secret settings only: each service's signing secret lives encrypted on the server.

export const REVIEW_SERVICE_DATA_MODES = ['push', 'pull'] as const;
/**
 * push: we send the request data in the stage.started event.
 * pull: we send only ids and links; the service reads the data from our API when it needs it
 *       (and keeps its own review data in its own database).
 */
export type ReviewServiceDataMode = (typeof REVIEW_SERVICE_DATA_MODES)[number];

export interface ReviewService {
  /** Stable key, used in stage settings and in the X-Service-Id header. */
  id: string;
  name: string;
  /** HTTPS endpoint that receives our events. */
  url: string;
  dataMode: ReviewServiceDataMode;
  /** push mode: send every answer (except people), not only the ones relevant to the stage. */
  sendAllAnswers: boolean;
  enabled: boolean;
}

export const REVIEW_SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** HTTPS only; plain http is allowed for localhost while developing. */
export function isServiceUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 500 && (/^https:\/\/[^\s/]+\.[^\s]+$/i.test(value) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/\S*)?$/i.test(value));
}

/** Checks the editable part of a service (everything except its id). */
export function parseReviewServiceInput(input: unknown): { service: Omit<ReviewService, 'id'> } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Expected the service settings' };
  const r = input as Record<string, unknown>;
  const extra = Object.keys(r).find((k) => !['name', 'url', 'dataMode', 'sendAllAnswers', 'enabled'].includes(k));
  if (extra) return { error: `Unknown setting “${extra}”` };
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (name.length < 1 || name.length > 60) return { error: 'Give the service a name of at most 60 characters' };
  if (!isServiceUrl(r.url)) return { error: 'The address must start with https:// (http://localhost is allowed for testing)' };
  if (!(REVIEW_SERVICE_DATA_MODES as readonly unknown[]).includes(r.dataMode)) return { error: 'Choose how the service gets the request data' };
  if (typeof r.sendAllAnswers !== 'boolean' || typeof r.enabled !== 'boolean') return { error: 'Choose yes or no for every option' };
  return { service: { name, url: r.url.trim(), dataMode: r.dataMode as ReviewServiceDataMode, sendAllAnswers: r.sendAllAnswers, enabled: r.enabled } };
}

/** A key for a new service, from its name, unique among the existing ones. */
export function reviewServiceId(name: string, taken: ReadonlySet<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'service';
  let id = /^[a-z0-9]/.test(base) ? base : `s-${base}`;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}
