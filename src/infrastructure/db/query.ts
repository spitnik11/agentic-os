/**
 * Typed query helpers.
 *
 * node:sqlite returns `Record<string, SQLOutputValue>` for every row, so every
 * call site would otherwise need its own double cast. Centralising the cast
 * here keeps the repositories readable and puts the unavoidable unsafety in one
 * reviewable place.
 */

import type { DatabaseSync } from 'node:sqlite';

/** Values SQLite can bind as a parameter. */
export type SqlParam = string | number | bigint | null | Uint8Array;

/** Minimal shape the helpers need, so callers can pass a test double. */
export interface Queryable {
  prepare(sql: string): {
    run(...params: SqlParam[]): unknown;
    get(...params: SqlParam[]): unknown;
    all(...params: SqlParam[]): unknown[];
  };
}

export function all<T>(db: Queryable | DatabaseSync, sql: string, ...params: SqlParam[]): T[] {
  return (db as Queryable).prepare(sql).all(...params) as T[];
}

export function get<T>(db: Queryable | DatabaseSync, sql: string, ...params: SqlParam[]): T | undefined {
  return (db as Queryable).prepare(sql).get(...params) as T | undefined;
}

export function run(db: Queryable | DatabaseSync, sql: string, ...params: SqlParam[]): void {
  (db as Queryable).prepare(sql).run(...params);
}

/** Read a single scalar column, defaulting when the query returns no row. */
export function scalar(
  db: Queryable | DatabaseSync,
  sql: string,
  fallback: number,
  ...params: SqlParam[]
): number {
  const row = get<Record<string, unknown>>(db, sql, ...params);
  if (row === undefined) return fallback;
  const first = Object.values(row)[0];
  return typeof first === 'number' ? first : fallback;
}
