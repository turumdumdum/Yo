import { describe, expect, it } from 'vitest';
import { authStep } from './steps';

const password = [{ method: 'password' }];

describe('authStep', () => {
  it('asks visitors without a session to sign in', () => {
    expect(authStep({ hasSession: false, currentLevel: null, nextLevel: null, methods: [] })).toBe('signed-out');
  });

  it('makes a password user without a second factor set one up', () => {
    expect(authStep({ hasSession: true, currentLevel: 'aal1', nextLevel: 'aal1', methods: password })).toBe('enroll-mfa');
  });

  it('asks a password user with a second factor for the code', () => {
    expect(authStep({ hasSession: true, currentLevel: 'aal1', nextLevel: 'aal2', methods: password })).toBe('verify-mfa');
  });

  it('lets a verified password user in', () => {
    expect(
      authStep({ hasSession: true, currentLevel: 'aal2', nextLevel: 'aal2', methods: [{ method: 'totp' }, ...password] }),
    ).toBe('ready');
  });

  it('lets a Google user in without TOTP', () => {
    expect(authStep({ hasSession: true, currentLevel: 'aal1', nextLevel: 'aal1', methods: [{ method: 'oauth' }] })).toBe('ready');
  });
});
