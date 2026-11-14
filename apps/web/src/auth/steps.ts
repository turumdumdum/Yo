import { isStrongSession } from '@app/shared';

export type AuthStep = 'signed-out' | 'enroll-mfa' | 'verify-mfa' | 'ready';

export interface AuthState {
  hasSession: boolean;
  /** Assurance level of the current session. */
  currentLevel: string | null;
  /** Level the session can reach; aal2 when the user has a verified second factor. */
  nextLevel: string | null;
  methods: readonly { method: string }[];
}

/** Decides which screen a visitor must pass before reaching the app. */
export function authStep({ hasSession, currentLevel, nextLevel, methods }: AuthState): AuthStep {
  if (!hasSession) return 'signed-out';
  if (isStrongSession({ aal: currentLevel, methods })) return 'ready';
  return nextLevel === 'aal2' ? 'verify-mfa' : 'enroll-mfa';
}
