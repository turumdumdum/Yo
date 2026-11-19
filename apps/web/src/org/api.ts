import { apiError, callApi } from '../requests/api';
import type { OrgRole } from '@app/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface Organization {
  id: string;
  name: string;
  allow_self_review: boolean;
  restrict_to_verified_domains: boolean;
}

export interface Domain {
  id: string;
  domain: string;
  verified_at: string | null;
}

/** One invitation as the API reports it: emailed, or with a link to share by hand, or refused. */
export interface InvitationOutcome {
  email: string;
  role: OrgRole;
  emailed: boolean;
  /** Present when the email was not sent: share it by hand. Not shown again later. */
  link?: string;
  emailError?: string;
  /** Present when the invitation was refused. */
  error?: string;
}

export interface Membership {
  role: OrgRole;
  organization: Organization;
}

export interface Member {
  user_id: string;
  email: string | null;
  role: OrgRole;
}

export interface Invitation {
  id: string;
  email: string;
  role: OrgRole;
  expires_at: string;
  accepted_at: string | null;
}

export async function loadMembership(supabase: SupabaseClient, userId: string): Promise<Membership | null> {
  const { data, error } = await supabase
    .from('memberships')
    .select('role, organizations(id, name, allow_self_review, restrict_to_verified_domains)')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle<{ role: OrgRole; organizations: Organization }>();
  if (error) throw error;
  return data ? { role: data.role, organization: data.organizations } : null;
}

export async function listMembers(supabase: SupabaseClient, orgId: string): Promise<Member[]> {
  const { data, error } = await supabase.from('memberships').select('user_id,email,role').eq('org_id', orgId).order('email');
  if (error) throw error;
  return data as Member[];
}

export async function changeRole(supabase: SupabaseClient, orgId: string, userId: string, role: OrgRole): Promise<void> {
  const { data, error } = await supabase.from('memberships').update({ role }).eq('org_id', orgId).eq('user_id', userId).select('user_id');
  if (error) throw error;
  if (data.length === 0) throw new Error('The role could not be changed.');
}

export async function removeMember(supabase: SupabaseClient, orgId: string, userId: string): Promise<void> {
  const { data, error } = await supabase.from('memberships').delete().eq('org_id', orgId).eq('user_id', userId).select('user_id');
  if (error) throw error;
  if (data.length === 0) throw new Error('The member could not be removed.');
}

export async function listInvitations(supabase: SupabaseClient, orgId: string): Promise<Invitation[]> {
  const { data, error } = await supabase
    .from('invitations')
    .select('id,email,role,expires_at,accepted_at')
    .eq('org_id', orgId)
    .is('accepted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as Invitation[];
}

/**
 * Creates invitations through the API, which emails each link when email is set up.
 * The database still checks the org-admin role and the domain rules.
 */
export async function sendInvitations(supabase: SupabaseClient, rows: { email: string; role: OrgRole }[]): Promise<InvitationOutcome[]> {
  const res = await callApi(supabase, '/v1/invitations', 'POST', 60_000, { invitations: rows });
  if (!res.ok) throw await apiError(res, 'The invitations could not be created.');
  return ((await res.json()) as { results: InvitationOutcome[] }).results;
}

export async function revokeInvitation(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase.from('invitations').delete().eq('id', id);
  if (error) throw error;
}

export async function acceptInvitation(supabase: SupabaseClient, token: string): Promise<void> {
  const { error } = await supabase.rpc('accept_invitation', { p_token: token });
  if (error) throw error;
}

export async function setAllowSelfReview(supabase: SupabaseClient, orgId: string, allow: boolean): Promise<void> {
  const { data, error } = await supabase.from('organizations').update({ allow_self_review: allow }).eq('id', orgId).select('id');
  if (error) throw error;
  if (data.length === 0) throw new Error('The setting could not be changed.');
}

export async function listDomains(supabase: SupabaseClient, orgId: string): Promise<Domain[]> {
  const { data, error } = await supabase.from('verified_domains').select('id,domain,verified_at').eq('org_id', orgId).order('domain');
  if (error) throw error;
  return data as Domain[];
}

export async function addDomain(supabase: SupabaseClient, orgId: string, domain: string): Promise<void> {
  const { error } = await supabase.from('verified_domains').insert({ org_id: orgId, domain });
  if (error) throw error.code === '23505' ? new Error(`${domain} is already on the list.`) : error;
}

export async function removeDomain(supabase: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await supabase.from('verified_domains').delete().eq('id', id).select('id');
  if (error) throw error;
  if (data.length === 0) throw new Error('The domain could not be removed.');
}

export async function setRestrictToDomains(supabase: SupabaseClient, orgId: string, restrict: boolean): Promise<void> {
  const { data, error } = await supabase
    .from('organizations')
    .update({ restrict_to_verified_domains: restrict })
    .eq('id', orgId)
    .select('id');
  if (error) throw error;
  if (data.length === 0) throw new Error('The setting could not be changed.');
}
