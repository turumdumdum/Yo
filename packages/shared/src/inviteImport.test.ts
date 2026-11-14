import { describe, expect, it } from 'vitest';
import { emailDomain, invitationLinksCsv, normalizeDomain, parseCsv, parseInviteImport, parseRole } from './inviteImport';

describe('parseRole', () => {
  it.each([
    ['reviewer', 'reviewer'],
    ['Reviewer', 'reviewer'],
    ['process_manager', 'process_manager'],
    ['Process manager', 'process_manager'],
    ['  ORG ADMIN ', 'org_admin'],
    ['Auditor', 'auditor'],
  ])('reads %j', (raw, role) => {
    expect(parseRole(raw)).toBe(role);
  });

  it('rejects unknown roles', () => {
    expect(parseRole('superuser')).toBeUndefined();
  });
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes and line endings', () => {
    expect(parseCsv('a,"b, c","d ""e"""\r\n1,2,3')).toEqual([
      ['a', 'b, c', 'd "e"'],
      ['1', '2', '3'],
    ]);
  });

  it('detects semicolons', () => {
    expect(parseCsv('email;role\nann@a.example;Reviewer')).toEqual([
      ['email', 'role'],
      ['ann@a.example', 'Reviewer'],
    ]);
  });
});

describe('parseInviteImport', () => {
  it('reads CSV with a header, in any column order, with the default role for blanks', () => {
    const csv = '﻿Name,Role,Email\nAnn,Reviewer,Ann@A.example\nBo,,bo@a.example\n\nCy,Auditor,cy@a.example\n';
    expect(parseInviteImport(csv, 'requester')).toEqual({
      rows: [
        { email: 'ann@a.example', role: 'reviewer' },
        { email: 'bo@a.example', role: 'requester' },
        { email: 'cy@a.example', role: 'auditor' },
      ],
      problems: [],
    });
  });

  it('reads CSV without a header as email[,role]', () => {
    expect(parseInviteImport('ann@a.example,reviewer\nbo@a.example', 'requester').rows).toEqual([
      { email: 'ann@a.example', role: 'reviewer' },
      { email: 'bo@a.example', role: 'requester' },
    ]);
  });

  it('reports bad rows with their line and keeps the good ones', () => {
    const csv = 'email,role\nann@a.example,reviewer\nnot-an-email,reviewer\nbo@a.example,boss\nANN@a.example,auditor\n,reviewer';
    const result = parseInviteImport(csv, 'requester');
    expect(result.rows).toEqual([{ email: 'ann@a.example', role: 'reviewer' }]);
    expect(result.problems).toEqual([
      { line: 3, message: '"not-an-email" is not a valid email address' },
      { line: 4, message: 'Unknown role "boss"' },
      { line: 5, message: 'ann@a.example is listed more than once' },
      { line: 6, message: 'No email address' },
    ]);
  });

  it('reads JSON lists of objects or strings, and wrapped lists', () => {
    expect(parseInviteImport('[{"email": "ann@a.example", "role": "Process manager"}, "bo@a.example"]', 'requester').rows).toEqual([
      { email: 'ann@a.example', role: 'process_manager' },
      { email: 'bo@a.example', role: 'requester' },
    ]);
    expect(parseInviteImport('{"invitations": [{"email": "cy@a.example"}]}', 'auditor').rows).toEqual([
      { email: 'cy@a.example', role: 'auditor' },
    ]);
  });

  it('explains unreadable input', () => {
    expect(parseInviteImport('[{"email": ', 'requester').problems[0]!.message).toMatch(/could not be read/);
    expect(parseInviteImport('{"a": 1}', 'requester').problems[0]!.message).toMatch(/Expected a list/);
    expect(parseInviteImport('[42, {"email": "ann@a.example"}]', 'requester')).toEqual({
      rows: [{ email: 'ann@a.example', role: 'requester' }],
      problems: [{ line: 1, message: 'Not an email address or an object with "email"' }],
    });
    expect(parseInviteImport('   ', 'requester').problems[0]!.message).toBe('Nothing to import');
  });

  it('caps one import at 500 people', () => {
    const csv = Array.from({ length: 501 }, (_, i) => `u${i}@a.example`).join('\n');
    const result = parseInviteImport(csv, 'requester');
    expect(result.rows).toHaveLength(500);
    expect(result.problems[0]!.message).toMatch(/At most 500/);
  });
});

describe('helpers', () => {
  it('writes links as CSV with safe quoting', () => {
    expect(invitationLinksCsv([{ email: 'ann@a.example', role: 'process_manager', url: 'https://app.example/?invite=abc' }])).toBe(
      'email,role,invitation_link\nann@a.example,Process manager,https://app.example/?invite=abc\n',
    );
  });

  it.each([
    ['Acme.com', 'acme.com'],
    ['@acme.com', 'acme.com'],
    ['https://www.acme.com/about', 'acme.com'],
    ['mail.acme.co.uk', 'mail.acme.co.uk'],
    ['acme', null],
    ['ac me.com', null],
    ['-acme.com', null],
  ])('normalizes the domain %j', (raw, domain) => {
    expect(normalizeDomain(raw)).toBe(domain);
  });

  it('takes the domain of an email', () => {
    expect(emailDomain('Ann@Mail.Acme.com')).toBe('mail.acme.com');
  });
});
