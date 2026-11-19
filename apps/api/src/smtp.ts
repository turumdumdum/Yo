import { createTransport } from 'nodemailer';
import { EmailError, type Mailer } from './email';

// SMTP transport for the Node API (self-host). Not used on Cloudflare Workers, which
// cannot open SMTP connections; the hosted version uses Resend instead.

/** `url` is an SMTP URL such as smtps://user:password@smtp.example.com:465. */
export function smtpMailer(options: { url: string; from: string }): Mailer {
  const transport = createTransport(options.url);
  return {
    async send(message) {
      try {
        await transport.sendMail({ from: options.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
      } catch (error) {
        // The error can contain server replies; keep them in the log, not in the response.
        console.error('SMTP send failed:', error instanceof Error ? error.message : error);
        throw new EmailError('The mail server refused the message');
      }
    },
  };
}
