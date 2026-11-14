import type { Answers, StageDecision, StageStatus } from '@app/shared';
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
  requester_id: string;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
}

const LIST_COLUMNS = 'id,status,service_name,request_type,risk_tier,requester_id,created_at,updated_at,submitted_at';

export type RequestSummary = Omit<RequestRow, 'answers' | 'risk_score' | 'risk_reasons'>;

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
}

const STAGE_COLUMNS =
  'id,request_id,position,name,status,note,reviewer_id,sla_due_at,sla_paused,checklist,decision_comment,conditions,decided_by,decided_at';

export async function listStages(supabase: SupabaseClient, requestId: string): Promise<StageRow[]> {
  const { data, error } = await supabase.from('request_stages').select(STAGE_COLUMNS).eq('request_id', requestId).order('position');
  if (error) throw error;
  return data as StageRow[];
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

/** Submission goes through our API, which validates the answers and computes the risk tier. */
export async function submitRequest(supabase: SupabaseClient, id: string): Promise<void> {
  const apiUrl = import.meta.env.VITE_API_URL;
  if (!apiUrl) throw new SubmitError('The API address is not configured. Set VITE_API_URL in apps/web/.env.');
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new SubmitError('Your session has expired. Sign in again.');
  let res: Response;
  try {
    res = await fetch(`${apiUrl.replace(/\/+$/, '')}/v1/requests/${id}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    throw new SubmitError('Could not reach the API. Check that it is running and try again.');
  }
  if (res.ok) return;
  const body = (await res.json().catch(() => null)) as { error?: string; fields?: Record<string, string> } | null;
  throw new SubmitError(body?.error ?? 'The request could not be submitted.', body?.fields);
}
