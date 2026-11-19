// Outgoing email (CLAUDE.md §3: any SMTP through an adapter, Resend for the hosted
// version). The app only sees the Mailer interface; the entrypoint picks the transport.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

export class EmailError extends Error {
  override name = 'EmailError';
}

/** Resend's HTTP API: works on Cloudflare Workers and in Node. */
export function resendMailer(options: { apiKey: string; from: string; baseUrl?: string; fetchImpl?: typeof fetch }): Mailer {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = (options.baseUrl ?? 'https://api.resend.com').replace(/\/+$/, '');
  return {
    async send(message) {
      let res: Response;
      try {
        res = await fetchImpl(`${base}/emails`, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: options.from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new EmailError('The email service could not be reached');
      }
      if (!res.ok) {
        // The body may echo request details; log the status only.
        console.error(`Resend responded ${res.status}`);
        throw new EmailError(res.status === 401 || res.status === 403 ? 'The email service rejected the API key or sender' : 'The email service refused the message');
      }
    },
  };
}

/** Prints emails instead of sending them. For local development only. */
export function logMailer(log: (line: string) => void = console.log): Mailer {
  return {
    async send(message) {
      log(`[email] to=${message.to} subject=${JSON.stringify(message.subject)}\n${message.text}`);
    },
  };
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const ROLE_NAMES: Record<string, string> = {
  org_admin: 'Org admin',
  process_manager: 'Process manager',
  reviewer: 'Reviewer',
  requester: 'Requester',
  owner: 'Owner',
  auditor: 'Auditor',
};

/** The invitation email. Plain wording; the link is the only call to action. */
export function invitationEmail(input: { to: string; orgName: string; inviter: string | null; role: string; link: string; productName?: string }): EmailMessage {
  const product = input.productName ?? '[Product name]';
  const role = ROLE_NAMES[input.role] ?? input.role;
  const who = input.inviter ? `${input.inviter} invited you` : 'You are invited';
  const subject = `Join ${input.orgName} on ${product}`;
  const text = [
    `${who} to join ${input.orgName} on ${product} as ${role}.`,
    '',
    `${product} is where your organization requests and approves new vendors and services.`,
    '',
    `Accept the invitation: ${input.link}`,
    '',
    'The link works once and expires in 7 days. If you did not expect this email, you can ignore it.',
  ].join('\n');
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#F5F6F8;font-family:Inter,Arial,sans-serif;color:#14181F">
<table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#FFFFFF;border:1px solid #DDE1E7;border-radius:10px">
<tr><td style="padding:28px">
<h1 style="margin:0 0 16px;font-size:22px">Join ${escapeHtml(input.orgName)}</h1>
<p style="margin:0 0 12px;line-height:1.5">${escapeHtml(who)} to join <strong>${escapeHtml(input.orgName)}</strong> on ${escapeHtml(product)} as <strong>${escapeHtml(role)}</strong>.</p>
<p style="margin:0 0 24px;line-height:1.5;color:#3D4654">${escapeHtml(product)} is where your organization requests and approves new vendors and services.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:12px 20px;background:#2F4BD8;color:#FFFFFF;text-decoration:none;border-radius:8px;font-weight:600">Accept invitation</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#566070">The link works once and expires in 7 days. If you did not expect this email, you can ignore it.</p>
</td></tr></table></body></html>`;
  return { to: input.to, subject, text, html };
}
