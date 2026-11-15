// Files attached to a request (CLAUDE.md §5 step 7, §8 Files). Limits are enforced three
// times: here for a friendly message, in the database when a file is registered, and by
// the storage bucket itself. Keep the lists in sync with
// supabase/migrations/20261115000002_attachments.sql.

export const ATTACHMENT_KINDS = [
  'Quote',
  'Contract draft',
  'DPA',
  'SOC 2 / ISO report',
  'Security questionnaire',
  'Other',
] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_REQUEST = 20;
export const ATTACHMENT_BUCKET = 'attachments';

/** Allowed file types by extension. Archives and executables are deliberately left out. */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
};

export const ATTACHMENT_EXTENSIONS = Object.keys(ATTACHMENT_TYPES);

export interface AttachmentMeta {
  filename: string;
  contentType: string;
  size: number;
  kind: AttachmentKind;
}

/** Removes folders and control characters from a file name and limits its length. */
export function cleanFilename(raw: string): string {
  const name = (raw.split(/[\\/]/).pop() ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (name.length <= 200) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  return name.slice(0, 200 - extension.length) + extension;
}

/**
 * Checks a file before upload. The type comes from the extension, not from what the
 * browser reports, so the stored content type is always one we chose.
 */
export function checkAttachment(file: { name: string; size: number }, kind: string): { meta: AttachmentMeta } | { error: string } {
  const filename = cleanFilename(file.name);
  if (filename === '') return { error: 'The file has no name' };
  const extension = filename.includes('.') ? filename.slice(filename.lastIndexOf('.') + 1).toLowerCase() : '';
  const contentType = ATTACHMENT_TYPES[extension];
  if (!contentType) {
    return { error: `This file type is not allowed. Use ${ATTACHMENT_EXTENSIONS.map((e) => e.toUpperCase()).join(', ')}.` };
  }
  if (!Number.isInteger(file.size) || file.size <= 0) return { error: 'The file is empty' };
  if (file.size > MAX_ATTACHMENT_BYTES) return { error: `The file is larger than ${formatBytes(MAX_ATTACHMENT_BYTES)}` };
  if (!(ATTACHMENT_KINDS as readonly string[]).includes(kind)) return { error: 'Choose what kind of document this is' };
  return { meta: { filename, contentType, size: file.size, kind: kind as AttachmentKind } };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb >= 10 || Number.isInteger(mb) ? Math.round(mb) : mb.toFixed(1)} MB`;
}
