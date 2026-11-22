import { serve } from '@hono/node-server';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { optionsFromEnv } from './config';
import { smtpMailer } from './smtp';
import { runOutbox } from './dispatcher';

// Node entrypoint (self-host container and local development).
const port = Number(process.env.PORT ?? 8787);

// Secrets saved in Admin → Integrations are encrypted with this key. Create one on the
// first start so nothing has to be set by hand; the key itself is never printed.
if (!process.env.INTEGRATION_ENCRYPTION_KEY) {
  const key = randomBytes(32).toString('base64');
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');
  try {
    const line = `INTEGRATION_ENCRYPTION_KEY=${key}`;
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    // Fill an empty INTEGRATION_ENCRYPTION_KEY= line (copied from .env.example), else append.
    const next = /^INTEGRATION_ENCRYPTION_KEY=[ \t]*$/m.test(current)
      ? current.replace(/^INTEGRATION_ENCRYPTION_KEY=[ \t]*$/m, line)
      : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`;
    writeFileSync(file, next, { mode: 0o600 });
    chmodSync(file, 0o600);
    process.env.INTEGRATION_ENCRYPTION_KEY = key;
    console.log('Generated an encryption key for integration secrets in apps/api/.env — back it up; without it saved secrets cannot be read.');
  } catch {
    console.warn('INTEGRATION_ENCRYPTION_KEY is not set and apps/api/.env could not be written: integrations that keep secrets are off.');
  }
}

const options = optionsFromEnv(process.env, { smtpFactory: (url, from) => smtpMailer({ url, from }) });

if (process.env.EMAIL_PROVIDER?.trim().toLowerCase() === 'smtp') {
  const { SMTP_URL, EMAIL_FROM } = process.env;
  if (!SMTP_URL || !EMAIL_FROM) console.warn('EMAIL_PROVIDER=smtp needs SMTP_URL and EMAIL_FROM; email from the environment is off.');
  else options.mailer = smtpMailer({ url: SMTP_URL, from: EMAIL_FROM });
}

// The outbox: queue notifications from the audit log and deliver what is due.
const timer = setInterval(() => void runOutbox(options.outbox), 30_000);
timer.unref();

serve({ fetch: createApp(options).fetch, port }, (info) => {
  console.log(`API listening on http://localhost:${info.port}${options.mailer ? '' : ' (email off: invitation links are shown to the admin)'}`);
});
