import { ORG_ROLE_LABELS, ORG_ROLES, type OrgRole } from './domain';

// Reads a list of people to invite from CSV or JSON, as exported by spreadsheets or HR
// tools. Rows that cannot be used are reported with their line, never silently dropped.

export const MAX_INVITATIONS_PER_IMPORT = 500;

export interface InviteRow {
  email: string;
  role: OrgRole;
}

export interface InviteImportProblem {
  /** 1-based line (CSV) or item number (JSON). */
  line: number;
  message: string;
}

export interface InviteImportResult {
  rows: InviteRow[];
  problems: InviteImportProblem[];
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const ROLE_BY_NAME = new Map<string, OrgRole>();
for (const role of ORG_ROLES) {
  ROLE_BY_NAME.set(role, role);
  ROLE_BY_NAME.set(ORG_ROLE_LABELS[role].toLowerCase(), role);
  ROLE_BY_NAME.set(role.replace('_', ' '), role);
}

/** Accepts "reviewer", "Reviewer", "process_manager", "Process manager" and so on. */
export function parseRole(raw: string): OrgRole | undefined {
  return ROLE_BY_NAME.get(raw.trim().toLowerCase().replace(/\s+/g, ' '));
}

/** Splits CSV text into rows of cells. Handles quotes, escaped quotes, commas and semicolons. */
export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  // Spreadsheets in many European locales export with semicolons.
  const separator = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === separator) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function finish(candidates: { line: number; email: string; role: string }[], defaultRole: OrgRole): InviteImportResult {
  const rows: InviteRow[] = [];
  const problems: InviteImportProblem[] = [];
  const seen = new Set<string>();
  for (const { line, email: rawEmail, role: rawRole } of candidates) {
    const email = rawEmail.trim().toLowerCase();
    if (email === '') {
      problems.push({ line, message: 'No email address' });
      continue;
    }
    if (email.length > 254 || !EMAIL.test(email)) {
      problems.push({ line, message: `"${rawEmail.trim()}" is not a valid email address` });
      continue;
    }
    const role = rawRole.trim() === '' ? defaultRole : parseRole(rawRole);
    if (!role) {
      problems.push({ line, message: `Unknown role "${rawRole.trim()}"` });
      continue;
    }
    if (seen.has(email)) {
      problems.push({ line, message: `${email} is listed more than once` });
      continue;
    }
    seen.add(email);
    rows.push({ email, role });
  }
  if (rows.length > MAX_INVITATIONS_PER_IMPORT) {
    problems.push({ line: 0, message: `At most ${MAX_INVITATIONS_PER_IMPORT} people at a time; split the file.` });
    return { rows: rows.slice(0, MAX_INVITATIONS_PER_IMPORT), problems };
  }
  return { rows, problems };
}

function fromCsv(text: string, defaultRole: OrgRole): InviteImportResult {
  const table = parseCsv(text).filter((cells) => cells.some((c) => c.trim() !== ''));
  if (table.length === 0) return { rows: [], problems: [{ line: 0, message: 'The file is empty' }] };
  const header = table[0]!.map((c) => c.trim().toLowerCase().replace(/^﻿/, ''));
  const emailColumn = header.findIndex((h) => h === 'email' || h === 'e-mail' || h === 'email address');
  const hasHeader = emailColumn !== -1;
  const roleColumn = hasHeader ? header.indexOf('role') : 1;
  const start = hasHeader ? 1 : 0;
  const candidates = table.slice(start).map((cells, i) => ({
    // Blank lines were removed, so count from the original text for the message.
    line: i + start + 1,
    email: cells[hasHeader ? emailColumn : 0] ?? '',
    role: roleColumn === -1 ? '' : (cells[roleColumn] ?? ''),
  }));
  return finish(candidates, defaultRole);
}

function fromJson(text: string, defaultRole: OrgRole): InviteImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { rows: [], problems: [{ line: 0, message: 'The JSON could not be read' }] };
  }
  // Accept a bare list or an object wrapping it, such as {"invitations": [...]}.
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    data = Object.values(data).find(Array.isArray);
  }
  if (!Array.isArray(data)) {
    return { rows: [], problems: [{ line: 0, message: 'Expected a list of people, for example [{"email": "...", "role": "reviewer"}]' }] };
  }
  const problems: InviteImportProblem[] = [];
  const candidates: { line: number; email: string; role: string }[] = [];
  data.forEach((item, i) => {
    if (typeof item === 'string') candidates.push({ line: i + 1, email: item, role: '' });
    else if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      candidates.push({
        line: i + 1,
        email: typeof record.email === 'string' ? record.email : '',
        role: typeof record.role === 'string' ? record.role : '',
      });
    } else problems.push({ line: i + 1, message: 'Not an email address or an object with "email"' });
  });
  const result = finish(candidates, defaultRole);
  return { rows: result.rows, problems: [...problems, ...result.problems].sort((a, b) => a.line - b.line) };
}

/** Reads CSV or JSON. The format is taken from the content: JSON starts with [ or {. */
export function parseInviteImport(text: string, defaultRole: OrgRole): InviteImportResult {
  const trimmed = text.replace(/^﻿/, '').trim();
  if (trimmed === '') return { rows: [], problems: [{ line: 0, message: 'Nothing to import' }] };
  return trimmed.startsWith('[') || trimmed.startsWith('{') ? fromJson(trimmed, defaultRole) : fromCsv(trimmed, defaultRole);
}

/** CSV with one invitation link per person, for sending them out by hand or mail merge. */
export function invitationLinksCsv(links: { email: string; role: OrgRole; url: string }[]): string {
  const quote = (value: string) => (/[",;\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return ['email,role,invitation_link', ...links.map((l) => [l.email, ORG_ROLE_LABELS[l.role], l.url].map(quote).join(','))].join('\n') + '\n';
}

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Normalizes what an admin types as a domain: "@Acme.com", "https://acme.com/" -> "acme.com". */
export function normalizeDomain(raw: string): string | null {
  const domain = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
  return DOMAIN.test(domain) && domain.length <= 253 ? domain : null;
}

/** Domain part of an email address. */
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}
