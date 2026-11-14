// The optional AI plugin (CLAUDE.md §2). The core never depends on it: without a
// configured provider the endpoints answer "disabled" and the UI shows no AI buttons.
//
// A provider only has to run one kind of job: take instructions and some input, and
// return JSON that matches a schema. Everything product-specific (what we ask, how
// answers are validated) lives in assist.ts, so any model or research API can be
// plugged in by implementing this interface.

export interface AiTask {
  /** What to do, in plain English. */
  instructions: string;
  /** The data to work on. Never contains attachments. */
  input: Record<string, unknown>;
  /** JSON Schema of the expected output object. */
  outputSchema: Record<string, unknown>;
}

export interface AiFieldBasis {
  field: string;
  reasoning: string;
  sources: { url: string; title: string | null }[];
}

export interface AiTaskResult {
  content: Record<string, unknown>;
  /** Per-field reasoning and sources, when the provider supplies them. */
  basis: AiFieldBasis[];
}

export interface AiProvider {
  /** Name shown to users, so they know where their data goes. */
  readonly name: string;
  run(task: AiTask): Promise<AiTaskResult>;
}

/** The provider failed or took too long. The message is safe to show to users. */
export class AiProviderError extends Error {}
