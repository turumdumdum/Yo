import { describe, expect, it } from 'vitest';
import { isStrongSession, signInSchema, signUpSchema, totpCodeSchema } from './auth';

describe('isStrongSession', () => {
  it.each([
    ['password only', { aal: 'aal1', methods: [{ method: 'password' }] }, false],
    ['password + TOTP', { aal: 'aal2', methods: [{ method: 'totp' }, { method: 'password' }] }, true],
    ['Google sign-in', { aal: 'aal1', methods: [{ method: 'oauth' }] }, true],
    ['email link or recovery', { aal: 'aal1', methods: [{ method: 'otp' }, { method: 'recovery' }] }, false],
    ['missing claims', { aal: undefined, methods: [] }, false],
  ] as const)('%s', (_label, session, expected) => {
    expect(isStrongSession(session)).toBe(expected);
  });
});

describe('auth schemas', () => {
  it('requires a 12-character password to sign up but not to sign in', () => {
    expect(signUpSchema.safeParse({ email: 'a@b.example', password: 'short' }).success).toBe(false);
    expect(signUpSchema.safeParse({ email: 'a@b.example', password: 'x'.repeat(12) }).success).toBe(true);
    expect(signUpSchema.safeParse({ email: 'a@b.example', password: 'x'.repeat(73) }).success).toBe(false);
    expect(signInSchema.safeParse({ email: 'a@b.example', password: 'short' }).success).toBe(true);
    expect(signInSchema.safeParse({ email: 'a@b.example', password: '' }).success).toBe(false);
  });

  it('lower-cases the email', () => {
    expect(signInSchema.parse({ email: 'Ann@Example.com', password: 'x' }).email).toBe('ann@example.com');
  });

  it('accepts a 6-digit code with spaces and rejects anything else', () => {
    expect(totpCodeSchema.parse('123 456')).toBe('123456');
    expect(totpCodeSchema.safeParse('12345').success).toBe(false);
    expect(totpCodeSchema.safeParse('12345a').success).toBe(false);
  });
});
