/**
 * Privacy policy: decides whether content may leave the machine.
 *
 * The rule this file exists to enforce is that silence means no. An unclassified
 * folder, a missing config entry, or a typo in a path all resolve to
 * 'never_external' rather than to a permissive default.
 */

import { DEFAULT_PRIVACY, type PrivacyLevel } from '../model/types.js';

const ORDER: Readonly<Record<PrivacyLevel, number>> = {
  ai_allowed: 0,
  ai_allowed_with_redaction: 1,
  local_processing_only: 2,
  never_external: 3,
};

/** The stricter of two levels. Used to combine a folder rule with a note rule. */
export function strictest(a: PrivacyLevel, b: PrivacyLevel): PrivacyLevel {
  return ORDER[a] >= ORDER[b] ? a : b;
}

/**
 * The strictest level across a set.
 *
 * An empty set answers with the closed default rather than the permissive one:
 * "nothing was specified" must never read as "everything is allowed". A
 * non-empty set reduces over its own members, so the seed cannot drag the
 * result in either direction.
 */
export function strictestOf(levels: readonly PrivacyLevel[]): PrivacyLevel {
  if (levels.length === 0) return DEFAULT_PRIVACY;
  return levels.reduce((a, b) => strictest(a, b));
}

export function allowsExternalModel(level: PrivacyLevel): boolean {
  return level === 'ai_allowed' || level === 'ai_allowed_with_redaction';
}

export function requiresRedaction(level: PrivacyLevel): boolean {
  return level === 'ai_allowed_with_redaction';
}

/**
 * Folder-scoped privacy rules, longest-prefix wins.
 * Configured by the user; empty by default, which means everything is closed.
 */
export interface PrivacyRule {
  /** Vault-relative path prefix, forward slashes, no leading slash. */
  readonly pathPrefix: string;
  readonly level: PrivacyLevel;
}

export class PrivacyPolicy {
  private readonly rules: readonly PrivacyRule[];

  constructor(rules: readonly PrivacyRule[] = []) {
    // Longest prefix first so the most specific rule is found by scanning.
    this.rules = [...rules].sort((a, b) => b.pathPrefix.length - a.pathPrefix.length);
  }

  /** Resolve the level for a vault path. Unmatched paths are closed. */
  levelFor(vaultPath: string): PrivacyLevel {
    const normalized = vaultPath.replace(/\\/g, '/').replace(/^\/+/, '');
    for (const rule of this.rules) {
      if (normalized === rule.pathPrefix || normalized.startsWith(rule.pathPrefix + '/')) {
        return rule.level;
      }
    }
    return DEFAULT_PRIVACY;
  }

  /** Whether a set of paths may be combined into one external model call. */
  canSendAll(vaultPaths: readonly string[]): boolean {
    if (vaultPaths.length === 0) return false;
    return vaultPaths.every((p) => allowsExternalModel(this.levelFor(p)));
  }
}

/** Patterns that must be stripped before any content leaves the machine. */
const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'anthropic_key', pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'openai_key', pattern: /sk-[A-Za-z0-9]{32,}/g },
  { name: 'github_token', pattern: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'aws_key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'slack_token', pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'private_key', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { name: 'password_assignment', pattern: /\b(password|passwd|secret|api[_-]?key)\s*[:=]\s*\S{6,}/gi },
  { name: 'connection_string', pattern: /\b[a-z+]+:\/\/[^\s:@/]+:[^\s@/]+@[^\s/]+/gi },
];

export interface RedactionResult {
  readonly text: string;
  readonly redactions: readonly { name: string; count: number }[];
}

/**
 * Best-effort secret removal. This reduces exposure; it does not guarantee a
 * clean payload, which is why it is a second line of defence behind the
 * privacy classification rather than a substitute for it.
 */
export function redact(text: string): RedactionResult {
  let out = text;
  const found: { name: string; count: number }[] = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    const matches = out.match(pattern);
    if (matches && matches.length > 0) {
      found.push({ name, count: matches.length });
      out = out.replace(pattern, `[REDACTED:${name}]`);
    }
  }
  return { text: out, redactions: found };
}
