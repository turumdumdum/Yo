// UpGuard vendor rating lookup (optional integration).
//
// UNVERIFIED: the endpoint, the auth header and the response field names below follow
// UpGuard's public CyberRisk API as we understand it; its documentation could not be
// reached from the environment this was written in. Confirm them against the current
// UpGuard API documentation before relying on the integration. The base URL is
// configurable (UPGUARD_BASE_URL) and the parser accepts several field spellings.

export interface VendorRating {
  name: string | null;
  hostname: string;
  score: number | null;
  categories: { name: string; score: number }[];
  fetchedAt: string;
}

export class UpGuardError extends Error {}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Turns UpGuard's vendor JSON into our snapshot, tolerating missing or renamed fields. */
export function parseUpGuardVendor(body: unknown, hostname: string, now = new Date()): VendorRating {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const cats = (b.categoryScores ?? b.category_scores) as unknown;
  const categories: VendorRating['categories'] = [];
  if (cats && typeof cats === 'object' && !Array.isArray(cats)) {
    for (const [name, value] of Object.entries(cats as Record<string, unknown>)) {
      const score = num(value);
      if (score !== null) categories.push({ name: name.slice(0, 80), score });
    }
  }
  return {
    name: typeof b.name === 'string' ? b.name.slice(0, 200) : null,
    hostname: typeof b.primary_hostname === 'string' ? b.primary_hostname.slice(0, 253) : hostname,
    score: num(b.score) ?? num(b.overallScore) ?? num(b.automatedScore),
    categories: categories.slice(0, 30),
    fetchedAt: now.toISOString(),
  };
}

/** Host name of a website answer such as "https://www.acme.com/x" -> "acme.com". */
export function hostnameOf(website: unknown): string | null {
  if (typeof website !== 'string' || website.trim() === '') return null;
  const m = website.trim().match(/^(?:https?:\/\/)?([^/:?#\s]+)/i);
  const host = m?.[1]?.toLowerCase().replace(/^www\./, '');
  return host && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

export async function lookupUpGuard(options: { baseUrl: string; apiKey: string; hostname: string; fetchImpl?: typeof fetch; now?: Date }): Promise<VendorRating> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/vendor?${new URLSearchParams({ hostname: options.hostname })}`;
  let res: Response;
  try {
    res = await (options.fetchImpl ?? fetch)(url, { headers: { authorization: options.apiKey, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new UpGuardError('UpGuard could not be reached');
  }
  if (res.status === 401 || res.status === 403) throw new UpGuardError('UpGuard refused the API key');
  if (res.status === 404) throw new UpGuardError(`UpGuard has no vendor for ${options.hostname}`);
  if (!res.ok) throw new UpGuardError(`UpGuard answered ${res.status}`);
  return parseUpGuardVendor(await res.json().catch(() => ({})), options.hostname, options.now);
}
