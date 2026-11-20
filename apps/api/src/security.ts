import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';

// Request hardening for the whole API: rate limits, body size limits, JSON only, no caching.
// The rate limit is in memory, per process (per isolate on Workers): it slows abuse of one
// instance; a shared limit for the hosted version belongs in Cloudflare's rate limiting.

export interface RateLimitRule {
  /** Paths starting with this prefix use the rule; the first match wins. */
  prefix: string;
  limit: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitRule[] = [
  { prefix: '/v1/external/', limit: 30, windowMs: 60_000 },
  { prefix: '/v1/', limit: 120, windowMs: 60_000 },
];

/** The caller's address: Cloudflare's header, else the first hop of X-Forwarded-For. */
export function clientIp(headers: Headers): string {
  return headers.get('cf-connecting-ip') ?? headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
}

export function rateLimit(rules: RateLimitRule[] = DEFAULT_RATE_LIMITS, now: () => number = Date.now): MiddlewareHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const rule = rules.find((r) => path.startsWith(r.prefix));
    if (!rule) return next();
    const key = `${rule.prefix}|${clientIp(c.req.raw.headers)}`;
    const t = now();
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= t) {
      if (buckets.size > 50_000) buckets.clear();
      bucket = { count: 0, resetAt: t + rule.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > rule.limit) {
      c.header('Retry-After', String(Math.ceil((bucket.resetAt - t) / 1000)));
      return c.json({ error: 'Too many requests. Please wait a moment and try again.' }, 429);
    }
    return next();
  };
}

/** Body size limits: 256 KB for calls from other services, 1 MB elsewhere. */
export function bodyLimits(): MiddlewareHandler {
  const small = bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: 'The request body is too large' }, 413) });
  const large = bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'The request body is too large' }, 413) });
  return (c, next) => (new URL(c.req.url).pathname.startsWith('/v1/external/') ? small(c, next) : large(c, next));
}

/** A POST or PUT that carries a body must declare it as JSON. */
export function jsonOnly(): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      const length = Number(c.req.header('content-length') ?? '0');
      const hasBody = length > 0 || c.req.header('transfer-encoding') !== undefined || (c.req.raw.body !== null && !c.req.header('content-length'));
      if (hasBody && !(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) {
        return c.json({ error: 'Send the body as application/json' }, 415);
      }
    }
    return next();
  };
}

/** Answers from the API are never stored by browsers or proxies. */
export function noStore(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  };
}
