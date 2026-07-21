/**
 * Ports: the interfaces the application layer depends on.
 *
 * Every replaceable provider is declared here. Concrete adapters live under
 * src/infrastructure and are wired at the composition root only. Nothing above
 * this layer may import a driver, an SDK, or a filesystem module directly.
 */

import type {
  KnowledgeRecord,
  PrivacyLevel,
  RecordType,
  Relationship,
  RelationshipType,
  TokenClass,
} from '../model/types.js';

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

export interface RecordQuery {
  readonly recordTypes?: readonly RecordType[];
  readonly projectId?: string;
  readonly search?: string;
  readonly includeArchived?: boolean;
  readonly limit?: number;
  readonly offset?: number;
}

export interface KnowledgeRepository {
  get(id: string): KnowledgeRecord | null;
  getByVaultPath(vaultPath: string): KnowledgeRecord | null;
  getByContentHash(hash: string): readonly KnowledgeRecord[];
  list(query: RecordQuery): readonly KnowledgeRecord[];
  count(query: RecordQuery): number;
  upsert(record: KnowledgeRecord): void;
  archive(id: string, at: string): void;
  /** Full-text search across title, summary, and body. */
  search(term: string, limit: number): readonly KnowledgeRecord[];
}

export interface RelationshipRepository {
  forRecord(id: string): readonly Relationship[];
  backlinksTo(id: string): readonly Relationship[];
  add(relationship: Relationship): void;
  approve(id: string): void;
  remove(id: string): void;
  byType(type: RelationshipType, limit: number): readonly Relationship[];
}

/* -------------------------------------------------------------------------- */
/* Filesystem                                                                 */
/* -------------------------------------------------------------------------- */

export interface VaultFileMeta {
  readonly absolutePath: string;
  /** Path relative to the vault root, using forward slashes. */
  readonly vaultPath: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly isDirectory: boolean;
  /** False for anything outside the managed folder. */
  readonly writable: boolean;
}

export interface FileStorageProvider {
  /** Read anywhere inside the vault. Reading is always permitted. */
  readText(vaultPath: string): Promise<string>;
  /**
   * Write inside the managed folder only.
   * @throws ManagedBoundaryViolation for any path outside it.
   */
  writeText(vaultPath: string, contents: string): Promise<void>;
  /**
   * Delete inside the managed folder only.
   * @throws ManagedBoundaryViolation for any path outside it.
   */
  remove(vaultPath: string): Promise<void>;
  exists(vaultPath: string): Promise<boolean>;
  stat(vaultPath: string): Promise<VaultFileMeta | null>;
  /** Recursive listing, excluding the internal folder and .obsidian by default. */
  list(vaultPath: string, options?: { recursive?: boolean }): Promise<readonly VaultFileMeta[]>;
  /** True when the path resolves inside the folder the app owns. */
  isManaged(vaultPath: string): boolean;
  /** Store an original import by content hash; returns its internal location. */
  preserveOriginal(bytes: Buffer, filename: string, hash: string): Promise<string>;
}

/* -------------------------------------------------------------------------- */
/* Language model                                                             */
/* -------------------------------------------------------------------------- */

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly model: string;
}

export interface AnalysisRequest {
  readonly prompt: string;
  readonly system?: string;
  readonly tokenClass: TokenClass;
  /** Highest privacy restriction across everything included in the prompt. */
  readonly privacy: PrivacyLevel;
  readonly maxOutputTokens?: number;
  /** JSON Schema the response must satisfy, when structured output is wanted. */
  readonly responseSchema?: Record<string, unknown>;
}

export type AnalysisResult =
  | { readonly ok: true; readonly text: string; readonly usage: ModelUsage }
  | { readonly ok: false; readonly reason: AnalysisRefusal; readonly detail: string };

export type AnalysisRefusal =
  | 'ai_disabled'
  | 'no_credentials'
  | 'privacy_blocked'
  | 'budget_exceeded'
  | 'token_ceiling_exceeded'
  | 'provider_error';

/**
 * A language model. The NoOp implementation refuses every request with a
 * structured reason, which is what ships by default; the product is fully
 * usable against it.
 */
export interface LanguageModelProvider {
  readonly name: string;
  readonly available: boolean;
  analyze(request: AnalysisRequest): Promise<AnalysisResult>;
}

/** Token counting. Deterministic estimate; never calls a network service. */
export interface TokenEstimator {
  estimate(text: string): number;
  estimateCostUsd(inputTokens: number, outputTokens: number, model: string): number;
}

/* -------------------------------------------------------------------------- */
/* Embeddings (optional; the product must work without one)                   */
/* -------------------------------------------------------------------------- */

export interface EmbeddingProvider {
  readonly name: string;
  readonly available: boolean;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

/* -------------------------------------------------------------------------- */
/* Audit                                                                      */
/* -------------------------------------------------------------------------- */

export interface AuditEvent {
  readonly id: string;
  readonly ts: string;
  readonly actor: 'user' | 'system' | 'ai';
  readonly action: string;
  readonly targetId: string | null;
  readonly targetPath: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  /** Serialized inverse operation, when the action can be undone. */
  readonly undo: Readonly<Record<string, unknown>> | null;
}

export interface AuditLogProvider {
  record(event: Omit<AuditEvent, 'id' | 'ts'>): AuditEvent;
  recent(limit: number): readonly AuditEvent[];
  get(id: string): AuditEvent | null;
  /** Most recent undoable event that has not already been undone. */
  lastUndoable(): AuditEvent | null;
  markUndone(id: string): void;
}

/* -------------------------------------------------------------------------- */
/* Usage accounting                                                           */
/* -------------------------------------------------------------------------- */

export interface UsageRecord {
  readonly id: string;
  readonly ts: string;
  readonly feature: string;
  readonly tokenClass: TokenClass;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

export interface UsageRepository {
  record(usage: Omit<UsageRecord, 'id' | 'ts'>): void;
  monthToDateUsd(): number;
  recent(limit: number): readonly UsageRecord[];
  byFeature(): readonly { feature: string; costUsd: number; calls: number }[];
}

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

export interface Job {
  readonly id: string;
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  readonly error: string | null;
  readonly createdAt: string;
}

export interface JobQueueProvider {
  enqueue(kind: string, payload: Record<string, unknown>): Job;
  get(id: string): Job | null;
  list(limit: number): readonly Job[];
  cancel(id: string): void;
}
