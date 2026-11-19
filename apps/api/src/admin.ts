import {
  DEFAULT_STAGES,
  parseRequestForm,
  parseReviewTemplate,
  parseAiCheckSettings,
  parseWorkflowSettings,
  type AiCheckSettings,
  type WorkflowSettings,
  type OrgRole,
  type RequestFormDefinition,
  type ReviewTemplate,
} from '@app/shared';
import { Hono, type Context } from 'hono';
import { UnauthorizedError } from './requests';

// Organization configuration that must be validated with the shared schemas before it
// is stored, so it goes through the API rather than straight to the database.

export interface Caller {
  userId: string;
  orgId: string;
  role: OrgRole;
  /** The caller's email address, when Supabase reports one. */
  email?: string;
}

export interface AdminStore {
  /** Who is calling, read with their own token; null when they belong to no organization. */
  getCaller(accessToken: string): Promise<Caller | null>;
  /** Stores a stage's review form, or removes it (null) so the default applies again. Audited. */
  saveReviewTemplate(orgId: string, stage: string, template: ReviewTemplate | null, actorId: string): Promise<void>;
  /** Saved request forms. Each call is audited by the store. */
  createRequestForm(orgId: string, form: SavedFormInput, actorId: string): Promise<{ id: string } | 'name-taken'>;
  /** Returns 'not-found' for a form of another organization. */
  updateRequestForm(orgId: string, id: string, form: SavedFormInput, actorId: string): Promise<'ok' | 'not-found' | 'name-taken'>;
  deleteRequestForm(orgId: string, id: string, actorId: string): Promise<'ok' | 'not-found'>;
  /** Makes a saved form the one new requests use; null returns to the standard form. */
  activateRequestForm(orgId: string, id: string | null, actorId: string): Promise<'ok' | 'not-found'>;
  /** Stores when each review is needed, its time and checklist; null returns to the defaults. Audited. */
  saveWorkflowSettings(orgId: string, settings: WorkflowSettings | null, actorId: string): Promise<void>;
  /**
   * Deletes a request in the trash for good (the database checks that the actor is an
   * org admin of its organization) and returns the storage paths of its files.
   */
  purgeRequest(requestId: string, actorId: string): Promise<string[] | 'not-found' | 'not-in-trash' | 'forbidden'>;
  /** Removes files from private storage. */
  removeAttachmentFiles(paths: string[]): Promise<void>;
  /** Stores the AI check settings; null returns to the defaults. Audited. */
  saveAiSettings(orgId: string, settings: AiCheckSettings | null, actorId: string): Promise<void>;
}

export interface SavedFormInput {
  name: string;
  description: string | null;
  definition: RequestFormDefinition;
}

const MANAGERS: readonly OrgRole[] = ['org_admin', 'process_manager'];
const STAGES = new Set<string>(DEFAULT_STAGES);
const MAX_BODY_BYTES = 200_000;

export function adminRoutes(store: AdminStore) {
  const routes = new Hono();

  async function manager(c: Context, what = 'review forms'): Promise<Caller | Response> {
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
      return c.json({ error: `Only an org admin or process manager can change ${what}` }, 403);
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

  // Deleting a request for good: org admins only, and only from the trash.
  routes.delete('/requests/:id', async (c) => {
    const caller = await manager(c, 'requests');
    if (caller instanceof Response) return caller;
    if (caller.role !== 'org_admin') return c.json({ error: 'Only an org admin can delete a request' }, 403);
    const id = c.req.param('id');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return c.json({ error: 'Not found' }, 404);
    const result = await store.purgeRequest(id, caller.userId);
    if (result === 'not-found') return c.json({ error: 'Not found' }, 404);
    if (result === 'forbidden') return c.json({ error: 'Only an org admin can delete a request' }, 403);
    if (result === 'not-in-trash') return c.json({ error: 'Move the request to the trash first' }, 409);
    let filesRemoved = true;
    if (result.length > 0) {
      try {
        await store.removeAttachmentFiles(result);
      } catch (error) {
        // The request is gone; leftover files are only reachable with the service key.
        console.error(`Request ${id} was deleted but ${result.length} file(s) could not be removed:`, error);
        filesRemoved = false;
      }
    }
    return c.json({ deleted: true, filesRemoved });
  });

  routes.put('/ai-settings', async (c) => {
    const caller = await manager(c, 'AI settings');
    if (caller instanceof Response) return caller;
    const raw = await c.req.text();
    if (raw.length > 20_000) return c.json({ error: 'The settings are too large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'Expected JSON' }, 400);
    }
    const parsed = parseAiCheckSettings(body);
    if ('error' in parsed) return c.json({ error: parsed.error }, 422);
    await store.saveAiSettings(caller.orgId, parsed.settings, caller.userId);
    return c.json(parsed.settings);
  });

  routes.delete('/ai-settings', async (c) => {
    const caller = await manager(c, 'AI settings');
    if (caller instanceof Response) return caller;
    await store.saveAiSettings(caller.orgId, null, caller.userId);
    return c.body(null, 204);
  });

  routes.put('/workflow', async (c) => {
    const caller = await manager(c, 'review settings');
    if (caller instanceof Response) return caller;
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES) return c.json({ error: 'The settings are too large' }, 413);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'Expected JSON' }, 400);
    }
    const parsed = parseWorkflowSettings((body as { stages?: unknown } | null)?.stages);
    if ('error' in parsed) return c.json({ error: parsed.error }, 422);
    await store.saveWorkflowSettings(caller.orgId, parsed.settings, caller.userId);
    return c.json({ stages: parsed.settings });
  });

  routes.delete('/workflow', async (c) => {
    const caller = await manager(c, 'review settings');
    if (caller instanceof Response) return caller;
    await store.saveWorkflowSettings(caller.orgId, null, caller.userId);
    return c.body(null, 204);
  });

  routes.delete('/review-forms/:stage', async (c) => {
    const caller = await manager(c);
    if (caller instanceof Response) return caller;
    const stage = c.req.param('stage');
    if (!STAGES.has(stage)) return c.json({ error: 'Unknown stage' }, 404);
    await store.saveReviewTemplate(caller.orgId, stage, null, caller.userId);
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------------------
  // Saved request forms
  // ---------------------------------------------------------------------------

  async function formInput(c: Context): Promise<SavedFormInput | Response> {
    const raw = await c.req.text();
    if (raw.length > MAX_BODY_BYTES * 2) return c.json({ error: 'The form is too large' }, 413);
    let body: { name?: unknown; description?: unknown; definition?: unknown };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return c.json({ error: 'Expected JSON' }, 400);
    }
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 80) return c.json({ error: 'Give the form a name of at most 80 characters' }, 422);
    const description = typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null;
    if (description && description.length > 400) return c.json({ error: 'Use at most 400 characters for the description' }, 422);
    const parsed = parseRequestForm(body.definition);
    if ('error' in parsed) return c.json({ error: parsed.error }, 422);
    return { name, description, definition: parsed.form };
  }

  const NAME_TAKEN = 'A saved form with this name already exists';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  routes.post('/request-forms', async (c) => {
    const caller = await manager(c, 'request forms');
    if (caller instanceof Response) return caller;
    const input = await formInput(c);
    if (input instanceof Response) return input;
    const result = await store.createRequestForm(caller.orgId, input, caller.userId);
    if (result === 'name-taken') return c.json({ error: NAME_TAKEN }, 409);
    return c.json(result, 201);
  });

  routes.put('/request-forms/:id', async (c) => {
    const caller = await manager(c, 'request forms');
    if (caller instanceof Response) return caller;
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json({ error: 'Not found' }, 404);
    const input = await formInput(c);
    if (input instanceof Response) return input;
    const result = await store.updateRequestForm(caller.orgId, id, input, caller.userId);
    if (result === 'not-found') return c.json({ error: 'Not found' }, 404);
    if (result === 'name-taken') return c.json({ error: NAME_TAKEN }, 409);
    return c.json({ id });
  });

  routes.delete('/request-forms/:id', async (c) => {
    const caller = await manager(c, 'request forms');
    if (caller instanceof Response) return caller;
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json({ error: 'Not found' }, 404);
    if ((await store.deleteRequestForm(caller.orgId, id, caller.userId)) === 'not-found') return c.json({ error: 'Not found' }, 404);
    return c.body(null, 204);
  });

  routes.post('/request-forms/:id/activate', async (c) => {
    const caller = await manager(c, 'request forms');
    if (caller instanceof Response) return caller;
    const raw = c.req.param('id');
    const id = raw === 'standard' ? null : raw;
    if (id !== null && !UUID.test(id)) return c.json({ error: 'Not found' }, 404);
    if ((await store.activateRequestForm(caller.orgId, id, caller.userId)) === 'not-found') return c.json({ error: 'Not found' }, 404);
    return c.json({ active: id ?? 'standard' });
  });

  return routes;
}
