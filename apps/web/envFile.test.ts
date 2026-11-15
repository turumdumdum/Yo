import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseEnv, readEnvDir } from './envFile';

describe('parseEnv', () => {
  it('tolerates a byte-order mark, CRLF, spaces, quotes and comments', () => {
    const text = '﻿VITE_SUPABASE_URL = https://p.supabase.co\r\n# comment\r\nVITE_SUPABASE_ANON_KEY="sb_publishable_abc"\r\n\r\nexport VITE_API_URL=\'http://localhost:8787\'\r\nnot a line\r\n';
    expect(parseEnv(text)).toEqual({
      VITE_SUPABASE_URL: 'https://p.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'sb_publishable_abc',
      VITE_API_URL: 'http://localhost:8787',
    });
  });
});

describe('readEnvDir', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reports a missing file and look-alikes without printing values', () => {
    dir = mkdtempSync(join(tmpdir(), 'env-'));
    writeFileSync(join(dir, '.env.txt'), 'VITE_SUPABASE_URL=https://secret.example');
    const report = readEnvDir(dir);
    expect(report.values).toEqual({});
    expect(report.lines[0]).toMatch(/^No .env file in/);
    expect(report.lines.join('\n')).toMatch(/Ignored: .env.txt/);
    expect(report.lines.at(-1)).toBe('VITE_SUPABASE_URL: MISSING · VITE_SUPABASE_ANON_KEY: MISSING · VITE_API_URL: MISSING');
    expect(report.lines.join('\n')).not.toContain('secret.example');
  });

  it('reads .env with a byte-order mark and lets .env.local override it', () => {
    dir = mkdtempSync(join(tmpdir(), 'env-'));
    writeFileSync(join(dir, '.env'), '﻿VITE_SUPABASE_URL=https://a.supabase.co\nVITE_SUPABASE_ANON_KEY=k1');
    writeFileSync(join(dir, '.env.local'), 'VITE_SUPABASE_ANON_KEY=k2\nVITE_API_URL=http://localhost:8787');
    const report = readEnvDir(dir);
    expect(report.values).toEqual({ VITE_SUPABASE_URL: 'https://a.supabase.co', VITE_SUPABASE_ANON_KEY: 'k2', VITE_API_URL: 'http://localhost:8787' });
    expect(report.lines.join('\n')).toMatch(/byte-order mark/);
    expect(report.lines.at(-1)).toBe('VITE_SUPABASE_URL: set · VITE_SUPABASE_ANON_KEY: set · VITE_API_URL: set');
  });
});

describe('look-alike files', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('ignores source files whose names merely start with "env"', () => {
    dir = mkdtempSync(join(tmpdir(), 'env-'));
    writeFileSync(join(dir, 'envFile.ts'), '');
    writeFileSync(join(dir, '.env.example'), '');
    writeFileSync(join(dir, 'env'), '');
    const lines = readEnvDir(dir).lines.join('\n');
    expect(lines).toMatch(/Ignored: env\./);
    expect(lines).not.toMatch(/envFile|\.env\.example/);
  });
});
