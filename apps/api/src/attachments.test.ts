import type { AttachmentMeta } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { RefusedError, type AttachmentRecord, type AttachmentStore } from './attachments';
import { UnauthorizedError } from './requests';
import { supabaseAttachmentStore } from './supabaseAttachments';

const REQ = '11111111-2222-4333-8444-555555555555';
const ATT = '22222222-2222-4333-8444-555555555555';
const record: AttachmentRecord = { id: ATT, org_id: 'org', request_id: REQ, filename: 'Quote 2026.pdf', storage_path: `org/${REQ}/${ATT}`, status: 'uploaded' };

function setup(over: Partial<AttachmentStore> = {}, attachment: AttachmentRecord | null = record) {
  const log: string[] = [];
  const registered: AttachmentMeta[] = [];
  const store: AttachmentStore = {
    async register(_token, _requestId, meta) {
      registered.push(meta);
      return { id: ATT, path: record.storage_path };
    },
    async getAsUser() {
      return attachment;
    },
    async deleteAsUser() {
      log.push('delete row');
      return record.storage_path;
    },
    async userId() {
      return 'user-1';
    },
    async signUpload(path) {
      log.push(`sign upload ${path}`);
      return 'upload-token';
    },
    async objectSize() {
      return 2048;
    },
    async removeObject(path) {
      log.push(`remove ${path}`);
    },
    async markUploaded(id, size) {
      log.push(`uploaded ${id} ${size}`);
    },
    async auditDownload(a, actor) {
      log.push(`audit ${a.id} ${actor}`);
    },
    async signDownload(path, filename, seconds) {
      log.push(`sign download ${seconds}`);
      return `https://storage.example/${path}?token=t&download=${encodeURIComponent(filename)}`;
    },
    ...over,
  };
  const app = createApp({ attachments: store });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = { authorization: 'Bearer t' }) =>
    app.request(`/v1${path}`, { method, headers: { ...headers, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { call, log, registered };
}

describe('starting an upload', () => {
  const body = { filename: 'C:\\docs\\Quote 2026.PDF', size: 1000, kind: 'Quote', contentType: 'text/html' };

  it('registers the file and returns a one-time upload token', async () => {
    const { call, log, registered } = setup();
    const res = await call('POST', `/requests/${REQ}/attachments`, body);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: ATT, path: record.storage_path, token: 'upload-token', contentType: 'application/pdf' });
    // Name cleaned, type derived from the extension rather than taken from the client.
    expect(registered).toEqual([{ filename: 'Quote 2026.PDF', contentType: 'application/pdf', size: 1000, kind: 'Quote' }]);
    expect(log).toEqual([`sign upload ${record.storage_path}`]);
  });

  it.each([
    [{ ...body, filename: 'tool.exe' }, 422],
    [{ ...body, size: 26214401 }, 422],
    [{ ...body, kind: 'Invoice' }, 422],
    [{ ...body, size: '1000' }, 400],
    [{ filename: 'a.pdf' }, 400],
  ])('rejects %j before touching the database or storage', async (bad, status) => {
    const { call, log, registered } = setup();
    expect((await call('POST', `/requests/${REQ}/attachments`, bad)).status).toBe(status);
    expect(registered).toEqual([]);
    expect(log).toEqual([]);
  });

  it('passes on a refusal from the database and signs nothing', async () => {
    const { call, log } = setup({
      async register() {
        throw new RefusedError('You cannot attach files to this request', 403);
      },
    });
    const res = await call('POST', `/requests/${REQ}/attachments`, body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'You cannot attach files to this request' });
    expect(log).toEqual([]);
  });

  it('requires a session', async () => {
    expect((await setup().call('POST', `/requests/${REQ}/attachments`, body, {})).status).toBe(401);
    const expired = setup({
      async register() {
        throw new UnauthorizedError();
      },
    });
    expect((await expired.call('POST', `/requests/${REQ}/attachments`, body)).status).toBe(401);
  });
});

describe('finishing an upload', () => {
  const pending: AttachmentRecord = { ...record, status: 'pending' };

  it('marks the file uploaded with its real size', async () => {
    const { call, log } = setup({}, pending);
    expect((await call('POST', `/attachments/${ATT}/complete`)).status).toBe(200);
    expect(log).toEqual([`uploaded ${ATT} 2048`]);
  });

  it('refuses when nothing was uploaded', async () => {
    const { call, log } = setup({ objectSize: async () => null }, pending);
    expect((await call('POST', `/attachments/${ATT}/complete`)).status).toBe(409);
    expect(log).toEqual([]);
  });

  it('removes a file that is larger than allowed', async () => {
    const { call, log } = setup({ objectSize: async () => 26214401 }, pending);
    expect((await call('POST', `/attachments/${ATT}/complete`)).status).toBe(413);
    expect(log).toEqual([`remove ${record.storage_path}`]);
  });

  it('is harmless to repeat, and hides attachments the caller cannot see', async () => {
    const done = setup();
    expect((await done.call('POST', `/attachments/${ATT}/complete`)).status).toBe(200);
    expect(done.log).toEqual([]);
    expect((await setup({}, null).call('POST', `/attachments/${ATT}/complete`)).status).toBe(404);
  });
});

describe('downloading', () => {
  it('writes the audit log before handing out a link valid for one minute', async () => {
    const { call, log } = setup();
    const res = await call('GET', `/attachments/${ATT}/download`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: `https://storage.example/${record.storage_path}?token=t&download=Quote%202026.pdf`,
      expiresIn: 60,
    });
    expect(log).toEqual([`audit ${ATT} user-1`, 'sign download 60']);
  });

  it('gives no link when the audit entry cannot be written', async () => {
    const { call, log } = setup({
      async auditDownload() {
        throw new Error('database down');
      },
    });
    expect((await call('GET', `/attachments/${ATT}/download`)).status).toBe(500);
    expect(log).toEqual([]);
  });

  it('hides files the caller cannot see, unfinished uploads and malformed ids', async () => {
    expect((await setup({}, null).call('GET', `/attachments/${ATT}/download`)).status).toBe(404);
    expect((await setup({}, { ...record, status: 'pending' }).call('GET', `/attachments/${ATT}/download`)).status).toBe(404);
    expect((await setup().call('GET', '/attachments/not-a-uuid/download')).status).toBe(404);
    expect((await setup().call('GET', `/attachments/${ATT}/download`, undefined, {})).status).toBe(401);
  });
});

describe('removing', () => {
  it('removes the record as the user, then the file', async () => {
    const { call, log } = setup();
    expect((await call('DELETE', `/attachments/${ATT}`)).status).toBe(204);
    expect(log).toEqual(['delete row', `remove ${record.storage_path}`]);
  });

  it('leaves the file alone when the database refuses', async () => {
    const { call, log } = setup({
      async deleteAsUser() {
        throw new RefusedError('Files cannot be removed after the request was submitted', 422);
      },
    });
    expect((await call('DELETE', `/attachments/${ATT}`)).status).toBe(422);
    expect(log).toEqual([]);
  });
});

describe('supabaseAttachmentStore', () => {
  const config = { url: 'https://p.supabase.co', publishableKey: 'pub', serviceRoleKey: 'secret' };
  const path = `org/${REQ}/${ATT}`;

  function fake(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    return { store: supabaseAttachmentStore(config, impl), calls };
  }
  const key = (call: { init: RequestInit | undefined }) => (call.init!.headers as Record<string, string>).apikey;

  it('registers and deletes with the user token, never the secret key', async () => {
    const { store, calls } = fake(200, { id: ATT, path });
    await store.register('user-token', REQ, { filename: 'a.pdf', contentType: 'application/pdf', size: 5, kind: 'Quote' });
    expect(calls[0]!.url).toBe('https://p.supabase.co/rest/v1/rpc/register_attachment');
    expect(key(calls[0]!)).toBe('pub');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer user-token');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ p_request_id: REQ, p_filename: 'a.pdf', p_content_type: 'application/pdf', p_size: 5, p_kind: 'Quote' });
  });

  it.each([
    ['P0001', 422],
    ['P0002', 404],
    ['42501', 403],
  ] as const)('maps database refusal %s to %i with a readable message', async (code, status) => {
    const { store } = fake(400, { code, message: 'a request can have at most 20 files' });
    const failure = store.deleteAsUser('t', ATT);
    await expect(failure).rejects.toBeInstanceOf(RefusedError);
    await expect(failure).rejects.toMatchObject({ status, message: 'A request can have at most 20 files' });
  });

  it('signs uploads and downloads with the secret key and the right endpoints', async () => {
    const upload = fake(200, { url: `/object/upload/sign/attachments/${path}?token=up-token` });
    expect(await upload.store.signUpload(path)).toBe('up-token');
    expect(upload.calls[0]!.url).toBe(`https://p.supabase.co/storage/v1/object/upload/sign/attachments/${path}`);
    expect(key(upload.calls[0]!)).toBe('secret');

    const download = fake(200, { signedURL: `/object/sign/attachments/${path}?token=dl-token` });
    expect(await download.store.signDownload(path, 'Quote 2026.pdf', 60)).toBe(
      `https://p.supabase.co/storage/v1/object/sign/attachments/${path}?token=dl-token&download=Quote%202026.pdf`,
    );
    expect(JSON.parse(download.calls[0]!.init!.body as string)).toEqual({ expiresIn: 60 });
  });

  it('reads the size of a stored file and reports a missing one', async () => {
    expect(await fake(200, { size: 2048 }).store.objectSize(path)).toBe(2048);
    expect(await fake(404, { message: 'not found' }).store.objectSize(path)).toBeNull();
    expect(await fake(400, { message: 'Object not found' }).store.objectSize(path)).toBeNull();
  });

  it('removes a file by its exact path', async () => {
    const { store, calls } = fake(200, []);
    await store.removeObject(path);
    expect(calls[0]!.url).toBe('https://p.supabase.co/storage/v1/object/attachments');
    expect(calls[0]!.init!.method).toBe('DELETE');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ prefixes: [path] });
  });
});
