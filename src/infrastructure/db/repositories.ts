/**
 * SQLite implementations of the domain repository ports.
 *
 * Row shapes are converted to domain records here and nowhere else, so the rest
 * of the application never sees a database column name.
 */

import type { DatabaseSync } from 'node:sqlite';
import { newId } from '../../domain/model/identity.js';
import type {
  KnowledgeRecord,
  PrivacyLevel,
  ProcessingState,
  ProvenanceState,
  RecordType,
  Relationship,
  RelationshipOrigin,
  RelationshipType,
  SourceOfTruthMode,
  TokenClass,
} from '../../domain/model/types.js';
import { all, get, run, type SqlParam } from './query.js';
import type {
  AuditEvent,
  AuditLogProvider,
  KnowledgeRepository,
  RecordQuery,
  RelationshipRepository,
  UsageRecord,
  UsageRepository,
} from '../../domain/ports/index.js';

interface RecordRow {
  id: string;
  record_type: string;
  title: string;
  summary: string | null;
  body: string | null;
  vault_path: string | null;
  content_hash: string | null;
  provenance: string;
  source_of_truth: string;
  privacy: string;
  processing: string;
  confidence: number | null;
  human_verified: number;
  ai_generated: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  data: string;
}

function toRecord(row: RecordRow): KnowledgeRecord {
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.data);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // A corrupt data blob must not take down a listing; the rest of the row is
    // still useful and the reindexer will rewrite it.
    data = {};
  }
  return {
    id: row.id,
    recordType: row.record_type as RecordType,
    title: row.title,
    summary: row.summary,
    body: row.body,
    vaultPath: row.vault_path,
    contentHash: row.content_hash,
    provenance: row.provenance as ProvenanceState,
    sourceOfTruth: row.source_of_truth as SourceOfTruthMode,
    privacy: row.privacy as PrivacyLevel,
    processing: row.processing as ProcessingState,
    confidence: row.confidence,
    humanVerified: row.human_verified === 1,
    aiGenerated: row.ai_generated === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    data,
  };
}

/** Escape a user query for FTS5 so punctuation cannot become syntax. */
function toFtsQuery(term: string): string {
  const tokens = term
    .split(/\s+/)
    .map((t) => t.replace(/["*()]/g, ''))
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return '';
  // Quote each token and allow prefix matching on the last one, which is what
  // a person typing into a search box expects.
  return tokens.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`)).join(' AND ');
}

export class SqliteKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): KnowledgeRecord | null {
    const row = this.db.prepare('SELECT * FROM records WHERE id = ?').get(id) as unknown as RecordRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  getByVaultPath(vaultPath: string): KnowledgeRecord | null {
    const row = this.db.prepare('SELECT * FROM records WHERE vault_path = ?').get(vaultPath) as unknown as RecordRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  getByContentHash(hash: string): readonly KnowledgeRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM records WHERE content_hash = ?')
      .all(hash) as unknown as RecordRow[];
    return rows.map(toRecord);
  }

  private buildWhere(query: RecordQuery): { sql: string; params: SqlParam[] } {
    const clauses: string[] = [];
    const params: SqlParam[] = [];

    if (query.includeArchived !== true) clauses.push('archived_at IS NULL');

    if (query.recordTypes !== undefined && query.recordTypes.length > 0) {
      clauses.push(`record_type IN (${query.recordTypes.map(() => '?').join(', ')})`);
      params.push(...query.recordTypes);
    }

    if (query.projectId !== undefined) {
      clauses.push('id IN (SELECT record_id FROM project_records WHERE project_id = ?)');
      params.push(query.projectId);
    }

    if (query.search !== undefined && query.search.trim() !== '') {
      const like = `%${query.search.trim()}%`;
      clauses.push('(title LIKE ? OR summary LIKE ?)');
      params.push(like, like);
    }

    return {
      sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  }

  list(query: RecordQuery): readonly KnowledgeRecord[] {
    const { sql, params } = this.buildWhere(query);
    const limit = query.limit ?? 200;
    const offset = query.offset ?? 0;
    const rows = this.db
      .prepare(`SELECT * FROM records ${sql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as RecordRow[];
    return rows.map(toRecord);
  }

  count(query: RecordQuery): number {
    const { sql, params } = this.buildWhere(query);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM records ${sql}`).get(...params) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  upsert(record: KnowledgeRecord): void {
    this.db
      .prepare(
        `INSERT INTO records (
           id, record_type, title, summary, body, vault_path, content_hash,
           provenance, source_of_truth, privacy, processing, confidence,
           human_verified, ai_generated, created_at, updated_at, archived_at, data
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           record_type = excluded.record_type,
           title = excluded.title,
           summary = excluded.summary,
           body = excluded.body,
           vault_path = excluded.vault_path,
           content_hash = excluded.content_hash,
           provenance = excluded.provenance,
           source_of_truth = excluded.source_of_truth,
           privacy = excluded.privacy,
           processing = excluded.processing,
           confidence = excluded.confidence,
           human_verified = excluded.human_verified,
           ai_generated = excluded.ai_generated,
           updated_at = excluded.updated_at,
           archived_at = excluded.archived_at,
           data = excluded.data`,
      )
      .run(
        record.id,
        record.recordType,
        record.title,
        record.summary,
        record.body,
        record.vaultPath,
        record.contentHash,
        record.provenance,
        record.sourceOfTruth,
        record.privacy,
        record.processing,
        record.confidence,
        record.humanVerified ? 1 : 0,
        record.aiGenerated ? 1 : 0,
        record.createdAt,
        record.updatedAt,
        record.archivedAt,
        JSON.stringify(record.data),
      );
  }

  archive(id: string, at: string): void {
    this.db.prepare('UPDATE records SET archived_at = ?, updated_at = ? WHERE id = ?').run(at, at, id);
  }

  search(term: string, limit: number): readonly KnowledgeRecord[] {
    const ftsQuery = toFtsQuery(term);
    if (ftsQuery === '') return [];
    try {
      const rows = this.db
        .prepare(
          `SELECT r.* FROM records_fts f
             JOIN records r ON r.rowid = f.rowid
            WHERE records_fts MATCH ?
              AND r.archived_at IS NULL
            ORDER BY rank
            LIMIT ?`,
        )
        .all(ftsQuery, limit) as unknown as RecordRow[];
      return rows.map(toRecord);
    } catch {
      // FTS can reject exotic input; fall back to a LIKE scan rather than
      // showing the user an error for a search they typed in good faith.
      const like = `%${term}%`;
      const rows = this.db
        .prepare(
          `SELECT * FROM records
            WHERE archived_at IS NULL AND (title LIKE ? OR summary LIKE ? OR body LIKE ?)
            ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(like, like, like, limit) as unknown as RecordRow[];
      return rows.map(toRecord);
    }
  }
}

interface RelationshipRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  confidence: number;
  origin: string;
  created_at: string;
  approved: number;
  evidence: string | null;
  notes: string | null;
}

function toRelationship(row: RelationshipRow): Relationship {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type as RelationshipType,
    confidence: row.confidence,
    origin: row.origin as RelationshipOrigin,
    createdAt: row.created_at,
    approved: row.approved === 1,
    evidence: row.evidence,
    notes: row.notes,
  };
}

export class SqliteRelationshipRepository implements RelationshipRepository {
  constructor(private readonly db: DatabaseSync) {}

  forRecord(id: string): readonly Relationship[] {
    const rows = this.db
      .prepare('SELECT * FROM relationships WHERE source_id = ? ORDER BY created_at DESC')
      .all(id) as unknown as RelationshipRow[];
    return rows.map(toRelationship);
  }

  backlinksTo(id: string): readonly Relationship[] {
    const rows = this.db
      .prepare('SELECT * FROM relationships WHERE target_id = ? ORDER BY created_at DESC')
      .all(id) as unknown as RelationshipRow[];
    return rows.map(toRelationship);
  }

  add(relationship: Relationship): void {
    this.db
      .prepare(
        `INSERT INTO relationships
           (id, source_id, target_id, type, confidence, origin, created_at, approved, evidence, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_id, target_id, type) DO UPDATE SET
           confidence = excluded.confidence,
           evidence = excluded.evidence`,
      )
      .run(
        relationship.id,
        relationship.sourceId,
        relationship.targetId,
        relationship.type,
        relationship.confidence,
        relationship.origin,
        relationship.createdAt,
        relationship.approved ? 1 : 0,
        relationship.evidence,
        relationship.notes,
      );
  }

  approve(id: string): void {
    this.db.prepare('UPDATE relationships SET approved = 1 WHERE id = ?').run(id);
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM relationships WHERE id = ?').run(id);
  }

  byType(type: RelationshipType, limit: number): readonly Relationship[] {
    const rows = this.db
      .prepare('SELECT * FROM relationships WHERE type = ? ORDER BY created_at DESC LIMIT ?')
      .all(type, limit) as unknown as RelationshipRow[];
    return rows.map(toRelationship);
  }
}

interface AuditRow {
  id: string;
  ts: string;
  actor: string;
  action: string;
  target_id: string | null;
  target_path: string | null;
  detail: string;
  undo: string | null;
  undone_at: string | null;
}

function toAuditEvent(row: AuditRow): AuditEvent {
  const safeParse = (text: string | null): Record<string, unknown> | null => {
    if (text === null) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  return {
    id: row.id,
    ts: row.ts,
    actor: row.actor as AuditEvent['actor'],
    action: row.action,
    targetId: row.target_id,
    targetPath: row.target_path,
    detail: safeParse(row.detail) ?? {},
    undo: safeParse(row.undo),
  };
}

export class SqliteAuditLog implements AuditLogProvider {
  constructor(private readonly db: DatabaseSync) {}

  record(event: Omit<AuditEvent, 'id' | 'ts'>): AuditEvent {
    const full: AuditEvent = {
      ...event,
      id: `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      ts: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO audit_events (id, ts, actor, action, target_id, target_path, detail, undo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id,
        full.ts,
        full.actor,
        full.action,
        full.targetId,
        full.targetPath,
        JSON.stringify(full.detail),
        full.undo === null ? null : JSON.stringify(full.undo),
      );
    return full;
  }

  recent(limit: number): readonly AuditEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_events ORDER BY ts DESC LIMIT ?')
      .all(limit) as unknown as AuditRow[];
    return rows.map(toAuditEvent);
  }

  get(id: string): AuditEvent | null {
    const row = this.db.prepare('SELECT * FROM audit_events WHERE id = ?').get(id) as unknown as AuditRow | undefined;
    return row === undefined ? null : toAuditEvent(row);
  }

  lastUndoable(): AuditEvent | null {
    const row = this.db
      .prepare(
        'SELECT * FROM audit_events WHERE undo IS NOT NULL AND undone_at IS NULL ORDER BY ts DESC LIMIT 1',
      )
      .get() as AuditRow | undefined;
    return row === undefined ? null : toAuditEvent(row);
  }

  markUndone(id: string): void {
    this.db
      .prepare('UPDATE audit_events SET undone_at = ? WHERE id = ?')
      .run(new Date().toISOString(), id);
  }
}

interface UsageRow {
  id: string;
  ts: string;
  feature: string;
  token_class: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export class SqliteUsageRepository implements UsageRepository {
  constructor(private readonly db: DatabaseSync) {}

  record(usage: Omit<UsageRecord, 'id' | 'ts'>): void {
    this.db
      .prepare(
        `INSERT INTO usage_records (id, ts, feature, token_class, model, input_tokens, output_tokens, cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('report'),
        new Date().toISOString(),
        usage.feature,
        usage.tokenClass,
        usage.model,
        usage.inputTokens,
        usage.outputTokens,
        usage.costUsd,
      );
  }

  monthToDateUsd(): number {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const row = this.db
      .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_records WHERE ts >= ?')
      .get(monthStart.toISOString()) as unknown as { total: number } | undefined;
    return row?.total ?? 0;
  }

  recent(limit: number): readonly UsageRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM usage_records ORDER BY ts DESC LIMIT ?')
      .all(limit) as unknown as UsageRow[];
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      feature: r.feature,
      tokenClass: r.token_class as TokenClass,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd,
    }));
  }

  byFeature(): readonly { feature: string; costUsd: number; calls: number }[] {
    const rows = this.db
      .prepare(
        `SELECT feature, SUM(cost_usd) AS cost, COUNT(*) AS calls
           FROM usage_records GROUP BY feature ORDER BY cost DESC`,
      )
      .all() as unknown as { feature: string; cost: number; calls: number }[];
    return rows.map((r) => ({ feature: r.feature, costUsd: r.cost, calls: r.calls }));
  }
}
