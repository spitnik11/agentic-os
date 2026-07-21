/**
 * Core domain vocabulary.
 *
 * This module must not import React, Next.js, database drivers, or any SDK.
 * It describes what the system knows about, not how any of it is stored.
 */

/** Kinds of thing the system can hold. Not one generic record for everything. */
export const RECORD_TYPES = [
  'note',
  'document',
  'source',
  'research_item',
  'claim',
  'task',
  'decision',
  'question',
  'idea',
  'person',
  'organization',
  'community_insight',
  'concept',
  'project',
  'collection',
  'report',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/**
 * Where a piece of information came from, and how much weight it carries.
 * An inference must never be displayed with the authority of a verified fact,
 * so provenance is a required field on every record rather than an optional tag.
 */
export const PROVENANCE_STATES = [
  'original_user_content',
  'imported_third_party',
  'imported_obsidian_note',
  'deterministic_extraction',
  'ai_extracted',
  'ai_generated_summary',
  'ai_inference',
  'user_confirmed',
  'disputed',
  'superseded',
  'outdated',
] as const;
export type ProvenanceState = (typeof PROVENANCE_STATES)[number];

/** Provenance states a user may rely on without further checking. */
const TRUSTED_PROVENANCE: ReadonlySet<ProvenanceState> = new Set([
  'original_user_content',
  'imported_obsidian_note',
  'deterministic_extraction',
  'user_confirmed',
]);

/** True when the value was produced by a model rather than read off a source. */
export function isAiDerived(state: ProvenanceState): boolean {
  return state === 'ai_extracted' || state === 'ai_generated_summary' || state === 'ai_inference';
}

/** True when the value can be presented without an "unverified" qualifier. */
export function isVerified(state: ProvenanceState): boolean {
  return TRUSTED_PROVENANCE.has(state);
}

/**
 * Which layer owns a given record's content. Every managed note declares one so
 * that a change arriving from Obsidian and a change arriving from the app can be
 * reconciled deterministically instead of by last-writer-wins.
 */
export const SOURCE_OF_TRUTH_MODES = [
  /** Outside the managed folder. The app may read and link, never write. */
  'external_read_only',
  /** Markdown wins. The database mirrors it. */
  'obsidian_authoritative',
  /** Database wins. Markdown is a generated view. */
  'database_authoritative',
  /** Either side may change; divergence raises a conflict for review. */
  'bidirectional',
  /** Created and owned by the app inside the managed folder. */
  'managed',
  /** Point-in-time copy of an external source. Never edited. */
  'snapshot',
  /** Indexed but deliberately excluded from sync. */
  'unmanaged',
] as const;
export type SourceOfTruthMode = (typeof SOURCE_OF_TRUTH_MODES)[number];

/** Whether a mode permits the application to write the file at all. */
export function modeAllowsAppWrite(mode: SourceOfTruthMode): boolean {
  return mode === 'database_authoritative' || mode === 'managed' || mode === 'bidirectional';
}

/**
 * Privacy classification. Fails closed: anything unclassified is treated as
 * 'never_external' so that vault content is never sent anywhere by accident.
 */
export const PRIVACY_LEVELS = [
  'ai_allowed',
  'ai_allowed_with_redaction',
  'local_processing_only',
  'never_external',
] as const;
export type PrivacyLevel = (typeof PRIVACY_LEVELS)[number];

export const DEFAULT_PRIVACY: PrivacyLevel = 'never_external';

/** Lifecycle of an ingested item as it moves through the pipeline. */
export const PROCESSING_STATES = [
  'uploaded',
  'extracting',
  'awaiting_analysis',
  'analyzing',
  'needs_review',
  'cataloged',
  'linked_to_obsidian',
  'conflict',
  'failed',
  'archived',
] as const;
export type ProcessingState = (typeof PROCESSING_STATES)[number];

/**
 * Cost class of an operation, surfaced in the UI before the user commits to it.
 * Class 0 covers everything the product does without a model, which is most of it.
 */
export type TokenClass = 0 | 1 | 2 | 3 | 4;

export interface TokenClassInfo {
  readonly tokenClass: TokenClass;
  readonly label: string;
  readonly description: string;
  /** Class 4 is recurring and must never default to on. */
  readonly defaultEnabled: boolean;
}

export const TOKEN_CLASSES: Readonly<Record<TokenClass, TokenClassInfo>> = {
  0: {
    tokenClass: 0,
    label: 'No AI',
    description: 'Deterministic. Indexing, search, hashing, tree navigation, drag and drop.',
    defaultEnabled: true,
  },
  1: {
    tokenClass: 1,
    label: 'Low',
    description: 'Short summaries, tag suggestions, lightweight classification.',
    defaultEnabled: false,
  },
  2: {
    tokenClass: 2,
    label: 'Medium',
    description: 'Document analysis, task and decision extraction, managed note drafting.',
    defaultEnabled: false,
  },
  3: {
    tokenClass: 3,
    label: 'High',
    description: 'Multi-document synthesis, contradiction analysis, reorganization proposals.',
    defaultEnabled: false,
  },
  4: {
    tokenClass: 4,
    label: 'Recurring',
    description: 'Scheduled reviews and scans. Charges repeat over time.',
    defaultEnabled: false,
  },
};

/** Typed relationships. Direction matters: source -> type -> target. */
export const RELATIONSHIP_TYPES = [
  'references',
  'mentions',
  'supports',
  'contradicts',
  'related_to',
  'belongs_to',
  'created_for',
  'used_by',
  'depends_on',
  'requires',
  'extends',
  'replaces',
  'similar_to',
  'conflicts_with',
  'often_used_with',
  'generated_from',
  'validated_by',
  'reviewed_by',
  'supersedes',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** How a relationship came to exist. Claude's guesses stay separable forever. */
export const RELATIONSHIP_ORIGINS = [
  'user_created',
  'parsed_from_links',
  'imported',
  'deterministic_inference',
  'ai_suggested',
  'usage_derived',
  'reviewer_created',
] as const;
export type RelationshipOrigin = (typeof RELATIONSHIP_ORIGINS)[number];

export interface Relationship {
  readonly id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: RelationshipType;
  /** 0..1. Deterministic parses are 1; model suggestions carry the model's estimate. */
  readonly confidence: number;
  readonly origin: RelationshipOrigin;
  readonly createdAt: string;
  readonly approved: boolean;
  readonly evidence: string | null;
  readonly notes: string | null;
}

/** A record in the knowledge base. Domain-specific detail hangs off `data`. */
export interface KnowledgeRecord {
  readonly id: string;
  readonly recordType: RecordType;
  readonly title: string;
  readonly summary: string | null;
  readonly body: string | null;
  readonly vaultPath: string | null;
  readonly contentHash: string | null;
  readonly provenance: ProvenanceState;
  readonly sourceOfTruth: SourceOfTruthMode;
  readonly privacy: PrivacyLevel;
  readonly processing: ProcessingState;
  readonly confidence: number | null;
  readonly humanVerified: boolean;
  readonly aiGenerated: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  /** Type-specific fields, validated per record type at the application edge. */
  readonly data: Readonly<Record<string, unknown>>;
}

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

/** Raised when a write is attempted against a path the app does not own. */
export class ManagedBoundaryViolation extends DomainError {
  constructor(attemptedPath: string) {
    super(
      `Refusing to write outside the managed folder: ${attemptedPath}. ` +
        `User-authored notes are modified only through a reviewed proposal.`,
      'MANAGED_BOUNDARY_VIOLATION',
    );
    this.name = 'ManagedBoundaryViolation';
  }
}

/** Raised when a model call is attempted against content that forbids it. */
export class PrivacyViolation extends DomainError {
  constructor(path: string, level: PrivacyLevel) {
    super(
      `Content at ${path} is classified '${level}' and may not be sent to an external model.`,
      'PRIVACY_VIOLATION',
    );
    this.name = 'PrivacyViolation';
  }
}
