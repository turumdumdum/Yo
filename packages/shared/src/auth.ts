import { z } from 'zod';

// Sign-in rules shared by the frontend and tests (CLAUDE.md §8).

/** bcrypt, used by Supabase Auth, ignores everything after 72 bytes. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 72;

const emailSchema = z.email('Enter a valid email address').max(254).transform((v) => v.toLowerCase());

export const signInSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password').max(PASSWORD_MAX_LENGTH),
});

export const signUpSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
    .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters`),
});

export const totpCodeSchema = z
  .string()
  .transform((v) => v.replace(/\s+/g, ''))
  .pipe(z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from your authenticator app'));

export interface SessionAssurance {
  /** Authenticator assurance level of the current session. */
  aal: string | null | undefined;
  /** Authentication methods used in the current session. */
  methods: readonly { method: string }[];
}

/**
 * A session may touch tenant data only after a second factor (aal2) or when it was
 * started with an OAuth provider (Google), which carries its own MFA.
 * Keep in sync with private.session_is_strong() in supabase/migrations.
 */
export function isStrongSession({ aal, methods }: SessionAssurance): boolean {
  return aal === 'aal2' || methods.some((m) => m.method === 'oauth');
}
