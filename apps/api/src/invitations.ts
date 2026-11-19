import { ORG_ROLES, type OrgRole } from '@app/shared';
import { Hono } from 'hono';
import type { Caller } from './admin';
import { invitationEmail, type Mailer } from './email';
import { UnauthorizedError } from './requests';

// Invitations go through the API so that the invitation email can be sent from the
// backend (mail credentials never reach the browser). The invitations themselves are
// created by the database with the caller's own token, so the org-admin check, domain
// rules and audit log stay where they are.

export interface InvitationResult {
  email: string;
  role: string;
  /** One-time token; present when the invitation was created. */
  token?: string;
  error?: string;
}

export interface InvitationStore {
  getCaller(accessToken: string): Promise<Caller | null>;
  /** Calls public.create_invitations as the user. */
  createInvitations(accessToken: string, orgId: string, rows: { email: string; role: OrgRole }[]): Promise<InvitationResult[]>;
  organizationName(orgId: string): Promise<string>;
}

export interface InvitationOutcome {
  email: string;
  role: string;
  /** The link to share by hand when the email could not be sent. */
  link?: string;
  emailed: boolean;
  emailError?: string;
  error?: string;
}

const MAX_ROWS = 500;
const SEND_CONCURRENCY = 4;

export function invitationRoutes(store: InvitationStore, options: { webOrigin: string; mailer?: Mailer }) {
  const routes = new Hono();
  const base = options.webOrigin.replace(/\/+$/, '');

  routes.get('/invitations/email-status', (c) => c.json({ enabled: Boolean(options.mailer) }));

  routes.post('/invitations', async (c) => {
    const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return c.json({ error: 'Sign in to continue' }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Expected JSON' }, 400);
    }
    const raw = (body as { invitations?: unknown })?.invitations;
    if (!Array.isArray(raw) || raw.length === 0) return c.json({ error: 'List at least one invitation' }, 422);
    if (raw.length > MAX_ROWS) return c.json({ error: `At most ${MAX_ROWS} invitations at a time` }, 422);
    const rows: { email: string; role: OrgRole }[] = [];
    for (const item of raw) {
      const email = (item as { email?: unknown })?.email;
      const role = (item as { role?: unknown })?.role;
      if (typeof email !== 'string' || email.length > 254 || typeof role !== 'string' || !(ORG_ROLES as readonly string[]).includes(role)) {
        return c.json({ error: 'Each invitation needs an email address and a known role' }, 422);
      }
      rows.push({ email, role: role as OrgRole });
    }

    let caller: Caller | null;
    let results: InvitationResult[];
    try {
      caller = await store.getCaller(token);
      if (!caller || caller.role !== 'org_admin') return c.json({ error: 'Only an org admin can invite people' }, 403);
      results = await store.createInvitations(token, caller.orgId, rows);
    } catch (error) {
      if (error instanceof UnauthorizedError) return c.json({ error: 'Sign in to continue' }, 401);
      if (error instanceof InvitationRefused) return c.json({ error: error.message }, 422);
      throw error;
    }

    const orgName = options.mailer ? await store.organizationName(caller.orgId) : '';
    const outcomes: InvitationOutcome[] = results.map((r) =>
      r.token ? { email: r.email, role: r.role, link: `${base}/?invite=${r.token}`, emailed: false } : { email: r.email, role: r.role, emailed: false, error: r.error ?? 'Not invited' },
    );

    if (options.mailer) {
      const mailer = options.mailer;
      const queue = outcomes.filter((o) => o.link);
      const worker = async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          try {
            await mailer.send(invitationEmail({ to: next.email, orgName, inviter: caller.email ?? null, role: next.role, link: next.link! }));
            next.emailed = true;
          } catch (error) {
            next.emailError = error instanceof Error && error.name === 'EmailError' ? error.message : 'The email could not be sent';
            if (!(error instanceof Error && error.name === 'EmailError')) console.error(error);
          }
        }
      };
      await Promise.all(Array.from({ length: SEND_CONCURRENCY }, worker));
    } else {
      for (const o of outcomes) if (o.link) o.emailError = 'Email is not set up on this server';
    }

    // The link is only returned when the person did not get it by email.
    for (const o of outcomes) if (o.emailed) delete o.link;
    return c.json({ results: outcomes });
  });

  return routes;
}

/** The database refused the whole call (for example: not an org admin, MFA missing). */
export class InvitationRefused extends Error {}
