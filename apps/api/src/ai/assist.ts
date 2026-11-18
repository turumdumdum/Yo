import {
  CATEGORIES,
  allFields,
  DEFAULT_REQUEST_FORM,
  fieldLabel,
  normalizeAnswer,
  type AiRemark,
  type AiSource,
  type AiSuggestion,
  type Answers,
  type RequestFormDefinition,
} from '@app/shared';
import type { AiTask, AiTaskResult } from './provider';

// What we ask the AI plugin, and how its answers are checked before they reach the user.
// Model output is untrusted: every suggested value goes through the same validation as
// a typed answer, and nothing is ever written to the request by the backend.

const MAX_REASON = 300;
const MAX_MESSAGE = 400;
const MAX_REMARKS = 8;
const MAX_SOURCES = 3;

/** Fields the vendor lookup may suggest. */
const SUGGESTED_FIELDS = ['vendorWebsite', 'vendorLegalEntity', 'vendorCountry', 'category', 'dataLocation', 'vendorUsesAi'] as const;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Returns null when there is not enough to look a vendor up. */
export function vendorLookupTask(answers: Answers): AiTask | null {
  const serviceName = text(answers.serviceName);
  const vendorName = text(answers.vendorName);
  if (!serviceName && !vendorName) return null;
  const unknown = 'Use an empty string when it cannot be established from reliable public sources.';
  return {
    instructions:
      'Find public facts about a software vendor and its service for a vendor due-diligence request. ' +
      'Use only reliable public sources such as the vendor website, trust center, legal pages and company registries. ' +
      'Do not guess: leave a field empty rather than inventing a value.',
    // Only what is needed to identify the vendor leaves our system.
    input: { service_name: serviceName, vendor_name: vendorName, vendor_website: text(answers.vendorWebsite) },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [...SUGGESTED_FIELDS],
      properties: {
        vendorWebsite: { type: 'string', description: `Official website of the vendor, starting with https://. ${unknown}` },
        vendorLegalEntity: {
          type: 'string',
          description: `Full registered legal name of the company that sells the service, for example "Acme Inc.". ${unknown}`,
        },
        vendorCountry: {
          type: 'string',
          description: `ISO 3166-1 alpha-2 code of the country where that legal entity is registered, for example "US". ${unknown}`,
        },
        category: { type: 'string', description: `The best fitting category, exactly one of: ${CATEGORIES.join('; ')}. ${unknown}` },
        dataLocation: {
          type: 'string',
          description: `Where the vendor stores and processes customer data, for example "EU (Frankfurt)" or "United States". ${unknown}`,
        },
        vendorUsesAi: {
          type: 'string',
          description:
            'Whether the vendor applies AI or machine learning to customer data: exactly "Yes", "No" or "Unknown".',
        },
      },
    },
  };
}

function cleanSources(sources: { url: string; title: string | null }[]): AiSource[] {
  return sources
    .filter((s) => typeof s.url === 'string' && /^https?:\/\/\S+$/i.test(s.url))
    .slice(0, MAX_SOURCES)
    .map((s) => ({ url: s.url, title: typeof s.title === 'string' ? s.title.slice(0, 120) : null }));
}

/** Keeps only valid values that differ from what the requester already entered. */
export function suggestionsFromResult(
  result: AiTaskResult,
  answers: Answers,
  form: RequestFormDefinition = DEFAULT_REQUEST_FORM,
): AiSuggestion[] {
  const suggestions: AiSuggestion[] = [];
  for (const field of SUGGESTED_FIELDS) {
    const raw = result.content[field];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    // "Unknown" is the default answer nobody needs suggested.
    if (field === 'vendorUsesAi' && raw.trim() === 'Unknown') continue;
    // Fields the organization's form does not have are skipped.
    const value = normalizeAnswer(field, field === 'vendorCountry' ? raw.trim().toUpperCase() : raw, form);
    if (value === undefined || value === normalizeAnswer(field, answers[field], form)) continue;
    const basis = result.basis.find((b) => b.field === field);
    suggestions.push({
      field,
      value,
      reason: (basis?.reasoning ?? '').trim().slice(0, MAX_REASON),
      sources: cleanSources(basis?.sources ?? []),
    });
  }
  return suggestions;
}

/** Owner fields hold names and emails of colleagues: the AI only learns whether they are filled in. */
function withoutPeople(answers: Answers, form: RequestFormDefinition): Answers {
  const copy: Answers = { ...answers };
  for (const field of allFields(form)) {
    if (field.type !== 'owner') continue;
    const owner = copy[field.key] as { name?: string; notRequired?: boolean } | undefined;
    copy[field.key] = owner?.notRequired ? 'Not required' : owner?.name ? 'Named' : 'Not answered';
  }
  return copy;
}

export function answerCheckTask(answers: Answers, form: RequestFormDefinition = DEFAULT_REQUEST_FORM): AiTask {
  const fields = allFields(form).map((f) => `${f.key} (${f.label})`);
  return {
    instructions:
      'Review the answers of an internal request to buy or use a vendor service, before it goes to security, legal, ' +
      'finance and IT reviewers. Point out answers that contradict each other, look implausible for this vendor, or are ' +
      'too vague for a reviewer to act on. Be specific and brief. Do not repeat answers back, do not comment on fields ' +
      `that look fine, and return at most ${MAX_REMARKS} remarks. Return an empty list when nothing stands out. ` +
      `Field keys: ${fields.join(', ')}.`,
    input: { answers: withoutPeople(answers, form) },
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['remarks'],
      properties: {
        remarks: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['field', 'severity', 'message'],
            properties: {
              field: { type: 'string', description: 'Key of the field the remark is about, or an empty string for a general remark.' },
              severity: { type: 'string', description: '"warning" for a likely problem, "info" for a tip.' },
              message: { type: 'string', description: 'One or two sentences addressed to the requester.' },
            },
          },
        },
      },
    },
  };
}

export function remarksFromResult(result: AiTaskResult, form: RequestFormDefinition = DEFAULT_REQUEST_FORM): AiRemark[] {
  const raw = result.content.remarks;
  if (!Array.isArray(raw)) return [];
  const remarks: AiRemark[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { field, severity, message } = item as Record<string, unknown>;
    if (typeof message !== 'string' || message.trim() === '') continue;
    remarks.push({
      field: typeof field === 'string' && fieldLabel(field, form) ? field : null,
      severity: severity === 'warning' ? 'warning' : 'info',
      message: message.trim().slice(0, MAX_MESSAGE),
    });
    if (remarks.length === MAX_REMARKS) break;
  }
  return remarks;
}
