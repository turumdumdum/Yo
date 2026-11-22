import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { EmailError, invitationEmail, resendMailer, type EmailMessage, type Mailer } from './email';
import { InvitationRefused, type InvitationStore } from './invitations';

const ORG = '11111111-1111-4111-8111-111111111111';
const admin = { userId: 'u1', orgId: ORG, role: 'org_admin' as const, email: 'ann@acme.example' };

function setup(options: { caller?: typeof admin | null; mailer?: Mailer | null; refuse?: string } = {}) {
  const created: { token: string; rows: unknown }[] = [];
  const store: InvitationStore = {
    async getCaller() {
      return options.caller === undefined ? admin : options.caller;
    },
    async createInvitations(token, orgId, rows) {
      if (options.refuse) throw new InvitationRefused(options.refuse);
      created.push({ token, rows });
      expect(orgId).toBe(ORG);
      return rows.map((r, i) => (r.email.startsWith('bad') ? { ...r, error: 'enter a valid email address' } : { ...r, token: `tok${i}` }));
    },
    async organizationName() {
      return 'Acme <Corp>';
    },
  };
  const sent: EmailMessage[] = [];
  const mailer: Mailer =
    options.mailer === null
      ? (undefined as unknown as Mailer)
      : (options.mailer ?? {
          async send(m) {
            if (m.to.startsWith('bounce')) throw new EmailError('The mail server refused the message');
            sent.push(m);
          },
        });
  const app = createApp({ webOrigin: 'https://app.example', invitations: store, mailer: options.mailer === null ? undefined : mailer });
  const call = (body: unknown, auth = 'Bearer user-token') =>
    app.request('/v1/invitations', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { call, created, sent, app };
}

describe('POST /v1/invitations', () => {
  it('creates invitations as the user and emails each link', async () => {
    const { call, created, sent } = setup();
    const res = await call({ invitations: [{ email: 'bob@acme.example', role: 'reviewer' }, { email: 'bad', role: 'requester' }] });
    expect(res.status).toBe(200);
    expect(created[0]!.token).toBe('user-token');
    expect(await res.json()).toEqual({
      results: [
        { email: 'bob@acme.example', role: 'reviewer', emailed: true },
        { email: 'bad', role: 'requester', emailed: false, error: 'enter a valid email address' },
      ],
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('bob@acme.example');
    expect(sent[0]!.text).toContain('https://app.example/?invite=tok0');
    expect(sent[0]!.text).toContain('ann@acme.example invited you to join Acme <Corp>');
    expect(sent[0]!.html).toContain('Acme &lt;Corp&gt;');
    expect(sent[0]!.html).not.toContain('<Corp>');
  });

  it('hands the link back when the email fails or email is off', async () => {
    const bounced = (await (await setup().call({ invitations: [{ email: 'bounce@acme.example', role: 'reviewer' }] })).json()) as { results: unknown[] };
    expect(bounced.results[0]).toEqual({
      email: 'bounce@acme.example',
      role: 'reviewer',
      emailed: false,
      emailError: 'The mail server refused the message',
      link: 'https://app.example/?invite=tok0',
    });
    const off = setup({ mailer: null });
    const res = (await (await off.call({ invitations: [{ email: 'bob@acme.example', role: 'reviewer' }] })).json()) as { results: unknown[] };
    expect(res.results[0]).toMatchObject({ emailed: false, emailError: 'Email is not set up. An admin can set it up in Admin → Integrations.', link: 'https://app.example/?invite=tok0' });
    expect(await (await off.app.request('/v1/invitations/email-status')).json()).toEqual({ enabled: false });
  });

  it('refuses non-admins, bad input and what the database refuses', async () => {
    expect((await setup({ caller: { ...admin, role: 'reviewer' as never } }).call({ invitations: [{ email: 'b@a.example', role: 'reviewer' }] })).status).toBe(403);
    expect((await setup({ caller: null }).call({ invitations: [{ email: 'b@a.example', role: 'reviewer' }] })).status).toBe(403);
    expect((await setup().call({ invitations: [{ email: 'b@a.example', role: 'superuser' }] })).status).toBe(422);
    expect((await setup().call({ invitations: [] })).status).toBe(422);
    expect((await setup().call({ invitations: Array.from({ length: 501 }, () => ({ email: 'b@a.example', role: 'reviewer' })) })).status).toBe(422);
    expect((await setup().call({ invitations: [{ email: 'b@a.example', role: 'reviewer' }] }, '')).status).toBe(401);
    const refused = await setup({ refuse: 'multi-factor authentication required' }).call({ invitations: [{ email: 'b@a.example', role: 'reviewer' }] });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: 'multi-factor authentication required' });
  });
});

describe('email', () => {
  it('sends through Resend without leaking the response body', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = resendMailer({
      apiKey: 're_test',
      from: 'X <x@acme.example>',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response('{}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    await ok.send(invitationEmail({ to: 'b@acme.example', orgName: 'Acme', inviter: null, role: 'org_admin', link: 'https://app.example/?invite=t' }));
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer re_test');
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ to: ['b@acme.example'], subject: 'Join Acme on [Product name]' });

    const rejected = resendMailer({ apiKey: 'bad', from: 'x@acme.example', fetchImpl: (async () => new Response('secret details', { status: 403 })) as unknown as typeof fetch });
    await expect(rejected.send({ to: 'b@acme.example', subject: 's', text: 't', html: 'h' })).rejects.toThrow('The email service rejected the API key or sender');
  });
});
