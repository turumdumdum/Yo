import { describe, expect, it } from 'vitest';
import { checkAttachment, cleanFilename, formatBytes, MAX_ATTACHMENT_BYTES } from './attachments';

describe('checkAttachment', () => {
  it('accepts an allowed file and takes the type from the extension', () => {
    expect(checkAttachment({ name: 'Acme SOC2 Report.PDF', size: 1234 }, 'SOC 2 / ISO report')).toEqual({
      meta: { filename: 'Acme SOC2 Report.PDF', contentType: 'application/pdf', size: 1234, kind: 'SOC 2 / ISO report' },
    });
    expect(checkAttachment({ name: 'quote.xlsx', size: 1 }, 'Quote')).toMatchObject({
      meta: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
    });
  });

  it.each([
    [{ name: 'malware.exe', size: 10 }, 'Other', /not allowed/],
    [{ name: 'archive.zip', size: 10 }, 'Other', /not allowed/],
    [{ name: 'page.html', size: 10 }, 'Other', /not allowed/],
    [{ name: 'report.pdf.exe', size: 10 }, 'Other', /not allowed/],
    [{ name: 'noextension', size: 10 }, 'Other', /not allowed/],
    [{ name: 'empty.pdf', size: 0 }, 'Other', /empty/],
    [{ name: 'big.pdf', size: MAX_ATTACHMENT_BYTES + 1 }, 'Other', /larger than 25 MB/],
    [{ name: 'a.pdf', size: 10 }, 'Invoice', /what kind/],
    [{ name: '   ', size: 10 }, 'Other', /no name/],
  ])('rejects %j as %s', (file, kind, message) => {
    const result = checkAttachment(file, kind);
    expect('error' in result ? result.error : '').toMatch(message);
  });

  it('accepts a file of exactly the maximum size', () => {
    expect('meta' in checkAttachment({ name: 'max.pdf', size: MAX_ATTACHMENT_BYTES }, 'Other')).toBe(true);
  });
});

describe('cleanFilename', () => {
  it.each([
    ['C:\\Users\\ann\\quote.pdf', 'quote.pdf'],
    ['../../etc/passwd.txt', 'passwd.txt'],
    ['  report\u0000\n.pdf ', 'report.pdf'],
  ])('turns %j into %j', (raw, clean) => {
    expect(cleanFilename(raw)).toBe(clean);
  });

  it('shortens long names but keeps the extension', () => {
    const name = cleanFilename('x'.repeat(300) + '.pdf');
    expect(name).toHaveLength(200);
    expect(name.endsWith('.pdf')).toBe(true);
  });
});

describe('formatBytes', () => {
  it.each([
    [512, '512 B'],
    [2048, '2 KB'],
    [1.5 * 1024 * 1024, '1.5 MB'],
    [25 * 1024 * 1024, '25 MB'],
  ])('%i -> %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});
