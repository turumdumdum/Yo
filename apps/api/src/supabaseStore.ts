import { ATTACHMENT_BUCKET, type AiCheckSettings, type ConfigRequirement, type SecurityBaseline, type Answers, type OrgRole, type PlannedStage, type ReviewTemplate, type RiskResult, type WorkflowSettings } from '@app/shared';
import type { AdminStore, Caller, SavedFormInput } from './admin';
import { InvitationRefused, type InvitationResult, type InvitationStore } from './invitations';
import { NotADraftError, UnauthorizedError, type DraftRecord, type RequestStore, type SubmittedRecord, type Visibility } from './requests';

export interface SupabaseConfig {
  /** Project URL, for example https://abc.supabase.co */
  url: string;
  /** Publishable (anon) key: identifies the project, used together with the user's token. */
  publishableKey: string;
  /** Secret (service role) key: bypasses RLS. Backend only. */
  serviceRoleKey: string;
}

/** Talks to Supabase's REST API with fetch, so it runs on Workers and Node alike. */
export function supabaseRequestStore(config: SupabaseConfig, fetchImpl: typeof fetch = fetch): RequestStore & AdminStore & InvitationStore {
  const base = config.url.replace(/\/+$/, '');
  const rest = `${base}/rest/v1`;
  const service = { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, 'content-type': 'application/json' };

  async function audit(orgId: string, actorId: string, action: string, entityId: string, metadata: Record<string, unknown>) {
    const res = await fetchImpl(`${rest}/audit_log`, {
      method: 'POST',
      headers: service,
      body: JSON.stringify({ org_id: orgId, actor_id: actorId, action, entity_type: 'request_form', entity_id: entityId, metadata }),
    });
    if (!res.ok) throw new Error(`Supabase responded ${res.status} when writing the audit log`);
  }

  return {
    async getAsUser(accessToken, requestId): Promise<DraftRecord | null> {
      const query = new URLSearchParams({ id: `eq.${requestId}`, select: 'id,org_id,status,answers,form' });
      const res = await fetchImpl(`${rest}/requests?${query}`, {
        headers: { apikey: config.publishableKey, authorization: `Bearer ${accessToken}` },
      });
      if (res.status === 401 || res.status === 403) throw new UnauthorizedError();
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading a request`);
      const rows = (await res.json()) as DraftRecord[];
      return rows[0] ?? null;
    },

    async purgeRequest(requestId: string, actorId: string) {
      const res = await fetchImpl(`${rest}/rpc/purge_request`, {
        method: 'POST',
        headers: service,
        body: JSON.stringify({ p_request_id: requestId, p_actor: actorId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        const message = body?.message ?? '';
        if (message.includes('request not found')) return 'not-found' as const;
        if (message.includes('only an org admin')) return 'forbidden' as const;
        if (message.includes('trash first')) return 'not-in-trash' as const;
        throw new Error(`Supabase responded ${res.status} when deleting a request`);
      }
      return (await res.json()) as string[];
    },

    async removeAttachmentFiles(paths: string[]): Promise<void> {
      const res = await fetchImpl(`${base}/storage/v1/object/${ATTACHMENT_BUCKET}`, {
        method: 'DELETE',
        headers: service,
        body: JSON.stringify({ prefixes: paths }),
      });
      if (!res.ok) throw new Error(`Supabase storage responded ${res.status} when removing files`);
    },

    async getSecurityBaseline(orgId: string): Promise<unknown> {
      const res = await fetchImpl(`${rest}/security_baselines?${new URLSearchParams({ org_id: `eq.${orgId}`, select: 'controls' })}`, { headers: service });
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading the security baseline`);
      const rows = (await res.json()) as { controls: unknown }[];
      return rows[0] ? { controls: rows[0].controls } : null;
    },

    async saveSecurityBaseline(orgId: string, baseline: SecurityBaseline | null, actorId: string): Promise<void> {
      const res =
        baseline === null
          ? await fetchImpl(`${rest}/security_baselines?${new URLSearchParams({ org_id: `eq.${orgId}` })}`, { method: 'DELETE', headers: service })
          : await fetchImpl(`${rest}/security_baselines?on_conflict=org_id`, {
              method: 'POST',
              headers: { ...service, prefer: 'resolution=merge-duplicates' },
              body: JSON.stringify({ org_id: orgId, controls: baseline.controls, updated_by: actorId, updated_at: new Date().toISOString() }),
            });
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when saving the security baseline`);
      const audit = await fetchImpl(`${rest}/audit_log`, {
        method: 'POST',
        headers: service,
        body: JSON.stringify({
          org_id: orgId,
          actor_id: actorId,
          action: baseline === null ? 'security_baseline.reset' : 'security_baseline.updated',
          entity_type: 'security_baseline',
          entity_id: orgId,
          metadata: baseline === null ? {} : { controls: baseline.controls.length, required: baseline.controls.filter((c) => c.level === 'required').length },
        }),
      });
      if (!audit.ok) throw new Error(`Supabase responded ${audit.status} when writing the audit log`);
    },

    async getAiSettings(orgId: string): Promise<unknown> {
      const res = await fetchImpl(`${rest}/ai_settings?${new URLSearchParams({ org_id: `eq.${orgId}`, select: 'check_settings' })}`, { headers: service });
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading AI settings`);
      const rows = (await res.json()) as { check_settings: unknown }[];
      return rows[0]?.check_settings ?? null;
    },

    async saveAiSettings(orgId: string, settings: AiCheckSettings | null, actorId: string): Promise<void> {
      const res =
        settings === null
          ? await fetchImpl(`${rest}/ai_settings?${new URLSearchParams({ org_id: `eq.${orgId}` })}`, { method: 'DELETE', headers: service })
          : await fetchImpl(`${rest}/ai_settings?on_conflict=org_id`, {
              method: 'POST',
              headers: { ...service, prefer: 'resolution=merge-duplicates' },
              body: JSON.stringify({ org_id: orgId, check_settings: settings, updated_by: actorId, updated_at: new Date().toISOString() }),
            });
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when saving AI settings`);
      const audit = await fetchImpl(`${rest}/audit_log`, {
        method: 'POST',
        headers: service,
        body: JSON.stringify({
          org_id: orgId,
          actor_id: actorId,
          action: settings === null ? 'ai_settings.reset' : 'ai_settings.updated',
          entity_type: 'ai_settings',
          entity_id: orgId,
          // The instructions themselves are kept in ai_settings; the log records the change.
          metadata: settings === null ? {} : { fields: settings.fields.length, propose_fixes: settings.proposeFixes, instructions_length: settings.instructions.length },
        }),
      });
      if (!audit.ok) throw new Error(`Supabase responded ${audit.status} when writing the audit log`);
    },

    async getWorkflowSettings(orgId: string): Promise<unknown> {
      const res = await fetchImpl(`${rest}/workflow_settings?${new URLSearchParams({ org_id: `eq.${orgId}`, select: 'stages' })}`, { headers: service });
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading review settings`);
      const rows = (await res.json()) as { stages: unknown }[];
      return rows[0]?.stages ?? null;
    },

    async saveWorkflowSettings(orgId: string, settings: WorkflowSettings | null, actorId: string): Promise<void> {
      const res =
        settings === null
          ? await fetchImpl(`${rest}/workflow_settings?${new URLSearchParams({ org_id: `eq.${orgId}` })}`, { method: 'DELETE', headers: service })
          : await fetchImpl(`${rest}/workflow_settings?on_conflict=org_id`, {
              method: 'POST',
              headers: { ...service, prefer: 'resolution=merge-duplicates' },
              body: JSON.stringify({ org_id: orgId, stages: settings, updated_by: actorId, updated_at: new Date().toISOString() }),
            });
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when saving review settings`);
      const audit = await fetchImpl(`${rest}/audit_log`, {
        method: 'POST',
        headers: service,
        body: JSON.stringify({
          org_id: orgId,
          actor_id: actorId,
          action: settings === null ? 'workflow.reset' : 'workflow.updated',
          entity_type: 'workflow',
          entity_id: orgId,
          metadata: settings === null ? {} : { stages: Object.fromEntries(Object.entries(settings).map(([k, v]) => [k, v.requirement])) },
        }),
      });
      if (!audit.ok) throw new Error(`Supabase responded ${audit.status} when writing the audit log`);
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
      const user = (await userRes.json()) as { id: string; email?: string };
      // Read with the caller's own token: RLS (and its MFA rule) applies.
      const query = new URLSearchParams({ user_id: `eq.${user.id}`, select: 'org_id,role', limit: '1' });
      const res = await fetchImpl(`${rest}/memberships?${query}`, {
        headers: { apikey: config.publishableKey, authorization: `Bearer ${accessToken}` },
      });
      if (res.status === 401 || res.status === 403) throw new UnauthorizedError();
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading the membership`);
      const rows = (await res.json()) as { org_id: string; role: OrgRole }[];
      return rows[0] ? { userId: user.id, orgId: rows[0].org_id, role: rows[0].role, ...(user.email ? { email: user.email } : {}) } : null;
    },

    async createInvitations(accessToken: string, orgId: string, rows: { email: string; role: OrgRole }[]): Promise<InvitationResult[]> {
      // As the user: the database checks the org-admin role, MFA and domain rules.
      const res = await fetchImpl(`${rest}/rpc/create_invitations`, {
        method: 'POST',
        headers: { apikey: config.publishableKey, authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ p_org_id: orgId, p_invitations: rows }),
      });
      if (res.status === 401) throw new UnauthorizedError();
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as { message?: string } | null;
        if (res.status === 403 || res.status === 400) throw new InvitationRefused(detail?.message ?? 'The invitations were refused');
        throw new Error(`Supabase responded ${res.status} when creating invitations`);
      }
      return (await res.json()) as InvitationResult[];
    },

    async organizationName(orgId: string): Promise<string> {
      const res = await fetchImpl(`${rest}/organizations?${new URLSearchParams({ id: `eq.${orgId}`, select: 'name' })}`, { headers: service });
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading the organization`);
      const rows = (await res.json()) as { name: string }[];
      return rows[0]?.name ?? 'your organization';
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

    async createRequestForm(orgId: string, form: SavedFormInput, actorId: string) {
      const res = await fetchImpl(`${rest}/request_form_templates`, {
        method: 'POST',
        headers: { ...service, prefer: 'return=representation' },
        body: JSON.stringify({
          org_id: orgId,
          name: form.name,
          description: form.description,
          definition: form.definition,
          created_by: actorId,
          updated_by: actorId,
        }),
      });
      if (res.status === 409) return 'name-taken' as const;
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when saving a request form`);
      const [row] = (await res.json()) as { id: string }[];
      await audit(orgId, actorId, 'request_form.created', row!.id, { name: form.name });
      return { id: row!.id };
    },

    async updateRequestForm(orgId: string, id: string, form: SavedFormInput, actorId: string) {
      const res = await fetchImpl(`${rest}/request_form_templates?${new URLSearchParams({ id: `eq.${id}`, org_id: `eq.${orgId}` })}`, {
        method: 'PATCH',
        headers: { ...service, prefer: 'return=representation' },
        body: JSON.stringify({ name: form.name, description: form.description, definition: form.definition, updated_by: actorId }),
      });
      if (res.status === 409) return 'name-taken' as const;
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when saving a request form`);
      if (((await res.json()) as unknown[]).length === 0) return 'not-found' as const;
      await audit(orgId, actorId, 'request_form.updated', id, { name: form.name });
      return 'ok' as const;
    },

    async deleteRequestForm(orgId: string, id: string, actorId: string) {
      const res = await fetchImpl(`${rest}/request_form_templates?${new URLSearchParams({ id: `eq.${id}`, org_id: `eq.${orgId}` })}`, {
        method: 'DELETE',
        headers: { ...service, prefer: 'return=representation' },
      });
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when deleting a request form`);
      const rows = (await res.json()) as { name: string }[];
      if (rows.length === 0) return 'not-found' as const;
      await audit(orgId, actorId, 'request_form.deleted', id, { name: rows[0]!.name });
      return 'ok' as const;
    },

    async activateRequestForm(orgId: string, id: string | null, actorId: string) {
      const res = await fetchImpl(`${rest}/rpc/activate_request_form`, {
        method: 'POST',
        headers: service,
        body: JSON.stringify({ p_org_id: orgId, p_template_id: id }),
      });
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when activating a request form`);
      if (!((await res.json()) as boolean)) return 'not-found' as const;
      await audit(orgId, actorId, 'request_form.activated', id ?? 'standard', {});
      return 'ok' as const;
    },

    async submit(
      requestId: string,
      answers: Answers,
      risk: RiskResult,
      stages: PlannedStage[],
      visibility?: Visibility,
      configRequirements: ConfigRequirement[] = [],
    ): Promise<SubmittedRecord> {
      const controls = await fetchImpl(`${rest}/rpc/set_request_config_requirements`, {
        method: 'POST',
        headers: service,
        body: JSON.stringify({ p_request_id: requestId, p_items: configRequirements }),
      });
      if (!controls.ok) {
        const body = (await controls.json().catch(() => null)) as { message?: string } | null;
        if (body?.message?.includes('not a draft')) throw new NotADraftError();
        throw new Error(`Supabase responded ${controls.status} when recording the configuration controls`);
      }
      const visible = await fetchImpl(`${rest}/rpc/set_request_confidentiality`, {
        method: 'POST',
        headers: service,
        body: JSON.stringify({
          p_request_id: requestId,
          p_confidential: visibility?.confidential ?? false,
          p_business_owner_email: visibility?.businessOwnerEmail ?? null,
        }),
      });
      if (!visible.ok) {
        const body = (await visible.json().catch(() => null)) as { message?: string } | null;
        if (body?.message?.includes('not a draft')) throw new NotADraftError();
        throw new Error(`Supabase responded ${visible.status} when recording who may see a request`);
      }
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
