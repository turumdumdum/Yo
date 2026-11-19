import { z } from 'zod';
import { ORG_ROLES } from './domain';

// Server-side input validation shared with the frontend (CLAUDE.md §12).

export const orgRoleSchema = z.enum(ORG_ROLES);

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(2).max(120),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const createInvitationSchema = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  role: orgRoleSchema,
});
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

