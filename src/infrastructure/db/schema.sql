-- Agentic OS schema, migration 001.
--
-- The database is an index and an operational store. It is not the only copy of
-- any knowledge: every managed record also exists as markdown in the vault, and
-- `npm run index` rebuilds this file from the vault alone.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_version (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Workspace and identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  vault_root  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Knowledge records
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS records (
  id              TEXT PRIMARY KEY,
  record_type     TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary         TEXT,
  body            TEXT,
  vault_path      TEXT UNIQUE,
  content_hash    TEXT,
  provenance      TEXT NOT NULL,
  source_of_truth TEXT NOT NULL,
  privacy         TEXT NOT NULL DEFAULT 'never_external',
  processing      TEXT NOT NULL DEFAULT 'cataloged',
  confidence      REAL,
  human_verified  INTEGER NOT NULL DEFAULT 0,
  ai_generated    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  archived_at     TEXT,
  data            TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_records_type       ON records(record_type);
CREATE INDEX IF NOT EXISTS idx_records_hash       ON records(content_hash);
CREATE INDEX IF NOT EXISTS idx_records_updated    ON records(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_records_archived   ON records(archived_at);
CREATE INDEX IF NOT EXISTS idx_records_provenance ON records(provenance);
CREATE INDEX IF NOT EXISTS idx_records_processing ON records(processing);

-- Full-text search over the fields a person would actually search.
CREATE VIRTUAL TABLE IF NOT EXISTS records_fts USING fts5(
  title,
  summary,
  body,
  content='records',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS records_fts_insert AFTER INSERT ON records BEGIN
  INSERT INTO records_fts(rowid, title, summary, body)
  VALUES (new.rowid, new.title, coalesce(new.summary, ''), coalesce(new.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS records_fts_delete AFTER DELETE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, summary, body)
  VALUES ('delete', old.rowid, old.title, coalesce(old.summary, ''), coalesce(old.body, ''));
END;

CREATE TRIGGER IF NOT EXISTS records_fts_update AFTER UPDATE ON records BEGIN
  INSERT INTO records_fts(records_fts, rowid, title, summary, body)
  VALUES ('delete', old.rowid, old.title, coalesce(old.summary, ''), coalesce(old.body, ''));
  INSERT INTO records_fts(rowid, title, summary, body)
  VALUES (new.rowid, new.title, coalesce(new.summary, ''), coalesce(new.body, ''));
END;

-- ---------------------------------------------------------------------------
-- Typed relationships
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS relationships (
  id          TEXT PRIMARY KEY,
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  type        TEXT NOT NULL,
  confidence  REAL NOT NULL DEFAULT 1.0,
  origin      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  approved    INTEGER NOT NULL DEFAULT 0,
  evidence    TEXT,
  notes       TEXT,
  UNIQUE(source_id, target_id, type),
  FOREIGN KEY (source_id) REFERENCES records(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_id);
CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_id);
CREATE INDEX IF NOT EXISTS idx_rel_origin ON relationships(origin);
CREATE INDEX IF NOT EXISTS idx_rel_type   ON relationships(type);

-- Links whose target does not exist in the vault. Kept separately so the
-- broken-link report costs one indexed query instead of a graph walk.
CREATE TABLE IF NOT EXISTS unresolved_links (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL,
  raw_target   TEXT NOT NULL,
  link_kind    TEXT NOT NULL,
  detected_at  TEXT NOT NULL,
  FOREIGN KEY (source_id) REFERENCES records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_unresolved_source ON unresolved_links(source_id);

-- ---------------------------------------------------------------------------
-- Tags and collections
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tags (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS record_tags (
  record_id TEXT NOT NULL,
  tag_id    TEXT NOT NULL,
  origin    TEXT NOT NULL DEFAULT 'parsed_from_links',
  PRIMARY KEY (record_id, tag_id),
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id)    REFERENCES tags(id)    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS collections (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  kind        TEXT NOT NULL DEFAULT 'manual',
  query       TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_records (
  collection_id TEXT NOT NULL,
  record_id     TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, record_id),
  FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
  FOREIGN KEY (record_id)     REFERENCES records(id)     ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Project membership: one item may support many projects without duplication
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS project_records (
  project_id TEXT NOT NULL,
  record_id  TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'related',
  is_primary INTEGER NOT NULL DEFAULT 0,
  added_at   TEXT NOT NULL,
  origin     TEXT NOT NULL DEFAULT 'user_created',
  PRIMARY KEY (project_id, record_id),
  FOREIGN KEY (project_id) REFERENCES records(id) ON DELETE CASCADE,
  FOREIGN KEY (record_id)  REFERENCES records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_records_record ON project_records(record_id);

-- ---------------------------------------------------------------------------
-- Provenance: what supports each generated statement
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS citations (
  id             TEXT PRIMARY KEY,
  record_id      TEXT NOT NULL,
  source_id      TEXT,
  source_path    TEXT,
  excerpt        TEXT NOT NULL,
  start_offset   INTEGER,
  end_offset     INTEGER,
  created_at     TEXT NOT NULL,
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_citations_record ON citations(record_id);

-- ---------------------------------------------------------------------------
-- Ingestion
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingestion_events (
  id              TEXT PRIMARY KEY,
  ts              TEXT NOT NULL,
  filename        TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  original_path   TEXT,
  destination     TEXT NOT NULL,
  drop_category   TEXT,
  project_id      TEXT,
  state           TEXT NOT NULL,
  error           TEXT,
  record_id       TEXT,
  duplicate_of    TEXT
);

CREATE INDEX IF NOT EXISTS idx_ingestion_hash  ON ingestion_events(content_hash);
CREATE INDEX IF NOT EXISTS idx_ingestion_state ON ingestion_events(state);
CREATE INDEX IF NOT EXISTS idx_ingestion_ts    ON ingestion_events(ts DESC);

-- ---------------------------------------------------------------------------
-- Review centre: nothing outside the managed folder changes without approval
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS proposed_changes (
  id                TEXT PRIMARY KEY,
  ts                TEXT NOT NULL,
  target_path       TEXT NOT NULL,
  target_hash       TEXT NOT NULL,
  change_kind       TEXT NOT NULL,
  before_text       TEXT,
  after_text        TEXT,
  reason            TEXT NOT NULL,
  benefit           TEXT,
  risk              TEXT,
  token_class       INTEGER NOT NULL DEFAULT 0,
  model             TEXT,
  estimated_cost    REAL NOT NULL DEFAULT 0,
  state             TEXT NOT NULL DEFAULT 'pending',
  resolved_at       TEXT,
  resolution_note   TEXT,
  reversal_note     TEXT
);

CREATE INDEX IF NOT EXISTS idx_proposals_state ON proposed_changes(state);

CREATE TABLE IF NOT EXISTS conflicts (
  id            TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  record_id     TEXT,
  vault_path    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  db_hash       TEXT,
  file_hash     TEXT,
  detail        TEXT,
  state         TEXT NOT NULL DEFAULT 'open',
  resolved_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_conflicts_state ON conflicts(state);

-- ---------------------------------------------------------------------------
-- Audit and undo
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_id   TEXT,
  target_path TEXT,
  detail      TEXT NOT NULL DEFAULT '{}',
  undo        TEXT,
  undone_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_ts     ON audit_events(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(action);

CREATE TABLE IF NOT EXISTS revisions (
  id          TEXT PRIMARY KEY,
  record_id   TEXT NOT NULL,
  ts          TEXT NOT NULL,
  revision    INTEGER NOT NULL,
  body        TEXT,
  content_hash TEXT,
  author      TEXT NOT NULL,
  note        TEXT,
  FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_revisions_record ON revisions(record_id, revision DESC);

-- ---------------------------------------------------------------------------
-- Token and cost accounting
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_records (
  id            TEXT PRIMARY KEY,
  ts            TEXT NOT NULL,
  feature       TEXT NOT NULL,
  token_class   INTEGER NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_usage_ts      ON usage_records(ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_feature ON usage_records(feature);

-- Per-feature switches. Every Token Class 4 feature is absent here until the
-- user turns it on, and absence is read as off.
CREATE TABLE IF NOT EXISTS feature_settings (
  feature     TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 0,
  schedule    TEXT NOT NULL DEFAULT 'manual',
  updated_at  TEXT NOT NULL
);

-- Folder-scoped privacy rules. Empty means everything is closed.
CREATE TABLE IF NOT EXISTS privacy_rules (
  path_prefix TEXT PRIMARY KEY,
  level       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT '{}',
  state       TEXT NOT NULL DEFAULT 'queued',
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);

-- ---------------------------------------------------------------------------
-- Saved views
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS saved_views (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  tree_mode   TEXT NOT NULL,
  query       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
