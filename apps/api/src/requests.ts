import {
  computeRiskTier,
  planStages,
  riskInputFromAnswers,
  validateAnswers,
  type Answers,
  type PlannedStage,
  type RiskResult,
} from '@app/shared';
import { Hono } from 'hono';

// Request submission. Drafts are edited straight from the browser under RLS; this endpoint
// is the only way to submit one, so validation and triage cannot be skipped or forged.

export interface DraftRecord {
  id: string;
  status: string;
  answers: Answers;
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
  /** Marks a draft as submitted and starts its stages, atomically. Runs with backend privileges. */
  submit(requestId: string, answers: Answers, risk: RiskResult, stages: PlannedStage[]): Promise<SubmittedRecord>;
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

    const { errors, cleaned } = validateAnswers(request.answers);
    if (Object.keys(errors).length > 0) {
      return c.json({ error: 'Some answers are missing or invalid', fields: errors }, 422);
    }

    // Triage: the tier decides which review stages start.
    const risk = computeRiskTier(riskInputFromAnswers(cleaned));
    const stages = planStages(risk.tier, cleaned, new Date());
    try {
      const submitted = await store.submit(id, cleaned, risk, stages);
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
