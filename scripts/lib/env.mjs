/**
 * Minimal .env.local loader for standalone scripts.
 * Next.js loads env files itself; scripts run outside it and need this.
 */

import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(cwd = process.cwd()) {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(cwd, name);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // First file wins, matching Next.js precedence.
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}
