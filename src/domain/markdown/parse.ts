/**
 * Obsidian-flavoured markdown parsing.
 *
 * Pure functions over strings. Everything here is deterministic and free, which
 * is the point: the link graph, backlinks, headings, tasks, and tags are all
 * derived without a model.
 */

import { createHash } from 'node:crypto';

export interface WikiLink {
  /** The target as written, before resolution. */
  readonly target: string;
  /** Heading or block reference after '#', if present. */
  readonly anchor: string | null;
  /** Display text after '|', if present. */
  readonly alias: string | null;
  /** True for embeds written as ![[...]]. */
  readonly embed: boolean;
  readonly raw: string;
}

export interface MarkdownLink {
  readonly text: string;
  readonly url: string;
  readonly external: boolean;
}

export interface Heading {
  readonly level: number;
  readonly text: string;
  readonly line: number;
}

export interface TaskItem {
  readonly text: string;
  readonly checked: boolean;
  readonly line: number;
}

export interface ParsedMarkdown {
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly hasFrontmatter: boolean;
  readonly body: string;
  readonly headings: readonly Heading[];
  readonly wikiLinks: readonly WikiLink[];
  readonly markdownLinks: readonly MarkdownLink[];
  readonly tags: readonly string[];
  readonly tasks: readonly TaskItem[];
  readonly wordCount: number;
}

/**
 * Matches [[target#anchor|alias]] and the embed form ![[...]].
 * Targets may contain spaces and forward slashes but not the closing brackets.
 */
const WIKILINK_RE = /(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/** Matches [text](url) but not the image form, which is handled as an embed. */
const MDLINK_RE = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Inline #tag, excluding headings (# at line start) and code spans. */
const TAG_RE = /(?:^|[\s(])#([A-Za-z][\w\-/]*)/g;

const TASK_RE = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/;

/**
 * Strip fenced and inline code so links and tags inside examples are not
 * mistaken for real references.
 */
function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
    .replace(/`[^`\n]*`/g, '');
}

/**
 * Split YAML frontmatter from the body.
 * Only a leading '---' fence counts, matching Obsidian's behaviour.
 */
export function splitFrontmatter(source: string): {
  raw: string | null;
  body: string;
  bodyStartLine: number;
} {
  // Tolerate a UTF-8 BOM, which the vault's PowerShell-written files contain.
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  if (!text.startsWith('---')) {
    return { raw: null, body: text, bodyStartLine: 0 };
  }
  const end = text.indexOf('\n---', 3);
  if (end === -1) {
    return { raw: null, body: text, bodyStartLine: 0 };
  }
  const raw = text.slice(text.indexOf('\n') + 1, end);
  const afterFence = text.indexOf('\n', end + 1);
  const body = afterFence === -1 ? '' : text.slice(afterFence + 1);
  const bodyStartLine = (text.slice(0, afterFence === -1 ? text.length : afterFence).match(/\n/g) ?? [])
    .length + 1;
  return { raw, body, bodyStartLine };
}

/**
 * Minimal YAML subset parser covering what frontmatter actually uses:
 * scalars, quoted strings, block lists, inline lists, booleans, numbers, nulls.
 * Anything unrecognised is kept as a string rather than dropped, so no
 * user-authored metadata is lost on a round trip.
 */
export function parseYamlFrontmatter(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let currentKey: string | null = null;
  let listBuffer: string[] = [];

  const flush = (): void => {
    if (currentKey !== null && listBuffer.length > 0) {
      out[currentKey] = listBuffer;
      listBuffer = [];
    }
  };

  for (const line of lines) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const listMatch = /^\s+-\s+(.*)$/.exec(line);
    if (listMatch && currentKey !== null) {
      listBuffer.push(coerceScalar(listMatch[1]!.trim()) as string);
      continue;
    }

    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (kv) {
      flush();
      currentKey = kv[1]!;
      const value = kv[2]!.trim();
      if (value === '') {
        // Either an empty value or the start of a block list; decided by the
        // next line, so leave the key pending.
        out[currentKey] = null;
      } else {
        out[currentKey] = coerceScalar(value);
        currentKey = null;
      }
    }
  }
  flush();
  return out;
}

function coerceScalar(value: string): unknown {
  if (value === '') return null;
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    return value.slice(1, -1);
  }
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((v) => coerceScalar(v.trim()));
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d*\.\d+$/.test(value)) return Number.parseFloat(value);
  return value;
}

export function extractWikiLinks(body: string): WikiLink[] {
  const clean = stripCode(body);
  const links: WikiLink[] = [];
  for (const m of clean.matchAll(WIKILINK_RE)) {
    links.push({
      embed: m[1] === '!',
      target: m[2]!.trim(),
      anchor: m[3]?.trim() ?? null,
      alias: m[4]?.trim() ?? null,
      raw: m[0],
    });
  }
  return links;
}

export function extractMarkdownLinks(body: string): MarkdownLink[] {
  const clean = stripCode(body);
  const links: MarkdownLink[] = [];
  for (const m of clean.matchAll(MDLINK_RE)) {
    const url = m[2]!;
    links.push({
      text: m[1] ?? '',
      url,
      external: /^[a-z][a-z0-9+.-]*:/i.test(url),
    });
  }
  return links;
}

export function extractHeadings(body: string): Heading[] {
  const out: Heading[] = [];
  const lines = stripCode(body).split(/\r?\n/);
  lines.forEach((line, i) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) out.push({ level: m[1]!.length, text: m[2]!.trim(), line: i });
  });
  return out;
}

export function extractTags(body: string, frontmatter: Record<string, unknown>): string[] {
  const tags = new Set<string>();
  const fmTags = frontmatter['tags'];
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) if (typeof t === 'string') tags.add(t.replace(/^#/, ''));
  } else if (typeof fmTags === 'string') {
    for (const t of fmTags.split(/[,\s]+/)) if (t !== '') tags.add(t.replace(/^#/, ''));
  }
  for (const m of stripCode(body).matchAll(TAG_RE)) tags.add(m[1]!);
  return [...tags].sort();
}

export function extractTasks(body: string): TaskItem[] {
  const out: TaskItem[] = [];
  stripCode(body)
    .split(/\r?\n/)
    .forEach((line, i) => {
      const m = TASK_RE.exec(line);
      if (m) out.push({ checked: m[1]!.toLowerCase() === 'x', text: m[2]!.trim(), line: i });
    });
  return out;
}

export function parseMarkdown(source: string): ParsedMarkdown {
  const { raw, body } = splitFrontmatter(source);
  const frontmatter = raw === null ? {} : parseYamlFrontmatter(raw);
  return {
    frontmatter,
    hasFrontmatter: raw !== null,
    body,
    headings: extractHeadings(body),
    wikiLinks: extractWikiLinks(body),
    markdownLinks: extractMarkdownLinks(body),
    tags: extractTags(body, frontmatter),
    tasks: extractTasks(body),
    wordCount: body.split(/\s+/).filter((w) => w !== '').length,
  };
}

/**
 * Serialize frontmatter back to YAML, preserving key order where given.
 * Used when materializing managed notes; never applied to user-authored files.
 */
export function serializeFrontmatter(data: Record<string, unknown>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) {
      lines.push(`${key}:`);
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${formatScalar(item)}`);
      }
    } else {
      lines.push(`${key}: ${formatScalar(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function formatScalar(value: unknown): string {
  if (typeof value === 'string') {
    // Quote when the value could otherwise be misread as another YAML type.
    // Newlines must be quoted and escaped, not emitted raw: an unquoted
    // multi-line scalar terminates the value and the remainder of the string
    // becomes forged frontmatter keys. Defence in depth behind the filename
    // sanitiser, which is the only thing preventing that today.
    if (/[\n\r]/.test(value)) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n')}"`;
    }
    if (
      value === '' ||
      /^[\s]|[\s]$/.test(value) ||
      /^(true|false|null|~|-?\d+(\.\d+)?)$/.test(value) ||
      /[:#[\]{}",]/.test(value)
    ) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  }
  return String(value);
}

/** Stable content hash used to skip reparsing and to detect divergence. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}

/**
 * Resolve a wikilink target against the set of known vault paths, using
 * Obsidian's shortest-unique-path rule: a bare name matches any file with that
 * basename; a path fragment must match the tail of the path.
 */
export function resolveWikiLink(
  target: string,
  knownPaths: readonly string[],
): string | null {
  const normalized = target.replace(/\\/g, '/').replace(/\.md$/i, '');
  const candidates = knownPaths.filter((p) => {
    const withoutExt = p.replace(/\.md$/i, '');
    if (withoutExt === normalized) return true;
    if (withoutExt.endsWith('/' + normalized)) return true;
    const basename = withoutExt.split('/').pop();
    return basename === normalized;
  });
  if (candidates.length === 0) return null;
  // Prefer the shallowest match, matching Obsidian's disambiguation.
  return candidates.sort((a, b) => a.split('/').length - b.split('/').length)[0]!;
}
