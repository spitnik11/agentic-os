/**
 * Vault indexer.
 *
 * Walks the vault, parses every markdown file, and builds the record and
 * relationship tables. Strictly read-only with respect to the vault: it opens
 * files for reading and writes only to the database.
 *
 * This runs at Token Class 0. No model is involved in indexing, so the tree,
 * search, backlinks, and health reports all work with AI switched off.
 */

import { isValidId, newId } from '../../domain/model/identity.js';
import {
  contentHash,
  parseMarkdown,
  resolveWikiLink,
  type ParsedMarkdown,
} from '../../domain/markdown/parse.js';
import {
  PROVENANCE_STATES,
  type KnowledgeRecord,
  type ProvenanceState,
  type RecordType,
  type Relationship,
  type SourceOfTruthMode,
} from '../../domain/model/types.js';
import type {
  AuditLogProvider,
  FileStorageProvider,
  KnowledgeRepository,
  RelationshipRepository,
} from '../../domain/ports/index.js';
import type { PrivacyPolicy } from '../../domain/policy/privacy.js';

export interface IndexResult {
  readonly scanned: number;
  readonly indexed: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly relationships: number;
  readonly unresolvedLinks: number;
  /** Records whose file has disappeared from the vault since the last pass. */
  readonly archivedMissing: number;
  readonly durationMs: number;
  readonly errors: readonly { path: string; message: string }[];
}

export interface IndexerDeps {
  readonly files: FileStorageProvider;
  readonly records: KnowledgeRepository;
  readonly relationships: RelationshipRepository;
  readonly audit: AuditLogProvider;
  readonly privacy: PrivacyPolicy;
  readonly managedFolder: string;
  /** Raw handle used for the link-table writes the ports do not cover. */
  readonly db: {
    prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  };
}

/**
 * Infer a record type from where a note sits and what its frontmatter says.
 * Explicit frontmatter always wins over the folder heuristic, because the user
 * writing `record_type:` is a stronger signal than a folder name.
 */
export function inferRecordType(vaultPath: string, parsed: ParsedMarkdown): RecordType {
  const declared = parsed.frontmatter['record_type'];
  if (typeof declared === 'string') {
    const normalized = declared.toLowerCase().trim();
    const valid: RecordType[] = [
      'note', 'document', 'source', 'research_item', 'claim', 'task', 'decision',
      'question', 'idea', 'person', 'organization', 'community_insight',
      'concept', 'project', 'collection', 'report',
    ];
    if ((valid as string[]).includes(normalized)) return normalized as RecordType;
  }

  const lower = vaultPath.toLowerCase();
  const filename = lower.split('/').pop() ?? '';

  // A file literally named PROJECT.md is the project's hub note.
  if (filename === 'project.md') return 'project';
  if (/(^|\/)02 projects\//.test(lower) && filename === 'decisions.md') return 'decision';
  if (/(^|\/)(research|sources)\//.test(lower)) return 'research_item';
  if (/(^|\/)decisions?\//.test(lower)) return 'decision';
  if (/(^|\/)tasks?\//.test(lower)) return 'task';
  if (/(^|\/)questions?\//.test(lower)) return 'question';
  if (/(^|\/)ideas?\//.test(lower)) return 'idea';
  if (/(^|\/)people\//.test(lower)) return 'person';
  if (/(^|\/)organizations?\//.test(lower)) return 'organization';
  if (/(^|\/)community\//.test(lower)) return 'community_insight';
  if (/(^|\/)concepts?\//.test(lower)) return 'concept';
  if (/(^|\/)reports?\//.test(lower)) return 'report';
  return 'note';
}

/**
 * Decide who owns a file. Anything outside the managed folder is read-only,
 * enforced independently by the filesystem adapter; this records the intent.
 */
function inferSourceOfTruth(vaultPath: string, managedFolder: string): SourceOfTruthMode {
  const normalized = vaultPath.replace(/\\/g, '/');
  if (normalized === managedFolder || normalized.startsWith(managedFolder + '/')) {
    return 'managed';
  }
  return 'external_read_only';
}

function inferProvenance(
  vaultPath: string,
  managedFolder: string,
  parsed: ParsedMarkdown,
): ProvenanceState {
  // A declared provenance always wins. Managed notes carry `provenance:` in
  // their frontmatter, and re-deriving it from the folder would relabel an
  // imported file or a model's inference as deterministic extraction — losing
  // exactly the distinction the provenance system exists to preserve.
  const declared = parsed.frontmatter['provenance'];
  if (typeof declared === 'string') {
    const normalized = declared.toLowerCase().trim();
    if ((PROVENANCE_STATES as readonly string[]).includes(normalized)) {
      return normalized as ProvenanceState;
    }
  }

  if (parsed.frontmatter['ai_generated'] === true) return 'ai_generated_summary';

  const path = vaultPath.replace(/\\/g, '/');
  if (path.startsWith(managedFolder + '/')) return 'deterministic_extraction';
  return 'imported_obsidian_note';
}

/** Title: frontmatter, then first H1, then filename. */
function inferTitle(vaultPath: string, parsed: ParsedMarkdown): string {
  const fmTitle = parsed.frontmatter['title'];
  if (typeof fmTitle === 'string' && fmTitle.trim() !== '') return fmTitle.trim();
  const h1 = parsed.headings.find((h) => h.level === 1);
  if (h1 !== undefined && h1.text !== '') return h1.text;
  const filename = vaultPath.split('/').pop() ?? vaultPath;
  return filename.replace(/\.md$/i, '');
}

/** First non-empty, non-heading paragraph, trimmed to a readable length. */
function inferSummary(parsed: ParsedMarkdown): string | null {
  for (const line of parsed.body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
    if (trimmed.startsWith('|') || trimmed.startsWith('```')) continue;
    return trimmed.length > 280 ? trimmed.slice(0, 277) + '...' : trimmed;
  }
  return null;
}

export async function indexVault(deps: IndexerDeps): Promise<IndexResult> {
  const started = Date.now();
  const errors: { path: string; message: string }[] = [];
  let indexed = 0;
  let unchanged = 0;
  let failed = 0;

  const entries = await deps.files.list('.', { recursive: true });
  const markdownFiles = entries.filter(
    (e) => !e.isDirectory && e.vaultPath.toLowerCase().endsWith('.md'),
  );

  // Pass 1: records. Link resolution needs the full path set, so links wait.
  const parsedByPath = new Map<string, ParsedMarkdown>();
  const idByPath = new Map<string, string>();

  for (const file of markdownFiles) {
    try {
      const source = await deps.files.readText(file.vaultPath);
      const hash = contentHash(source);
      const existing = deps.records.getByVaultPath(file.vaultPath);

      const parsed = parseMarkdown(source);
      parsedByPath.set(file.vaultPath, parsed);

      if (existing !== null && existing.contentHash === hash) {
        // Unchanged since the last pass; skip the write but keep the id so
        // links still resolve.
        idByPath.set(file.vaultPath, existing.id);
        unchanged++;
        continue;
      }

      const recordType = inferRecordType(file.vaultPath, parsed);
      const now = new Date().toISOString();

      // Preserve an id already written into frontmatter, so a note that moves
      // keeps its identity and its relationships.
      // A declared id is honoured only if it is well-formed and not already
      // claimed by a different file. An arbitrary hand-typed string, or one
      // duplicated across two notes, would collide on upsert and make a record
      // silently disappear.
      const declaredId = parsed.frontmatter['agentic_id'];
      let claimedId: string | null = null;
      if (typeof declaredId === 'string' && isValidId(declaredId)) {
        const holder = deps.records.get(declaredId);
        if (holder === null || holder.vaultPath === file.vaultPath) {
          claimedId = declaredId;
        } else {
          errors.push({
            path: file.vaultPath,
            message: `agentic_id ${declaredId} is already used by ${holder.vaultPath}; a new id was assigned.`,
          });
        }
      }
      const id = existing?.id ?? claimedId ?? newId(recordType);

      const record: KnowledgeRecord = {
        id,
        recordType,
        title: inferTitle(file.vaultPath, parsed),
        summary: inferSummary(parsed),
        body: parsed.body,
        vaultPath: file.vaultPath,
        contentHash: hash,
        provenance: inferProvenance(file.vaultPath, deps.managedFolder, parsed),
        sourceOfTruth: inferSourceOfTruth(file.vaultPath, deps.managedFolder),
        privacy: deps.privacy.levelFor(file.vaultPath),
        processing: 'cataloged',
        confidence: null,
        humanVerified: parsed.frontmatter['human_verified'] === true,
        aiGenerated: parsed.frontmatter['ai_generated'] === true,
        createdAt: existing?.createdAt ?? file.modifiedAt,
        updatedAt: file.modifiedAt,
        archivedAt: null,
        data: {
          headings: parsed.headings.map((h) => ({ level: h.level, text: h.text })),
          tags: parsed.tags,
          wordCount: parsed.wordCount,
          taskCount: parsed.tasks.length,
          openTaskCount: parsed.tasks.filter((t) => !t.checked).length,
          frontmatter: parsed.frontmatter,
          sizeBytes: file.sizeBytes,
          hasFrontmatter: parsed.hasFrontmatter,
        },
      };

      deps.records.upsert(record);
      idByPath.set(file.vaultPath, id);
      indexed++;
    } catch (error) {
      failed++;
      errors.push({
        path: file.vaultPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Files that were indexed before but are no longer on disk. They are archived
  // rather than deleted: the record may still be the target of relationships, a
  // citation, or a context package, and silently dropping it would break those.
  // Archiving hides it from listings while keeping the history intact.
  const seenPaths = new Set(markdownFiles.map((f) => f.vaultPath));
  let archived = 0;
  for (const existing of deps.records.list({ limit: 10_000 })) {
    if (existing.vaultPath === null) continue;
    if (seenPaths.has(existing.vaultPath)) continue;
    deps.records.archive(existing.id, new Date().toISOString());
    deps.audit.record({
      actor: 'system',
      action: 'record.archive_missing_file',
      targetId: existing.id,
      targetPath: existing.vaultPath,
      detail: { reason: 'The file is no longer present in the vault.' },
      undo: null,
    });
    archived++;
  }

  // Fill in ids for unchanged files so pass 2 can resolve links to them.
  for (const file of markdownFiles) {
    if (!idByPath.has(file.vaultPath)) {
      const existing = deps.records.getByVaultPath(file.vaultPath);
      if (existing !== null) idByPath.set(file.vaultPath, existing.id);
    }
  }

  // Pass 2: link graph. Rebuilt wholesale for parsed links, since a rename can
  // invalidate an arbitrary number of them and a partial update would leave
  // stale edges behind.
  deps.db.prepare("DELETE FROM relationships WHERE origin = 'parsed_from_links'").run();
  deps.db.prepare('DELETE FROM unresolved_links').run();

  const knownPaths = [...idByPath.keys()];
  let relationshipCount = 0;
  let unresolvedCount = 0;
  const now = new Date().toISOString();

  for (const [vaultPath, parsed] of parsedByPath) {
    const sourceId = idByPath.get(vaultPath);
    if (sourceId === undefined) continue;

    for (const link of parsed.wikiLinks) {
      const resolvedPath = resolveWikiLink(link.target, knownPaths);
      if (resolvedPath === null) {
        deps.db
          .prepare(
            'INSERT INTO unresolved_links (id, source_id, raw_target, link_kind, detected_at) VALUES (?, ?, ?, ?, ?)',
          )
          .run(newId('note'), sourceId, link.target, link.embed ? 'embed' : 'wikilink', now);
        unresolvedCount++;
        continue;
      }
      const targetId = idByPath.get(resolvedPath);
      if (targetId === undefined || targetId === sourceId) continue;

      const relationship: Relationship = {
        id: newId('note'),
        sourceId,
        targetId,
        // An embed pulls content in; a link merely points at it. Both are
        // references, but the evidence records which so the distinction is
        // recoverable without reparsing.
        type: 'references',
        confidence: 1,
        origin: 'parsed_from_links',
        createdAt: now,
        approved: true,
        evidence: link.raw,
        notes: null,
      };
      deps.relationships.add(relationship);
      relationshipCount++;
    }

    // Relative markdown links to vault files count as references too.
    for (const link of parsed.markdownLinks) {
      if (link.external) continue;
      if (!link.url.toLowerCase().endsWith('.md')) continue;
      const decoded = decodeURIComponent(link.url).replace(/^\.\//, '');
      const resolvedPath = resolveWikiLink(decoded, knownPaths);
      if (resolvedPath === null) {
        unresolvedCount++;
        continue;
      }
      const targetId = idByPath.get(resolvedPath);
      if (targetId === undefined || targetId === sourceId) continue;
      deps.relationships.add({
        id: newId('note'),
        sourceId,
        targetId,
        type: 'references',
        confidence: 1,
        origin: 'parsed_from_links',
        createdAt: now,
        approved: true,
        evidence: `[${link.text}](${link.url})`,
        notes: null,
      });
      relationshipCount++;
    }
  }

  const result: IndexResult = {
    scanned: markdownFiles.length,
    indexed,
    unchanged,
    failed,
    relationships: relationshipCount,
    unresolvedLinks: unresolvedCount,
    archivedMissing: archived,
    durationMs: Date.now() - started,
    errors,
  };

  deps.audit.record({
    actor: 'system',
    action: 'vault.index',
    targetId: null,
    targetPath: null,
    detail: { ...result, errors: errors.length },
    undo: null,
  });

  return result;
}
