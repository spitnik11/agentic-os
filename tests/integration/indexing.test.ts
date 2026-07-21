/**
 * Integration tests for indexing.
 *
 * These build a real vault on disk, index it into a real (in-memory) database,
 * and assert on what a user would observe: their notes appear, their links
 * resolve, their files are unmodified, and the database can be thrown away and
 * rebuilt from the vault alone.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { indexVault } from '../../src/application/indexing/indexer.js';
import { ingestDrop } from '../../src/application/ingestion/ingest.js';
import { PrivacyPolicy } from '../../src/domain/policy/privacy.js';
import { openTestDatabase } from '../../src/infrastructure/db/database.js';
import {
  SqliteAuditLog,
  SqliteKnowledgeRepository,
  SqliteRelationshipRepository,
} from '../../src/infrastructure/db/repositories.js';
import { VaultFileSystem } from '../../src/infrastructure/fs/vault-filesystem.js';

const MANAGED = 'Agentic OS';

async function makeVault(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'agentic-vault-'));
  await mkdir(path.join(root, MANAGED, 'Inbox'), { recursive: true });
  await mkdir(path.join(root, '02 Projects', 'Alpha'), { recursive: true });
  await mkdir(path.join(root, 'Notes'), { recursive: true });
  await mkdir(path.join(root, '.obsidian'), { recursive: true });

  await writeFile(
    path.join(root, '02 Projects', 'Alpha', 'PROJECT.md'),
    '---\ntitle: Alpha\ntags:\n  - active\n---\n\n# Alpha\n\nGoal is to ship. See [[Research Note]].\n',
  );
  await writeFile(
    path.join(root, 'Notes', 'Research Note.md'),
    '# Research Note\n\nSupports [[Alpha]] and links to [[Missing Note]].\n\n- [ ] follow up\n- [x] done\n',
  );
  await writeFile(path.join(root, 'Notes', 'Orphan.md'), '# Orphan\n\nNothing links here.\n');
  // Should be excluded from indexing entirely.
  await writeFile(path.join(root, '.obsidian', 'workspace.json'), '{}');

  return root;
}

function makeDeps(root: string) {
  const db = openTestDatabase();
  const files = new VaultFileSystem({
    vaultRoot: root,
    managedRoot: path.join(root, MANAGED),
    internalRoot: path.join(root, '.agentic-os'),
  });
  const records = new SqliteKnowledgeRepository(db);
  const relationships = new SqliteRelationshipRepository(db);
  const audit = new SqliteAuditLog(db);
  return {
    db,
    files,
    records,
    relationships,
    audit,
    privacy: new PrivacyPolicy([]),
    managedFolder: MANAGED,
  };
}

let root: string;

beforeEach(async () => {
  root = await makeVault();
});

describe('indexing an existing vault', () => {
  it('finds every markdown file and skips Obsidian internals', async () => {
    const deps = makeDeps(root);
    const result = await indexVault(deps);

    expect(result.scanned).toBe(3);
    expect(result.indexed).toBe(3);
    expect(result.failed).toBe(0);

    const paths = deps.records.list({ limit: 100 }).map((r) => r.vaultPath);
    expect(paths).toContain('Notes/Research Note.md');
    expect(paths.some((p) => p?.includes('.obsidian'))).toBe(false);
  });

  it('leaves every source file byte-for-byte unmodified', async () => {
    const target = path.join(root, 'Notes', 'Research Note.md');
    const before = await readFile(target);
    const beforeStat = await stat(target);

    await indexVault(makeDeps(root));

    const after = await readFile(target);
    const afterStat = await stat(target);
    expect(after.equals(before)).toBe(true);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it('marks notes outside the managed folder read-only', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);
    const note = deps.records.getByVaultPath('Notes/Research Note.md');
    expect(note?.sourceOfTruth).toBe('external_read_only');
    expect(note?.provenance).toBe('imported_obsidian_note');
  });

  it('recognises a PROJECT.md as a project hub', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);
    const projects = deps.records.list({ recordTypes: ['project'], limit: 10 });
    expect(projects).toHaveLength(1);
    expect(projects[0]?.title).toBe('Alpha');
  });

  it('preserves frontmatter and extracts tasks', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);
    const project = deps.records.getByVaultPath('02 Projects/Alpha/PROJECT.md');
    const fm = project?.data['frontmatter'] as Record<string, unknown> | undefined;
    expect(fm?.['tags']).toEqual(['active']);

    const note = deps.records.getByVaultPath('Notes/Research Note.md');
    expect(note?.data['taskCount']).toBe(2);
    expect(note?.data['openTaskCount']).toBe(1);
  });
});

describe('link graph', () => {
  it('resolves wikilinks into relationships in both directions', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);

    const project = deps.records.getByVaultPath('02 Projects/Alpha/PROJECT.md');
    const note = deps.records.getByVaultPath('Notes/Research Note.md');
    expect(project).not.toBeNull();
    expect(note).not.toBeNull();

    const outbound = deps.relationships.forRecord(project!.id);
    expect(outbound.map((r) => r.targetId)).toContain(note!.id);

    const backlinks = deps.relationships.backlinksTo(note!.id);
    expect(backlinks.map((r) => r.sourceId)).toContain(project!.id);
  });

  it('records a link to a non-existent note as unresolved rather than dropping it', async () => {
    const deps = makeDeps(root);
    const result = await indexVault(deps);
    expect(result.unresolvedLinks).toBeGreaterThanOrEqual(1);

    const rows = deps.db.prepare('SELECT raw_target FROM unresolved_links').all() as unknown as {
      raw_target: string;
    }[];
    expect(rows.map((r) => r.raw_target)).toContain('Missing Note');
  });

  it('marks parsed links as deterministic, not model-suggested', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);
    const all = deps.relationships.byType('references', 50);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((r) => r.origin === 'parsed_from_links')).toBe(true);
    expect(all.every((r) => r.confidence === 1)).toBe(true);
  });

  it('does not duplicate relationships when reindexed', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);
    const first = deps.relationships.byType('references', 100).length;
    await indexVault(deps);
    const second = deps.relationships.byType('references', 100).length;
    expect(second).toBe(first);
  });
});

describe('incremental reindexing', () => {
  it('skips files whose content has not changed', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);
    const second = await indexVault(deps);
    expect(second.unchanged).toBe(3);
    expect(second.indexed).toBe(0);
  });

  it('reindexes a file after it changes', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);
    await writeFile(path.join(root, 'Notes', 'Orphan.md'), '# Orphan\n\nEdited in Obsidian.\n');
    const second = await indexVault(deps);
    expect(second.indexed).toBe(1);

    const note = deps.records.getByVaultPath('Notes/Orphan.md');
    expect(note?.body).toContain('Edited in Obsidian');
  });

  it('keeps a record id stable across an edit, so relationships survive', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);
    const before = deps.records.getByVaultPath('Notes/Research Note.md');

    await writeFile(
      path.join(root, 'Notes', 'Research Note.md'),
      '# Research Note\n\nRewritten. Still supports [[Alpha]].\n',
    );
    await indexVault(deps);
    const after = deps.records.getByVaultPath('Notes/Research Note.md');

    expect(after?.id).toBe(before?.id);
  });
});

describe('deleted files', () => {
  it('archives a record whose file has been removed, rather than leaving it stale', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);
    const orphan = deps.records.getByVaultPath('Notes/Orphan.md');
    expect(orphan).not.toBeNull();

    await rm(path.join(root, 'Notes', 'Orphan.md'));
    const result = await indexVault(deps);

    expect(result.archivedMissing).toBe(1);
    // Gone from normal listings...
    expect(deps.records.list({ limit: 100 }).map((r) => r.vaultPath)).not.toContain('Notes/Orphan.md');
    // ...but the record itself is retained, so anything pointing at it survives.
    expect(deps.records.get(orphan!.id)?.archivedAt).not.toBeNull();
  });

  it('does not archive anything when every file is still present', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);
    const second = await indexVault(deps);
    expect(second.archivedMissing).toBe(0);
  });
});

describe('rebuild from the vault alone', () => {
  it('reproduces the same records after the database is discarded', async () => {
    const first = makeDeps(root);
    await indexVault(first);
    const firstPaths = first.records
      .list({ limit: 100 })
      .map((r) => `${r.vaultPath}:${r.contentHash}`)
      .sort();

    // Throw the database away entirely and rebuild from disk.
    const second = makeDeps(root);
    await indexVault(second);
    const secondPaths = second.records
      .list({ limit: 100 })
      .map((r) => `${r.vaultPath}:${r.contentHash}`)
      .sort();

    expect(secondPaths).toEqual(firstPaths);
  });
});

describe('search', () => {
  it('finds a note by a word in its body', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);
    const hits = deps.records.search('ship', 10);
    expect(hits.map((h) => h.title)).toContain('Alpha');
  });

  it('returns nothing rather than throwing on punctuation-only input', async () => {
    const deps = makeDeps(root);
    await indexVault(deps);
    expect(() => deps.records.search('*()"', 10)).not.toThrow();
  });
});

describe('ingestion', () => {
  it('preserves the original, catalogs it, and detects an exact duplicate', async () => {
    const deps = makeDeps(root);
    const bytes = Buffer.from('# Dropped\n\nSome imported content.\n', 'utf8');

    const first = await ingestDrop(
      { filename: 'dropped.md', bytes, dropCategory: 'Inbox', projectId: null },
      { ...deps, privacyFor: () => 'never_external' },
    );
    expect(first.state).toBe('cataloged');
    expect(first.recordId).not.toBeNull();
    expect(first.originalPath).not.toBeNull();

    // The preserved original exists on disk and matches the input bytes.
    const preserved = await readFile(path.join(root, first.originalPath!));
    expect(preserved.equals(bytes)).toBe(true);

    const second = await ingestDrop(
      { filename: 'dropped-copy.md', bytes, dropCategory: 'Inbox', projectId: null },
      { ...deps, privacyFor: () => 'never_external' },
    );
    expect(second.state).toBe('duplicate');
    expect(second.duplicateOfId).toBe(first.recordId);
  });

  it('honours the drop category as an explicit user classification', async () => {
    const deps = makeDeps(root);
    const outcome = await ingestDrop(
      {
        filename: 'paper.md',
        bytes: Buffer.from('# Paper\n', 'utf8'),
        dropCategory: 'Research',
        projectId: null,
      },
      { ...deps, privacyFor: () => 'never_external' },
    );
    const record = deps.records.get(outcome.recordId!);
    expect(record?.recordType).toBe('research_item');
    expect(record?.data['userClassified']).toBe(true);
    expect(record?.data['dropCategory']).toBe('Research');
  });

  it('holds an executable for review instead of cataloging it silently', async () => {
    const deps = makeDeps(root);
    const outcome = await ingestDrop(
      {
        filename: 'tool.exe',
        bytes: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
        dropCategory: 'Inbox',
        projectId: null,
      },
      { ...deps, privacyFor: () => 'never_external' },
    );
    expect(outcome.state).toBe('quarantined');
    expect(outcome.warnings.join(' ')).toMatch(/executable/i);

    const record = deps.records.get(outcome.recordId!);
    expect(record?.processing).toBe('needs_review');
    // Never parsed as text.
    expect(record?.body).toBeNull();
  });

  it('defaults an imported item to closed privacy', async () => {
    const deps = makeDeps(root);
    const outcome = await ingestDrop(
      {
        filename: 'note.md',
        bytes: Buffer.from('# X\n', 'utf8'),
        dropCategory: 'Inbox',
        projectId: null,
      },
      { ...deps, privacyFor: (p) => new PrivacyPolicy([]).levelFor(p) },
    );
    const record = deps.records.get(outcome.recordId!);
    expect(record?.privacy).toBe('never_external');
  });

  it('writes an audit entry carrying an inverse operation', async () => {
    const deps = makeDeps(root);
    await ingestDrop(
      {
        filename: 'note.md',
        bytes: Buffer.from('# X\n', 'utf8'),
        dropCategory: 'Inbox',
        projectId: null,
      },
      { ...deps, privacyFor: () => 'never_external' },
    );
    const undoable = deps.audit.lastUndoable();
    expect(undoable).not.toBeNull();
    expect(undoable?.undo?.['kind']).toBe('archive_record');
  });
});
