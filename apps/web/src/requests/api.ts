import { ATTACHMENT_BUCKET } from '@app/shared';
import type {
  AsanaField,
  AiCheckSettings,
  ConfigRequirement,
  ExceptionStatus,
  SecurityBaseline,
  AiRemark,
  AiStatus,
  AiSuggestion,
  Answers,
  RequestFormDefinition,
  ReviewFieldDef,
  ReviewRule,
  ReviewTemplate,
  StageDecision,
  StageStatus,
  WorkflowSettings,
} from '@app/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export type RequestStatus = 'draft' | 'submitted' | 'in_review' | 'approved' | 'rejected';

export interface RequestRow {
  id: string;
  /** 'submitted' only on requests sent before review stages existed. */
  status: RequestStatus;
  service_name: string | null;
  request_type: string | null;
  risk_tier: string | null;
  risk_score: number | null;
  risk_reasons: string[] | null;
  answers: Answers;
  /** The form the request was started with; null for the standard form. */
  form: RequestFormDefinition | null;
  requester_id: string;
  /** Visible only to the requester, org admins, the business owner and added viewers. */
  is_confidential: boolean;
  /** Archived by an org admin; still visible, listed under Archived. */
  archived_at: string | null;
  /** In the trash: visible to org admins only, until restored or deleted for good. */
  deleted_at: string | null;
  /** Security baseline controls that applied at submission, with decisions and configuration state. */
  config_requirements?: ConfigRequirement[];
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

const LIST_COLUMNS = 'id,status,service_name,vendor_name:answers->>vendorName,request_type,risk_tier,requester_id,is_confidential,archived_at,deleted_at,created_at,updated_at,submitted_at,request_stages(status)';

export type RequestSummary = Omit<RequestRow, 'answers' | 'risk_score' | 'risk_reasons' | 'form'> & {
  /** The vendor answer, when the form asks for it. */
  vendor_name?: string | null;
  /** Statuses of the review stages, for progress in lists. */
  request_stages?: { status: StageStatus }[];
};

export async function listRequests(supabase: SupabaseClient): Promise<RequestSummary[]> {
  const { data, error } = await supabase.from('requests').select(LIST_COLUMNS).order('updated_at', { ascending: false });
  if (error) throw error;
  return data as RequestSummary[];
}

export async function loadRequest(supabase: SupabaseClient, id: string): Promise<RequestRow | null> {
  const { data, error } = await supabase.from('requests').select('*').eq('id', id).maybeSingle<RequestRow>();
  if (error) throw error;
  return data;
}

export interface ChecklistItem {
  label: string;
  checked: boolean;
}

export interface StageRow {
  id: string;
  request_id: string;
  position: number;
  name: string;
  status: StageStatus;
  note: string | null;
  reviewer_id: string | null;
  sla_due_at: string | null;
  sla_paused: boolean;
  checklist: ChecklistItem[];
  decision_comment: string | null;
  conditions: string | null;
  decided_by: string | null;
  decided_at: string | null;
  review_fields: ReviewFieldDef[];
  review_rules: ReviewRule[];
  /** Reviewed in an external service; only that service changes the status. */
  external?: boolean;
  external_id?: string | null;
  external_url?: string | null;
  /** Id of the review service that handles an external stage. */
  external_service?: string | null;
}

const STAGE_COLUMNS =
  'id,request_id,position,name,status,note,reviewer_id,sla_due_at,sla_paused,checklist,decision_comment,conditions,decided_by,decided_at,review_fields,review_rules,external,external_id,external_url,external_service';

/** Review answers by stage id. Empty for people who may not see them, such as the requester. */
export async function requestReviewAnswers(supabase: SupabaseClient, requestId: string): Promise<Record<string, Answers>> {
  const { data, error } = await supabase.rpc('request_review_answers', { p_request_id: requestId });
  if (error) throw error;
  return (data ?? {}) as Record<string, Answers>;
}

export async function saveReviewAnswers(supabase: SupabaseClient, stageId: string, answers: Answers): Promise<void> {
  const { error } = await supabase.rpc('save_stage_review_answers', { p_stage_id: stageId, p_answers: answers });
  if (error) throw error;
}

/** The organization's own form for a stage, or null when it uses the default. */
export async function loadReviewTemplate(supabase: SupabaseClient, orgId: string, stage: string): Promise<ReviewTemplate | null> {
  const { data, error } = await supabase
    .from('review_templates')
    .select('fields,rules')
    .eq('org_id', orgId)
    .eq('stage_name', stage)
    .maybeSingle<ReviewTemplate>();
  if (error) throw error;
  return data;
}

export async function listStages(supabase: SupabaseClient, requestId: string): Promise<StageRow[]> {
  const { data, error } = await supabase.from('request_stages').select(STAGE_COLUMNS).eq('request_id', requestId).order('position');
  if (error) throw error;
  return data as StageRow[];
}

export interface InfoRequest {
  id: string;
  request_id: string;
  stage_id: string;
  question: string;
  asked_by: string | null;
  asked_at: string;
  answer: string | null;
  answered_at: string | null;
}

const INFO_COLUMNS = 'id,request_id,stage_id,question,asked_by,asked_at,answer,answered_at';

export async function listInfoRequests(supabase: SupabaseClient, requestId: string): Promise<InfoRequest[]> {
  const { data, error } = await supabase.from('info_requests').select(INFO_COLUMNS).eq('request_id', requestId).order('asked_at');
  if (error) throw error;
  return data as InfoRequest[];
}

export interface OpenQuestion {
  id: string;
  request_id: string;
  question: string;
  requests: { service_name: string | null; requester_id: string };
}

/** Unanswered questions on requests the caller can see. */
export async function listOpenQuestions(supabase: SupabaseClient): Promise<OpenQuestion[]> {
  const { data, error } = await supabase
    .from('info_requests')
    .select('id,request_id,question,requests(service_name,requester_id)')
    .is('answered_at', null)
    .order('asked_at');
  if (error) throw error;
  return data as unknown as OpenQuestion[];
}

export async function askRequester(supabase: SupabaseClient, stageId: string, question: string): Promise<void> {
  const { error } = await supabase.rpc('ask_requester', { p_stage_id: stageId, p_question: question });
  if (error) throw error;
}

export async function answerInfoRequest(supabase: SupabaseClient, id: string, answer: string): Promise<void> {
  const { error } = await supabase.rpc('answer_info_request', { p_info_request_id: id, p_answer: answer });
  if (error) throw error;
}

export interface QueueItem {
  id: string;
  request_id: string;
  name: string;
  status: StageStatus;
  reviewer_id: string | null;
  sla_due_at: string | null;
  requests: { service_name: string | null; requester_id: string; risk_tier: string | null };
  external?: boolean;
}

/** Open stages of requests the caller can see, most urgent first. */
export async function listOpenStages(supabase: SupabaseClient): Promise<QueueItem[]> {
  const { data, error } = await supabase
    .from('request_stages')
    .select('id,request_id,name,status,reviewer_id,sla_due_at,external,requests(service_name,requester_id,risk_tier)')
    .in('status', ['In review', 'Waiting for requester'])
    .order('sla_due_at');
  if (error) throw error;
  return data as unknown as QueueItem[];
}

export async function assignReviewer(supabase: SupabaseClient, stageId: string, reviewerId: string | null): Promise<void> {
  const { error } = await supabase.rpc('assign_stage_reviewer', { p_stage_id: stageId, p_reviewer_id: reviewerId });
  if (error) throw error;
}

export async function setChecklistItem(supabase: SupabaseClient, stageId: string, index: number, checked: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_stage_checklist_item', { p_stage_id: stageId, p_index: index, p_checked: checked });
  if (error) throw error;
}

export async function decideStage(
  supabase: SupabaseClient,
  stageId: string,
  decision: StageDecision,
  comment: string,
  conditions: string,
): Promise<void> {
  const { error } = await supabase.rpc('decide_stage', {
    p_stage_id: stageId,
    p_decision: decision,
    p_comment: comment,
    p_conditions: conditions,
  });
  if (error) throw error;
}

export async function createDraft(supabase: SupabaseClient, orgId: string): Promise<string> {
  const { data, error } = await supabase.from('requests').insert({ org_id: orgId, answers: {} }).select('id').single<{ id: string }>();
  if (error) throw error;
  return data.id;
}

export async function saveAnswers(supabase: SupabaseClient, id: string, answers: Answers): Promise<void> {
  const { data, error } = await supabase.from('requests').update({ answers }).eq('id', id).select('id');
  if (error) throw error;
  // RLS hides the row once it is no longer an editable draft of this user.
  if (data.length === 0) throw new Error('This draft can no longer be edited.');
}

export async function deleteDraft(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from('requests').delete().eq('id', id);
  if (error) throw error;
}

export class SubmitError extends Error {
  constructor(
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

export async function callApi(
  supabase: SupabaseClient,
  path: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  timeoutMs = 30_000,
  body?: unknown,
): Promise<Response> {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (!apiUrl) throw new SubmitError('The API address is not configured. Set VITE_API_URL in apps/web/.env.');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new SubmitError('Your session has expired. Sign in again.');
  try {
    return await fetch(`${apiUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: body === undefined ? { authorization: `Bearer ${token}` } : { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new SubmitError('The API did not answer in time. Check that it is still running and try again.');
    }
    throw new SubmitError('Could not reach the API. Check that it is running and try again.');
  }
}

export async function apiError(res: Response, fallback: string): Promise<SubmitError> {
  const body = (await res.json().catch(() => null)) as { error?: string; fields?: Record<string, string> } | null;
  return new SubmitError(body?.error ?? fallback, body?.fields);
}

/** Submission goes through our API, which validates the answers and computes the risk tier. */
export async function submitRequest(supabase: SupabaseClient, id: string): Promise<void> {
  const res = await callApi(supabase, `/v1/requests/${id}/submit`, 'POST');
  if (!res.ok) throw await apiError(res, 'The request could not be submitted.');
}

const AI_OFF: AiStatus = { enabled: false, provider: null };

/** Starting a job and each poll are short requests; a poll waits up to ~20 s on the server. */
const AI_REQUEST_TIMEOUT_MS = 45_000;
/** Language-model providers answer the first request directly (up to ~90 s on the server). */
const AI_START_TIMEOUT_MS = 120_000;
/** How long the browser keeps asking before it gives up on a job. */
const AI_MAX_WAIT_MS = 6 * 60_000;
const AI_POLL_PAUSE_MS = 2_000;

export interface AiRunOptions {
  /** Stops polling, for example when the form closes. */
  signal?: AbortSignal;
  /** Seconds since the job started, after every poll. */
  onProgress?: (elapsedSeconds: number) => void;
}

const aborted = () => new SubmitError('The AI request was cancelled.');

/**
 * Starts an AI job and waits for it. The API answers 202 with a handle for slow
 * providers, and the browser polls; an older API that answers 200 at once works too.
 */
async function runAi<T>(supabase: SupabaseClient, id: string, kind: 'check' | 'suggestions', fallback: string, options: AiRunOptions): Promise<T> {
  const startedAt = Date.now();
  let res = await callApi(supabase, `/v1/requests/${id}/ai/${kind}`, 'POST', AI_START_TIMEOUT_MS);
  if (res.status !== 202) {
    if (!res.ok) throw await apiError(res, fallback);
    return (await res.json()) as T;
  }
  const { handle } = (await res.json()) as { handle?: string };
  if (!handle) throw new SubmitError(fallback);
  while (Date.now() - startedAt < AI_MAX_WAIT_MS) {
    if (options.signal?.aborted) throw aborted();
    res = await callApi(supabase, `/v1/requests/${id}/ai/runs/${encodeURIComponent(handle)}`, 'GET', AI_REQUEST_TIMEOUT_MS);
    options.onProgress?.(Math.round((Date.now() - startedAt) / 1000));
    if (res.status !== 202) {
      if (!res.ok) throw await apiError(res, fallback);
      return (await res.json()) as T;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, AI_POLL_PAUSE_MS);
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
  throw new SubmitError('The AI did not finish within 6 minutes. Try again, or ask an admin to choose the faster "lite" processor in Admin → Integrations.');
}

/** Whether the optional AI plugin is configured. Any failure simply means "no AI". */
export async function aiStatus(supabase: SupabaseClient): Promise<AiStatus> {
  try {
    const res = await callApi(supabase, '/v1/ai', 'GET');
    return res.ok ? ((await res.json()) as AiStatus) : AI_OFF;
  } catch {
    return AI_OFF;
  }
}

export async function aiSuggestions(supabase: SupabaseClient, id: string, options: AiRunOptions = {}): Promise<AiSuggestion[]> {
  return (await runAi<{ suggestions: AiSuggestion[] }>(supabase, id, 'suggestions', 'The AI could not suggest anything.', options)).suggestions;
}

export async function aiCheck(supabase: SupabaseClient, id: string, options: AiRunOptions = {}): Promise<AiRemark[]> {
  return (await runAi<{ remarks: AiRemark[] }>(supabase, id, 'check', 'The AI could not check the answers.', options)).remarks;
}

/** Saves a stage's review form through the API, which validates it with the shared schema. */
export async function saveReviewTemplate(supabase: SupabaseClient, stage: string, template: ReviewTemplate): Promise<void> {
  const res = await callApi(supabase, `/v1/review-forms/${encodeURIComponent(stage)}`, 'PUT', 30_000, template);
  if (!res.ok) throw await apiError(res, 'The form could not be saved.');
}

/** Removes the organization's form so the default applies again. */
export async function resetReviewTemplate(supabase: SupabaseClient, stage: string): Promise<void> {
  const res = await callApi(supabase, `/v1/review-forms/${encodeURIComponent(stage)}`, 'DELETE');
  if (!res.ok) throw await apiError(res, 'The form could not be reset.');
}

export interface AttachmentRow {
  id: string;
  kind: string;
  filename: string;
  size_bytes: number;
  uploaded_by: string | null;
  uploaded_at: string | null;
}

export async function listAttachments(supabase: SupabaseClient, requestId: string): Promise<AttachmentRow[]> {
  const { data, error } = await supabase
    .from('attachments')
    .select('id,kind,filename,size_bytes,uploaded_by,uploaded_at')
    .eq('request_id', requestId)
    .eq('status', 'uploaded')
    .order('created_at');
  if (error) throw error;
  return data as AttachmentRow[];
}

/**
 * Uploads a file in three steps: the API checks and registers it and returns a one-time
 * token, the file goes straight to storage with that token, and the API confirms it arrived.
 */
export async function uploadAttachment(supabase: SupabaseClient, requestId: string, file: File, kind: string): Promise<void> {
  const started = await callApi(supabase, `/v1/requests/${requestId}/attachments`, 'POST', 30_000, {
    filename: file.name,
    size: file.size,
    kind,
  });
  if (!started.ok) throw await apiError(started, 'The file could not be attached.');
  const { id, path, token, contentType } = (await started.json()) as { id: string; path: string; token: string; contentType: string };

  const { error } = await supabase.storage.from(ATTACHMENT_BUCKET).uploadToSignedUrl(path, token, file, { contentType });
  if (error) {
    // Forget the unfinished upload so it does not count towards the limit.
    await callApi(supabase, `/v1/attachments/${id}`, 'DELETE').catch(() => undefined);
    throw new SubmitError(`The upload failed. ${error.message}`);
  }

  const finished = await callApi(supabase, `/v1/attachments/${id}/complete`, 'POST');
  if (!finished.ok) throw await apiError(finished, 'The upload could not be confirmed.');
}

/** A link that downloads the file, valid for about a minute. The download is recorded in the audit log. */
export async function attachmentDownloadUrl(supabase: SupabaseClient, id: string): Promise<string> {
  const res = await callApi(supabase, `/v1/attachments/${id}/download`, 'GET');
  if (!res.ok) throw await apiError(res, 'The file could not be downloaded.');
  return ((await res.json()) as { url: string }).url;
}

export async function deleteAttachment(supabase: SupabaseClient, id: string): Promise<void> {
  const res = await callApi(supabase, `/v1/attachments/${id}`, 'DELETE');
  if (!res.ok) throw await apiError(res, 'The file could not be removed.');
}

export interface SavedRequestForm {
  id: string;
  name: string;
  description: string | null;
  definition: RequestFormDefinition;
  is_active: boolean;
  updated_at: string;
}

/** The organization's saved request forms (org admins and process managers only). */
export async function listRequestForms(supabase: SupabaseClient, orgId: string): Promise<SavedRequestForm[]> {
  const { data, error } = await supabase
    .from('request_form_templates')
    .select('id,name,description,definition,is_active,updated_at')
    .eq('org_id', orgId)
    .order('name');
  if (error) throw error;
  return data as SavedRequestForm[];
}

export interface RequestFormInput {
  name: string;
  description: string;
  definition: RequestFormDefinition;
}

/** Creates (id null) or updates a saved form through the API, which validates it. Returns its id. */
export async function saveRequestForm(supabase: SupabaseClient, id: string | null, input: RequestFormInput): Promise<string> {
  const res = await callApi(supabase, id ? `/v1/request-forms/${id}` : '/v1/request-forms', id ? 'PUT' : 'POST', 30_000, input);
  if (!res.ok) throw await apiError(res, 'The form could not be saved.');
  return ((await res.json()) as { id: string }).id;
}

export async function deleteRequestForm(supabase: SupabaseClient, id: string): Promise<void> {
  const res = await callApi(supabase, `/v1/request-forms/${id}`, 'DELETE');
  if (!res.ok) throw await apiError(res, 'The form could not be deleted.');
}

/** Makes a saved form the one new requests use; null returns to the standard form. */
export async function activateRequestForm(supabase: SupabaseClient, id: string | null): Promise<void> {
  const res = await callApi(supabase, `/v1/request-forms/${id ?? 'standard'}/activate`, 'POST');
  if (!res.ok) throw await apiError(res, 'The form could not be made active.');
}

export interface RequestViewer {
  user_id: string;
  /** business_owner: matched from the answers; added: by an org admin. */
  reason: 'business_owner' | 'added';
}

/** Who may see a confidential request besides the requester and org admins. RLS decides what is listed. */
export async function listViewers(supabase: SupabaseClient, requestId: string): Promise<RequestViewer[]> {
  const { data, error } = await supabase.from('request_viewers').select('user_id,reason').eq('request_id', requestId).order('created_at');
  if (error) throw error;
  return data as RequestViewer[];
}

export async function addViewer(supabase: SupabaseClient, requestId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc('add_request_viewer', { p_request_id: requestId, p_user_id: userId });
  if (error) throw error;
}

export async function removeViewer(supabase: SupabaseClient, requestId: string, userId: string): Promise<void> {
  const { error } = await supabase.rpc('remove_request_viewer', { p_request_id: requestId, p_user_id: userId });
  if (error) throw error;
}

export async function setConfidential(supabase: SupabaseClient, requestId: string, confidential: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_request_confidential', { p_request_id: requestId, p_confidential: confidential });
  if (error) throw error;
}

/** The organization's stored review settings (unvalidated), or null for the defaults. */
export async function loadWorkflowSettings(supabase: SupabaseClient, orgId: string): Promise<unknown> {
  const { data, error } = await supabase.from('workflow_settings').select('stages').eq('org_id', orgId).maybeSingle<{ stages: unknown }>();
  if (error) throw error;
  return data?.stages ?? null;
}

/** Stage names that have their own review form. */
export async function customizedReviewForms(supabase: SupabaseClient, orgId: string): Promise<string[]> {
  const { data, error } = await supabase.from('review_templates').select('stage_name').eq('org_id', orgId);
  if (error) throw error;
  return (data as { stage_name: string }[]).map((r) => r.stage_name);
}

export async function saveWorkflowSettings(supabase: SupabaseClient, stages: WorkflowSettings): Promise<void> {
  const res = await callApi(supabase, '/v1/workflow', 'PUT', 30_000, { stages });
  if (!res.ok) throw await apiError(res, 'The review settings could not be saved.');
}

export async function resetWorkflowSettings(supabase: SupabaseClient): Promise<void> {
  const res = await callApi(supabase, '/v1/workflow', 'DELETE');
  if (!res.ok) throw await apiError(res, 'The review settings could not be reset.');
}

export async function setArchived(supabase: SupabaseClient, requestId: string, archived: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_request_archived', { p_request_id: requestId, p_archived: archived });
  if (error) throw error;
}

export async function setTrashed(supabase: SupabaseClient, requestId: string, trashed: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_request_trashed', { p_request_id: requestId, p_trashed: trashed });
  if (error) throw error;
}

/** Deletes a request in the trash for good, with its files. Org admins only. */
export async function deleteForever(supabase: SupabaseClient, requestId: string): Promise<{ filesRemoved: boolean }> {
  const res = await callApi(supabase, `/v1/requests/${requestId}`, 'DELETE');
  if (!res.ok) throw await apiError(res, 'The request could not be deleted.');
  return (await res.json()) as { filesRemoved: boolean };
}

/** The organization's stored AI check settings (unvalidated), or null for the defaults. */
export async function loadAiSettings(supabase: SupabaseClient, orgId: string): Promise<unknown> {
  const { data, error } = await supabase.from('ai_settings').select('check_settings').eq('org_id', orgId).maybeSingle<{ check_settings: unknown }>();
  if (error) throw error;
  return data?.check_settings ?? null;
}

export async function saveAiSettings(supabase: SupabaseClient, settings: AiCheckSettings): Promise<void> {
  const res = await callApi(supabase, '/v1/ai-settings', 'PUT', 30_000, settings);
  if (!res.ok) throw await apiError(res, 'The AI settings could not be saved.');
}

export async function resetAiSettings(supabase: SupabaseClient): Promise<void> {
  const res = await callApi(supabase, '/v1/ai-settings', 'DELETE');
  if (!res.ok) throw await apiError(res, 'The AI settings could not be reset.');
}

// ---------------------------------------------------------------------------
// Security baseline and exceptions
// ---------------------------------------------------------------------------

export interface ReviewException {
  id: string;
  request_id: string;
  /** The review the exception was raised in (null only for very old rows). */
  stage_id: string | null;
  stage_name: string | null;
  /** Short name of the exception; older rows only have the control title. */
  title: string | null;
  checklist_item: string | null;
  control_id: string | null;
  control_title: string | null;
  deviation: string;
  justification: string;
  compensating_controls: string;
  risk_level: string;
  expires_on: string;
  status: ExceptionStatus;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_comment: string | null;
  created_at: string;
  requests?: { service_name: string | null };
}

const EXCEPTION_COLUMNS =
  'id,request_id,stage_id,stage_name,title,checklist_item,control_id,control_title,deviation,justification,compensating_controls,risk_level,expires_on,status,requested_by,decided_by,decided_at,decision_comment,created_at';

export async function listExceptions(supabase: SupabaseClient, requestId: string): Promise<ReviewException[]> {
  const { data, error } = await supabase.from('review_exceptions').select(EXCEPTION_COLUMNS).eq('request_id', requestId).order('created_at');
  if (error) throw error;
  return data as ReviewException[];
}

/** Every exception the caller can see in the organization, soonest expiry first. */
export async function listOrgExceptions(supabase: SupabaseClient, orgId: string): Promise<ReviewException[]> {
  const { data, error } = await supabase
    .from('review_exceptions')
    .select(`${EXCEPTION_COLUMNS},requests(service_name)`)
    .eq('org_id', orgId)
    .order('expires_on');
  if (error) throw error;
  return data as unknown as ReviewException[];
}

export async function setConfigDecision(supabase: SupabaseClient, requestId: string, controlId: string | null, decision: 'required' | 'not_applicable' | null, note: string | null): Promise<void> {
  const { error } = await supabase.rpc('set_config_decision', { p_request_id: requestId, p_control_id: controlId, p_decision: decision, p_note: note });
  if (error) throw error;
}

export interface ExceptionInput {
  controlId: string;
  deviation: string;
  justification: string;
  compensating: string;
  riskLevel: string;
  expiresOn: string;
}

export async function requestException(supabase: SupabaseClient, requestId: string, input: ExceptionInput): Promise<void> {
  const { error } = await supabase.rpc('request_exception', {
    p_request_id: requestId,
    p_control_id: input.controlId,
    p_deviation: input.deviation,
    p_justification: input.justification,
    p_compensating: input.compensating,
    p_risk_level: input.riskLevel,
    p_expires_on: input.expiresOn,
  });
  if (error) throw error;
}

/** What an exception is called: its title, else the control it waives. */
export const exceptionTitle = (e: Pick<ReviewException, 'title' | 'control_title'>) => e.title || e.control_title || 'Exception';

export interface StageExceptionInput {
  title: string;
  deviation: string;
  justification: string;
  compensating: string;
  riskLevel: string;
  expiresOn: string;
  controlId: string | null;
  checklistItem: string | null;
}

/** The reviewer of any stage raises an exception there; an org admin other than them decides. */
export async function raiseStageException(supabase: SupabaseClient, stageId: string, input: StageExceptionInput): Promise<void> {
  const { error } = await supabase.rpc('raise_stage_exception', {
    p_stage_id: stageId,
    p_title: input.title,
    p_deviation: input.deviation,
    p_justification: input.justification,
    p_compensating: input.compensating,
    p_risk_level: input.riskLevel,
    p_expires_on: input.expiresOn,
    p_control_id: input.controlId,
    p_checklist_item: input.checklistItem,
  });
  if (error) throw error;
}

export async function decideException(supabase: SupabaseClient, id: string, approve: boolean, comment: string | null): Promise<void> {
  const { error } = await supabase.rpc('decide_exception', { p_exception_id: id, p_approve: approve, p_comment: comment });
  if (error) throw error;
}

export async function revokeException(supabase: SupabaseClient, id: string, comment: string | null): Promise<void> {
  const { error } = await supabase.rpc('revoke_exception', { p_exception_id: id, p_comment: comment });
  if (error) throw error;
}

export async function confirmConfiguration(supabase: SupabaseClient, requestId: string, controlId: string, configured: boolean): Promise<void> {
  const { error } = await supabase.rpc('confirm_configuration', { p_request_id: requestId, p_control_id: controlId, p_configured: configured });
  if (error) throw error;
}

export async function loadSecurityBaseline(supabase: SupabaseClient, orgId: string): Promise<unknown> {
  const { data, error } = await supabase.from('security_baselines').select('controls').eq('org_id', orgId).maybeSingle<{ controls: unknown }>();
  if (error) throw error;
  return data ? { controls: data.controls } : null;
}

export async function saveSecurityBaseline(supabase: SupabaseClient, baseline: SecurityBaseline): Promise<void> {
  const res = await callApi(supabase, '/v1/security-baseline', 'PUT', 30_000, baseline);
  if (!res.ok) throw await apiError(res, 'The security baseline could not be saved.');
}

export async function resetSecurityBaseline(supabase: SupabaseClient): Promise<void> {
  const res = await callApi(supabase, '/v1/security-baseline', 'DELETE');
  if (!res.ok) throw await apiError(res, 'The security baseline could not be reset.');
}

// ---------------------------------------------------------------------------
// Integrations (secrets are write-only: the API never returns them)
// ---------------------------------------------------------------------------

export const SLACK_EVENTS = [
  { key: 'request.submitted', label: 'A request is submitted' },
  { key: 'request.approved', label: 'A request is approved' },
  { key: 'request.rejected', label: 'A request is rejected' },
  { key: 'stage.decided', label: 'A review stage is decided' },
  { key: 'exception.requested', label: 'An exception waits for an org admin' },
  { key: 'info_request.asked', label: 'A reviewer asks the requester a question' },
] as const;

/** Where a setting comes from: saved in the app, the server's .env file, or nowhere. */
export type SettingSource = 'settings' | 'env' | 'none';

export interface ReviewServiceStatus {
  id: string;
  name: string;
  url: string;
  dataMode: 'push' | 'pull';
  sendAllAnswers: boolean;
  enabled: boolean;
  hasSecret: boolean;
  /** Review stages that use this service. */
  usedBy: string[];
}

export interface IntegrationsStatus {
  encryptionReady: boolean;
  server: { publicApiUrl: string; source: SettingSource };
  email: { provider: 'off' | 'resend' | 'smtp' | 'log'; from: string; configured: boolean; source: SettingSource };
  ai: {
    provider: AiProviderName;
    processor: string;
    model?: string;
    baseUrl?: string;
    configured: boolean;
    source: SettingSource;
    /** Providers with a saved key (never the key itself). */
    savedKeys?: AiProviderName[];
  };
  slack: { enabled: boolean; configured: boolean; events: string[] };
  upguard: { enabled: boolean; configured: boolean };
  reviewServices: ReviewServiceStatus[];
}

export async function loadIntegrations(supabase: SupabaseClient): Promise<IntegrationsStatus> {
  const res = await callApi(supabase, '/v1/integrations', 'GET');
  if (!res.ok) throw await apiError(res, 'The integrations could not be loaded.');
  return (await res.json()) as IntegrationsStatus;
}

export async function saveSlack(supabase: SupabaseClient, body: { enabled: boolean; events: string[]; webhookUrl?: string }): Promise<void> {
  const res = await callApi(supabase, '/v1/integrations/slack', 'PUT', 30_000, body);
  if (!res.ok) throw await apiError(res, 'The Slack settings could not be saved.');
}

export async function testSlack(supabase: SupabaseClient): Promise<void> {
  const res = await callApi(supabase, '/v1/integrations/slack/test', 'POST', 30_000, {});
  if (!res.ok) throw await apiError(res, 'The test message could not be sent.');
}

export async function saveUpguard(supabase: SupabaseClient, body: { enabled: boolean; apiKey?: string }): Promise<void> {
  const res = await callApi(supabase, '/v1/integrations/upguard', 'PUT', 30_000, body);
  if (!res.ok) throw await apiError(res, 'The UpGuard settings could not be saved.');
}

// --- Asana (import project fields into the request form) ---

export interface AsanaStatus {
  encryptionReady: boolean;
  configured: boolean;
  workspaceGid: string | null;
  workspaceName: string | null;
}
export interface AsanaPlace {
  gid: string;
  name: string;
}

async function asanaGet<T>(supabase: SupabaseClient, path: string, fallback: string): Promise<T> {
  const res = await callApi(supabase, `/v1/integrations/asana${path}`, 'GET');
  if (!res.ok) throw await apiError(res, fallback);
  return (await res.json()) as T;
}

export const loadAsanaStatus = (supabase: SupabaseClient) => asanaGet<AsanaStatus>(supabase, '', 'The Asana settings could not be loaded.');

/** Checks the token with Asana and saves it; the token is never sent back. */
export async function saveAsana(supabase: SupabaseClient, body: { token?: string; workspaceGid?: string | null }): Promise<{ user: string; workspaces: AsanaPlace[] }> {
  const res = await callApi(supabase, '/v1/integrations/asana', 'PUT', 30_000, body);
  if (!res.ok) throw await apiError(res, 'The Asana settings could not be saved.');
  return (await res.json()) as { user: string; workspaces: AsanaPlace[] };
}

export async function removeAsana(supabase: SupabaseClient): Promise<void> {
  const res = await callApi(supabase, '/v1/integrations/asana', 'DELETE');
  if (!res.ok) throw await apiError(res, 'Asana could not be disconnected.');
}

export async function testAsana(supabase: SupabaseClient): Promise<{ user: string; workspaces: number }> {
  const res = await callApi(supabase, '/v1/integrations/asana/test', 'POST', 30_000, {});
  if (!res.ok) throw await apiError(res, 'Asana could not be reached.');
  return (await res.json()) as { user: string; workspaces: number };
}

export const listAsanaWorkspaces = (supabase: SupabaseClient) =>
  asanaGet<{ workspaces: AsanaPlace[]; selected: string | null }>(supabase, '/workspaces', 'The Asana workspaces could not be loaded.');

export const listAsanaProjects = async (supabase: SupabaseClient, workspaceGid: string) =>
  (await asanaGet<{ projects: AsanaPlace[] }>(supabase, `/workspaces/${encodeURIComponent(workspaceGid)}/projects`, 'The Asana projects could not be loaded.')).projects;

export const listAsanaFields = async (supabase: SupabaseClient, projectGid: string) =>
  (await asanaGet<{ fields: AsanaField[] }>(supabase, `/projects/${encodeURIComponent(projectGid)}/fields`, 'The project fields could not be loaded.')).fields;

async function sendJson<T = unknown>(supabase: SupabaseClient, path: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown, fallback: string): Promise<T> {
  const res = await callApi(supabase, path, method, 30_000, method === 'DELETE' ? undefined : body);
  if (!res.ok) throw await apiError(res, fallback);
  return (await res.json().catch(() => ({}))) as T;
}

export const saveServerSettings = (supabase: SupabaseClient, body: { publicApiUrl: string }) =>
  sendJson(supabase, '/v1/integrations/server', 'PUT', body, 'The server address could not be saved.');

export const saveEmailSettings = (supabase: SupabaseClient, body: { provider: string; from: string; resendApiKey?: string; smtpUrl?: string }) =>
  sendJson(supabase, '/v1/integrations/email', 'PUT', body, 'The email settings could not be saved.');

export const testEmail = (supabase: SupabaseClient) => sendJson(supabase, '/v1/integrations/email/test', 'POST', {}, 'The test email could not be sent.');

export type AiProviderName = 'off' | 'parallel' | 'anthropic' | 'openai' | 'openai_compatible';

export const saveAiProvider = (supabase: SupabaseClient, body: { provider: string; processor?: string; apiKey?: string; model?: string; baseUrl?: string }) =>
  sendJson(supabase, '/v1/integrations/ai', 'PUT', body, 'The AI settings could not be saved.');

export interface ReviewServiceInput {
  name: string;
  url: string;
  dataMode: 'push' | 'pull';
  sendAllAnswers: boolean;
  enabled: boolean;
}

export const createReviewService = (supabase: SupabaseClient, body: ReviewServiceInput) =>
  sendJson<{ service: ReviewServiceStatus; secret: string }>(supabase, '/v1/integrations/review-services', 'POST', body, 'The service could not be added.');

export const updateReviewService = (supabase: SupabaseClient, id: string, body: ReviewServiceInput) =>
  sendJson(supabase, `/v1/integrations/review-services/${encodeURIComponent(id)}`, 'PUT', body, 'The service could not be saved.');

export const rotateReviewServiceSecret = (supabase: SupabaseClient, id: string) =>
  sendJson<{ secret: string }>(supabase, `/v1/integrations/review-services/${encodeURIComponent(id)}/rotate-secret`, 'POST', {}, 'A new secret could not be created.');

export const deleteReviewService = (supabase: SupabaseClient, id: string) =>
  sendJson(supabase, `/v1/integrations/review-services/${encodeURIComponent(id)}`, 'DELETE', null, 'The service could not be deleted.');

export const testReviewService = (supabase: SupabaseClient, id: string) =>
  sendJson<{ ok: boolean; status?: number; ms?: number; error?: string }>(
    supabase,
    `/v1/integrations/review-services/${encodeURIComponent(id)}/test`,
    'POST',
    {},
    'The connection test could not run.',
  );

export interface Delivery {
  id: number;
  type: string;
  created_at: string;
  attempts: number;
  delivered_at: string | null;
  failed_at: string | null;
  last_error: string | null;
  next_attempt_at: string | null;
}

export async function listDeliveries(supabase: SupabaseClient, id: string): Promise<Delivery[]> {
  const res = await callApi(supabase, `/v1/integrations/review-services/${encodeURIComponent(id)}/deliveries`, 'GET');
  if (!res.ok) throw await apiError(res, 'The delivery log could not be loaded.');
  return (await res.json()) as Delivery[];
}

/** Names of the organization's review services, for any member. */
export async function listReviewServiceNames(supabase: SupabaseClient): Promise<{ id: string; name: string }[]> {
  const res = await callApi(supabase, '/v1/review-services', 'GET');
  if (!res.ok) throw await apiError(res, 'The review services could not be loaded.');
  return (await res.json()) as { id: string; name: string }[];
}

/** Address of the machine-readable format (OpenAPI) of the review service connection. */
export function externalSpecUrl(): string | null {
  const base = import.meta.env.VITE_API_URL as string | undefined;
  return base ? `${base.replace(/\/+$/, '')}/v1/external/spec` : null;
}

export interface VendorRiskCheck {
  id: string;
  source: string;
  hostname: string;
  data: { name?: string | null; hostname?: string | null; score?: number | null; categories?: { name: string; score: number | null }[]; url?: string | null };
  fetched_at: string;
}

export async function listVendorRiskChecks(supabase: SupabaseClient, requestId: string): Promise<VendorRiskCheck[]> {
  const { data, error } = await supabase
    .from('vendor_risk_checks')
    .select('id,source,hostname,data,fetched_at')
    .eq('request_id', requestId)
    .order('fetched_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  return data as VendorRiskCheck[];
}

export async function checkUpguard(supabase: SupabaseClient, requestId: string): Promise<VendorRiskCheck> {
  const res = await callApi(supabase, `/v1/requests/${requestId}/vendor-risk/upguard`, 'POST', 60_000, {});
  if (!res.ok) throw await apiError(res, 'UpGuard could not be reached.');
  return ((await res.json()) as { check: VendorRiskCheck }).check;
}

// ---------------------------------------------------------------------------
// Vendor catalog and metrics (read-only; RLS decides what each viewer sees)
// ---------------------------------------------------------------------------

export interface VendorRow {
  id: string;
  status: RequestStatus;
  service_name: string | null;
  risk_tier: string | null;
  is_confidential: boolean;
  archived_at: string | null;
  submitted_at: string | null;
  updated_at: string;
  answers: Answers;
  form: RequestFormDefinition | null;
  request_stages: { status: StageStatus; decided_at: string | null }[];
}

/** Approved requests, as vendor records. Archived ones are included; the catalog filters them. */
export async function listVendors(supabase: SupabaseClient): Promise<VendorRow[]> {
  const { data, error } = await supabase
    .from('requests')
    .select('id,status,service_name,risk_tier,is_confidential,archived_at,submitted_at,updated_at,answers,form,request_stages(status,decided_at)')
    .eq('status', 'approved')
    .is('deleted_at', null)
    .order('service_name');
  if (error) throw error;
  return data as unknown as VendorRow[];
}

export interface MetricsStage {
  name: string;
  status: StageStatus;
  created_at: string;
  decided_at: string | null;
  sla_due_at: string | null;
}

export interface MetricsRequest {
  id: string;
  status: RequestStatus;
  risk_tier: string | null;
  submitted_at: string | null;
  answers: Answers;
  request_stages: MetricsStage[];
}

export interface MetricsException {
  request_id: string;
  status: ExceptionStatus;
  expires_on: string;
  created_at: string;
}

/** Submitted requests with their stages, and exceptions, for the metrics page. */
export async function listMetricsData(supabase: SupabaseClient): Promise<{ requests: MetricsRequest[]; exceptions: MetricsException[] }> {
  const [requests, exceptions] = await Promise.all([
    supabase
      .from('requests')
      .select('id,status,risk_tier,submitted_at,answers,request_stages(name,status,created_at,decided_at,sla_due_at)')
      .neq('status', 'draft')
      .is('deleted_at', null),
    supabase.from('review_exceptions').select('request_id,status,expires_on,created_at'),
  ]);
  if (requests.error) throw requests.error;
  if (exceptions.error) throw exceptions.error;
  return { requests: requests.data as unknown as MetricsRequest[], exceptions: exceptions.data as MetricsException[] };
}
