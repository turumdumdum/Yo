import { DEFAULT_STAGES, parseReviewTemplate, type OrgRole, type ReviewTemplate } from '@app/shared';
import { Hono, type Context } from 'hono';
import { UnauthorizedError } from './requests';

// Organization configuration that must be validated with the shared schemas before it
// is stored, so it goes through the API rather than straight to the database.

export interface Caller {
  userId: string;
  orgId: string;
  role: OrgRole;
}

export interface AdminStore {
  /** Who is calling, read with their own token; null when they belong to no organization. */
  getCaller(accessToken: string): Promise<Caller | null>;
  /** Stores a stage's review form, or removes it (null) so the default applies again. Audited. */
  saveReviewTemplate(orgId: string, stage: string, template: ReviewTemplate | null, actorId: string): Promise<void>;
}

const MANAGERS: readonly OrgRole[] = ['org_admin', 'process_manager'];
const STAGES = new Set<string>(DEFAULT_STAGES);
const MAX_BODY_BYTES = 200_000;

export function adminRoutes(store: AdminStore) {
  const routes = new Hono();

  async function manager(c: Context): Promise<Caller | Response> {
    const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return c.json({ error: 'Sign in to continue' }, 401);
    let caller: Caller | null;
    try {
      caller = await store.getCaller(token);
    } catch (error) {
      if (error instanceof UnauthorizedError) return c.json({ error: 'Sign in to continue' }, 401);
      throw error;
    }
    if (!caller || !MANAGERS.includes(caller.role)) {
      return c.json({ error: 'Only an org admin or process manager can change review forms' }, 403);
    }
    return caller;
  }

  routes.put('/review-forms/:stage', async (c) => {
    const caller = await manager(c);
    if (caller instanceof Response) return caller;
    const stage = c.req.param('stage');
    if (!STAGES.has(stage)) return c.json({ error: 'Unknown stage' }, 404);
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return c.json({ error: 'The form is too large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'Expected JSON' }, 400);
    }
    const parsed = parseReviewTemplate(body);
    if ('error' in parsed) return c.json({ error: parsed.error }, 422);
    await store.saveReviewTemplate(caller.orgId, stage, parsed.template, caller.userId);
    return c.json(parsed.template);
  });

  routes.delete('/review-forms/:stage', async (c) => {
    const caller = await manager(c);
    if (caller instanceof Response) return caller;
    const stage = c.req.param('stage');
    if (!STAGES.has(stage)) return c.json({ error: 'Unknown stage' }, 404);
    await store.saveReviewTemplate(caller.orgId, stage, null, caller.userId);
    return c.body(null, 204);
  });

  return routes;
}
