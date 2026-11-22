import { ATTACHMENT_BUCKET, type AttachmentMeta } from '@app/shared';
import { RefusedError, type AttachmentRecord, type AttachmentStore } from './attachments';
import { UnauthorizedError } from './requests';
import type { SupabaseConfig } from './supabaseStore';

/** Attachments on Supabase: metadata through PostgREST, files through the Storage API. */
export function supabaseAttachmentStore(config: SupabaseConfig, fetchImpl: typeof fetch = fetch): AttachmentStore {
  const base = config.url.replace(/\/+$/, '');
  const rest = `${base}/rest/v1`;
  const storage = `${base}/storage/v1`;
  // Download links are opened by the browser, so they use the public address.
  const publicStorage = `${(config.publicUrl || config.url).replace(/\/+$/, '')}/storage/v1`;
  const service = { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, 'content-type': 'application/json' };
  const asUser = (token: string) => ({ apikey: config.publishableKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' });
  // Paths are made of UUIDs, but encode each segment anyway.
  const objectUrl = (prefix: string, path: string) => `${storage}/object/${prefix}${ATTACHMENT_BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;

  /** Calls a database function as the user and turns its refusals into RefusedError. */
  async function rpcAsUser<T>(token: string, name: string, args: Record<string, unknown>): Promise<T> {
    const res = await fetchImpl(`${rest}/rpc/${name}`, { method: 'POST', headers: asUser(token), body: JSON.stringify(args) });
    if (res.ok) return (await res.json()) as T;
    if (res.status === 401) throw new UnauthorizedError();
    const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    const message = body?.message ? body.message.charAt(0).toUpperCase() + body.message.slice(1) : 'The request was refused';
    if (body?.code === 'P0001') throw new RefusedError(message, 422);
    if (body?.code === 'P0002') throw new RefusedError(message, 404);
    if (body?.code === '42501') throw new RefusedError(message, 403);
    throw new Error(`Supabase responded ${res.status} to ${name}`);
  }

  async function serviceCall(what: string, url: string, init: RequestInit): Promise<Response> {
    const res = await fetchImpl(url, { ...init, headers: service });
    if (!res.ok) throw new Error(`Supabase responded ${res.status} when ${what}`);
    return res;
  }

  return {
    register(token: string, requestId: string, meta: AttachmentMeta) {
      return rpcAsUser<{ id: string; path: string }>(token, 'register_attachment', {
        p_request_id: requestId,
        p_filename: meta.filename,
        p_content_type: meta.contentType,
        p_size: meta.size,
        p_kind: meta.kind,
      });
    },

    async getAsUser(token, attachmentId): Promise<AttachmentRecord | null> {
      const query = new URLSearchParams({ id: `eq.${attachmentId}`, select: 'id,org_id,request_id,filename,storage_path,status' });
      const res = await fetchImpl(`${rest}/attachments?${query}`, { headers: asUser(token) });
      if (res.status === 401 || res.status === 403) throw new UnauthorizedError();
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading an attachment`);
      return ((await res.json()) as AttachmentRecord[])[0] ?? null;
    },

    deleteAsUser(token, attachmentId) {
      return rpcAsUser<string>(token, 'delete_attachment', { p_attachment_id: attachmentId });
    },

    async userId(token) {
      const res = await fetchImpl(`${base}/auth/v1/user`, { headers: asUser(token) });
      if (res.status === 401 || res.status === 403) throw new UnauthorizedError();
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading the user`);
      return ((await res.json()) as { id: string }).id;
    },

    async signUpload(path) {
      const res = await serviceCall('signing an upload', objectUrl('upload/sign/', path), { method: 'POST', body: '{}' });
      const { url } = (await res.json()) as { url: string };
      const token = new URL(url, base).searchParams.get('token');
      if (!token) throw new Error('Supabase returned no upload token');
      return token;
    },

    async objectSize(path) {
      const res = await fetchImpl(objectUrl('info/', path), { headers: service });
      // Storage answers 400 or 404 for an object that does not exist.
      if (res.status === 404 || res.status === 400) return null;
      if (!res.ok) throw new Error(`Supabase responded ${res.status} when reading file information`);
      const info = (await res.json()) as { size?: number; metadata?: { size?: number } };
      return info.size ?? info.metadata?.size ?? null;
    },

    async removeObject(path) {
      await serviceCall('removing a file', `${storage}/object/${ATTACHMENT_BUCKET}`, { method: 'DELETE', body: JSON.stringify({ prefixes: [path] }) });
    },

    async markUploaded(attachmentId, size) {
      await serviceCall('confirming an upload', `${rest}/rpc/complete_attachment`, {
        method: 'POST',
        body: JSON.stringify({ p_attachment_id: attachmentId, p_actual_size: size }),
      });
    },

    async auditDownload(attachment, actorId) {
      await serviceCall('writing the audit log', `${rest}/audit_log`, {
        method: 'POST',
        body: JSON.stringify({
          org_id: attachment.org_id,
          actor_id: actorId,
          action: 'attachment.downloaded',
          entity_type: 'attachment',
          entity_id: attachment.id,
          metadata: { request_id: attachment.request_id, filename: attachment.filename },
        }),
      });
    },

    async signDownload(path, filename, seconds) {
      const res = await serviceCall('signing a download', objectUrl('sign/', path), { method: 'POST', body: JSON.stringify({ expiresIn: seconds }) });
      const { signedURL } = (await res.json()) as { signedURL: string };
      return `${publicStorage}${signedURL}&download=${encodeURIComponent(filename)}`;
    },
  };
}
