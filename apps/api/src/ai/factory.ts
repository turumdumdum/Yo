import { anthropicProvider } from './anthropic';
import { openAiProvider } from './openai';
import { parallelProvider } from './parallel';
import type { AiProvider } from './provider';

// Builds the configured AI provider. Off unless named; the core never needs it.

export const AI_PROVIDER_NAMES = ['off', 'parallel', 'anthropic', 'openai', 'openai_compatible'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_NAMES)[number];

export interface AiProviderSettings {
  provider: AiProviderKind;
  apiKey?: string;
  /** Parallel only: lite, base or core. */
  processor?: string;
  /** Anthropic, OpenAI and compatible servers. */
  model?: string;
  /** Parallel (optional) and OpenAI-compatible servers (required). */
  baseUrl?: string;
  /** How long one answer may take; the provider default when absent. */
  timeoutSeconds?: number;
}

/** Whether these settings are complete enough to call the provider. */
export function aiConfigured(s: AiProviderSettings): boolean {
  switch (s.provider) {
    case 'parallel':
    case 'anthropic':
      return !!s.apiKey;
    case 'openai':
      return !!s.apiKey && !!s.model;
    case 'openai_compatible':
      return !!s.baseUrl && !!s.model;
    default:
      return false;
  }
}

export function buildAiProvider(s: AiProviderSettings, fetchImpl: typeof fetch = fetch): AiProvider | undefined {
  if (!aiConfigured(s)) return undefined;
  const timeoutMs = s.timeoutSeconds ? s.timeoutSeconds * 1000 : undefined;
  switch (s.provider) {
    case 'parallel':
      return parallelProvider({ apiKey: s.apiKey!, processor: s.processor, baseUrl: s.baseUrl, timeoutMs }, fetchImpl);
    case 'anthropic':
      return anthropicProvider({ apiKey: s.apiKey!, model: s.model, fetchImpl, timeoutMs });
    case 'openai':
      return openAiProvider({ apiKey: s.apiKey, model: s.model!, name: 'OpenAI', timeoutMs }, fetchImpl);
    case 'openai_compatible':
      return openAiProvider({ apiKey: s.apiKey, model: s.model!, baseUrl: s.baseUrl, strictSchema: false, name: providerHostName(s.baseUrl!), timeoutMs }, fetchImpl);
    default:
      return undefined;
  }
}

/** Shown to users so they know where data goes, e.g. "localhost:11434". */
function providerHostName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'AI server';
  }
}
