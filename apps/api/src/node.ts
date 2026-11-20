import { serve } from '@hono/node-server';
import { createApp } from './app';
import { optionsFromEnv } from './config';
import { smtpMailer } from './smtp';
import { runOutbox } from './dispatcher';

// Node entrypoint (self-host container and local development).
const port = Number(process.env.PORT ?? 8787);
const options = optionsFromEnv(process.env);

if (process.env.EMAIL_PROVIDER?.trim().toLowerCase() === 'smtp') {
  const { SMTP_URL, EMAIL_FROM } = process.env;
  if (!SMTP_URL || !EMAIL_FROM) {
    throw new Error('EMAIL_PROVIDER=smtp needs SMTP_URL and EMAIL_FROM in apps/api/.env (see apps/api/.env.example).');
  }
  options.mailer = smtpMailer({ url: SMTP_URL, from: EMAIL_FROM });
}

// The outbox: queue notifications from the audit log and deliver what is due.
const timer = setInterval(() => void runOutbox(options.outbox), 30_000);
timer.unref();

serve({ fetch: createApp(options).fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}${options.mailer ? '' : ' (email off: invitation links are shown to the admin)'}`);
});
