import { ASANA_GID, normalizeAsanaFields, type AsanaField } from '@app/shared';
import { Hono, type Context } from 'hono';
import type { Caller } from './admin';
import { decrypt, encrypt, type EncryptionKey } from './crypto';
import type { IntegrationConfig, IntegrationSecrets, IntegrationStore } from './integrationStore';
import { UnauthorizedError } from './requests';

// Asana, for importing a project's custom fields (and all their values) into the request
// form. Org admins only. The personal access token is stored encrypted with the other
// integration secrets and is only ever sent to app.asana.com, from the server.
// API reference: https://developers.asana.com/reference (workspaces, projects,
// custom field settings). Shapes used here: { data: [...], next_page: { offset } | null }.

export const ASANA_API = 'https://app.asana.com/api/1.0';
const PAGE = 100;
/** Stop after this many pages: a project has far fewer fields, a workspace rarely more projects. */
const MAX_PAGES = 20;
const TIMEOUT_MS = 15_000;
const NAME_MAX = 200;

export class AsanaError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502,
  ) {
    super(message);
  }
}

export interface AsanaClient {
  me(): Promise<{ name: string; workspaces: { gid: string; name: string }[] }>;
  workspaces(): Promise<{ gid: string; name: string }[]>;
  projects(workspaceGid: string): Promise<{ gid: string; name: string }[]>;
  fields(projectGid: string): Promise<AsanaField[]>;
}

const cleanName = (value: unknown) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, NAME_MAX)
    : '';
const named = (rows: unknown[]) =>
  rows
    .map((r) => r as { gid?: unknown; name?: unknown } | null)
    .filter((r): r is { gid: string; name: unknown } => typeof r?.gid === 'string' && ASANA_GID.test(r.gid))
    .map((r) => ({ gid: r.gid, name: cleanName(r.name) || r.gid }));

/** A client for one token. Every call is bounded, never follows redirects and never retries on its own. */
export function asanaClient(token: string, fetchImpl: typeof fetch = fetch, baseUrl = ASANA_API): AsanaClient {
  async function get(path: string, query: Record<string, string>): Promise<{ data: unknown; next: string | null }> {
    const url = `${baseUrl}${path}?${new URLSearchParams(query)}`;
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new AsanaError('Asana could not be reached. Try again in a moment.', 502);
    }
    if (res.status === 401) throw new AsanaError('Asana did not accept the token. Create a new personal access token and save it again.', 401);
    if (res.status === 402) throw new AsanaError('Custom fields need a paid Asana plan for this workspace.', 403);
    if (res.status === 403) throw new AsanaError('The Asana token has no access to this workspace or project.', 403);
    if (res.status === 404) throw new AsanaError('Asana could not find it, or the token has no access to it.', 404);
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'));
      throw new AsanaError(`Asana asks to slow down. Try again in ${Number.isFinite(wait) && wait > 0 ? Math.ceil(wait) : 60} seconds.`, 429);
    }
    if (!res.ok) throw new AsanaError(`Asana answered with an error (${res.status}).`, 502);
    const body = (await res.json().catch(() => null)) as { data?: unknown; next_page?: { offset?: unknown } | null } | null;
    if (!body || body.data === undefined) throw new AsanaError('Asana answered in an unexpected format.', 502);
    const offset = body.next_page?.offset;
    return { data: body.data, next: typeof offset === 'string' && offset.length < 1000 ? offset : null };
  }

  async function all(path: string, query: Record<string, string>): Promise<unknown[]> {
    const rows: unknown[] = [];
    let offset: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, next }: { data: unknown; next: string | null } = await get(path, { ...query, limit: String(PAGE), ...(offset ? { offset } : {}) });
      if (!Array.isArray(data)) throw new AsanaError('Asana answered in an unexpected format.', 502);
      rows.push(...data);
      if (!next) break;
      offset = next;
    }
    return rows;
  }

  return {
    async me() {
      const { data } = await get('/users/me', { opt_fields: 'name,workspaces.name' });
      const user = data as { name?: unknown; workspaces?: unknown } | null;
      return { name: cleanName(user?.name), workspaces: named(Array.isArray(user?.workspaces) ? user.workspaces : []) };
    },
    async workspaces() {
      return named(await all('/workspaces', { opt_fields: 'name' }));
    },
    async projects(workspaceGid) {
      if (!ASANA_GID.test(workspaceGid)) throw new AsanaError('Choose a workspace', 400);
      return named(await all('/projects', { workspace: workspaceGid, archived: 'false', opt_fields: 'name' }));
    },
    async fields(projectGid) {
      if (!ASANA_GID.test(projectGid)) throw new AsanaError('Choose a project', 400);
      const settings = await all(`/projects/${projectGid}/custom_field_settings`, {
        opt_fields: [
          'is_important',
          'custom_field.gid',
          'custom_field.name',
          'custom_field.description',
          'custom_field.type',
          'custom_field.resource_subtype',
          'custom_field.precision',
          'custom_field.enum_options.gid',
          'custom_field.enum_options.name',
          'custom_field.enum_options.enabled',
        ].join(','),
      });
      return normalizeAsanaFields(settings);
    },
  };
}

export interface AsanaRouteOptions {
  store: Pick<IntegrationStore, 'getIntegration' | 'saveIntegration'>;
  getCaller: (token: string) => Promise<Caller | null>;
  key: Promise<EncryptionKey | null>;
  /** Drops cached settings after a change. */
  invalidate?: (orgId: string) => void;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export function asanaRoutes(o: AsanaRouteOptions) {
  const routes = new Hono();

  async function admin(c: Context): Promise<Caller | Response> {
    const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return c.json({ error: 'Sign in to continue' }, 401);
    try {
      const who = await o.getCaller(token);
      if (!who || who.role !== 'org_admin') return c.json({ error: 'Only org admins can manage Asana' }, 403);
      return who;
    } catch (error) {
      if (error instanceof UnauthorizedError) return c.json({ error: 'Sign in to continue' }, 401);
      throw error;
    }
  }

  async function load(orgId: string): Promise<{ config: IntegrationConfig; secrets: IntegrationSecrets; key: EncryptionKey | null }> {
    const [record, key] = await Promise.all([o.store.getIntegration(orgId), o.key]);
    const secrets = key && record?.secrets ? (JSON.parse(await decrypt(key, record.secrets)) as IntegrationSecrets) : {};
    return { config: record?.config ?? {}, secrets, key };
  }

  async function save(orgId: string, key: EncryptionKey, config: IntegrationConfig, secrets: IntegrationSecrets, actorId: string, action: string, metadata: Record<string, unknown>) {
    const hasSecrets = Object.values(secrets).some(Boolean);
    await o.store.saveIntegration(orgId, { config, secrets: hasSecrets ? await encrypt(key, JSON.stringify(secrets)) : null }, actorId, action, metadata);
    o.invalidate?.(orgId);
  }

  /** The saved token's client, or a response explaining why there is none. */
  async function client(c: Context, orgId: string): Promise<{ api: AsanaClient; config: IntegrationConfig } | Response> {
    const { config, secrets, key } = await load(orgId);
    if (!key) return c.json({ error: 'Integrations need INTEGRATION_ENCRYPTION_KEY on the API server' }, 503);
    if (!secrets.asanaToken) return c.json({ error: 'Connect Asana first in Admin → Integrations' }, 409);
    return { api: asanaClient(secrets.asanaToken, o.fetchImpl, o.baseUrl), config };
  }

  const fail = (c: Context, error: unknown) => {
    if (error instanceof AsanaError) return c.json({ error: error.message }, error.status);
    throw error;
  };

  routes.get('/integrations/asana', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const { config, secrets, key } = await load(who.orgId);
    // Never the token itself: only whether one is saved.
    return c.json({
      encryptionReady: key !== null,
      configured: !!secrets.asanaToken,
      workspaceGid: config.asana?.workspaceGid ?? null,
      workspaceName: config.asana?.workspaceName ?? null,
    });
  });

  routes.put('/integrations/asana', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    let b: { token?: unknown; workspaceGid?: unknown };
    try {
      b = (await c.req.json()) as typeof b;
    } catch {
      return c.json({ error: 'Expected JSON' }, 400);
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) return c.json({ error: 'Expected a JSON object' }, 400);
    const token = typeof b.token === 'string' ? b.token.trim() : undefined;
    if (b.token !== undefined && (!token || token.length < 16 || token.length > 500 || /\s/.test(token))) {
      return c.json({ error: 'Paste the whole Asana personal access token' }, 422);
    }
    if (b.workspaceGid !== undefined && b.workspaceGid !== null && (typeof b.workspaceGid !== 'string' || !ASANA_GID.test(b.workspaceGid))) {
      return c.json({ error: 'Choose a workspace' }, 422);
    }
    const { config, secrets, key } = await load(who.orgId);
    if (!key) return c.json({ error: 'Integrations need INTEGRATION_ENCRYPTION_KEY on the API server' }, 503);
    const nextToken = token ?? secrets.asanaToken;
    if (!nextToken) return c.json({ error: 'Paste an Asana personal access token' }, 422);

    // Check the token (and the workspace) before saving, so a typo is caught at once.
    let me: Awaited<ReturnType<AsanaClient['me']>>;
    try {
      me = await asanaClient(nextToken, o.fetchImpl, o.baseUrl).me();
    } catch (error) {
      return fail(c, error);
    }
    const workspaceGid = b.workspaceGid === undefined ? (config.asana?.workspaceGid ?? null) : (b.workspaceGid as string | null);
    const workspace = workspaceGid ? me.workspaces.find((w) => w.gid === workspaceGid) : undefined;
    if (workspaceGid && !workspace) return c.json({ error: 'The token has no access to that workspace' }, 422);
    await save(
      who.orgId,
      key,
      { ...config, asana: { workspaceGid: workspace?.gid ?? null, workspaceName: workspace?.name ?? null } },
      { ...secrets, asanaToken: nextToken },
      who.userId,
      'integration.asana_updated',
      { token_changed: token !== undefined, workspace: workspace?.gid ?? null },
    );
    return c.json({ ok: true, user: me.name, workspaces: me.workspaces });
  });

  routes.delete('/integrations/asana', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const { config, secrets, key } = await load(who.orgId);
    if (!key) return c.json({ error: 'Integrations need INTEGRATION_ENCRYPTION_KEY on the API server' }, 503);
    const { asana: _config, ...restConfig } = config;
    const { asanaToken: _token, ...restSecrets } = secrets;
    await save(who.orgId, key, restConfig, restSecrets, who.userId, 'integration.asana_removed', {});
    return c.json({ ok: true });
  });

  routes.post('/integrations/asana/test', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const found = await client(c, who.orgId);
    if (found instanceof Response) return found;
    try {
      const me = await found.api.me();
      return c.json({ ok: true, user: me.name, workspaces: me.workspaces.length });
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.get('/integrations/asana/workspaces', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const found = await client(c, who.orgId);
    if (found instanceof Response) return found;
    try {
      return c.json({ workspaces: await found.api.workspaces(), selected: found.config.asana?.workspaceGid ?? null });
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.get('/integrations/asana/workspaces/:gid/projects', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const gid = c.req.param('gid');
    if (!ASANA_GID.test(gid)) return c.json({ error: 'Choose a workspace' }, 400);
    const found = await client(c, who.orgId);
    if (found instanceof Response) return found;
    try {
      return c.json({ projects: await found.api.projects(gid) });
    } catch (error) {
      return fail(c, error);
    }
  });

  routes.get('/integrations/asana/projects/:gid/fields', async (c) => {
    const who = await admin(c);
    if (who instanceof Response) return who;
    const gid = c.req.param('gid');
    if (!ASANA_GID.test(gid)) return c.json({ error: 'Choose a project' }, 400);
    const found = await client(c, who.orgId);
    if (found instanceof Response) return found;
    try {
      return c.json({ fields: await found.api.fields(gid) });
    } catch (error) {
      return fail(c, error);
    }
  });

  return routes;
}
