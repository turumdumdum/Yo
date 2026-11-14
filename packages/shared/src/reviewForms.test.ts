import { describe, expect, it } from 'vitest';
import {
  CERTIFICATIONS,
  DEFAULT_REVIEW_TEMPLATES,
  defaultReviewTemplate,
  parseReviewTemplate,
  reviewConcerns,
  validateReviewAnswers,
  type ReviewFieldDef,
  type ReviewTemplate,
} from './reviewForms';

const security = DEFAULT_REVIEW_TEMPLATES['Security review']!;
const now = new Date('2026-11-14T12:00:00Z');

const goodAnswers = {
  certifications: ['SOC 2 Type II', 'ISO/IEC 27001'],
  reportDate: '2026-06-30',
  mfa: 'Enforced for all users',
  encryptionAtRest: 'Yes',
  residualRisk: 'Low',
};

describe('default security review form', () => {
  it('is a valid template', () => {
    expect(parseReviewTemplate(security)).toEqual({ template: security });
  });

  it('offers the common certifications and has a conclusion', () => {
    expect(security.fields[0]!.options).toEqual(CERTIFICATIONS);
    expect(security.fields.find((f) => f.key === 'residualRisk')).toMatchObject({ required: true, section: 'Conclusion' });
  });

  it('is empty for stages without a default form', () => {
    expect(defaultReviewTemplate('License check')).toEqual({ fields: [], rules: [] });
  });
});

describe('validateReviewAnswers', () => {
  it('accepts complete answers', () => {
    expect(validateReviewAnswers(security.fields, goodAnswers)).toEqual({});
  });

  it('requires the required fields only for a decision', () => {
    const errors = validateReviewAnswers(security.fields, {});
    expect(Object.keys(errors).sort()).toEqual(['certifications', 'encryptionAtRest', 'mfa', 'residualRisk']);
    expect(validateReviewAnswers(security.fields, {}, false)).toEqual({});
  });

  it('rejects values outside the options and malformed dates', () => {
    const errors = validateReviewAnswers(security.fields, {
      ...goodAnswers,
      certifications: ['SOC 3'],
      mfa: 'Sometimes',
      reportDate: '2026-02-30',
      findings: 'x'.repeat(2001),
    });
    expect(Object.keys(errors).sort()).toEqual(['certifications', 'findings', 'mfa', 'reportDate']);
  });
});

describe('reviewConcerns', () => {
  it('finds nothing in a strong vendor', () => {
    expect(reviewConcerns(security, goodAnswers, { dataClassification: 'Restricted' }, now)).toEqual([]);
  });

  it('flags concern values and old dates', () => {
    const concerns = reviewConcerns(
      security,
      { ...goodAnswers, mfa: 'Not available', reportDate: '2025-10-01', certifications: ['None'] },
      {},
      now,
    );
    expect(concerns.map((c) => c.message)).toEqual([
      'Current certifications and attestation reports: None',
      'Date of the latest report or certificate is older than 12 months',
      'Multi-factor authentication: Not available',
    ]);
  });

  it('applies certification rules by data classification', () => {
    const iso27017Only = { ...goodAnswers, certifications: ['ISO/IEC 27017'] };
    expect(reviewConcerns(security, iso27017Only, { dataClassification: 'Restricted' }, now)).toEqual([
      { field: 'certifications', message: 'Restricted data: the vendor should hold SOC 2 Type II or ISO/IEC 27001.' },
    ]);
    const soc2TypeI = { ...goodAnswers, certifications: ['SOC 2 Type I'] };
    expect(reviewConcerns(security, soc2TypeI, { dataClassification: 'Confidential' }, now)).toEqual([]);
    expect(reviewConcerns(security, soc2TypeI, { dataClassification: 'Restricted' }, now)).toHaveLength(1);
    expect(reviewConcerns(security, iso27017Only, { dataClassification: 'Internal' }, now)).toEqual([]);
  });
});

describe('parseReviewTemplate', () => {
  const field: ReviewFieldDef = { key: 'q1', label: 'Question', type: 'select', required: false, options: ['Yes', 'No'] };
  const valid = (template: ReviewTemplate) => 'template' in parseReviewTemplate(template);
  const error = (template: unknown) => {
    const result = parseReviewTemplate(template);
    return 'error' in result ? result.error : null;
  };

  it('accepts a custom form', () => {
    expect(valid({ fields: [field, { key: 'notes', label: 'Notes', type: 'textarea', required: true }], rules: [] })).toBe(true);
    expect(valid({ fields: [], rules: [] })).toBe(true);
  });

  it.each([
    [{ fields: [{ ...field, key: '1bad' }], rules: [] }, /Invalid field key/],
    [{ fields: [field, field], rules: [] }, /same key/],
    [{ fields: [{ ...field, label: ' ' }], rules: [] }, /needs a label/],
    [{ fields: [{ ...field, options: ['Yes'] }], rules: [] }, /at least 2 options/],
    [{ fields: [{ ...field, options: ['Yes', 'Yes'] }], rules: [] }, /option twice/],
    [{ fields: [{ ...field, concernValues: ['Maybe'] }], rules: [] }, /not one of its options/],
    [{ fields: [{ key: 'n', label: 'N', type: 'text', required: false, options: ['a', 'b'] }], rules: [] }, /cannot have options/],
    [{ fields: [{ ...field, maxAgeMonths: 12 }], rules: [] }, /Only date fields/],
    [{ fields: [{ ...field, type: 'checkbox' }], rules: [] }, /Invalid option/],
  ])('rejects %j', (template, message) => {
    expect(error(template)).toMatch(message);
  });

  it('checks that rules point at real fields and values', () => {
    const certs: ReviewFieldDef = { key: 'certs', label: 'Certs', type: 'multiselect', required: false, options: ['A', 'B'] };
    const rule = { when: { field: 'dataClassification', in: ['Restricted'] }, field: 'certs', anyOf: ['A'], message: 'Need A' };
    expect(valid({ fields: [certs], rules: [rule] })).toBe(true);
    expect(error({ fields: [certs], rules: [{ ...rule, field: 'missing' }] })).toMatch(/multiple-choice field/);
    expect(error({ fields: [certs], rules: [{ ...rule, anyOf: ['C'] }] })).toMatch(/does not offer/);
    expect(error({ fields: [certs], rules: [{ ...rule, when: { field: 'serviceName', in: ['x'] } }] })).toMatch(/unknown request field/);
    expect(error({ fields: [certs], rules: [{ ...rule, when: { field: 'dataClassification', in: ['Secret'] } }] })).toMatch(/does not offer/);
  });
});
