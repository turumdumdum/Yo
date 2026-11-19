import {
  businessOwnerEmail,
  computeRisk,
  isConfidential,
  DEFAULT_REQUEST_FORM,
  parseRequestForm,
  parseReviewTemplate,
  planStages,
  validateAnswers,
  workflowFromSettings,
  type Answers,
  type PlannedStage,
  type RequestFormDefinition,
  type ReviewTemplate,
  type RiskResult,
} from '@app/shared';
import { Hono } from 'hono';

// Request submission. Drafts are edited straight from the browser under RLS; this endpoint
// is the only way to submit one, so validation and triage cannot be skipped or forged.

export interface DraftRecord {
  id: string;
  org_id: string;
  status: string;
  answers: Answers;
  /** The form the draft was started with; null for the standard form. */
  form?: unknown;
}

export interface SubmittedRecord {
  id: string;
  status: string;
  risk_tier: string;
  risk_score: number;
  risk_reasons: string[];
  submitted_at: string;
}

/** Thrown by a store when the caller's token is rejected. */
export class UnauthorizedError extends Error {}
/** Thrown by a store when the request stopped being a draft in the meantime. */
export class NotADraftError extends Error {}

/** Storage adapter, so the route stays free of platform and Supabase details. */
export interface RequestStore {
  /**
   * Reads a request with the caller's own token. Row Level Security decides what the
   * caller may see, so null means "does not exist for this user".
   */
  getAsUser(accessToken: string, requestId: string): Promise<DraftRecord | null>;
  /** The organization's own review forms by stage name, unvalidated. Runs with backend privileges. */
  getReviewTemplates(orgId: string): Promise<Record<string, unknown>>;
  /** The organization's review settings, unvalidated; null when it uses the defaults. */
  getWorkflowSettings?(orgId: string): Promise<unknown>;
  /** The organization's AI check settings, unvalidated; null when it uses the defaults. */
  getAiSettings?(orgId: string): Promise<unknown>;
  /**
   * Records who may see the request, then marks the draft as submitted and starts its
   * stages. Visibility is stored first, so a confidential request is never visible
   * without it. Runs with backend privileges.
   */
  submit(requestId: string, answers: Answers, risk: RiskResult, stages: PlannedStage[], visibility?: Visibility): Promise<SubmittedRecord>;
}

export interface Visibility {
  confidential: boolean;
  /** Matched against members' emails; that member may see the request. */
  businessOwnerEmail: string | null;
}

/** The form a draft was started with. A stored form that fails validation falls back to the standard one. */
export function formOf(request: DraftRecord): RequestFormDefinition {
  if (request.form === null || request.form === undefined) return DEFAULT_REQUEST_FORM;
  const parsed = parseRequestForm(request.form);
  if ('form' in parsed) return parsed.form;
  console.warn(`Request ${request.id} has an invalid form (${parsed.error}); using the standard form`);
  return DEFAULT_REQUEST_FORM;
}

/** The organization's valid review forms. A stored form that fails validation is skipped, so the default applies. */
export async function reviewTemplates(store: RequestStore, orgId: string): Promise<Record<string, ReviewTemplate>> {
  const stored = await store.getReviewTemplates(orgId);
  const valid: Record<string, ReviewTemplate> = {};
  for (const [stage, raw] of Object.entries(stored)) {
    const parsed = parseReviewTemplate(raw);
    if ('template' in parsed) valid[stage] = parsed.template;
    else console.warn(`Ignoring the stored review form of "${stage}": ${parsed.error}`);
  }
  return valid;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestRoutes(store: RequestStore) {
  const routes = new Hono();

  routes.post('/:id/submit', async (c) => {
    const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return c.json({ error: 'Sign in to continue' }, 401);

    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json({ error: 'Not found' }, 404);

    let request: DraftRecord | null;
    try {
      request = await store.getAsUser(token, id);
    } catch (error) {
      if (error instanceof UnauthorizedError) return c.json({ error: 'Sign in to continue' }, 401);
      throw error;
    }
    if (!request) return c.json({ error: 'Not found' }, 404);
    if (request.status !== 'draft') return c.json({ error: 'This request has already been submitted' }, 409);

    const form = formOf(request);
    const { errors, cleaned } = validateAnswers(request.answers, undefined, form);
    if (Object.keys(errors).length > 0) {
      return c.json({ error: 'Some answers are missing or invalid', fields: errors }, 422);
    }

    // Triage: the tier decides which review stages start.
    const risk = computeRisk(cleaned, form);
    const workflow = workflowFromSettings(store.getWorkflowSettings ? await store.getWorkflowSettings(request.org_id) : null);
    const stages = planStages(risk.tier, cleaned, new Date(), workflow, await reviewTemplates(store, request.org_id), form);
    try {
      const visibility = { confidential: isConfidential(cleaned, form), businessOwnerEmail: businessOwnerEmail(cleaned, form) };
      const submitted = await store.submit(id, cleaned, risk, stages, visibility);
      return c.json({
        id: submitted.id,
        status: submitted.status,
        riskTier: submitted.risk_tier,
        riskScore: submitted.risk_score,
        riskReasons: submitted.risk_reasons,
        submittedAt: submitted.submitted_at,
      });
    } catch (error) {
      if (error instanceof NotADraftError) return c.json({ error: 'This request has already been submitted' }, 409);
      throw error;
    }
  });

  return routes;
}
