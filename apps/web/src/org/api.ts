import type { OrgRole } from '@app/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface Organization {
  id: string;
  name: string;
  allow_self_review: boolean;
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
    .select('role, organizations(id, name, allow_self_review)')
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

/** Returns the one-time token. It is shown once and never stored in readable form. */
export async function createInvitation(supabase: SupabaseClient, orgId: string, email: string, role: OrgRole): Promise<string> {
  const { data, error } = await supabase.rpc('create_invitation', { p_org_id: orgId, p_email: email, p_role: role });
  if (error) throw error;
  return data as string;
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
