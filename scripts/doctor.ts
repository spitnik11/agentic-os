/**
 * Diagnostics.
 *
 * Checks the things that actually break a local setup, and tells the user what
 * to do about each one rather than only that it failed.
 *
 *   npm run doctor
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { displayPath, loadConfig } from '../src/infrastructure/config/paths.js';
import { currentSchemaVersion, openDatabase } from '../src/infrastructure/db/database.js';
import { loadEnv } from './lib/bootstrap.js';

type Status = 'ok' | 'warn' | 'fail';

interface Check {
  name: string;
  status: Status;
  detail: string;
  remedy?: string;
}

const checks: Check[] = [];

function add(name: string, status: Status, detail: string, remedy?: string): void {
  checks.push(remedy === undefined ? { name, status, detail } : { name, status, detail, remedy });
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

// --- Runtime -----------------------------------------------------------------

const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
const minor = Number.parseInt(process.versions.node.split('.')[1] ?? '0', 10);
const hasNodeSqlite = major > 22 || (major === 22 && minor >= 5);

add(
  'Node version',
  hasNodeSqlite ? 'ok' : 'fail',
  `Node ${process.versions.node}`,
  hasNodeSqlite
    ? undefined
    : 'Node 22.5 or newer is required for the built-in node:sqlite module. Install the current LTS from https://nodejs.org.',
);

// --- Configuration -----------------------------------------------------------

const envLocal = path.join(process.cwd(), '.env.local');
if (!fs.existsSync(envLocal)) {
  add(
    'Configuration file',
    'fail',
    '.env.local is missing',
    'Run: Copy-Item .env.example .env.local   then edit VAULT_ROOT to point at your vault.',
  );
} else {
  add('Configuration file', 'ok', '.env.local found');
}

loadEnv();

let config: ReturnType<typeof loadConfig> | null = null;
try {
  config = loadConfig();
  add('VAULT_ROOT', 'ok', displayPath(config.vaultRoot));
} catch (error) {
  add(
    'VAULT_ROOT',
    'fail',
    error instanceof Error ? error.message : String(error),
    'Set VAULT_ROOT in .env.local to the absolute path of your Obsidian vault.',
  );
}

// --- Vault -------------------------------------------------------------------

if (config !== null) {
  if (!fs.existsSync(config.vaultRoot)) {
    add(
      'Vault reachable',
      'fail',
      `Not found: ${displayPath(config.vaultRoot)}`,
      'Check the path in .env.local. On Windows use a full path such as C:\\Users\\you\\Documents\\MyVault.',
    );
  } else {
    const mdCount = countMarkdown(config.vaultRoot, config.internalFolder);
    add('Vault reachable', 'ok', `${mdCount} markdown file(s) found`);

    const obsidian = path.join(config.vaultRoot, '.obsidian');
    add(
      'Obsidian vault',
      fs.existsSync(obsidian) ? 'ok' : 'warn',
      fs.existsSync(obsidian)
        ? '.obsidian found; this is a real vault'
        : 'No .obsidian folder; the app will still work but Obsidian links may not open',
    );

    if (!fs.existsSync(config.managedRoot)) {
      add(
        'Managed folder',
        'warn',
        `${config.managedFolder} does not exist yet`,
        'It is created automatically on first write. Nothing is wrong.',
      );
    } else {
      add('Managed folder', 'ok', `${config.managedFolder} exists and is writable by the app`);
    }

    try {
      const probe = path.join(config.internalRoot, '.write-probe');
      fs.mkdirSync(config.internalRoot, { recursive: true });
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      add('Write access', 'ok', 'Application folder is writable');
    } catch (error) {
      add(
        'Write access',
        'fail',
        error instanceof Error ? error.message : String(error),
        'The app needs to write to the .agentic-os folder inside your vault. Check folder permissions.',
      );
    }

    const backups = path.join(config.internalRoot, 'backups');
    const backupCount = fs.existsSync(backups) ? fs.readdirSync(backups).length : 0;
    add(
      'Vault backup',
      backupCount > 0 ? 'ok' : 'warn',
      backupCount > 0 ? `${backupCount} backup(s) present` : 'No backup found',
      backupCount > 0 ? undefined : 'Take one before importing anything. See TROUBLESHOOTING.md.',
    );
  }

  // --- Database ---------------------------------------------------------------

  try {
    const db = openDatabase(config.databasePath);
    const version = currentSchemaVersion(db);
    const row = db.prepare('SELECT COUNT(*) AS n FROM records').get() as unknown as
      | { n: number }
      | undefined;
    const count = row?.n ?? 0;
    add(
      'Database',
      'ok',
      `schema v${version}, ${count} record(s) indexed`,
      count === 0 ? 'Run: npm run index   to index your vault for the first time.' : undefined,
    );
  } catch (error) {
    add(
      'Database',
      'fail',
      error instanceof Error ? error.message : String(error),
      'Delete the .agentic-os/database folder and run `npm run index` to rebuild from the vault.',
    );
  }

  // --- AI ---------------------------------------------------------------------

  if (!config.aiEnabled) {
    add('AI features', 'ok', 'Disabled. Everything runs locally at no cost.');
  } else if ((config.anthropicApiKey ?? '') === '') {
    add(
      'AI features',
      'warn',
      'AI_ENABLED is true but no ANTHROPIC_API_KEY is set',
      'Either add a key to .env.local or set AI_ENABLED=false. The app works fully either way.',
    );
  } else {
    add('AI features', 'ok', `Enabled, budget $${config.monthlyBudgetUsd.toFixed(2)}/month`);
  }
}

// --- Port --------------------------------------------------------------------

const free = await portFree(3000);
add(
  'Port 3000',
  free ? 'ok' : 'warn',
  free ? 'Available' : 'In use',
  free ? undefined : 'Either the app is already running, or something else holds it. Use `npm run dev -- -p 3001`.',
);

// --- Dependencies ------------------------------------------------------------

add(
  'Dependencies',
  fs.existsSync(path.join(process.cwd(), 'node_modules')) ? 'ok' : 'fail',
  fs.existsSync(path.join(process.cwd(), 'node_modules')) ? 'Installed' : 'node_modules is missing',
  fs.existsSync(path.join(process.cwd(), 'node_modules')) ? undefined : 'Run: npm install',
);

// --- Report ------------------------------------------------------------------

const GLYPH: Record<Status, string> = { ok: '  OK  ', warn: ' WARN ', fail: ' FAIL ' };

console.log('\nAgentic OS - diagnostics\n');
for (const check of checks) {
  console.log(`[${GLYPH[check.status]}] ${check.name.padEnd(20)} ${check.detail}`);
  if (check.remedy !== undefined) console.log(`${' '.repeat(11)}-> ${check.remedy}`);
}

const failures = checks.filter((c) => c.status === 'fail').length;
const warnings = checks.filter((c) => c.status === 'warn').length;

console.log('');
if (failures > 0) {
  console.log(`${failures} problem(s) must be fixed before the app will start.`);
} else if (warnings > 0) {
  console.log(`Ready to run, with ${warnings} note(s) above.`);
  console.log('Start with: npm run dev    then open http://localhost:3000');
} else {
  console.log('Everything checks out.');
  console.log('Start with: npm run dev    then open http://localhost:3000');
}

process.exit(failures > 0 ? 1 : 0);

function countMarkdown(root: string, internalFolder: string): number {
  let total = 0;
  const skip = new Set([internalFolder, '.obsidian', '.git', 'node_modules']);
  const walk = (dir: string, depth: number): void => {
    if (depth > 20) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.toLowerCase().endsWith('.md')) total++;
    }
  };
  walk(root, 0);
  return total;
}
