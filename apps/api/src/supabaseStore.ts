import type { Answers, OrgRole, PlannedStage, ReviewTemplate, RiskResult } from '@app/shared';
import type { AdminStore, Caller } from './admin';
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
export function supabaseRequestStore(config: SupabaseConfig, fetchImpl: typeof fetch = fetch): RequestStore & AdminStore {
  const base = config.url.replace(/\/+$/, '');
  const rest = `${base}/rest/v1`;
  const service = { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, 'content-type': 'application/json' };

  return {
    async getAsUser(accessToken, requestId): Promise<DraftRecord | null> {
      const query = new URLSearchParams({ id: `eq.${requestId}`, select: 'id,org_id,status,answers' });
      const res = await fetchImpl(`${rest}/requests?${query}`, {
        headers: { apikey: config.publishableKey, authorization: `Bearer ${accessToken}` },
      });
      if (res.status === 401 || res.status === 403) throw new UnauthorizedError();
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading a request`);
      const rows = (await res.json()) as DraftRecord[];
      return rows[0] ?? null;
    },

    async getReviewTemplates(orgId: string): Promise<Record<string, unknown>> {
      const query = new URLSearchParams({ org_id: `eq.${orgId}`, select: 'stage_name,fields,rules' });
      const res = await fetchImpl(`${rest}/review_templates?${query}`, { headers: service });
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading review forms`);
      const rows = (await res.json()) as { stage_name: string; fields: unknown; rules: unknown }[];
      return Object.fromEntries(rows.map((r) => [r.stage_name, { fields: r.fields, rules: r.rules }]));
    },

    async getCaller(accessToken: string): Promise<Caller | null> {
      const userRes = await fetchImpl(`${base}/auth/v1/user`, {
        headers: { apikey: config.publishableKey, authorization: `Bearer ${accessToken}` },
      });
      if (userRes.status === 401 || userRes.status === 403) throw new UnauthorizedError();
      if (!userRes.ok) throw new Error(`Supabase responded ${userRes.status} when reading the user`);
      const user = (await userRes.json()) as { id: string };
      // Read with the caller's own token: RLS (and its MFA rule) applies.
      const query = new URLSearchParams({ user_id: `eq.${user.id}`, select: 'org_id,role', limit: '1' });
      const res = await fetchImpl(`${rest}/memberships?${query}`, {
        headers: { apikey: config.publishableKey, authorization: `Bearer ${accessToken}` },
      });
      if (res.status === 401 || res.status === 403) throw new UnauthorizedError();
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading the membership`);
      const rows = (await res.json()) as { org_id: string; role: OrgRole }[];
      return rows[0] ? { userId: user.id, orgId: rows[0].org_id, role: rows[0].role } : null;
    },

    async saveReviewTemplate(orgId: string, stage: string, template: ReviewTemplate | null, actorId: string): Promise<void> {
      const res =
        template === null
          ? await fetchImpl(`${rest}/review_templates?${new URLSearchParams({ org_id: `eq.${orgId}`, stage_name: `eq.${stage}` })}`, {
              method: 'DELETE',
              headers: service,
            })
          : await fetchImpl(`${rest}/review_templates?on_conflict=org_id,stage_name`, {
              method: 'POST',
              headers: { ...service, prefer: 'resolution=merge-duplicates' },
              body: JSON.stringify({
                org_id: orgId,
                stage_name: stage,
                fields: template.fields,
                rules: template.rules,
                updated_by: actorId,
                updated_at: new Date().toISOString(),
              }),
            });
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when saving a review form`);
      const audit = await fetchImpl(`${rest}/audit_log`, {
        method: 'POST',
        headers: service,
        body: JSON.stringify({
          org_id: orgId,
          actor_id: actorId,
          action: template === null ? 'review_form.reset' : 'review_form.updated',
          entity_type: 'review_form',
          entity_id: stage,
          metadata: template === null ? {} : { fields: template.fields.length, rules: template.rules.length },
        }),
      });
      if (!audit.ok) throw new Error(`Supabase responded ${audit.status} when writing the audit log`);
    },

    async submit(requestId: string, answers: Answers, risk: RiskResult, stages: PlannedStage[]): Promise<SubmittedRecord> {
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
          p_stages: stages.map((stage) => ({
            name: stage.name,
            status: stage.status,
            note: stage.note,
            sla_business_days: stage.slaBusinessDays,
            sla_due_at: stage.slaDueAt,
            checklist: stage.checklist,
            review_fields: stage.reviewFields,
            review_rules: stage.reviewRules,
          })),
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
