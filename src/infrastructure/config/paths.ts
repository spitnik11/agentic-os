/**
 * Path resolution and configuration.
 *
 * No personal path is hardcoded. Everything derives from environment variables
 * so the repository can be published without leaking where the vault lives.
 */

import path from 'node:path';
import { z } from 'zod';

const ConfigSchema = z.object({
  vaultRoot: z.string().min(1, 'VAULT_ROOT must be set (see .env.example)'),
  managedFolder: z.string().min(1).default('Agentic OS'),
  internalFolder: z.string().min(1).default('.agentic-os'),
  aiEnabled: z.boolean().default(false),
  anthropicApiKey: z.string().optional(),
  modelFast: z.string().default('claude-haiku-4-5-20251001'),
  modelDeep: z.string().default('claude-sonnet-5'),
  monthlyBudgetUsd: z.number().nonnegative().default(5),
  perRunTokenCeiling: z.number().int().positive().default(30_000),
});

export type AppConfig = z.infer<typeof ConfigSchema> & {
  readonly managedRoot: string;
  readonly internalRoot: string;
  readonly databasePath: string;
  readonly originalsRoot: string;
  readonly quarantineRoot: string;
  readonly logsRoot: string;
  readonly coordinationRoot: string;
};

let cached: AppConfig | null = null;

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() === 'true' || value === '1';
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (cached !== null && env === process.env) return cached;

  const parsed = ConfigSchema.parse({
    vaultRoot: env['VAULT_ROOT'] ?? '',
    managedFolder: env['MANAGED_FOLDER'] ?? 'Agentic OS',
    internalFolder: env['INTERNAL_FOLDER'] ?? '.agentic-os',
    aiEnabled: parseBool(env['AI_ENABLED'], false),
    anthropicApiKey: env['ANTHROPIC_API_KEY'] ?? undefined,
    modelFast: env['AI_MODEL_FAST'] ?? 'claude-haiku-4-5-20251001',
    modelDeep: env['AI_MODEL_DEEP'] ?? 'claude-sonnet-5',
    monthlyBudgetUsd: parseNumber(env['AI_MONTHLY_BUDGET_USD'], 5),
    perRunTokenCeiling: parseNumber(env['AI_PER_RUN_TOKEN_CEILING'], 30_000),
  });

  const vaultRoot = path.resolve(parsed.vaultRoot);
  const internalRoot = path.join(vaultRoot, parsed.internalFolder);

  const config: AppConfig = {
    ...parsed,
    vaultRoot,
    managedRoot: path.join(vaultRoot, parsed.managedFolder),
    internalRoot,
    databasePath: path.join(internalRoot, 'database', 'agentic.sqlite'),
    originalsRoot: path.join(internalRoot, 'originals'),
    quarantineRoot: path.join(internalRoot, 'quarantine'),
    logsRoot: path.join(internalRoot, 'logs'),
    coordinationRoot: path.join(internalRoot, 'coordination'),
  };

  if (env === process.env) cached = config;
  return config;
}

/** Test seam: drop the memoized config. */
export function resetConfigCache(): void {
  cached = null;
}

/** Convert an absolute path to a vault-relative path with forward slashes. */
export function toVaultPath(absolutePath: string, vaultRoot: string): string {
  const rel = path.relative(vaultRoot, absolutePath);
  return rel.split(path.sep).join('/');
}

/** Convert a vault-relative path to absolute, rejecting traversal attempts. */
export function toAbsolutePath(vaultPath: string, vaultRoot: string): string {
  const normalized = vaultPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const resolved = path.resolve(vaultRoot, normalized);
  const relative = path.relative(vaultRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes the vault root: ${vaultPath}`);
  }
  return resolved;
}

/**
 * True when `child` is inside `parent`. Compares resolved paths segment-wise so
 * that a sibling directory sharing a name prefix is not treated as contained.
 */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Redact the user's home directory from a path before displaying it. */
export function displayPath(absolutePath: string): string {
  const home = process.env['USERPROFILE'] ?? process.env['HOME'] ?? '';
  if (home !== '' && absolutePath.startsWith(home)) {
    return '~' + absolutePath.slice(home.length);
  }
  return absolutePath;
}
