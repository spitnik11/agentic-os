/**
 * SQLite connection and migration runner.
 *
 * Uses node:sqlite, built into Node 22.5+, so there is no native module to
 * compile and no database server to install. The repositories above this file
 * talk to interfaces, so swapping in Postgres later touches only this folder.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 1;

let instance: DatabaseSync | null = null;
let instancePath: string | null = null;

function schemaSql(): string {
  // Resolve relative to this module so it works from the app, tests, and scripts.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'schema.sql'),
    path.join(process.cwd(), 'src', 'infrastructure', 'db', 'schema.sql'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
  }
  throw new Error(`Could not locate schema.sql. Looked in: ${candidates.join(', ')}`);
}

export function openDatabase(databasePath: string): DatabaseSync {
  if (instance !== null && instancePath === databasePath) return instance;
  if (instance !== null) {
    instance.close();
    instance = null;
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);

  instance = db;
  instancePath = databasePath;
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(schemaSql());

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;

  if (current < SCHEMA_VERSION) {
    db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      SCHEMA_VERSION,
      new Date().toISOString(),
    );
  }
}

export function currentSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

export function closeDatabase(): void {
  if (instance !== null) {
    instance.close();
    instance = null;
    instancePath = null;
  }
}

/** In-memory database for tests. Never memoized. */
export function openTestDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(schemaSql());
  db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)').run(
    SCHEMA_VERSION,
    new Date().toISOString(),
  );
  return db;
}

/** Run a function inside a transaction, rolling back on any throw. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
