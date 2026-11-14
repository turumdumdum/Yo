import type { Answers, RiskResult } from '@app/shared';
import { NotADraftError, UnauthorizedError, type DraftRecord, type RequestStore, type SubmittedRecord } from './requests';

export interface SupabaseConfig {
  /** Project URL, for example https://abc.supabase.co */
  url: string;
  /** Publishable (anon) key: identifies the project, used together with the user's token. */
  publishableKey: string;
  /** Secret (service role) key: bypasses RLS. Backend only. */
  serviceRoleKey: string;
}

/** Talks to Supabase's REST API with fetch, so it runs on Workers and Node alike. */
export function supabaseRequestStore(config: SupabaseConfig, fetchImpl: typeof fetch = fetch): RequestStore {
  const rest = `${config.url.replace(/\/+$/, '')}/rest/v1`;

  return {
    async getAsUser(accessToken, requestId): Promise<DraftRecord | null> {
      const query = new URLSearchParams({ id: `eq.${requestId}`, select: 'id,status,answers' });
      const res = await fetchImpl(`${rest}/requests?${query}`, {
        headers: { apikey: config.publishableKey, authorization: `Bearer ${accessToken}` },
      });
      if (res.status === 401 || res.status === 403) throw new UnauthorizedError();
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading a request`);
      const rows = (await res.json()) as DraftRecord[];
      return rows[0] ?? null;
    },

    async submit(requestId: string, answers: Answers, risk: RiskResult): Promise<SubmittedRecord> {
      const res = await fetchImpl(`${rest}/rpc/submit_request`, {
        method: 'POST',
        headers: {
          apikey: config.serviceRoleKey,
          authorization: `Bearer ${config.serviceRoleKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          p_request_id: requestId,
          p_answers: answers,
          p_risk_tier: risk.tier,
          p_risk_score: risk.score,
          p_risk_reasons: risk.reasons,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        if (body?.message?.includes('not a draft')) throw new NotADraftError();
        throw new Error(`Supabase responded ${res.status} when submitting a request`);
      }
      return (await res.json()) as SubmittedRecord;
    },
  };
}
