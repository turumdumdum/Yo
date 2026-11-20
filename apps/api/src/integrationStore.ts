import type { SupabaseConfig } from './supabaseStore';

// Service-role access to the integration tables (integration_settings, outbound_events,
// inbound_events, notification_cursors, vendor_risk_checks) and the data the dispatcher
// and the external review routes need. Never used with a user's token.

export const SLACK_EVENTS = ['request.submitted', 'request.approved', 'request.rejected', 'stage.decided', 'exception.requested', 'info_request.asked'] as const;
export type SlackEvent = (typeof SLACK_EVENTS)[number];

export interface IntegrationConfig {
  slack?: { enabled: boolean; events: SlackEvent[] };
  upguard?: { enabled: boolean };
  external?: { enabled: boolean; name: string; outboundUrl: string; sendAllAnswers: boolean };
}

export interface IntegrationSecrets {
  slackWebhookUrl?: string;
  upguardApiKey?: string;
  externalSecret?: string;
}

export interface IntegrationRecord {
  config: IntegrationConfig;
  /** Encrypted JSON of IntegrationSecrets, or null. */
  secrets: string | null;
}

export interface AuditRow {
  id: number;
  org_id: string;
  action: string;
  entity_id: string | null;
  metadata: Record<string, unknown>;
}

export interface OutboundRow {
  id: number;
  org_id: string;
  kind: 'slack' | 'external';
  payload: Record<string, unknown>;
  attempts: number;
}

export interface RequestInfo {
  id: string;
  org_id: string;
  service_name: string | null;
  is_confidential: boolean;
  risk_tier: string | null;
  risk_score: number | null;
  risk_reasons: string[] | null;
  request_type: string | null;
  submitted_at: string | null;
  answers: Record<string, unknown>;
  form: unknown;
  config_requirements: unknown[];
}

export interface StageInfo {
  id: string;
  org_id: string;
  request_id: string;
  name: string;
  status: string;
  sla_due_at: string | null;
  external: boolean;
}

export interface VendorRiskRow {
  id: string;
  request_id: string;
  source: 'upguard';
  hostname: string;
  data: Record<string, unknown>;
  fetched_at: string;
}

export interface IntegrationStore {
  getIntegration(orgId: string): Promise<IntegrationRecord | null>;
  saveIntegration(orgId: string, record: IntegrationRecord, actorId: string, action: string, metadata: Record<string, unknown>): Promise<void>;
  /** Moves the notifier to the end of the audit log, so enabling Slack does not replay history. */
  resetCursor(orgId: string): Promise<void>;
  orgsWithSlack(): Promise<string[]>;
  getCursor(orgId: string): Promise<number>;
  setCursor(orgId: string, lastAuditId: number): Promise<void>;
  auditAfter(orgId: string, afterId: number, limit: number): Promise<AuditRow[]>;
  requests(ids: string[]): Promise<RequestInfo[]>;
  enqueue(orgId: string, kind: 'slack' | 'external', payloads: Record<string, unknown>[]): Promise<void>;
  dueEvents(limit: number): Promise<OutboundRow[]>;
  /** Claims an event for delivery; false when another worker took it. */
  claim(row: OutboundRow, leaseUntil: Date): Promise<boolean>;
  markDelivered(id: number): Promise<void>;
  markRetry(id: number, attempts: number, nextAttemptAt: Date, error: string): Promise<void>;
  markFailed(id: number, attempts: number, error: string): Promise<void>;
  /** True when the event id is new for the organization. */
  recordInbound(orgId: string, eventId: string): Promise<boolean>;
  applyExternalStatus(
    orgId: string,
    stageId: string,
    update: { status: string; comment?: string; conditions?: string; external_id?: string; external_url?: string },
  ): Promise<'ok' | 'not_found' | 'closed'>;
  stage(orgId: string, stageId: string): Promise<StageInfo | null>;
  externalStages(requestId: string): Promise<StageInfo[]>;
  saveVendorRisk(row: { org_id: string; request_id: string; hostname: string; data: Record<string, unknown>; fetched_by: string }): Promise<VendorRiskRow>;
}

export class ExternalUpdateRejected extends Error {}

export function supabaseIntegrationStore(config: SupabaseConfig, fetchImpl: typeof fetch = fetch): IntegrationStore {
  const rest = `${config.url.replace(/\/+$/, '')}/rest/v1`;
  const headers = { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, 'content-type': 'application/json' };
  async function call<T>(what: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetchImpl(`${rest}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (res.status === 400 && body?.message) throw new ExternalUpdateRejected(body.message);
      throw new Error(`Supabase responded ${res.status} when ${what}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }
  const q = (params: Record<string, string>) => `?${new URLSearchParams(params)}`;

  return {
    async getIntegration(orgId) {
      const rows = await call<IntegrationRecord[]>('reading integrations', `/integration_settings${q({ org_id: `eq.${orgId}`, select: 'config,secrets' })}`);
      return rows[0] ?? null;
    },
    async saveIntegration(orgId, record, actorId, action, metadata) {
      await call('saving integrations', `/integration_settings?on_conflict=org_id`, {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ org_id: orgId, config: record.config, secrets: record.secrets, updated_by: actorId, updated_at: new Date().toISOString() }),
      });
      await call('writing the audit log', '/audit_log', {
        method: 'POST',
        body: JSON.stringify({ org_id: orgId, actor_id: actorId, action, entity_type: 'integration', entity_id: orgId, metadata }),
      });
    },
    async resetCursor(orgId) {
      const rows = await call<{ id: number }[]>('reading the audit log', `/audit_log${q({ org_id: `eq.${orgId}`, select: 'id', order: 'id.desc', limit: '1' })}`);
      await this.setCursor(orgId, rows[0]?.id ?? 0);
    },
    async orgsWithSlack() {
      const rows = await call<{ org_id: string }[]>('reading integrations', `/integration_settings${q({ select: 'org_id', 'config->slack->>enabled': 'eq.true' })}`);
      return rows.map((r) => r.org_id);
    },
    async getCursor(orgId) {
      const rows = await call<{ last_audit_id: number }[]>('reading the cursor', `/notification_cursors${q({ org_id: `eq.${orgId}`, select: 'last_audit_id' })}`);
      return rows[0]?.last_audit_id ?? 0;
    },
    async setCursor(orgId, lastAuditId) {
      await call('saving the cursor', `/notification_cursors?on_conflict=org_id`, {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ org_id: orgId, last_audit_id: lastAuditId }),
      });
    },
    async auditAfter(orgId, afterId, limit) {
      return call<AuditRow[]>(
        'reading the audit log',
        `/audit_log${q({ org_id: `eq.${orgId}`, id: `gt.${afterId}`, select: 'id,org_id,action,entity_id,metadata', order: 'id.asc', limit: String(limit) })}`,
      );
    },
    async requests(ids) {
      if (ids.length === 0) return [];
      return call<RequestInfo[]>(
        'reading requests',
        `/requests${q({ id: `in.(${ids.join(',')})`, select: 'id,org_id,service_name,is_confidential,risk_tier,risk_score,risk_reasons,request_type,submitted_at,answers,form,config_requirements' })}`,
      );
    },
    async enqueue(orgId, kind, payloads) {
      if (payloads.length === 0) return;
      await call('queueing events', '/outbound_events', { method: 'POST', body: JSON.stringify(payloads.map((payload) => ({ org_id: orgId, kind, payload }))) });
    },
    async dueEvents(limit) {
      return call<OutboundRow[]>(
        'reading the queue',
        `/outbound_events${q({ delivered_at: 'is.null', failed_at: 'is.null', next_attempt_at: `lte.${new Date().toISOString()}`, select: 'id,org_id,kind,payload,attempts', order: 'id.asc', limit: String(limit) })}`,
      );
    },
    async claim(row, leaseUntil) {
      const rows = await call<unknown[]>('claiming an event', `/outbound_events${q({ id: `eq.${row.id}`, attempts: `eq.${row.attempts}`, delivered_at: 'is.null' })}`, {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({ attempts: row.attempts + 1, next_attempt_at: leaseUntil.toISOString() }),
      });
      return Array.isArray(rows) && rows.length === 1;
    },
    async markDelivered(id) {
      await call('updating the queue', `/outbound_events${q({ id: `eq.${id}` })}`, { method: 'PATCH', body: JSON.stringify({ delivered_at: new Date().toISOString(), last_error: null }) });
    },
    async markRetry(id, attempts, nextAttemptAt, error) {
      await call('updating the queue', `/outbound_events${q({ id: `eq.${id}` })}`, {
        method: 'PATCH',
        body: JSON.stringify({ attempts, next_attempt_at: nextAttemptAt.toISOString(), last_error: error.slice(0, 500) }),
      });
    },
    async markFailed(id, attempts, error) {
      await call('updating the queue', `/outbound_events${q({ id: `eq.${id}` })}`, {
        method: 'PATCH',
        body: JSON.stringify({ attempts, failed_at: new Date().toISOString(), last_error: error.slice(0, 500) }),
      });
    },
    async recordInbound(orgId, eventId) {
      const rows = await call<unknown[]>('recording an event', `/inbound_events?on_conflict=org_id,event_id`, {
        method: 'POST',
        headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ org_id: orgId, event_id: eventId }),
      });
      return Array.isArray(rows) && rows.length === 1;
    },
    async applyExternalStatus(orgId, stageId, u) {
      return call<'ok' | 'not_found' | 'closed'>('applying an external status', '/rpc/apply_external_stage_status', {
        method: 'POST',
        body: JSON.stringify({
          p_org_id: orgId,
          p_stage_id: stageId,
          p_status: u.status,
          p_comment: u.comment ?? null,
          p_conditions: u.conditions ?? null,
          p_external_id: u.external_id ?? null,
          p_external_url: u.external_url ?? null,
        }),
      });
    },
    async stage(orgId, stageId) {
      const rows = await call<StageInfo[]>('reading a stage', `/request_stages${q({ id: `eq.${stageId}`, org_id: `eq.${orgId}`, select: 'id,org_id,request_id,name,status,sla_due_at,external' })}`);
      return rows[0] ?? null;
    },
    async externalStages(requestId) {
      return call<StageInfo[]>('reading stages', `/request_stages${q({ request_id: `eq.${requestId}`, external: 'eq.true', select: 'id,org_id,request_id,name,status,sla_due_at,external' })}`);
    },
    async saveVendorRisk(row) {
      const rows = await call<VendorRiskRow[]>('saving a vendor rating', '/vendor_risk_checks', {
        method: 'POST',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({ ...row, source: 'upguard' }),
      });
      return rows[0]!;
    },
  };
}
