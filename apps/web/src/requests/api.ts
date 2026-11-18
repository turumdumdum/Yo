import { ATTACHMENT_BUCKET } from '@app/shared';
import type {
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
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

const LIST_COLUMNS = 'id,status,service_name,request_type,risk_tier,requester_id,created_at,updated_at,submitted_at,request_stages(status)';

export type RequestSummary = Omit<RequestRow, 'answers' | 'risk_score' | 'risk_reasons' | 'form'> & {
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
}

const STAGE_COLUMNS =
  'id,request_id,position,name,status,note,reviewer_id,sla_due_at,sla_paused,checklist,decision_comment,conditions,decided_by,decided_at,review_fields,review_rules';

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
}

/** Open stages of requests the caller can see, most urgent first. */
export async function listOpenStages(supabase: SupabaseClient): Promise<QueueItem[]> {
  const { data, error } = await supabase
    .from('request_stages')
    .select('id,request_id,name,status,reviewer_id,sla_due_at,requests(service_name,requester_id,risk_tier)')
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

async function callApi(
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

async function apiError(res: Response, fallback: string): Promise<SubmitError> {
  const body = (await res.json().catch(() => null)) as { error?: string; fields?: Record<string, string> } | null;
  return new SubmitError(body?.error ?? fallback, body?.fields);
}

/** Submission goes through our API, which validates the answers and computes the risk tier. */
export async function submitRequest(supabase: SupabaseClient, id: string): Promise<void> {
  const res = await callApi(supabase, `/v1/requests/${id}/submit`, 'POST');
  if (!res.ok) throw await apiError(res, 'The request could not be submitted.');
}

const AI_OFF: AiStatus = { enabled: false, provider: null };

/** The API gives up on the provider after about two minutes; the browser waits a little longer. */
const AI_TIMEOUT_MS = 150_000;

/** Whether the optional AI plugin is configured. Any failure simply means "no AI". */
export async function aiStatus(supabase: SupabaseClient): Promise<AiStatus> {
  try {
    const res = await callApi(supabase, '/v1/ai', 'GET');
    return res.ok ? ((await res.json()) as AiStatus) : AI_OFF;
  } catch {
    return AI_OFF;
  }
}

export async function aiSuggestions(supabase: SupabaseClient, id: string): Promise<AiSuggestion[]> {
  const res = await callApi(supabase, `/v1/requests/${id}/ai/suggestions`, 'POST', AI_TIMEOUT_MS);
  if (!res.ok) throw await apiError(res, 'The AI could not suggest anything.');
  return ((await res.json()) as { suggestions: AiSuggestion[] }).suggestions;
}

export async function aiCheck(supabase: SupabaseClient, id: string): Promise<AiRemark[]> {
  const res = await callApi(supabase, `/v1/requests/${id}/ai/check`, 'POST', AI_TIMEOUT_MS);
  if (!res.ok) throw await apiError(res, 'The AI could not check the answers.');
  return ((await res.json()) as { remarks: AiRemark[] }).remarks;
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
