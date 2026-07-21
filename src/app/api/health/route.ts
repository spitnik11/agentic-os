import { NextResponse } from 'next/server';
import { getServices } from '../../../infrastructure/container.js';
import { currentSchemaVersion } from '../../../infrastructure/db/database.js';
import { displayPath } from '../../../infrastructure/config/paths.js';

export const dynamic = 'force-dynamic';

/**
 * Operational status. Reports availability only: no secrets, no vault content,
 * and the vault path is shown with the home directory redacted.
 */
export async function GET() {
  try {
    const { config, db, records, usage } = getServices();

    let vaultReachable = false;
    try {
      const { files } = getServices();
      vaultReachable = await files.exists('.');
    } catch {
      vaultReachable = false;
    }

    return NextResponse.json({
      status: 'ok',
      version: '0.1.0',
      mode: 'private',
      database: {
        available: true,
        schemaVersion: currentSchemaVersion(db),
        location: displayPath(config.databasePath),
      },
      vault: {
        reachable: vaultReachable,
        path: displayPath(config.vaultRoot),
        managedFolder: config.managedFolder,
        indexedRecords: records.count({}),
      },
      search: { available: true, engine: 'sqlite-fts5' },
      ai: {
        enabled: config.aiEnabled,
        provider: config.aiEnabled && (config.anthropicApiKey ?? '') !== '' ? 'claude' : 'none',
        monthToDateUsd: usage.monthToDateUsd(),
        monthlyBudgetUsd: config.monthlyBudgetUsd,
      },
      worker: { available: true, kind: 'in-process' },
    });
  } catch (error) {
    return NextResponse.json(
      {
        status: 'error',
        detail: error instanceof Error ? error.message : String(error),
        hint: 'Check that VAULT_ROOT in .env.local points at an existing folder, then run `npm run doctor`.',
      },
      { status: 503 },
    );
  }
}
