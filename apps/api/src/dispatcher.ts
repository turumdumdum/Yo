import { allFields, focusFieldsForStage, parseRequestForm, DEFAULT_REQUEST_FORM, type ExternalStageStarted, type RequestFormDefinition } from '@app/shared';
import { decrypt, signatureHeader, type EncryptionKey } from './crypto';
import type { AuditRow, IntegrationConfig, IntegrationSecrets, IntegrationStore, OutboundRow, RequestInfo, StageInfo } from './integrationStore';

// The outbox: notifications and calls to other services go through outbound_events, so a
// failure is retried instead of lost, and a slow service never delays a user.

export const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60_000;

export interface DispatcherDeps {
  store: IntegrationStore;
  /** Resolves to null when INTEGRATION_ENCRYPTION_KEY is not set. */
  key: Promise<EncryptionKey | null>;
  webOrigin: string;
  publicApiUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (line: string) => void;
}

/** Delay before the next attempt: 30 s, 1 min, 2 min, … at most 6 hours. */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 6 * 3_600_000);
}

export async function readSecrets(key: EncryptionKey | null, encrypted: string | null): Promise<IntegrationSecrets> {
  if (!key || !encrypted) return {};
  return JSON.parse(await decrypt(key, encrypted)) as IntegrationSecrets;
}

const escapeSlack = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The Slack text for one audit event, or null when it is not a notification. Never includes answers. */
export function slackText(row: AuditRow, request: Pick<RequestInfo, 'service_name' | 'is_confidential' | 'risk_tier'> | undefined, webOrigin: string): string | null {
  const name = !request ? 'A request' : request.is_confidential ? 'A confidential request' : `*${escapeSlack(request.service_name || 'Untitled request')}*`;
  const m = row.metadata;
  const str = (v: unknown) => (typeof v === 'string' ? escapeSlack(v) : '');
  let text: string;
  switch (row.action) {
    case 'request.submitted':
      text = `${name} was submitted${m.risk_tier ? ` (${str(m.risk_tier)} risk)` : ''} and is being checked.`;
      break;
    case 'request.approved':
      text = `${name} was approved.`;
      break;
    case 'request.rejected':
      text = `${name} was not approved.`;
      break;
    case 'stage.decided':
      text = `${name}: ${str(m.stage)} — ${str(m.decision)}${m.external ? ' (external review)' : ''}.`;
      break;
    case 'exception.requested':
      text = `${name}: an exception was requested (${str(m.risk_level)} risk). An org admin must accept or refuse it.`;
      break;
    case 'info_request.asked':
      text = `${name}: a reviewer of the ${str(m.stage)} asked the requester a question.`;
      break;
    default:
      return null;
  }
  return `${text} <${webOrigin}|Open>`;
}

function requestIdOf(row: AuditRow): string | null {
  if (row.action.startsWith('request.')) return row.entity_id;
  return typeof row.metadata.request_id === 'string' ? row.metadata.request_id : null;
}

/** Turns new audit events into Slack messages in the queue, for one or every organization with Slack on. */
export async function flushNotifications(deps: DispatcherDeps, orgId?: string): Promise<number> {
  const { store } = deps;
  const orgs = orgId ? [orgId] : await store.orgsWithSlack();
  let queued = 0;
  for (const org of orgs) {
    const integration = await store.getIntegration(org);
    const slack = integration?.config.slack;
    if (!slack?.enabled) continue;
    const cursor = await store.getCursor(org);
    const rows = await store.auditAfter(org, cursor, 200);
    if (rows.length === 0) continue;
    const ids = [...new Set(rows.map(requestIdOf).filter((id): id is string => !!id && /^[0-9a-f-]{36}$/i.test(id)))];
    const requests = new Map((await store.requests(ids)).map((r) => [r.id, r]));
    const payloads: Record<string, unknown>[] = [];
    for (const row of rows) {
      if (!(slack.events as string[]).includes(row.action)) continue;
      const id = requestIdOf(row);
      const text = slackText(row, id ? requests.get(id) : undefined, deps.webOrigin);
      if (text) payloads.push({ text, audit_id: row.id });
    }
    await store.enqueue(org, 'slack', payloads);
    await store.setCursor(org, rows.at(-1)!.id);
    queued += payloads.length;
  }
  return queued;
}

/** Sends due events; returns how many were delivered. */
export async function deliverDue(deps: DispatcherDeps, limit = 50): Promise<number> {
  const { store } = deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());
  const key = await deps.key;
  const cache = new Map<string, { config: IntegrationConfig; secrets: IntegrationSecrets } | null>();
  let delivered = 0;
  for (const row of await store.dueEvents(limit)) {
    if (!(await store.claim(row, new Date(now().getTime() + LEASE_MS)))) continue;
    const attempts = row.attempts + 1;
    if (!cache.has(row.org_id)) {
      const record = await store.getIntegration(row.org_id);
      cache.set(row.org_id, record ? { config: record.config, secrets: await readSecrets(key, record.secrets).catch(() => ({})) } : null);
    }
    const integration = cache.get(row.org_id);
    const fail = async (error: string, final = false) => {
      if (final || attempts >= MAX_ATTEMPTS) await store.markFailed(row.id, attempts, error);
      else await store.markRetry(row.id, attempts, new Date(now().getTime() + backoffMs(attempts)), error);
    };
    try {
      let res: Response;
      if (row.kind === 'slack') {
        const url = integration?.secrets.slackWebhookUrl;
        if (!integration?.config.slack?.enabled || !url) {
          await fail('Slack is off or not configured', true);
          continue;
        }
        res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: row.payload.text }), signal: AbortSignal.timeout(10_000) });
      } else {
        const ext = integration?.config.external;
        const secret = integration?.secrets.externalSecret;
        if (!ext?.enabled || !secret) {
          await fail('The external review service is off or not configured', true);
          continue;
        }
        const body = JSON.stringify(row.payload);
        res = await fetchImpl(ext.outboundUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-signature': await signatureHeader(secret, body, now().getTime()), 'x-event-id': String(row.payload.event_id ?? row.id) },
          body,
          signal: AbortSignal.timeout(15_000),
        });
      }
      if (res.ok) {
        await store.markDelivered(row.id);
        delivered++;
      } else {
        // 4xx other than 408/429 will not get better by retrying.
        const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
        await fail(`The service answered ${res.status}`, permanent);
      }
    } catch (error) {
      await fail(error instanceof Error && error.name === 'TimeoutError' ? 'The service did not answer in time' : 'The service could not be reached');
    }
  }
  if (delivered > 0) deps.log?.(`Outbox: delivered ${delivered} event(s)`);
  return delivered;
}

/** One pass: queue new notifications, then deliver what is due. Errors are logged, never thrown. */
export async function runOutbox(deps: DispatcherDeps, orgId?: string): Promise<void> {
  try {
    await flushNotifications(deps, orgId);
    await deliverDue(deps);
  } catch (error) {
    console.error('Outbox run failed:', error instanceof Error ? error.message : error);
  }
}

function formOf(raw: unknown): RequestFormDefinition {
  if (raw === null || raw === undefined) return DEFAULT_REQUEST_FORM;
  const parsed = parseRequestForm(raw);
  return 'form' in parsed ? parsed.form : DEFAULT_REQUEST_FORM;
}

/** The "stage.started" payload for an external stage. Answers about people are never sent. */
export function stageStartedPayload(
  request: RequestInfo,
  stage: StageInfo,
  options: { sendAllAnswers: boolean; publicApiUrl?: string; eventId?: string; now?: Date },
): ExternalStageStarted {
  const form = formOf(request.form);
  const fields = allFields(form).filter((f) => f.type !== 'owner');
  const focus = new Set(focusFieldsForStage(stage.name));
  const chosen = options.sendAllAnswers || focus.size === 0 ? fields : fields.filter((f) => focus.has(f.key));
  const answers: ExternalStageStarted['request']['answers'] = {};
  for (const f of chosen) {
    const value = request.answers[f.key];
    if (value !== undefined && value !== null && value !== '') answers[f.key] = { label: f.label, value };
  }
  const text = (key: string) => (typeof request.answers[key] === 'string' ? (request.answers[key] as string) : null);
  const base = options.publicApiUrl?.replace(/\/+$/, '');
  return {
    type: 'stage.started',
    event_id: options.eventId ?? `stage.started:${stage.id}`,
    created_at: (options.now ?? new Date()).toISOString(),
    organization: { id: request.org_id },
    request: {
      id: request.id,
      title: request.service_name,
      vendor: text('vendorName'),
      website: text('vendorWebsite'),
      request_type: request.request_type,
      risk_tier: request.risk_tier ?? 'Low',
      risk_score: request.risk_score ?? 0,
      risk_reasons: request.risk_reasons ?? [],
      confidential: request.is_confidential,
      submitted_at: request.submitted_at ?? '',
      answers,
      config_requirements: request.config_requirements ?? [],
    },
    stage: { id: stage.id, name: stage.name, due_at: stage.sla_due_at },
    callback: {
      status_url: base ? `${base}/v1/external/stages/${stage.id}/status` : null,
      stage_url: base ? `${base}/v1/external/stages/${stage.id}?org_id=${request.org_id}` : null,
    },
  };
}

/** After submission: queue a "stage.started" event for every external stage of the request. */
export async function queueExternalStages(deps: DispatcherDeps, requestId: string): Promise<number> {
  const { store } = deps;
  const stages = (await store.externalStages(requestId)).filter((s) => s.status === 'In review');
  if (stages.length === 0) return 0;
  const [request] = await store.requests([requestId]);
  if (!request) return 0;
  const integration = await store.getIntegration(request.org_id);
  const ext = integration?.config.external;
  if (!ext?.enabled) return 0;
  await store.enqueue(
    request.org_id,
    'external',
    stages.map((s) => stageStartedPayload(request, s, { sendAllAnswers: ext.sendAllAnswers, publicApiUrl: deps.publicApiUrl }) as unknown as Record<string, unknown>),
  );
  return stages.length;
}

export type { OutboundRow };
