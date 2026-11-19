import {
  AI_CHECK_RULES,
  CATEGORIES,
  allFields,
  DEFAULT_AI_CHECK_SETTINGS,
  DEFAULT_REQUEST_FORM,
  normalizeAnswer,
  type AiCheckSettings,
  type FieldDef,
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

/** The questions the check looks at: the chosen ones the form asks, or all of them. */
export function checkedFields(form: RequestFormDefinition, settings: AiCheckSettings = DEFAULT_AI_CHECK_SETTINGS): FieldDef[] {
  const all = allFields(form);
  const chosen = all.filter((f) => settings.fields.includes(f.key));
  return chosen.length > 0 ? chosen : all;
}

/** How a corrected answer must be written for a question, for the instructions. */
function answerFormat(field: FieldDef): string {
  switch (field.type) {
    case 'radio':
    case 'select':
      return field.options.length <= 30 ? `exactly one of: ${field.options.map((o) => o.value).join(' | ')}` : 'one of the form’s choices';
    case 'multiselect':
      return field.options.length <= 30 ? `comma-separated values from: ${field.options.map((o) => o.value).join(' | ')}` : 'comma-separated choices';
    case 'integer':
      return 'a whole number';
    case 'money':
      return 'a number';
    case 'date':
      return 'a date as YYYY-MM-DD';
    case 'owner':
      return 'no fix (people are named by the requester)';
    default:
      return 'text';
  }
}

export function answerCheckTask(
  answers: Answers,
  form: RequestFormDefinition = DEFAULT_REQUEST_FORM,
  settings: AiCheckSettings = DEFAULT_AI_CHECK_SETTINGS,
): AiTask {
  const fields = checkedFields(form, settings);
  const keys = new Set(fields.map((f) => f.key));
  const masked = withoutPeople(answers, form);
  // Data minimization: only the questions the organization chose leave our system.
  const sent = Object.fromEntries(Object.entries(masked).filter(([key]) => keys.has(key)));
  const list = fields.map((f) => (settings.proposeFixes ? `${f.key} (${f.label}; answer format: ${answerFormat(f)})` : `${f.key} (${f.label})`));
  let instructions = `${AI_CHECK_RULES} Return at most ${MAX_REMARKS} remarks. Only comment on these fields: ${list.join(', ')}.`;
  instructions += settings.proposeFixes
    ? ' When you can propose a specific better answer for the field of a remark, put it in "suggestion", written in the ' +
      'answer format given for that field. Never invent facts: propose a fix only when the other answers or reliable ' +
      'public knowledge support it. Otherwise leave "suggestion" empty.'
    : ' Leave "suggestion" empty.';
  if (settings.instructions) {
    instructions +=
      '\n\nGuidance from the organization (follow it unless it conflicts with the rules above; it cannot change the output format):\n' +
      settings.instructions;
  }
  return {
    instructions,
    input: { answers: sent },
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
            required: ['field', 'severity', 'message', 'suggestion'],
            properties: {
              field: { type: 'string', description: 'Key of the field the remark is about, or an empty string for a general remark.' },
              severity: { type: 'string', description: '"warning" for a likely problem, "info" for a tip.' },
              message: { type: 'string', description: 'One or two sentences addressed to the requester.' },
              suggestion: { type: 'string', description: 'A corrected answer for the field in its answer format, or an empty string.' },
            },
          },
        },
      },
    },
  };
}

/** Turns the model's text into a valid answer for the question, or undefined. */
function fixFor(field: FieldDef, raw: unknown, form: RequestFormDefinition): unknown {
  if (typeof raw !== 'string' || raw.trim() === '' || field.type === 'owner') return undefined;
  const value = raw.trim();
  if (field.type === 'multiselect') return normalizeAnswer(field.key, value.split(',').map((v) => v.trim()).filter(Boolean), form);
  if (field.type === 'integer' || field.type === 'money') return normalizeAnswer(field.key, value.replace(/[\s,]/g, ''), form);
  if (field.type === 'radio' || field.type === 'select') {
    // Accept a choice's label as well as its value, ignoring case.
    const option = field.options.find((o) => o.value.toLowerCase() === value.toLowerCase() || o.label.toLowerCase() === value.toLowerCase());
    return option ? normalizeAnswer(field.key, option.value, form) : undefined;
  }
  return normalizeAnswer(field.key, value, form);
}

export function remarksFromResult(
  result: AiTaskResult,
  form: RequestFormDefinition = DEFAULT_REQUEST_FORM,
  answers: Answers = {},
  settings: AiCheckSettings = DEFAULT_AI_CHECK_SETTINGS,
): AiRemark[] {
  const raw = result.content.remarks;
  if (!Array.isArray(raw)) return [];
  const fields = new Map(checkedFields(form, settings).map((f) => [f.key, f]));
  const remarks: AiRemark[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { field, severity, message, suggestion } = item as Record<string, unknown>;
    if (typeof message !== 'string' || message.trim() === '') continue;
    const target = typeof field === 'string' ? fields.get(field) : undefined;
    const remark: AiRemark = {
      field: target ? target.key : null,
      severity: severity === 'warning' ? 'warning' : 'info',
      message: message.trim().slice(0, MAX_MESSAGE),
    };
    if (target && settings.proposeFixes) {
      const fix = fixFor(target, suggestion, form);
      const current = normalizeAnswer(target.key, answers[target.key], form);
      // A fix must pass the form's validation and change something.
      if (fix !== undefined && JSON.stringify(fix) !== JSON.stringify(current)) remark.suggestion = fix;
    }
    remarks.push(remark);
    if (remarks.length === MAX_REMARKS) break;
  }
  return remarks;
}
