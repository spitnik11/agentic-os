/**
 * Filesystem adapter for the vault.
 *
 * This is the only module permitted to write into the vault, and it refuses
 * every write that lands outside the managed folder. The check runs against the
 * fully resolved real path, after symlink resolution, so a symlink planted
 * inside the managed folder cannot be used to reach user-authored notes.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ManagedBoundaryViolation } from '../../domain/model/types.js';
import type { FileStorageProvider, VaultFileMeta } from '../../domain/ports/index.js';
import { isInside, toAbsolutePath, toVaultPath } from '../config/paths.js';

/** Directories never surfaced as knowledge content. */
const ALWAYS_EXCLUDED = new Set(['.obsidian', '.git', 'node_modules', '.trash']);

export interface VaultFileSystemOptions {
  readonly vaultRoot: string;
  readonly managedRoot: string;
  readonly internalRoot: string;
}

export class VaultFileSystem implements FileStorageProvider {
  constructor(private readonly options: VaultFileSystemOptions) {}

  private abs(vaultPath: string): string {
    return toAbsolutePath(vaultPath, this.options.vaultRoot);
  }

  isManaged(vaultPath: string): boolean {
    try {
      return isInside(this.options.managedRoot, this.abs(vaultPath));
    } catch {
      return false;
    }
  }

  /**
   * Resolve symlinks before deciding whether a write is allowed. If the target
   * does not exist yet, resolve its nearest existing ancestor instead, which is
   * what actually determines where the write lands.
   */
  private async realPathForWrite(absolutePath: string): Promise<string> {
    let candidate = absolutePath;
    const tail: string[] = [];
    for (;;) {
      try {
        const real = await fs.realpath(candidate);
        return path.join(real, ...tail.reverse());
      } catch {
        const parent = path.dirname(candidate);
        if (parent === candidate) return absolutePath;
        tail.push(path.basename(candidate));
        candidate = parent;
      }
    }
  }

  async readText(vaultPath: string): Promise<string> {
    return fs.readFile(this.abs(vaultPath), 'utf8');
  }

  async writeText(vaultPath: string, contents: string): Promise<void> {
    const absolute = this.abs(vaultPath);
    const real = await this.realPathForWrite(absolute);
    if (!isInside(this.options.managedRoot, real)) {
      throw new ManagedBoundaryViolation(vaultPath);
    }
    await fs.mkdir(path.dirname(real), { recursive: true });
    // Write to a temporary file and rename, so an interrupted write cannot
    // leave a half-written note behind.
    const tmp = `${real}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, contents, 'utf8');
    await fs.rename(tmp, real);
  }

  /**
   * Delete a file. Subject to exactly the same boundary check as writing, so a
   * note the user owns can never be removed by the application.
   */
  async remove(vaultPath: string): Promise<void> {
    const absolute = this.abs(vaultPath);
    const real = await this.realPathForWrite(absolute);
    if (!isInside(this.options.managedRoot, real)) {
      throw new ManagedBoundaryViolation(vaultPath);
    }
    try {
      await fs.unlink(real);
    } catch (error) {
      // Already gone is a success for the caller's purposes.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async exists(vaultPath: string): Promise<boolean> {
    try {
      await fs.access(this.abs(vaultPath));
      return true;
    } catch {
      return false;
    }
  }

  async stat(vaultPath: string): Promise<VaultFileMeta | null> {
    const absolute = this.abs(vaultPath);
    try {
      const s = await fs.stat(absolute);
      return {
        absolutePath: absolute,
        vaultPath: toVaultPath(absolute, this.options.vaultRoot),
        sizeBytes: s.size,
        modifiedAt: s.mtime.toISOString(),
        isDirectory: s.isDirectory(),
        writable: isInside(this.options.managedRoot, absolute),
      };
    } catch {
      return null;
    }
  }

  async list(
    vaultPath: string,
    options: { recursive?: boolean } = {},
  ): Promise<readonly VaultFileMeta[]> {
    const root = this.abs(vaultPath);
    const out: VaultFileMeta[] = [];

    const walk = async (dir: string, depth: number): Promise<void> => {
      // Guard against a symlink loop producing unbounded recursion.
      if (depth > 32) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (ALWAYS_EXCLUDED.has(entry.name)) continue;
        const absolute = path.join(dir, entry.name);
        // Never descend into the application's own internal folder.
        if (isInside(this.options.internalRoot, absolute)) continue;
        // Do not follow symlinks while walking; report them but do not traverse.
        if (entry.isSymbolicLink()) continue;

        let stats: import('node:fs').Stats;
        try {
          stats = await fs.stat(absolute);
        } catch {
          continue;
        }

        out.push({
          absolutePath: absolute,
          vaultPath: toVaultPath(absolute, this.options.vaultRoot),
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString(),
          isDirectory: stats.isDirectory(),
          writable: isInside(this.options.managedRoot, absolute),
        });

        if (stats.isDirectory() && options.recursive === true) {
          await walk(absolute, depth + 1);
        }
      }
    };

    await walk(root, 0);
    return out;
  }

  /**
   * Store an imported original under the internal folder, addressed by content
   * hash rather than by its supplied filename, so a hostile name cannot steer
   * the write. The original extension is kept for preview purposes only, after
   * being stripped of any path separators.
   */
  async preserveOriginal(bytes: Buffer, filename: string, hash: string): Promise<string> {
    const ext = path.extname(filename).replace(/[^A-Za-z0-9.]/g, '').slice(0, 12);
    const shard = hash.slice(0, 2);
    const dir = path.join(this.options.internalRoot, 'originals', shard);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, `${hash}${ext}`);
    // Content-addressed: if it already exists the bytes are identical.
    try {
      await fs.access(target);
    } catch {
      await fs.writeFile(target, bytes);
    }
    return toVaultPath(target, this.options.vaultRoot);
  }
}

export function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32);
}
