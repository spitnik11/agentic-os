/**
 * Composition root.
 *
 * The single place where interfaces are bound to concrete adapters. Route
 * handlers and server components ask for services here; nothing else constructs
 * a repository, a filesystem, or a provider.
 */

import 'server-only';

import type { DatabaseSync } from 'node:sqlite';
import { PrivacyPolicy, type PrivacyRule } from '../domain/policy/privacy.js';
import type { PrivacyLevel } from '../domain/model/types.js';
import type {
  AuditLogProvider,
  FileStorageProvider,
  KnowledgeRepository,
  RelationshipRepository,
  UsageRepository,
} from '../domain/ports/index.js';
import { loadConfig, type AppConfig } from './config/paths.js';
import { openDatabase } from './db/database.js';
import {
  SqliteAuditLog,
  SqliteKnowledgeRepository,
  SqliteRelationshipRepository,
  SqliteUsageRepository,
} from './db/repositories.js';
import { VaultFileSystem } from './fs/vault-filesystem.js';

export interface Services {
  readonly config: AppConfig;
  readonly db: DatabaseSync;
  readonly records: KnowledgeRepository;
  readonly relationships: RelationshipRepository;
  readonly files: FileStorageProvider;
  readonly audit: AuditLogProvider;
  readonly usage: UsageRepository;
  readonly privacy: PrivacyPolicy;
}

let services: Services | null = null;

export function getServices(): Services {
  if (services !== null) return services;

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

  services = {
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

  return services;
}

/** Drop the cached container, e.g. after privacy rules change. */
export function resetServices(): void {
  services = null;
}
