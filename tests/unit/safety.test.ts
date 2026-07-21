/**
 * Safety tests.
 *
 * These cover the guarantees the product actually makes to the user: it will
 * not modify notes it does not own, and it will not send content anywhere
 * without being told to. A regression in either is a data-loss or privacy
 * incident, so each is tested at the boundary that enforces it rather than at
 * the call site that happens to respect it.
 */

import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManagedBoundaryViolation } from '../../src/domain/model/types.js';
import { VaultFileSystem } from '../../src/infrastructure/fs/vault-filesystem.js';
import { PrivacyPolicy, redact, strictest } from '../../src/domain/policy/privacy.js';
import { NoOpLanguageModelProvider, createLanguageModelProvider } from '../../src/infrastructure/ai/providers.js';
import { sanitizeFilename } from '../../src/application/ingestion/ingest.js';
import { isInside, toAbsolutePath } from '../../src/infrastructure/config/paths.js';

let vaultRoot: string;
let fs: VaultFileSystem;

beforeEach(async () => {
  vaultRoot = await mkdtemp(path.join(tmpdir(), 'agentic-test-'));
  await mkdir(path.join(vaultRoot, 'Agentic OS', 'Inbox'), { recursive: true });
  await mkdir(path.join(vaultRoot, 'Personal Notes'), { recursive: true });
  await writeFile(path.join(vaultRoot, 'Personal Notes', 'private.md'), '# Do not touch\n');

  fs = new VaultFileSystem({
    vaultRoot,
    managedRoot: path.join(vaultRoot, 'Agentic OS'),
    internalRoot: path.join(vaultRoot, '.agentic-os'),
  });
});

afterEach(() => {
  vaultRoot = '';
});

describe('managed write boundary', () => {
  it('allows writes inside the managed folder', async () => {
    await fs.writeText('Agentic OS/Inbox/note.md', '# Managed\n');
    const text = await fs.readText('Agentic OS/Inbox/note.md');
    expect(text).toBe('# Managed\n');
  });

  it('refuses to overwrite a user-authored note outside the managed folder', async () => {
    await expect(fs.writeText('Personal Notes/private.md', 'overwritten')).rejects.toBeInstanceOf(
      ManagedBoundaryViolation,
    );
    // The original must be byte-for-byte intact.
    const untouched = await readFile(path.join(vaultRoot, 'Personal Notes', 'private.md'), 'utf8');
    expect(untouched).toBe('# Do not touch\n');
  });

  it('refuses a traversal that would escape via ..', async () => {
    await expect(fs.writeText('Agentic OS/../Personal Notes/private.md', 'x')).rejects.toThrow();
    const untouched = await readFile(path.join(vaultRoot, 'Personal Notes', 'private.md'), 'utf8');
    expect(untouched).toBe('# Do not touch\n');
  });

  it('refuses a write that escapes the vault entirely', async () => {
    await expect(fs.writeText('../outside.md', 'x')).rejects.toThrow();
  });

  it('still permits reading anywhere in the vault', async () => {
    const text = await fs.readText('Personal Notes/private.md');
    expect(text).toBe('# Do not touch\n');
  });

  it('reports managed status correctly', () => {
    expect(fs.isManaged('Agentic OS/Inbox/x.md')).toBe(true);
    expect(fs.isManaged('Personal Notes/x.md')).toBe(false);
    // A sibling sharing a name prefix is not inside the managed folder.
    expect(fs.isManaged('Agentic OS Extra/x.md')).toBe(false);
  });
});

describe('path containment', () => {
  it('does not treat a name-prefix sibling as contained', () => {
    expect(isInside('/a/managed', '/a/managed-other/file')).toBe(false);
    expect(isInside('/a/managed', '/a/managed/file')).toBe(true);
  });

  it('rejects a vault path that resolves outside the root', () => {
    expect(() => toAbsolutePath('../../etc/passwd', '/vault')).toThrow();
  });
});

describe('privacy policy', () => {
  it('fails closed for any path with no rule', () => {
    const policy = new PrivacyPolicy([]);
    expect(policy.levelFor('anything/at/all.md')).toBe('never_external');
    expect(policy.canSendAll(['anything.md'])).toBe(false);
  });

  it('applies the longest matching prefix', () => {
    const policy = new PrivacyPolicy([
      { pathPrefix: 'Notes', level: 'ai_allowed' },
      { pathPrefix: 'Notes/Private', level: 'never_external' },
    ]);
    expect(policy.levelFor('Notes/public.md')).toBe('ai_allowed');
    expect(policy.levelFor('Notes/Private/secret.md')).toBe('never_external');
  });

  it('does not let a name-prefix sibling inherit a rule', () => {
    const policy = new PrivacyPolicy([{ pathPrefix: 'Notes', level: 'ai_allowed' }]);
    expect(policy.levelFor('NotesArchive/x.md')).toBe('never_external');
  });

  it('takes the stricter of two levels when combining scopes', () => {
    expect(strictest('ai_allowed', 'never_external')).toBe('never_external');
    expect(strictest('ai_allowed', 'ai_allowed_with_redaction')).toBe('ai_allowed_with_redaction');
  });

  it('refuses a mixed batch if any member is closed', () => {
    const policy = new PrivacyPolicy([
      { pathPrefix: 'Open', level: 'ai_allowed' },
      { pathPrefix: 'Closed', level: 'never_external' },
    ]);
    expect(policy.canSendAll(['Open/a.md', 'Closed/b.md'])).toBe(false);
  });

  it('refuses an empty batch rather than treating it as permitted', () => {
    const policy = new PrivacyPolicy([{ pathPrefix: 'Open', level: 'ai_allowed' }]);
    expect(policy.canSendAll([])).toBe(false);
  });
});

describe('secret redaction', () => {
  it('removes recognisable credential formats', () => {
    const { text, redactions } = redact(
      'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 and password: hunter2xyz',
    );
    expect(text).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
    expect(text).not.toContain('hunter2xyz');
    expect(redactions.length).toBeGreaterThan(0);
  });

  it('leaves ordinary prose untouched', () => {
    const { text, redactions } = redact('This is a normal sentence about passwords in general.');
    expect(text).toBe('This is a normal sentence about passwords in general.');
    expect(redactions).toHaveLength(0);
  });
});

describe('language model gating', () => {
  it('is disabled by default and reports why', async () => {
    const provider = new NoOpLanguageModelProvider('ai_disabled');
    expect(provider.available).toBe(false);
    const result = await provider.analyze({
      prompt: 'anything',
      tokenClass: 1,
      privacy: 'ai_allowed',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('ai_disabled');
  });

  it('returns the NoOp provider when the switch is off, even with a key present', () => {
    const provider = createLanguageModelProvider({
      aiEnabled: false,
      apiKey: 'sk-ant-something',
      model: 'claude-haiku-4-5-20251001',
      monthlyBudgetUsd: 5,
      perRunTokenCeiling: 1000,
      usage: { record: () => undefined, monthToDateUsd: () => 0, recent: () => [], byFeature: () => [] },
      feature: 'test',
    });
    expect(provider.available).toBe(false);
    expect(provider.name).toBe('none');
  });

  it('returns the NoOp provider when enabled but no key is configured', () => {
    const provider = createLanguageModelProvider({
      aiEnabled: true,
      apiKey: undefined,
      model: 'claude-haiku-4-5-20251001',
      monthlyBudgetUsd: 5,
      perRunTokenCeiling: 1000,
      usage: { record: () => undefined, monthToDateUsd: () => 0, recent: () => [], byFeature: () => [] },
      feature: 'test',
    });
    expect(provider.available).toBe(false);
  });
});

describe('filename sanitisation', () => {
  it('strips path separators', () => {
    const { safe, warnings } = sanitizeFilename('../../etc/passwd');
    expect(safe).not.toContain('/');
    expect(safe).not.toContain('..');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('neutralises Windows reserved device names', () => {
    const { safe } = sanitizeFilename('CON.md');
    expect(safe.toLowerCase()).not.toMatch(/^con(\.|$)/);
  });

  it('removes characters that are invalid on Windows', () => {
    const { safe } = sanitizeFilename('a:b*c?.md');
    expect(safe).not.toMatch(/[:*?]/);
  });

  it('never returns an empty name', () => {
    expect(sanitizeFilename('...').safe).not.toBe('');
    expect(sanitizeFilename('').safe).toBe('untitled');
  });
});
