import {
  ATTACHMENT_EXTENSIONS,
  ATTACHMENT_KINDS,
  checkAttachment,
  formatBytes,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_REQUEST,
} from '@app/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { FormError } from '../components/FormError';
import { errorMessage } from '../lib/errors';
import { attachmentDownloadUrl, deleteAttachment, listAttachments, uploadAttachment, type AttachmentRow } from './api';

interface Props {
  supabase: SupabaseClient;
  requestId: string;
  userId: string;
  /** Whether this person may add files right now. The server decides for real. */
  canUpload: boolean;
  /** Files can be removed by whoever added them while the request is a draft. */
  canRemoveOwn: boolean;
  nameOf: (userId: string | null) => string;
}

const formatDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium' });

/** Files of a request: list, download through a short-lived link, upload, remove. */
export function Attachments({ supabase, requestId, userId, canUpload, canRemoveOwn, nameOf }: Props) {
  const [files, setFiles] = useState<AttachmentRow[] | null>(null);
  const [kind, setKind] = useState<string>(ATTACHMENT_KINDS[0]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    try {
      setFiles(await listAttachments(supabase, requestId));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [supabase, requestId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function upload() {
    const file = input.current?.files?.[0];
    if (!file) {
      setError('Choose a file first.');
      return;
    }
    const checked = checkAttachment(file, kind);
    if ('error' in checked) {
      setError(`${checked.error}.`);
      return;
    }
    setBusy('upload');
    setError(null);
    try {
      await uploadAttachment(supabase, requestId, file, kind);
      if (input.current) input.current.value = '';
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function download(file: AttachmentRow) {
    setBusy(file.id);
    setError(null);
    try {
      // The link carries the file name, so the browser saves it instead of opening it.
      window.location.assign(await attachmentDownloadUrl(supabase, file.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove(file: AttachmentRow) {
    if (!window.confirm(`Remove ${file.filename}?`)) return;
    setBusy(file.id);
    setError(null);
    try {
      await deleteAttachment(supabase, file.id);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const full = (files?.length ?? 0) >= MAX_ATTACHMENTS_PER_REQUEST;

  return (
    <div className="attachments">
      <FormError message={error} />
      {files === null ? (
        <p role="status">Loading…</p>
      ) : files.length === 0 ? (
        <p className="empty">No files attached.</p>
      ) : (
        <ul className="member-list">
          {files.map((file) => (
            <li key={file.id}>
              <span className="member-email">
                <strong>{file.filename}</strong>
                <span className="stage-meta">
                  {' '}
                  {file.kind} · {formatBytes(file.size_bytes)} · {nameOf(file.uploaded_by)}
                  {file.uploaded_at ? ` · ${formatDate(file.uploaded_at)}` : ''}
                </span>
              </span>
              <button
                type="button"
                className="button button-secondary button-small"
                disabled={busy !== null}
                aria-label={`Download ${file.filename}`}
                onClick={() => void download(file)}
              >
                Download
              </button>
              {canRemoveOwn && file.uploaded_by === userId && (
                <button
                  type="button"
                  className="button button-secondary button-small"
                  disabled={busy !== null}
                  aria-label={`Remove ${file.filename}`}
                  onClick={() => void remove(file)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {files !== null && files.length > 0 && (
        <p className="field-hint">
          Files are not scanned for malware. Open only files from people and vendors you trust. Downloads are recorded in the
          audit log.
        </p>
      )}

      {canUpload && !full && (
        <div className="upload-form">
          <div className="field">
            <label htmlFor={`kind-${requestId}`}>Document</label>
            <select id={`kind-${requestId}`} className="role-select" value={kind} onChange={(e) => setKind(e.target.value)}>
              {ATTACHMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`file-${requestId}`}>File</label>
            <input
              id={`file-${requestId}`}
              ref={input}
              type="file"
              accept={ATTACHMENT_EXTENSIONS.map((e) => `.${e}`).join(',')}
              aria-describedby={`file-hint-${requestId}`}
            />
            <p id={`file-hint-${requestId}`} className="field-hint">
              {ATTACHMENT_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')}. Up to {formatBytes(MAX_ATTACHMENT_BYTES)} per file,{' '}
              {MAX_ATTACHMENTS_PER_REQUEST} files per request.
            </p>
          </div>
          <button type="button" className="button button-secondary" disabled={busy !== null} onClick={() => void upload()}>
            {busy === 'upload' ? 'Uploading…' : 'Attach file'}
          </button>
        </div>
      )}
      {canUpload && full && <p className="field-hint">This request has the maximum of {MAX_ATTACHMENTS_PER_REQUEST} files.</p>}
    </div>
  );
}
