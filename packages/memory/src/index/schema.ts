import type { SchemaMigration } from "@fluffles/storage";

/**
 * The derived, disposable index. Every byte of memory is a markdown file;
 * deleting this database and reindexing reproduces identical results. Injected
 * into a LedgerDb so it inherits WAL + synchronous=FULL, the serialized write
 * chain, and the migration runner.
 */
export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_documents (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'wiki', 'durable')),
  title TEXT NOT NULL,
  date TEXT,
  sha256 TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_tags (
  path TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (path, key, value)
);
CREATE INDEX IF NOT EXISTS memory_tags_by_key_value ON memory_tags (key, value);

CREATE TABLE IF NOT EXISTS memory_aliases (
  alias TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  path TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_links (
  from_path TEXT NOT NULL,
  to_title TEXT NOT NULL,
  to_path TEXT,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_links_by_target ON memory_links (to_path);
CREATE INDEX IF NOT EXISTS memory_links_by_source ON memory_links (from_path);

CREATE TABLE IF NOT EXISTS memory_sweeps (
  date TEXT PRIMARY KEY,
  swept_at TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  path UNINDEXED,
  kind UNINDEXED,
  line_start UNINDEXED,
  line_end UNINDEXED,
  title,
  body,
  tokenize = 'porter unicode61'
);
`;

export const MEMORY_MIGRATIONS: readonly SchemaMigration[] = [
  // The index is derived: migrations may drop and clear tables freely; the
  // next `memory index` rebuilds everything from the markdown files.
  [1, (db) => {
    db.exec(`
DROP TABLE IF EXISTS memory_documents;
CREATE TABLE memory_documents (
  path TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('note', 'wiki', 'durable')),
  title TEXT NOT NULL,
  date TEXT,
  sha256 TEXT NOT NULL,
  mtime_ms INTEGER NOT NULL,
  indexed_at TEXT NOT NULL
);
DELETE FROM memory_fts;
DELETE FROM memory_tags;
DELETE FROM memory_aliases;
DELETE FROM memory_links;
`);
  }]
];
