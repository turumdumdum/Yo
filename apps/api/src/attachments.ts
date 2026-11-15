import { checkAttachment, MAX_ATTACHMENT_BYTES, type AttachmentMeta } from '@app/shared';
import { Hono, type Context } from 'hono';
import { UnauthorizedError } from './requests';

// Attachments (CLAUDE.md §8 Files). The storage bucket is private and has no access
// policies, so every upload and download goes through here: the database decides, as
// the calling user, whether they may; only then does the backend hand out a signed URL
// that is valid for a short time. Downloads are written to the audit log.
//
// Open gap: files are not scanned for malware.

export interface AttachmentRecord {
  id: string;
  org_id: string;
  request_id: string;
  filename: string;
  storage_path: string;
  status: 'pending' | 'uploaded';
}

/** A refusal from the database with a message meant for the user. */
export class RefusedError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 422,
  ) {
    super(message);
  }
}

export interface AttachmentStore {
  /** Registers a file as the calling user. Throws RefusedError when they may not, or a limit is hit. */
  register(accessToken: string, requestId: string, meta: AttachmentMeta): Promise<{ id: string; path: string }>;
  /** Reads an attachment as the calling user; null when they cannot see it. */
  getAsUser(accessToken: string, attachmentId: string): Promise<AttachmentRecord | null>;
  /** Removes the attachment record as the calling user and returns its storage path. */
  deleteAsUser(accessToken: string, attachmentId: string): Promise<string>;
  /** Id of the calling user, for the audit log. */
  userId(accessToken: string): Promise<string>;
  /** One-time token that lets the browser upload exactly this object. */
  signUpload(path: string): Promise<string>;
  /** Size of the stored object in bytes, or null when nothing was uploaded. */
  objectSize(path: string): Promise<number | null>;
  removeObject(path: string): Promise<void>;
  markUploaded(attachmentId: string, size: number): Promise<void>;
  auditDownload(attachment: AttachmentRecord, actorId: string): Promise<void>;
  /** URL that downloads the object under the given file name, valid for `seconds`. */
  signDownload(path: string, filename: string, seconds: number): Promise<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Long enough to start the download, short enough that a leaked link is useless. */
const DOWNLOAD_URL_SECONDS = 60;

export function attachmentRoutes(store: AttachmentStore) {
  const routes = new Hono();

  /** Runs a handler with the caller's token and maps the expected failures. */
  async function withToken(c: Context, handler: (token: string) => Promise<Response>): Promise<Response> {
    const token = c.req.header('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return c.json({ error: 'Sign in to continue' }, 401);
    try {
      return await handler(token);
    } catch (error) {
      if (error instanceof UnauthorizedError) return c.json({ error: 'Sign in to continue' }, 401);
      if (error instanceof RefusedError) return c.json({ error: error.message }, error.status);
      throw error;
    }
  }

  // Step 1 of an upload: check and register the file, get a one-time upload token.
  routes.post('/requests/:id/attachments', (c) =>
    withToken(c, async (token) => {
      const requestId = c.req.param('id') ?? '';
      if (!UUID.test(requestId)) return c.json({ error: 'Not found' }, 404);
      const body = (await c.req.json().catch(() => null)) as { filename?: unknown; size?: unknown; kind?: unknown } | null;
      if (!body || typeof body.filename !== 'string' || typeof body.size !== 'number' || typeof body.kind !== 'string') {
        return c.json({ error: 'Expected filename, size and kind' }, 400);
      }
      // The content type is derived from the extension here, never taken from the client.
      const checked = checkAttachment({ name: body.filename, size: body.size }, body.kind);
      if ('error' in checked) return c.json({ error: checked.error }, 422);
      const { id, path } = await store.register(token, requestId, checked.meta);
      const uploadToken = await store.signUpload(path);
      return c.json({ id, path, token: uploadToken, contentType: checked.meta.contentType }, 201);
    }),
  );

  // Step 2: the browser has uploaded the file; confirm it is really there.
  routes.post('/attachments/:id/complete', (c) =>
    withToken(c, async (token) => {
      const id = c.req.param('id') ?? '';
      if (!UUID.test(id)) return c.json({ error: 'Not found' }, 404);
      const attachment = await store.getAsUser(token, id);
      if (!attachment) return c.json({ error: 'Not found' }, 404);
      if (attachment.status === 'uploaded') return c.json({ id });
      const size = await store.objectSize(attachment.storage_path);
      if (size === null) return c.json({ error: 'The file has not been uploaded' }, 409);
      if (size < 1 || size > MAX_ATTACHMENT_BYTES) {
        await store.removeObject(attachment.storage_path);
        return c.json({ error: 'The uploaded file is empty or too large' }, 413);
      }
      await store.markUploaded(id, size);
      return c.json({ id });
    }),
  );

  routes.get('/attachments/:id/download', (c) =>
    withToken(c, async (token) => {
      const id = c.req.param('id') ?? '';
      if (!UUID.test(id)) return c.json({ error: 'Not found' }, 404);
      const attachment = await store.getAsUser(token, id);
      if (!attachment || attachment.status !== 'uploaded') return c.json({ error: 'Not found' }, 404);
      // Audit first: no link is handed out without a record of who asked for it.
      await store.auditDownload(attachment, await store.userId(token));
      const url = await store.signDownload(attachment.storage_path, attachment.filename, DOWNLOAD_URL_SECONDS);
      return c.json({ url, expiresIn: DOWNLOAD_URL_SECONDS });
    }),
  );

  routes.delete('/attachments/:id', (c) =>
    withToken(c, async (token) => {
      const id = c.req.param('id') ?? '';
      if (!UUID.test(id)) return c.json({ error: 'Not found' }, 404);
      const path = await store.deleteAsUser(token, id);
      await store.removeObject(path);
      return c.body(null, 204);
    }),
  );

  return routes;
}
