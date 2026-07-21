/**
 * Rebuild the database index from the vault.
 *
 * Read-only with respect to vault content: it opens files for reading and
 * writes only to the database. This is the recovery path if the database is
 * ever lost, which is what keeps the vault the real source of truth.
 *
 *   npm run index
 */

import { indexVault } from '../src/application/indexing/indexer.js';
import { displayPath } from '../src/infrastructure/config/paths.js';
import { createServices, loadEnv } from './lib/bootstrap.js';

loadEnv();

const services = createServices();
const { config } = services;

console.log('Agentic OS - vault reindex');
console.log(`  vault:    ${displayPath(config.vaultRoot)}`);
console.log(`  managed:  ${config.managedFolder}`);
console.log(`  database: ${displayPath(config.databasePath)}`);
console.log('');

const result = await indexVault({
  files: services.files,
  records: services.records,
  relationships: services.relationships,
  audit: services.audit,
  privacy: services.privacy,
  managedFolder: config.managedFolder,
  db: services.db,
});

console.log(`  scanned:          ${result.scanned} markdown files`);
console.log(`  indexed:          ${result.indexed}`);
console.log(`  unchanged:        ${result.unchanged}`);
console.log(`  failed:           ${result.failed}`);
console.log(`  relationships:    ${result.relationships}`);
console.log(`  unresolved links: ${result.unresolvedLinks}`);
console.log(`  archived (file gone): ${result.archivedMissing}`);
console.log(`  duration:         ${result.durationMs} ms`);

if (result.errors.length > 0) {
  console.log('\n  errors:');
  for (const e of result.errors.slice(0, 20)) {
    console.log(`    ${e.path}: ${e.message}`);
  }
}

process.exit(result.failed > 0 ? 1 : 0);
