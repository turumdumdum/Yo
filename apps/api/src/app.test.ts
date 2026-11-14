import { describe, expect, it } from 'vitest';
import { createApp } from './app';

describe('api', () => {
  const app = createApp();

  it('reports health', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('sends security headers on every response', async () => {
    const res = await app.request('/health');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('strict-transport-security')).toContain('max-age=63072000');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('answers unknown routes with JSON 404', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });
});
