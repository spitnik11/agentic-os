/**
 * Service wiring for standalone scripts.
 *
 * Scripts run outside Next.js, so they load .env.local themselves and build the
 * same adapters the server uses. The container module is not reused because it
 * imports `server-only`, which is meaningful only inside the framework.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PrivacyPolicy, type PrivacyRule } from '../../src/domain/policy/privacy.js';
import type { PrivacyLevel } from '../../src/domain/model/types.js';
import { loadConfig, resetConfigCache, type AppConfig } from '../../src/infrastructure/config/paths.js';
import { openDatabase } from '../../src/infrastructure/db/database.js';
import {
  SqliteAuditLog,
  SqliteKnowledgeRepository,
  SqliteRelationshipRepository,
  SqliteUsageRepository,
} from '../../src/infrastructure/db/repositories.js';
import { VaultFileSystem } from '../../src/infrastructure/fs/vault-filesystem.js';

/** Load .env.local then .env, first value winning, matching Next.js. */
export function loadEnv(cwd: string = process.cwd()): void {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(cwd, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  resetConfigCache();
}

export function createServices(): {
  config: AppConfig;
  db: ReturnType<typeof openDatabase>;
  records: SqliteKnowledgeRepository;
  relationships: SqliteRelationshipRepository;
  files: VaultFileSystem;
  audit: SqliteAuditLog;
  usage: SqliteUsageRepository;
  privacy: PrivacyPolicy;
} {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);

  const rows = db.prepare('SELECT path_prefix, level FROM privacy_rules').all() as {
    path_prefix: string;
    level: string;
  }[];
  const rules: PrivacyRule[] = rows.map((r) => ({
    pathPrefix: r.path_prefix,
    level: r.level as PrivacyLevel,
  }));

  return {
    config,
    db,
    records: new SqliteKnowledgeRepository(db),
    relationships: new SqliteRelationshipRepository(db),
    files: new VaultFileSystem({
      vaultRoot: config.vaultRoot,
      managedRoot: config.managedRoot,
      internalRoot: config.internalRoot,
    }),
    audit: new SqliteAuditLog(db),
    usage: new SqliteUsageRepository(db),
    privacy: new PrivacyPolicy(rules),
  };
}
