# Implementation status

An honest inventory. The brief that produced this project specified roughly 300
requirements across 12 milestones; what follows is what is actually built,
verified, and running versus what is not.

Verified on 2026-07-21 against the real vault (38 markdown files).

## Working and verified

| Capability | Evidence |
|---|---|
| **Native desktop application (Electron)** | Window titled "Agentic OS" opens in ~1s from the desktop shortcut |
| Desktop server is loopback-only | Listener on `127.0.0.1` only; 0 non-loopback bindings |
| `node:sqlite` under Electron's runtime | Electron 43 bundles Node 24.18.0; in-memory insert/read roundtrip verified |
| Clean desktop shutdown | After quit: 0 electron processes, 0 listeners, 0 orphaned servers |
| Browser mode still works alongside it | `start-desktop.ps1 -Web` -> HTTP 200 |
| Vault indexing, read-only | `npm run index` → 38 scanned, 38 indexed, 0 failed |
| Content hashing, incremental reindex | integration test: second pass reports 3 unchanged, 0 indexed |
| Frontmatter parsing (scalars, lists, quoting, BOM) | 20 unit tests |
| Wikilink extraction and resolution | integration test: backlinks resolve both directions |
| Broken-link detection | 1 unresolved link found in the real vault |
| Duplicate detection by content hash | 9 genuine duplicate pairs found in `90 Archive` |
| Full-text search (FTS5) | `/api/search?q=signrise` → 3 hits in 1 ms |
| Tri-mode tree (Knowledge / Vault / Project) | `/api/tree?mode=…` returns all three |
| Three-panel interface, dark + light | rendered and screenshotted |
| Keyboard tree navigation, roving tabindex | ARIA treeview; verified in the accessibility tree |
| Command palette (`Ctrl+K`) with live search | implemented |
| Drag-and-drop ingestion with keyboard fallback | `/api/ingest`; file input alternative present |
| Original preservation, content-addressed | integration test: preserved bytes equal input bytes |
| Executable quarantine (never opened or run) | integration test: `.exe` → `needs_review`, body null |
| Managed write boundary | 6 unit tests incl. symlink and traversal refusal |
| Fail-closed privacy policy | 6 unit tests incl. empty-batch refusal |
| Secret redaction | 2 unit tests |
| AI disabled by default, both gates | 3 unit tests |
| Token estimation and cost projection | Home shows 43k tokens for the whole vault |
| Audit log with inverse operations | integration test asserts undo payload |
| Undo | `/api/undo` reverses an import |
| Health endpoint | `/api/health` → `status: ok` |
| Doctor diagnostics | 12 checks, all passing |
| Production build | `npm run build` succeeds |
| Type checking | `tsc --noEmit` clean, strict mode |
| Tests | 97 passing (52 unit, 45 integration) |

## Built but not yet exercised

| Capability | State |
|---|---|
| `ClaudeLanguageModelProvider` | Written with all four gates; never called, because no API key is configured. Untested against the live API. |
| Schema for conflicts, proposals, revisions, citations, collections, jobs, saved views | Tables and indexes exist and are queried; no writer populates most of them yet. |
| `project_records` membership | Table and tree-building exist; nothing writes memberships yet, so the Project tree is empty. |

## Not built

Deferred, in rough order of how much they are missed:

1. **Materializing imported records as Markdown.** Ingested items live in the
   database only. Until this lands they are invisible in Obsidian and outside
   the rebuild-from-vault guarantee. This is the most important gap.
2. **Filesystem watcher.** Reindex is manual.
3. **Conflict detection.** Divergence between a note and its indexed copy is not
   detected; the modes and table are ready for it.
4. **PDF, DOCX, image, and transcript text extraction.** Preserved but not read.
5. **Claude workflows** — classification, summarization, task and decision
   extraction, relationship suggestion, retrieval answering. The provider and
   the token accounting exist; the prompts and pipelines do not.
6. **Review center UI.** The `proposed_changes` table and the rule that nothing
   outside the managed folder changes without approval are in place; the screen
   to review proposals is not.
7. **Embeddings and semantic search.** The port is declared; no adapter.
8. **Graph visualization.** The link graph is queryable; there is no visual
   graph view.
9. **Public demo mode, synthetic data, capture mode, landing page.** None built.
   The header says "Private vault" because there is currently only one mode.
10. **Skills registry.** Not started.
11. **E2E test suite.** Unit and integration only.
12. **Tauri desktop shell.** Electron is what shipped. Tauri would produce a
    far smaller binary and WebView2 is already present on this machine, but it
    needs a Rust toolchain that is not installed. Recorded as a future option.
13. **Packaged installer not verified.** `npm run desktop:build` and the
    electron-builder config exist, but the resulting NSIS installer has not been
    built or tested. Desktop mode currently runs from the source folder.

## Known defects

Open items, after the independent audit. Full records in
`<vault>/.agentic-os/coordination/unresolved-findings.jsonl`.

| Issue | Impact | ID |
|---|---|---|
| Project tree renders empty | Nothing populates `project_records` yet | — |
| Vault contains double-encoded text | Pre-existing damage in the source files, not caused by this app; see TROUBLESHOOTING.md | FND-001 |
| AI status surfaces have no feature behind them | The spend meter and "AI enabled" badge are truthful but unreachable — nothing can currently spend | FND-A10 |
| Raw SQL bypasses the repository ports in five tables | ARCHITECTURE.md overstates how isolated the persistence layer is | FND-A11 |
| Command palette ARIA is invalid; wikilinks in the reader are inert | `aria-activedescendant` without `role="combobox"`, non-option children in the listbox, no background inerting, link-styled spans that are not focusable | FND-A12 |
| Tree omits `aria-setsize`/`aria-posinset`; mode tabs lack arrow keys | Screen readers announce wrong positional context | FND-A12 |
| TOCTOU window in `writeText` | Theoretical; requires an attacker who already has vault write access | FND-A13 |
| Several paths do not degrade at scale | `/api/overview` loads every body into memory; prune capped at 10,000 | FND-A14 |

### Fixed during the audit round

| Issue | Severity | ID |
|---|---|---|
| Reindex destroyed provenance — imported files were relabeled "extracted by code" | High, blocking | FND-A1 |
| Undo was silently reverted by the next reindex | High, blocking | FND-A2 |
| `strictestOf` returned the *most permissive* level for an empty set | Medium | FND-A3 |
| `text-ink-faint` failed WCAG AA on every dark surface | Medium | FND-A4 |
| Drag-and-drop onto tree nodes was decorative | Medium | FND-A5 |
| Raw NUL bytes in the filename-sanitizer regex | Low | FND-A6 |
| `agentic_id` accepted without validation | Low | FND-A7 |
| Tree counts capped; managed folder hardcoded | Low | FND-A8 |
| Newlines unescaped in generated YAML | Low | FND-A9 |

## Assumptions on record

Full list in `<vault>/.agentic-os/coordination/assumptions.jsonl`. The two that
most affect scope:

- **ASM-001**: the "existing second-brain backend" the brief assumed does not
  exist as software. The vault is 37 scaffold notes totalling 167 KB, created a
  day earlier, plus PowerShell capture hooks. There was no database, app,
  ingestion pipeline, or search index to extend.
- **ASM-002**: the full brief is multiple weeks of work. A working vertical
  slice was built instead, with every deferred item listed above rather than
  quietly skipped.
