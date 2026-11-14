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
}

export interface AiStatus {
  enabled: boolean;
  /** Display name of the configured provider, for the disclosure next to the buttons. */
  provider: string | null;
}
