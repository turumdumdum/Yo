// Small Web Crypto helpers (Workers and Node alike): application-level encryption of
// integration secrets and HMAC signatures for calls between services.

type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
export type EncryptionKey = CryptoKey;

const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Imports a base64 32-byte key, or throws with a message that names the variable. */
export async function importEncryptionKey(base64: string): Promise<CryptoKey> {
  let raw: Uint8Array;
  try {
    raw = fromB64(base64.trim());
  } catch {
    throw new Error('INTEGRATION_ENCRYPTION_KEY must be base64');
  }
  if (raw.length !== 32) throw new Error('INTEGRATION_ENCRYPTION_KEY must be 32 bytes (base64)');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** AES-256-GCM; returns "base64(iv).base64(ciphertext)". */
export async function encrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return `${toB64(iv)}.${toB64(new Uint8Array(ct))}`;
}

export async function decrypt(key: CryptoKey, payload: string): Promise<string> {
  const [iv, ct] = payload.split('.');
  if (!iv || !ct) throw new Error('Malformed ciphertext');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(ct));
  return dec.decode(pt);
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Compares without leaking where the strings differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Header value "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`>". */
export async function signatureHeader(secret: string, body: string, now = Date.now()): Promise<string> {
  const t = Math.floor(now / 1000);
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

export type SignatureCheck = 'ok' | 'missing' | 'malformed' | 'stale' | 'mismatch';

export async function verifySignature(secret: string, header: string | undefined, rawBody: string, now = Date.now(), toleranceSeconds = 300): Promise<SignatureCheck> {
  if (!header) return 'missing';
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=', 2) as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return 'malformed';
  if (Math.abs(Math.floor(now / 1000) - t) > toleranceSeconds) return 'stale';
  return timingSafeEqual(await hmacHex(secret, `${t}.${rawBody}`), v1) ? 'ok' : 'mismatch';
}

/** A random secret for signing, 32 bytes hex. */
export function randomSecret(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}
