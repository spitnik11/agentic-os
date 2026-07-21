# Agentic OS

A visual command center for an existing Obsidian vault.

Obsidian remembers. This application processes, organizes, connects, and
visualizes — without taking ownership of your notes.

---

## Everyday use

Double-click **Agentic OS** on your desktop. It opens as a desktop application
in its own window — not a browser tab.

| Shortcut | What it opens |
|---|---|
| **Agentic OS** | The desktop application window |
| **Agentic OS (Browser)** | The same app in a browser tab, for when you want it there |
| **Stop Agentic OS** | Stops a server left running by browser mode |

The launcher installs dependencies if they are missing, rebuilds when the source
has changed, and focuses the existing window rather than starting a second copy.

Quitting the window shuts the background server down with it, so **Stop Agentic
OS** is only needed for browser mode.

### How desktop mode works

The desktop build does not reimplement anything. Electron starts the same
production server that browser mode uses, on a **loopback-only** port, waits for
its health check, then puts a native window in front of it. Everything the
server enforces — the write boundary, the fail-closed privacy policy, the
provenance rules — is unchanged.

Two consequences worth knowing:

- **Desktop mode is more private than browser mode.** It binds to `127.0.0.1`
  only. Browser mode binds to all interfaces, which means the vault is reachable
  from other machines on your network while it runs.
- **No separate Node install is needed.** Electron bundles Node 24, which
  includes the `node:sqlite` module the app depends on. The app checks this at
  startup and falls back to a system Node if a future Electron ever ships one
  older than 22.5.

## Creating the shortcuts

Already done, but if you ever need them back:

```powershell
cd "Z:\Claude app\agentic-os"
.\scripts\install-shortcut.ps1 -StartMenu
```

`-StartMenu` also makes it findable from the Start menu. Add `-Remove` to
delete the shortcuts again.

## First-time setup

```powershell
cd "Z:\Claude app\agentic-os"
npm install
Copy-Item .env.example .env.local
notepad .env.local     # set VAULT_ROOT to your vault folder
npm run index          # build the search index from your vault
```

Then use the desktop shortcut, or start it manually:

```powershell
npm run dev            # development, hot reload
npm start              # production, after npm run build
```

Either way the address is:

```
http://localhost:3000
```

If anything goes wrong, run `npm run doctor` — it checks the whole setup and
tells you what to fix.

---

## What this does, and what it deliberately does not

**It does:**

- Index every markdown file in your vault into a fast local search index.
- Show three views of the same knowledge: a logical **Knowledge** tree, the real
  **Vault** folder tree, and a **Project** tree grouped by association.
- Resolve `[[wikilinks]]` into a real link graph, with backlinks and a list of
  links that point at notes which do not exist.
- Accept dropped files, preserve the originals untouched, hash them, detect
  exact duplicates, and file them under the category you chose.
- Track where every piece of information came from and label anything a model
  produced.
- Record every change with an audit entry, and undo the reversible ones.
- Show what your vault would cost in tokens, before you spend anything.

**It does not:**

- Modify, move, rename, or delete any note outside `<vault>/Agentic OS`. This is
  enforced in the filesystem adapter, not merely promised.
- Send anything to any model unless you switch AI on *and* mark a scope as
  allowed. Both gates must pass. The default configuration has no network
  client at all.
- Require a model to be useful. Indexing, search, the trees, links, backlinks,
  duplicate detection, drag and drop, and every dashboard figure run locally at
  no cost.
- Require Obsidian plugins. Everything is plain Markdown with YAML frontmatter.

---

## Where things live

| What | Where | Who owns it |
|---|---|---|
| Application source | `Z:\Claude app\agentic-os` | this repository |
| Your knowledge | `<VAULT_ROOT>` | you — read-only to the app |
| App-managed notes | `<VAULT_ROOT>\Agentic OS` | the app may write here |
| Database, logs, backups, imported originals | `<VAULT_ROOT>\.agentic-os` | the app |

Your vault is never moved or copied. The application points at it through
`VAULT_ROOT` in `.env.local`, which is git-ignored so your personal paths are
never committed.

The database is an index, not a source of truth. Delete it and run
`npm run index` and everything rebuilds from the vault.

---

## Commands

| Command | What it does |
|---|---|
| `npm run desktop` | Run the desktop app directly, with startup output visible |
| `npm run desktop:build` | Build a Windows installer into `release/` |
| `.\scripts\start-desktop.ps1` | What the desktop shortcut runs |
| `.\scripts\start-desktop.ps1 -Web` | Browser mode instead |
| `.\scripts\start-app.ps1` | Browser mode: build if needed, start, open browser |
| `.\scripts\start-app.ps1 -Dev` | Browser mode with hot reload |
| `.\scripts\stop-app.ps1` | Stop the running server |
| `.\scripts\install-shortcut.ps1` | (Re)create the desktop shortcuts |
| `npm run dev` | Start the development server on port 3000 |
| `npm run build` | Build for production |
| `npm start` | Run the production build |
| `npm run index` | Rebuild the search index from the vault (read-only to your notes) |
| `npm run doctor` | Diagnose setup problems and print how to fix each one |
| `npm test` | Run the full test suite |
| `npm run test:unit` | Unit tests only |
| `npm run test:integration` | Integration tests only |
| `npm run typecheck` | TypeScript with no emit |
| `npm run lint` | Lint |

---

## Keyboard

| Key | Action |
|---|---|
| `Ctrl+K` or `/` | Open search and the command palette |
| `↑` `↓` | Move through the tree or results |
| `→` `←` | Expand or collapse a tree branch |
| `Enter` | Open the selected item |
| `Home` `End` | Jump to the first or last visible row |
| `Ctrl+Z` | Undo the last reversible change |
| `Esc` | Close the palette |
| `Tab` | Reach the tree in one press (roving tabindex) |

---

## Cost control

Every action is labelled with a token class:

| Class | Meaning | Default |
|---|---|---|
| 0 | Runs locally. No tokens, no cost. | always on |
| 1 | Low — short summaries, tag suggestions | off |
| 2 | Medium — document analysis, extraction | off |
| 3 | High — multi-document synthesis | off |
| 4 | **Recurring** — scheduled scans that charge repeatedly | off |

Everything shipped and working today is Class 0. Classes 1–4 require you to set
`AI_ENABLED=true` and provide `ANTHROPIC_API_KEY`, and are additionally bounded
by `AI_MONTHLY_BUDGET_USD` and `AI_PER_RUN_TOKEN_CEILING`.

Home shows what the entire vault would cost as a single model call — the number
that explains why the system does not work that way.

---

## Safety

Before anything else ran, a full copy of the vault was written to
`<VAULT_ROOT>\.agentic-os\backups\vault-<timestamp>\`.

To restore, copy the folders back out of that directory. See
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## Status

This is an early working build. See [CHANGELOG.md](CHANGELOG.md) for what is
implemented and [docs/STATUS.md](docs/STATUS.md) for what is not yet built.

Built with Claude. Not affiliated with, endorsed, or certified by Anthropic.
