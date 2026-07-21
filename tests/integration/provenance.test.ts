/**
 * Regression tests for two defects the independent audit found.
 *
 * Both were invisible to the existing suite because the round-trip test
 * asserted only `body` and `id`. Provenance, privacy, and record type were
 * never checked, so a reindex could quietly relabel an imported file as
 * deterministic extraction and every test stayed green.
 */

import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { indexVault } from '../../src/application/indexing/indexer.js';
import { ingestDrop } from '../../src/application/ingestion/ingest.js';
import { materializeRecord } from '../../src/application/sync/materialize.js';
import { PrivacyPolicy } from '../../src/domain/policy/privacy.js';
import { ManagedBoundaryViolation } from '../../src/domain/model/types.js';
import { openTestDatabase } from '../../src/infrastructure/db/database.js';
import {
  SqliteAuditLog,
  SqliteKnowledgeRepository,
  SqliteRelationshipRepository,
} from '../../src/infrastructure/db/repositories.js';
import { VaultFileSystem } from '../../src/infrastructure/fs/vault-filesystem.js';

const MANAGED = 'Agentic OS';
let root: string;

function makeDeps(vaultRoot: string) {
  const db = openTestDatabase();
  const files = new VaultFileSystem({
    vaultRoot,
    managedRoot: path.join(vaultRoot, MANAGED),
    internalRoot: path.join(vaultRoot, '.agentic-os'),
  });
  return {
    db,
    files,
    records: new SqliteKnowledgeRepository(db),
    relationships: new SqliteRelationshipRepository(db),
    audit: new SqliteAuditLog(db),
    privacy: new PrivacyPolicy([]),
    managedFolder: MANAGED,
  };
}

async function importAndMaterialize(deps: ReturnType<typeof makeDeps>, filename = 'source.md') {
  const outcome = await ingestDrop(
    {
      filename,
      bytes: Buffer.from('# Imported\n\nFrom a third party.\n', 'utf8'),
      dropCategory: 'Research',
      projectId: null,
    },
    { ...deps, privacyFor: () => 'never_external' },
  );
  const record = deps.records.get(outcome.recordId!);
  const materialized = await materializeRecord(record!, deps);
  return { outcome, record: record!, materialized };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agentic-prov-'));
  await mkdir(path.join(root, MANAGED, 'Research'), { recursive: true });
  await mkdir(path.join(root, 'Personal'), { recursive: true });
});

describe('provenance survives a reindex', () => {
  it('does not relabel an imported file as deterministic extraction', async () => {
    const deps = makeDeps(root);
    const { record, materialized } = await importAndMaterialize(deps);
    expect(record.provenance).toBe('imported_third_party');

    await indexVault(deps);

    const after = deps.records.getByVaultPath(materialized.vaultPath!);
    expect(after).not.toBeNull();
    // The defect: this used to come back as 'deterministic_extraction',
    // claiming code produced content that actually came from outside.
    expect(after!.provenance).toBe('imported_third_party');
  });

  it('preserves a model-authored provenance rather than downgrading it', async () => {
    const deps = makeDeps(root);
    await deps.files.writeText(
      `${MANAGED}/Research/Model Note.md`,
      [
        '---',
        'agentic_id: res_01MODELNOTE0000000000000000',
        'record_type: research_item',
        'provenance: ai_inference',
        'ai_generated: true',
        '---',
        '',
        '# Model Note',
        '',
        'A guess, not a stated fact.',
      ].join('\n'),
    );

    await indexVault(deps);

    const record = deps.records.getByVaultPath(`${MANAGED}/Research/Model Note.md`);
    // An inference must never be promoted to a verified-looking state.
    expect(record?.provenance).toBe('ai_inference');
    expect(record?.aiGenerated).toBe(true);
  });

  it('ignores a provenance value that is not a known state', async () => {
    const deps = makeDeps(root);
    await deps.files.writeText(
      `${MANAGED}/Research/Bogus.md`,
      ['---', 'provenance: totally-made-up', '---', '', '# Bogus', '', 'x'].join('\n'),
    );
    await indexVault(deps);
    const record = deps.records.getByVaultPath(`${MANAGED}/Research/Bogus.md`);
    expect(record?.provenance).toBe('deterministic_extraction');
  });

  it('round-trips record type as well as provenance', async () => {
    const deps = makeDeps(root);
    const { record, materialized } = await importAndMaterialize(deps);
    expect(record.recordType).toBe('research_item');

    await indexVault(deps);

    const after = deps.records.getByVaultPath(materialized.vaultPath!);
    expect(after!.recordType).toBe('research_item');
  });
});

describe('undo is not reverted by the next reindex', () => {
  it('removes the materialized note, so a rescan cannot resurrect the record', async () => {
    const deps = makeDeps(root);
    const { record, materialized } = await importAndMaterialize(deps);
    const notePath = materialized.vaultPath!;
    expect(await deps.files.exists(notePath)).toBe(true);

    // What the undo route now does: delete the note, then archive the record.
    await deps.files.remove(notePath);
    deps.records.archive(record.id, new Date().toISOString());

    expect(await deps.files.exists(notePath)).toBe(false);

    await indexVault(deps);

    // The defect: the note stayed on disk, so reindex rebuilt the record with
    // archived_at reset to null and the undone import silently reappeared.
    const after = deps.records.get(record.id);
    expect(after?.archivedAt).not.toBeNull();
    expect(deps.records.list({ limit: 100 }).map((r) => r.vaultPath)).not.toContain(notePath);
  });

  it('keeps the preserved original after the note is removed', async () => {
    const deps = makeDeps(root);
    const { outcome, materialized } = await importAndMaterialize(deps);

    await deps.files.remove(materialized.vaultPath!);

    // Undo removes the note the app created, never the bytes the user gave it.
    const preserved = await readFile(path.join(root, outcome.originalPath!), 'utf8');
    expect(preserved).toContain('From a third party.');
  });
});

describe('remove honours the same boundary as write', () => {
  it('refuses to delete a note the user owns', async () => {
    const deps = makeDeps(root);
    await mkdir(path.join(root, 'Personal'), { recursive: true });
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(root, 'Personal', 'mine.md'), '# Mine\n');

    await expect(deps.files.remove('Personal/mine.md')).rejects.toBeInstanceOf(
      ManagedBoundaryViolation,
    );

    const stillThere = await readFile(path.join(root, 'Personal', 'mine.md'), 'utf8');
    expect(stillThere).toBe('# Mine\n');
  });

  it('refuses a traversal that would escape the managed folder', async () => {
    const deps = makeDeps(root);
    await expect(deps.files.remove('Agentic OS/../Personal/mine.md')).rejects.toThrow();
  });

  it('treats an already-absent file as success', async () => {
    const deps = makeDeps(root);
    await expect(deps.files.remove(`${MANAGED}/Research/never-existed.md`)).resolves.toBeUndefined();
  });
});
