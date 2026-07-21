# Troubleshooting

Run this first. It checks everything below and prints the fix for each problem:

```powershell
cd "Z:\Claude app\agentic-os"
npm run doctor
```

---

## The app will not start

### `VAULT_ROOT must be set`

`.env.local` is missing or has no vault path.

```powershell
Copy-Item .env.example .env.local
notepad .env.local
```

Set `VAULT_ROOT` to the full path of your vault, for example:

```
VAULT_ROOT=C:\Users\YourName\Documents\MyVault
```

Use a full path with a drive letter. Do not quote it. Do not use a trailing
backslash.

### `Port 3000 is already in use`

Either the app is already running in another terminal, or something else holds
the port.

```powershell
# See what holds it
Get-NetTCPConnection -LocalPort 3000 | Select-Object OwningProcess
Get-Process -Id <the id from above>

# Or just use a different port
npm run dev -- -p 3001
```

### `Cannot find module 'node:sqlite'`

Your Node is older than 22.5. Check with `node --version` and install the
current LTS from <https://nodejs.org>.

---

## Nothing appears in the interface

The vault has not been indexed yet.

```powershell
npm run index
```

You should see a count of scanned files. If it says `scanned: 0`, `VAULT_ROOT`
is pointing at the wrong folder — confirm with `npm run doctor`.

---

## A note I just edited in Obsidian is not showing the change

There is no filesystem watcher yet. Press the **Reindex** button in the header,
or run `npm run index`. Only changed files are re-read, so this is fast.

---

## The database is broken

Delete it and rebuild. **This is always safe** — the database holds no knowledge
that is not in the vault.

```powershell
Remove-Item "$env:USERPROFILE\Documents\ClaudeBrain\.agentic-os\database" -Recurse -Force
npm run index
```

---

## Restoring the vault from backup

A complete copy of the vault was taken before this application first ran:

```
<VAULT_ROOT>\.agentic-os\backups\vault-<timestamp>\
```

To see what is available:

```powershell
Get-ChildItem "$env:USERPROFILE\Documents\ClaudeBrain\.agentic-os\backups"
```

To restore a single file, copy it back:

```powershell
Copy-Item "$env:USERPROFILE\Documents\ClaudeBrain\.agentic-os\backups\vault-20260721-092328\02 Projects\SignRise\STATUS.md" `
          "$env:USERPROFILE\Documents\ClaudeBrain\02 Projects\SignRise\STATUS.md"
```

To restore everything, close Obsidian first, then copy the backup contents over
the vault. Take a fresh copy of the current state before you do, in case the
backup is older than you expect.

To take a new backup at any time:

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$root  = "$env:USERPROFILE\Documents\ClaudeBrain"
$dest  = "$root\.agentic-os\backups\vault-$stamp"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Get-ChildItem -Path $root -Force |
  Where-Object { $_.Name -ne '.agentic-os' } |
  ForEach-Object { Copy-Item $_.FullName -Destination $dest -Recurse -Force }
```

---

## Turning AI off completely

It is already off. To be certain:

```
AI_ENABLED=false
ANTHROPIC_API_KEY=
```

With either of those in that state, no network client is constructed at all. The
whole application keeps working: indexing, search, trees, links, backlinks,
duplicate detection, drag and drop, and every figure on Home are local and free.

To confirm from the running app, open <http://localhost:3000/api/health> and
check `"ai": { "enabled": false, "provider": "none" }`.

---

## I dropped a file and nothing happened

Check the result panel under the drop zone. Common outcomes:

- **"Already present"** — an identical file is in the vault. Content is matched
  by hash, so a renamed copy is still recognised as a duplicate.
- **"Held for review"** — the file is an executable type. It is stored but never
  opened or run.
- **"Failed"** — the file is over the 64 MB single-file limit, or the drop
  exceeded 500 files / 256 MB in total.

---

## Text in my notes looks garbled (`â€"` instead of `—`)

This is in the source files, not the viewer. Some notes in the vault were
written double-encoded: UTF-8 bytes were re-encoded as UTF-8 a second time. The
indexer reads the files faithfully, so the damage shows through.

Confirm on a specific file:

```powershell
Format-Hex -Path "path\to\note.md" -Count 64
```

A correct em dash is `E2 80 94`. A double-encoded one is `C3 A2 E2 82 AC E2 80 9D`.

The cause is the writer, not this app — check that any script writing to the
vault uses `-Encoding utf8NoBOM` in PowerShell 7, and avoid piping through
`Out-File` without an explicit encoding.

---

## Getting more detail

The dev server prints errors to the terminal it is running in. The audit log of
every action the app has taken is queryable:

```powershell
# Requires sqlite3, or read it through the app's Activity panel on Home
sqlite3 "$env:USERPROFILE\Documents\ClaudeBrain\.agentic-os\database\agentic.sqlite" `
  "SELECT ts, actor, action, target_path FROM audit_events ORDER BY ts DESC LIMIT 20;"
```
