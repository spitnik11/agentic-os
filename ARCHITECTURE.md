# Architecture

## The one idea

The vault is the source of truth. The database is a rebuildable index over it.

Everything else follows from that. If the database is deleted, `npm run index`
reconstructs it from the markdown files alone — this is covered by an
integration test (`tests/integration/indexing.test.ts`, "rebuild from the vault
alone"). If this application disappears, the knowledge is still plain Markdown
in Obsidian.

## Layers

```
Presentation      src/presentation, src/app
  ↓ calls
Application       src/application        use cases: index, ingest, build trees
  ↓ depends on
Domain            src/domain             entities, policies, parsing, ports
  ↑ implemented by
Infrastructure    src/infrastructure     SQLite, filesystem, Claude, config
```

The dependency rule: **domain never imports downward**. `src/domain` has no
import of React, Next.js, a database driver, or any SDK. It imports only
`node:crypto` for hashing. This is checkable:

```powershell
Select-String -Path "src\domain\**\*.ts" -Pattern "from 'react'|from 'next|node:sqlite"
```

Infrastructure depends on domain (it implements the ports). Presentation depends
on application and domain types. Nothing in `src/presentation` opens a database.

## Ports and adapters

Replaceable providers are declared as interfaces in `src/domain/ports/index.ts`:

| Port | Shipped adapter | Swap target |
|---|---|---|
| `KnowledgeRepository` | `SqliteKnowledgeRepository` | Postgres |
| `RelationshipRepository` | `SqliteRelationshipRepository` | Postgres |
| `FileStorageProvider` | `VaultFileSystem` | S3, remote vault |
| `LanguageModelProvider` | `NoOpLanguageModelProvider` (default), `ClaudeLanguageModelProvider` | any model |
| `EmbeddingProvider` | none — the product works without one | any |
| `AuditLogProvider` | `SqliteAuditLog` | — |
| `UsageRepository` | `SqliteUsageRepository` | — |
| `TokenEstimator` | `HeuristicTokenEstimator` | real tokenizer |
| `JobQueueProvider` | in-process | Redis, SQS |

Adapters are bound in exactly one place: `src/infrastructure/container.ts`. No
other module constructs a repository or a provider.

**Correction, from the independent audit:** the isolation is currently partial.
`ingestion_events`, `project_records`, `citations`, `revisions`, and
`unresolved_links` have no port, and are queried with raw SQL from the
application layer and from four route handlers. Swapping the persistence
adapter would therefore touch more than this folder. The domain layer itself is
clean and no presentation component queries the database, but the claim that
"only this folder changes" is not true today. Tracked as `FND-A11`.

Two further gaps the audit found, both now fixed and regression-tested: a
reindex used to overwrite the provenance of managed notes (`FND-A1`), and undo
used to be silently reverted by the next reindex (`FND-A2`).

### Why SQLite, not Postgres

Postgres is not installed on this machine (`psql` is absent) and the product is
local-first and must work offline with no service to start. SQLite via
`node:sqlite` — built into Node 22.5+ — needs no native compilation and no
server. Full-text search uses FTS5.

Because persistence sits behind `KnowledgeRepository`, moving to Postgres +
pgvector later means writing one adapter, not touching the domain or the UI.
Recorded as decision `DEC-001` in `<vault>/.agentic-os/coordination/decisions.jsonl`.

## The write boundary

This is the most important piece of code in the system.

`VaultFileSystem.writeText` (`src/infrastructure/fs/vault-filesystem.ts`)
refuses any write whose *resolved real path* falls outside the managed folder:

1. The vault-relative path is resolved to absolute, rejecting `..` escapes.
2. Symlinks are resolved with `fs.realpath`. If the target does not exist yet,
   its nearest existing ancestor is resolved instead — that is what determines
   where the write actually lands.
3. The result is compared against the managed root segment-wise, so a sibling
   directory sharing a name prefix (`Agentic OS Extra`) is not treated as
   contained.
4. Anything outside throws `ManagedBoundaryViolation`.

Writes go to a temporary file and are then renamed, so an interrupted write
cannot leave a half-written note.

Directory walking never follows symlinks and never descends into `.agentic-os`,
`.obsidian`, `.git`, or `node_modules`.

Covered by `tests/unit/safety.test.ts`, which asserts the user's file is
byte-for-byte unchanged after a refused write.

## Identity

Filenames are not identity. Every record carries a sortable stable id
(`src/domain/model/identity.ts`) of the form `project_01HXYZ…`, Crockford
base32, monotonic within a millisecond. The id is preserved across edits and can
be pinned into frontmatter as `agentic_id` so a note keeps its identity — and
all its relationships — through a rename or a move.

## Indexing

Two passes, because link resolution needs the complete path set:

1. **Records.** Walk the vault, parse frontmatter and body, hash the content.
   Files whose hash is unchanged are skipped entirely.
2. **Links.** Resolve every `[[wikilink]]` using Obsidian's shortest-unique-path
   rule. Resolved links become `references` relationships with
   `origin: 'parsed_from_links'` and confidence 1. Unresolved ones are recorded
   in `unresolved_links` rather than dropped, which is what makes the broken-link
   report possible.

Parsed links are rebuilt wholesale each pass: a single rename can invalidate an
arbitrary number of edges, and a partial update would leave stale ones behind.

Indexing is Token Class 0. No model is involved.

## Provenance

Every record carries a `ProvenanceState`. The states that matter:

- `imported_obsidian_note` — an existing note of yours, read from the vault
- `deterministic_extraction` — produced by code, no model
- `ai_extracted` / `ai_generated_summary` — a model produced this
- `ai_inference` — a model's *guess*, not a stated fact
- `user_confirmed` — you have checked it

`isAiDerived()` and `isVerified()` in `src/domain/model/types.ts` are the single
definition of what counts as trustworthy. The UI never renders a model's output
with the same treatment as your own writing: `ProvenanceBadge` gives each state
a distinct label, glyph, and tone.

Relationships carry the same separation through `RelationshipOrigin`, so a link
you drew and a link a model guessed are distinguishable forever.

## Privacy

`PrivacyPolicy` (`src/domain/policy/privacy.ts`) fails closed. An unclassified
path, a missing rule, or a typo all resolve to `never_external`. There are no
rules by default, so out of the box nothing may leave the machine.

`canSendAll` requires *every* path in a batch to be permitted, and returns false
for an empty batch rather than treating "nothing" as "allowed".

Before a real provider is even constructed, two independent gates must pass:
`AI_ENABLED=true` **and** a non-empty `ANTHROPIC_API_KEY`. Otherwise
`createLanguageModelProvider` returns the NoOp provider, which has no network
client at all and refuses with a structured reason the UI can display.

Inside `ClaudeLanguageModelProvider.analyze` there are three further gates,
checked in order before any request is built: privacy classification, monthly
budget, and per-run token ceiling.

## Cost

`HeuristicTokenEstimator` is deliberately local and slightly conservative — it
over-estimates rather than under-estimates, because the failure mode of an
underestimate is a surprise charge. Every model call is written to
`usage_records` with real token counts returned by the API, so spend is never
invisible.

## Reversibility

Actions that change state write an `audit_events` row carrying a serialized
inverse operation. `POST /api/undo` reads the most recent un-undone entry and
applies its inverse. Actions with no inverse are recorded but explicitly not
undoable, rather than silently appearing undoable.

## Known architectural gaps

Recorded honestly rather than hidden:

- **Imported files are not yet materialized as Markdown.** An ingested record
  lives in the database with `vaultPath: null`; its original bytes are preserved
  under `.agentic-os/originals` but no managed `.md` note is written yet. Until
  that lands, imported items are not visible in Obsidian and are not covered by
  the "rebuild from the vault" guarantee. Tracked as risk `RSK-004`.
- **No filesystem watcher.** Changes made in Obsidian appear after
  `npm run index` or the Reindex button, not instantly.
- **Conflict detection is schema-only.** The `conflicts` table and the
  source-of-truth modes exist and are enforced for writes, but the divergence
  detector that populates the table is not written.
- **No PDF/DOCX text extraction.** Those files are preserved and searchable by
  name; their contents are not indexed.
