/**
 * Ingestion pipeline.
 *
 * Everything here runs at Token Class 0. A dropped file is preserved, hashed,
 * deduplicated, extracted, and cataloged without a model being involved; model
 * analysis is a later, opt-in step against an already-safe record.
 *
 * The order matters: the original is preserved before anything else touches it,
 * so a failure halfway through can never lose the user's file.
 */

import { newId } from '../../domain/model/identity.js';
import { contentHash, parseMarkdown } from '../../domain/markdown/parse.js';
import type {
  KnowledgeRecord,
  PrivacyLevel,
  RecordType,
} from '../../domain/model/types.js';
import type {
  AuditLogProvider,
  FileStorageProvider,
  KnowledgeRepository,
} from '../../domain/ports/index.js';

/** Ceilings that bound a single ingestion, so one drop cannot fill the disk. */
export const INGESTION_LIMITS = {
  maxFileBytes: 64 * 1024 * 1024,
  maxFiles: 500,
  maxTotalBytes: 256 * 1024 * 1024,
  maxTextBytesForBody: 2 * 1024 * 1024,
} as const;

/** Extensions we can read as text today. Others are preserved but not parsed. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml',
  '.log', '.html', '.htm', '.xml', '.rtf',
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.cs', '.sh', '.ps1', '.sql', '.toml', '.ini', '.env.example',
]);

/** Extensions that are never executed and are flagged on arrival. */
const EXECUTABLE_EXTENSIONS = new Set([
  '.exe', '.dll', '.bat', '.cmd', '.com', '.scr', '.msi', '.vbs', '.jar', '.app',
]);

export interface DropRequest {
  readonly filename: string;
  readonly bytes: Buffer;
  /** The category the user dropped onto. A strong signal, never overridden. */
  readonly dropCategory: string;
  readonly projectId: string | null;
}

export interface IngestionOutcome {
  readonly ingestionId: string;
  readonly state: 'cataloged' | 'duplicate' | 'quarantined' | 'failed';
  readonly recordId: string | null;
  readonly duplicateOfId: string | null;
  readonly contentHash: string;
  readonly originalPath: string | null;
  readonly warnings: readonly string[];
  readonly detail: string;
}

export interface IngestDeps {
  readonly files: FileStorageProvider;
  readonly records: KnowledgeRepository;
  readonly audit: AuditLogProvider;
  readonly db: {
    prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown };
  };
  readonly managedFolder: string;
  readonly privacyFor: (vaultPath: string) => PrivacyLevel;
}

function extensionOf(filename: string): string {
  const idx = filename.lastIndexOf('.');
  return idx === -1 ? '' : filename.slice(idx).toLowerCase();
}

/**
 * Reject filenames that could steer a write somewhere unintended. The filename
 * is never used to build a path for the preserved original (that is content
 * addressed), but it is used for display and for the managed note's name.
 */
export function sanitizeFilename(filename: string): { safe: string; warnings: string[] } {
  const warnings: string[] = [];
  let safe = filename;

  if (safe.includes('/') || safe.includes('\\')) {
    warnings.push('Filename contained path separators; they were removed.');
    safe = safe.split(/[\\/]/).pop() ?? 'untitled';
  }
  if (safe.includes('..')) {
    warnings.push('Filename contained ".."; it was removed.');
    safe = safe.replace(/\.\./g, '_');
  }
  // Control characters and the characters Windows forbids in a filename.
  // Written as escapes rather than literal bytes: a raw NUL in the source
  // makes the file read as binary to grep, and any tool that normalises
  // control bytes would silently degrade this into a space-to-"<" range.
  const INVALID_FILENAME_CHARS = /[\u0000-\u001f<>:"|?*]/g;
  if (INVALID_FILENAME_CHARS.test(safe)) {
    warnings.push('Filename contained characters that are not valid on this platform.');
    // `test` with a global regex advances lastIndex, so reset before reuse.
    INVALID_FILENAME_CHARS.lastIndex = 0;
    safe = safe.replace(INVALID_FILENAME_CHARS, '_');
  }
  // Reserved device names on Windows, with or without an extension.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(safe)) {
    warnings.push('Filename matched a reserved device name; it was prefixed.');
    safe = `file_${safe}`;
  }
  safe = safe.trim().replace(/^\.+/, '');
  if (safe === '') safe = 'untitled';
  if (safe.length > 120) safe = safe.slice(0, 120);

  return { safe, warnings };
}

/** Heuristic binary check: a NUL byte in the first block means not text. */
function looksBinary(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(8192, bytes.length));
  return sample.includes(0);
}

function inferTypeFromCategory(category: string): RecordType {
  const map: Record<string, RecordType> = {
    Inbox: 'document',
    Research: 'research_item',
    Sources: 'source',
    Tasks: 'task',
    Decisions: 'decision',
    Questions: 'question',
    Ideas: 'idea',
    People: 'person',
    Organizations: 'organization',
    Community: 'community_insight',
    Concepts: 'concept',
    Reports: 'report',
    Projects: 'project',
  };
  return map[category] ?? 'document';
}

export async function ingestDrop(
  request: DropRequest,
  deps: IngestDeps,
): Promise<IngestionOutcome> {
  const ingestionId = newId('document');
  const warnings: string[] = [];
  const now = new Date().toISOString();

  const { safe: filename, warnings: nameWarnings } = sanitizeFilename(request.filename);
  warnings.push(...nameWarnings);

  const recordIngestion = (
    state: string,
    recordId: string | null,
    duplicateOf: string | null,
    originalPath: string | null,
    hash: string,
    error: string | null,
  ): void => {
    deps.db
      .prepare(
        `INSERT INTO ingestion_events
           (id, ts, filename, size_bytes, content_hash, original_path, destination,
            drop_category, project_id, state, error, record_id, duplicate_of)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ingestionId, now, filename, request.bytes.length, hash, originalPath,
        request.dropCategory, request.dropCategory, request.projectId, state,
        error, recordId, duplicateOf,
      );
  };

  // 1. Size ceiling, checked before anything is written.
  if (request.bytes.length > INGESTION_LIMITS.maxFileBytes) {
    const hash = contentHash(filename + request.bytes.length);
    recordIngestion('failed', null, null, null, hash, 'file too large');
    return {
      ingestionId,
      state: 'failed',
      recordId: null,
      duplicateOfId: null,
      contentHash: hash,
      originalPath: null,
      warnings,
      detail: `File is ${(request.bytes.length / 1024 / 1024).toFixed(1)} MB, above the ${
        INGESTION_LIMITS.maxFileBytes / 1024 / 1024
      } MB limit.`,
    };
  }

  // 2. Hash before storing, so identical content is recognised immediately.
  const hash = contentHash(request.bytes.toString('binary'));

  const existing = deps.records.getByContentHash(hash);
  if (existing.length > 0) {
    const first = existing[0]!;
    recordIngestion('duplicate', null, first.id, null, hash, null);
    deps.audit.record({
      actor: 'user',
      action: 'ingest.duplicate',
      targetId: first.id,
      targetPath: first.vaultPath,
      detail: { filename, hash },
      undo: null,
    });
    return {
      ingestionId,
      state: 'duplicate',
      recordId: null,
      duplicateOfId: first.id,
      contentHash: hash,
      originalPath: null,
      warnings,
      detail: `Identical content is already in the vault as “${first.title}”. Nothing was added.`,
    };
  }

  // 3. Preserve the original before any parsing. Content addressed, so the
  //    supplied filename cannot influence where it lands.
  const originalPath = await deps.files.preserveOriginal(request.bytes, filename, hash);

  // 4. Classify. Executables are preserved and recorded but never parsed or run.
  const extension = extensionOf(filename);
  const isExecutable = EXECUTABLE_EXTENSIONS.has(extension);
  const isBinary = looksBinary(request.bytes);

  if (isExecutable) {
    warnings.push(
      `“${filename}” is an executable file type. It has been stored for reference and will not be opened or run.`,
    );
  }

  let body: string | null = null;
  let title = filename.replace(/\.[^.]+$/, '');
  let tags: string[] = [];

  const isText = TEXT_EXTENSIONS.has(extension) && !isBinary && !isExecutable;
  if (isText) {
    if (request.bytes.length > INGESTION_LIMITS.maxTextBytesForBody) {
      body = request.bytes.subarray(0, INGESTION_LIMITS.maxTextBytesForBody).toString('utf8');
      warnings.push('File was large; only the first 2 MB was indexed as text.');
    } else {
      body = request.bytes.toString('utf8');
    }

    if (extension === '.md' || extension === '.markdown') {
      const parsed = parseMarkdown(body);
      body = parsed.body;
      tags = [...parsed.tags];
      const h1 = parsed.headings.find((h) => h.level === 1);
      const fmTitle = parsed.frontmatter['title'];
      if (typeof fmTitle === 'string' && fmTitle.trim() !== '') title = fmTitle.trim();
      else if (h1 !== undefined) title = h1.text;
    }
  } else if (!isExecutable) {
    warnings.push(
      `“${extension || 'this file type'}” is not extracted as text yet. The original is preserved and searchable by name.`,
    );
  }

  // 5. Create the record. The drop category is recorded as an explicit user
  //    classification and is never silently changed by a later analysis pass.
  const recordType = inferTypeFromCategory(request.dropCategory);
  const managedPath = `${deps.managedFolder}/${request.dropCategory}/${filename.replace(/\.[^.]+$/, '')}.md`;

  const record: KnowledgeRecord = {
    id: newId(recordType),
    recordType,
    title,
    summary: body === null ? null : firstParagraph(body),
    body,
    vaultPath: null, // set when the managed note is materialized
    contentHash: hash,
    provenance: 'imported_third_party',
    sourceOfTruth: 'managed',
    privacy: deps.privacyFor(managedPath),
    processing: isExecutable ? 'needs_review' : 'cataloged',
    confidence: null,
    humanVerified: false,
    aiGenerated: false,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    data: {
      originalFilename: filename,
      originalPath,
      sizeBytes: request.bytes.length,
      extension,
      isBinary,
      isExecutable,
      tags,
      dropCategory: request.dropCategory,
      userClassified: true,
      warnings,
    },
  };

  deps.records.upsert(record);

  if (request.projectId !== null) {
    deps.db
      .prepare(
        `INSERT OR IGNORE INTO project_records (project_id, record_id, role, is_primary, added_at, origin)
         VALUES (?, ?, ?, 1, ?, 'user_created')`,
      )
      .run(request.projectId, record.id, request.dropCategory.toLowerCase(), now);
  }

  recordIngestion(isExecutable ? 'needs_review' : 'cataloged', record.id, null, originalPath, hash, null);

  // 6. Audit with an inverse operation, so the drop can be undone.
  deps.audit.record({
    actor: 'user',
    action: 'ingest.create',
    targetId: record.id,
    targetPath: null,
    detail: { filename, hash, category: request.dropCategory, sizeBytes: request.bytes.length },
    undo: { kind: 'archive_record', recordId: record.id },
  });

  return {
    ingestionId,
    state: isExecutable ? 'quarantined' : 'cataloged',
    recordId: record.id,
    duplicateOfId: null,
    contentHash: hash,
    originalPath,
    warnings,
    detail: isExecutable
      ? `Stored “${filename}” for review. Executable files are never opened or run.`
      : `Added “${title}” to ${request.dropCategory}.`,
  };
}

function firstParagraph(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    return trimmed.length > 280 ? trimmed.slice(0, 277) + '...' : trimmed;
  }
  return null;
}
