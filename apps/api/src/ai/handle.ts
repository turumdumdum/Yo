import { hmacHex, timingSafeEqual } from '../crypto';

// A running AI job is identified to the browser by a signed handle, so the API stays
// stateless (Workers and Node alike). The handle binds the provider's run to one
// request, one kind of job and one person, and expires. It is not a credential on its
// own: every poll checks again that the caller may see the draft.

export type AiRunKind = 'check' | 'suggestions';

export interface AiRunClaims {
  runId: string;
  requestId: string;
  kind: AiRunKind;
  subject: string;
  /** Unix seconds. */
  expires: number;
}

export const HANDLE_TTL_SECONDS = 15 * 60;

const b64url = (text: string) => btoa(unescape(encodeURIComponent(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (text: string) => decodeURIComponent(escape(atob(text.replace(/-/g, '+').replace(/_/g, '/'))));

export async function signHandle(secret: string, claims: AiRunClaims): Promise<string> {
  const payload = b64url(JSON.stringify([claims.runId, claims.requestId, claims.kind, claims.subject, claims.expires]));
  return `${payload}.${await hmacHex(secret, `ai-run.${payload}`)}`;
}

/** Null for anything that is not a valid, unexpired handle for this request, kind and person. */
export async function verifyHandle(
  secret: string,
  handle: string,
  expected: { requestId: string; subject: string },
  nowMs = Date.now(),
): Promise<AiRunClaims | null> {
  if (handle.length > 2048) return null;
  const [payload, mac, extra] = handle.split('.');
  if (!payload || !mac || extra !== undefined) return null;
  if (!timingSafeEqual(mac, await hmacHex(secret, `ai-run.${payload}`))) return null;
  let parts: unknown;
  try {
    parts = JSON.parse(fromB64url(payload));
  } catch {
    return null;
  }
  if (!Array.isArray(parts) || parts.length !== 5) return null;
  const [runId, requestId, kind, subject, expires] = parts as unknown[];
  if (typeof runId !== 'string' || typeof requestId !== 'string' || typeof subject !== 'string' || typeof expires !== 'number') return null;
  if (kind !== 'check' && kind !== 'suggestions') return null;
  if (requestId !== expected.requestId || subject !== expected.subject) return null;
  if (expires * 1000 < nowMs) return null;
  return { runId, requestId, kind, subject, expires };
}

/**
 * The `sub` claim of the caller's access token, read without verifying it. Only used
 * to bind a handle to a person; access itself is checked by the database on every call.
 */
export function tokenSubject(token: string): string {
  try {
    const part = token.split('.')[1];
    if (!part) return '';
    const sub = (JSON.parse(fromB64url(part)) as { sub?: unknown }).sub;
    return typeof sub === 'string' ? sub : '';
  } catch {
    return '';
  }
}
