/**
 * Stable identifiers.
 *
 * Filenames are not identity. A note that is renamed in Obsidian, moved to
 * another folder, or edited on another machine keeps the same agentic_id, and
 * every relationship pointing at it survives the change.
 *
 * Format: <type-prefix>_<ULID-like monotonic id>. Sortable by creation time,
 * URL-safe, and readable enough to eyeball in frontmatter.
 */

import { randomBytes } from 'node:crypto';
import type { RecordType } from './types.js';

/** Crockford base32: no I, L, O, or U, so ids resist transcription errors. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

const PREFIXES: Readonly<Record<RecordType, string>> = {
  note: 'note',
  document: 'doc',
  source: 'src',
  research_item: 'res',
  claim: 'clm',
  task: 'task',
  decision: 'dec',
  question: 'qst',
  idea: 'idea',
  person: 'per',
  organization: 'org',
  community_insight: 'comm',
  concept: 'cpt',
  project: 'project',
  collection: 'coll',
  report: 'rpt',
};

function encodeTime(now: number): string {
  let out = '';
  let value = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ALPHABET[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ALPHABET[bytes[i]! % 32]!;
  }
  return out;
}

/** Monotonic guard so two ids minted in the same millisecond still sort stably. */
let lastTime = 0;
let lastRandom = '';

/**
 * Mint a new identifier for a record type.
 * @example newId('project') -> 'project_01HXYZ...'
 */
export function newId(recordType: RecordType): string {
  const now = Date.now();
  let random: string;
  if (now === lastTime && lastRandom !== '') {
    // Same millisecond: increment the previous random part rather than redrawing,
    // which keeps ids strictly increasing within the millisecond.
    random = incrementBase32(lastRandom);
  } else {
    random = encodeRandom();
  }
  lastTime = now;
  lastRandom = random;
  return `${PREFIXES[recordType]}_${encodeTime(now)}${random}`;
}

function incrementBase32(s: string): string {
  const chars = s.split('');
  for (let i = chars.length - 1; i >= 0; i--) {
    const idx = ALPHABET.indexOf(chars[i]!);
    if (idx < 31) {
      chars[i] = ALPHABET[idx + 1]!;
      return chars.join('');
    }
    chars[i] = ALPHABET[0]!;
  }
  // Overflowed the whole string; fall back to a fresh draw.
  return encodeRandom();
}

const ID_PATTERN = new RegExp(`^[a-z]+_[${ALPHABET}]{${TIME_LEN + RANDOM_LEN}}$`);

export function isValidId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** Recover the record type from an id without a database round trip. */
export function recordTypeOf(id: string): RecordType | null {
  const prefix = id.split('_')[0];
  if (prefix === undefined) return null;
  for (const [type, p] of Object.entries(PREFIXES)) {
    if (p === prefix) return type as RecordType;
  }
  return null;
}

/** Creation time encoded in the id, for sorting without touching the database. */
export function timestampOf(id: string): Date | null {
  const body = id.split('_')[1];
  if (body === undefined || body.length < TIME_LEN) return null;
  let value = 0;
  for (const ch of body.slice(0, TIME_LEN)) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = value * 32 + idx;
  }
  return new Date(value);
}
