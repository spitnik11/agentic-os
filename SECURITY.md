# Security and privacy

The two guarantees this application makes, and how each is enforced.

## 1. Your notes are not modified

**The rule:** the application may create and modify files only inside
`<VAULT_ROOT>/Agentic OS`. Everything else in the vault is read-only to it.

**How it is enforced:** in `VaultFileSystem.writeText`
(`src/infrastructure/fs/vault-filesystem.ts`), not by convention elsewhere.

Every write resolves its target through `fs.realpath` before the containment
check, so a symlink placed inside the managed folder cannot be used to reach a
note outside it. When the target does not exist yet, its nearest existing
ancestor is resolved instead — that is what determines where the write lands.
Containment is compared segment-wise, so `Agentic OS Extra` is not treated as
inside `Agentic OS`.

Writes are made to a temporary file and then renamed, so an interrupted write
cannot leave a truncated note behind.

Directory walks never follow symlinks and never enter `.agentic-os`,
`.obsidian`, `.git`, or `node_modules`.

**Tested by:** `tests/unit/safety.test.ts` — six cases, including one that
asserts the user's file is byte-for-byte unchanged after a refused write, and
`tests/integration/indexing.test.ts`, which asserts mtime is unchanged after a
full index.

**Known limitation:** there is a theoretical TOCTOU window between the realpath
check and the write. Exploiting it requires an attacker who can already create
symlinks inside your vault at a precise moment, which implies they already have
write access to the vault. Not mitigated; documented rather than hidden.

## 2. Nothing is sent anywhere without two explicit permissions

**The rule:** content leaves the machine only if AI is switched on *and* the
content's scope is classified as allowed.

**How it is enforced:** four gates, in order.

1. **Construction.** `createLanguageModelProvider`
   (`src/infrastructure/ai/providers.ts`) returns `NoOpLanguageModelProvider`
   unless `AI_ENABLED=true` **and** `ANTHROPIC_API_KEY` is non-empty. The NoOp
   provider contains no network client. In the shipped default configuration
   there is nothing that could make a request.
2. **Privacy.** `PrivacyPolicy` fails closed: an unclassified path, a missing
   rule, or a typo all resolve to `never_external`. There are no rules by
   default. `canSendAll` requires every path in a batch to be permitted and
   returns false for an empty batch rather than treating "nothing" as
   "allowed". Re-checked inside `analyze` immediately before the request.
3. **Budget.** Month-to-date spend is compared against
   `AI_MONTHLY_BUDGET_USD` before each call.
4. **Size.** The estimated input is compared against
   `AI_PER_RUN_TOKEN_CEILING`, which prevents a single call from silently
   sending a large slice of the vault.

Content marked `ai_allowed_with_redaction` is passed through `redact()` first,
which strips recognisable Anthropic, OpenAI, GitHub, AWS, and Slack key formats,
private key blocks, bearer tokens, password assignments, and connection strings.

**Tested by:** `tests/unit/safety.test.ts` — six privacy-policy cases, two
redaction cases, three provider-gating cases.

**Known limitation:** redaction is pattern matching. It reduces exposure; it
cannot guarantee a clean payload, especially for secrets in unusual formats or
split across lines. It is a second line of defence behind classification, never
a substitute for it.

## Ingestion

Imported content is treated as untrusted.

| Threat | Mitigation |
|---|---|
| Path traversal via filename | The preserved original is content-addressed by hash; the supplied filename never forms part of the write path. `sanitizeFilename` additionally strips separators, `..`, control characters, and Windows-reserved device names. |
| Oversized file | 64 MB per file, rejected before anything is written. |
| Decompression / volume abuse | 500 files and 256 MB per drop. |
| Executables | `.exe .dll .bat .cmd .com .scr .msi .vbs .jar .app` are stored, flagged, set to `needs_review`, and never parsed or run. **No imported file is ever executed, at any point.** |
| Binary content mislabelled as text | NUL-byte detection in the first 8 KB. |
| Memory exhaustion on a large text file | Only the first 2 MB is indexed as text; the full original is preserved. |
| Silent overwrite | Materialization refuses to clobber an existing note with a different id, adding a numeric suffix instead. |

**Not yet implemented:** ZIP archive extraction. When it is added it will need
explicit zip-slip and nested-archive handling; the ceilings above already exist
to support it.

## Data handling

- **Originals are never modified.** Imported bytes are written once, addressed
  by content hash, under `.agentic-os/originals/`.
- **Deletion is archival.** A record whose file disappears is archived, not
  dropped, because relationships and citations may point at it.
- **Every change is audited.** `audit_events` records actor, action, target, and
  a serialized inverse operation where one exists. `POST /api/undo` applies it.
- **No secrets in the repository.** `.env.local` is git-ignored. `.env.example`
  contains no key and no personal path.
- **Paths are redacted in output.** `displayPath()` replaces the home directory
  with `~` before any path reaches the health endpoint or the console.

## Application surface

- Binds to localhost. There is no authentication, because there is no remote
  access; the `workspaces` table exists so auth can be added without a
  migration. **Do not expose this port to a network.**
- All SQL uses bound parameters. The only interpolated fragments are internally
  generated placeholder lists (`?, ?, ?`), never user input.
- FTS5 queries are tokenized and quoted before use, with a LIKE fallback, so
  punctuation in a search box cannot become query syntax.
- Markdown is rendered as React elements, never as `dangerouslySetInnerHTML`.
  Vault content cannot inject markup or script.

## Reporting

This is a personal local-first tool. If you find a problem, the audit log and
`npm run doctor` output are the place to start.
