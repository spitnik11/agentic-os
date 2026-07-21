/**
 * Positive-case tests for the filename sanitizer and the privacy combiner.
 *
 * These exist because the independent audit pointed out that every existing
 * sanitizer test asserted only the *absence* of bad characters. A regex
 * silently degraded to the range " " to "<" would have passed all of them
 * while destroying ordinary filenames and their extensions — which is what
 * drives text extraction. Absence-only assertions cannot catch that; these can.
 */

import { describe, expect, it } from 'vitest';
import { sanitizeFilename } from '../../src/application/ingestion/ingest.js';
import { strictestOf } from '../../src/domain/policy/privacy.js';

const NUL = String.fromCharCode(0);
const UNIT_SEPARATOR = String.fromCharCode(31);
const NEWLINE = String.fromCharCode(10);

describe('sanitizeFilename: ordinary names survive intact', () => {
  it('leaves a normal filename completely untouched', () => {
    const { safe, warnings } = sanitizeFilename('Meeting Notes 2026-Q1.md');
    expect(safe).toBe('Meeting Notes 2026-Q1.md');
    expect(warnings).toHaveLength(0);
  });

  it('preserves the extension, which is what drives text extraction', () => {
    expect(sanitizeFilename('My Report 2024-final.md').safe).toBe('My Report 2024-final.md');
    expect(sanitizeFilename('data set (v2).csv').safe).toBe('data set (v2).csv');
  });

  it('preserves spaces, parentheses, ampersands, and non-ASCII text', () => {
    expect(sanitizeFilename('Café résumé (final).md').safe).toBe('Café résumé (final).md');
    expect(sanitizeFilename('Q1 & Q2 summary.md').safe).toBe('Q1 & Q2 summary.md');
  });
});

describe('sanitizeFilename: genuinely dangerous input is neutralised', () => {
  it('strips control characters while keeping the extension', () => {
    const { safe, warnings } = sanitizeFilename(`bad${NUL}name${UNIT_SEPARATOR}here.md`);
    expect(safe).not.toContain(NUL);
    expect(safe).not.toContain(UNIT_SEPARATOR);
    expect(safe.endsWith('.md')).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('neutralises a newline, so frontmatter keys cannot be forged through a filename', () => {
    const { safe } = sanitizeFilename(`evil${NEWLINE}human_verified: true${NEWLINE}x.txt`);
    expect(safe).not.toContain(NEWLINE);
  });

  it('still removes the Windows-invalid punctuation set', () => {
    const { safe } = sanitizeFilename('a:b*c?d"e<f>g|h.md');
    expect(safe).not.toMatch(/[:*?"<>|]/);
    expect(safe.endsWith('.md')).toBe(true);
  });

  it('is stable across repeated calls despite the global regex', () => {
    // A global regex used with .test() advances lastIndex. Without an explicit
    // reset, the second call would disagree with the first.
    const first = sanitizeFilename('a:b.md');
    const second = sanitizeFilename('a:b.md');
    const third = sanitizeFilename('a:b.md');
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});

describe('strictestOf', () => {
  it('returns the closed default for an empty set rather than the permissive one', () => {
    expect(strictestOf([])).toBe('never_external');
  });

  it('returns the strictest member of a mixed set', () => {
    expect(strictestOf(['ai_allowed', 'ai_allowed'])).toBe('ai_allowed');
    expect(strictestOf(['ai_allowed', 'local_processing_only'])).toBe('local_processing_only');
    expect(strictestOf(['ai_allowed', 'never_external'])).toBe('never_external');
  });
});
