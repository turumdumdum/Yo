import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Reads apps/web/.env the forgiving way and explains what it found, because a file that
// Vite silently ignores (saved as .env.txt, or with a byte-order mark from Notepad) is
// the most common set-up problem on Windows.

export const REQUIRED_ENV = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_API_URL'] as const;

/** Parses KEY=value lines; tolerates a byte-order mark, CRLF, spaces around "=" and quotes. */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]!] = value;
  }
  return values;
}

export interface EnvReport {
  values: Record<string, string>;
  lines: string[];
}

/** Values from .env and .env.local in `dir` (later files win), and lines describing them. */
export function readEnvDir(dir: string): EnvReport {
  const values: Record<string, string> = {};
  const lines: string[] = [];
  const read: string[] = [];
  for (const name of ['.env', '.env.local']) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (text.startsWith('﻿')) lines.push(`${name} starts with a byte-order mark (saved by Notepad); it is read anyway.`);
    Object.assign(values, parseEnv(text));
    read.push(name);
  }
  lines.unshift(read.length > 0 ? `Read ${read.join(' and ')} in ${dir}` : `No .env file in ${dir}`);

  // Look-alikes that Vite ignores.
  const lookalikes = readdirSync(dir).filter((f) => /^\.?env(\.|$)/i.test(f) && !['.env', '.env.local', '.env.example'].includes(f));
  if (lookalikes.length > 0) {
    lines.push(`Ignored: ${lookalikes.join(', ')}. The file must be named exactly ".env" (rename ".env.txt").`);
  }

  // Values are never printed; only whether each one is there.
  lines.push(REQUIRED_ENV.map((key) => `${key}: ${values[key] ? 'set' : 'MISSING'}`).join(' · '));
  return { values, lines };
}
