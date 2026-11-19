// Shapes exchanged between the API and the web app for the optional AI plugin
// (CLAUDE.md §2: off by default, never required, suggestions need confirmation).

export interface AiSource {
  url: string;
  title: string | null;
}

/** A proposed value for one form field. Never applied without the user's confirmation. */
export interface AiSuggestion {
  field: string;
  value: unknown;
  reason: string;
  sources: AiSource[];
}

/** A remark about the answers. Remarks never block submission. */
export interface AiRemark {
  /** Form field the remark is about, or null for a general remark. */
  field: string | null;
  severity: 'info' | 'warning';
  message: string;
  /** A corrected answer for `field`, already validated like a typed answer. Applied only if the requester accepts it. */
  suggestion?: unknown;
}

export interface AiStatus {
  enabled: boolean;
  /** Display name of the configured provider, for the disclosure next to the buttons. */
  provider: string | null;
}

/** How the AI check at the end of the request form works in an organization. */
export interface AiCheckSettings {
  /** Extra guidance from the organization, added after the fixed rules. */
  instructions: string;
  /** Keys of the questions the AI looks at; empty means every question. Only these answers are sent. */
  fields: string[];
  /** Whether the AI proposes corrected answers the requester can accept. */
  proposeFixes: boolean;
}

export const DEFAULT_AI_CHECK_SETTINGS: AiCheckSettings = { instructions: '', fields: [], proposeFixes: true };

export const AI_SETTINGS_LIMITS = { instructions: 4000, fields: 200 } as const;

/** What the AI is always told for the answer check. Organization guidance cannot replace it. */
export const AI_CHECK_RULES =
  'Review the answers of an internal request to buy or use a vendor service, before it goes to security, legal, ' +
  'finance and IT reviewers. Point out answers that contradict each other, look implausible for this vendor, or are ' +
  'too vague for a reviewer to act on. Be specific and brief. Do not repeat answers back and do not comment on fields ' +
  'that look fine. Return an empty list when nothing stands out.';

/** Checks settings sent by an admin. */
export function parseAiCheckSettings(input: unknown): { settings: AiCheckSettings } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Expected AI settings' };
  const raw = input as Record<string, unknown>;
  const extra = Object.keys(raw).find((k) => !['instructions', 'fields', 'proposeFixes'].includes(k));
  if (extra) return { error: `Unknown setting “${extra}”` };
  if (typeof raw.instructions !== 'string') return { error: 'The instructions must be text' };
  const instructions = raw.instructions.trim();
  if (instructions.length > AI_SETTINGS_LIMITS.instructions) {
    return { error: `Use at most ${AI_SETTINGS_LIMITS.instructions} characters for the instructions` };
  }
  if (!Array.isArray(raw.fields) || raw.fields.length > AI_SETTINGS_LIMITS.fields) return { error: 'Choose the questions to check' };
  if (raw.fields.some((f) => typeof f !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/.test(f))) return { error: 'A chosen question is unknown' };
  if (typeof raw.proposeFixes !== 'boolean') return { error: 'Choose whether the AI proposes fixes' };
  return { settings: { instructions, fields: [...new Set(raw.fields as string[])], proposeFixes: raw.proposeFixes } };
}
