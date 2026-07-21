import { NextResponse } from 'next/server';
import { indexVault } from '../../../application/indexing/indexer.js';
import { getServices } from '../../../infrastructure/container.js';

export const dynamic = 'force-dynamic';

/**
 * Rescan the vault.
 *
 * Reads vault files and writes only to the database. Token Class 0.
 */
export async function POST() {
  const services = getServices();
  try {
    const result = await indexVault({
      files: services.files,
      records: services.records,
      relationships: services.relationships,
      audit: services.audit,
      privacy: services.privacy,
      managedFolder: services.config.managedFolder,
      db: services.db,
    });
    return NextResponse.json({ tokenClass: 0, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
