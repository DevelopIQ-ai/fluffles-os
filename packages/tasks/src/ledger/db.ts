import { LedgerDb as StorageLedgerDb } from "@fluffles/storage";
import { SCHEMA_MIGRATIONS } from "./migrations";

export interface LedgerDbOptions {
  filePath: string;
  now?: () => Date;
  idFactory?: () => string;
}

/**
 * The fluffles task ledger's base schema. Migrations 1..N in
 * `./migrations` evolve it; new tables belong to their owning domain.
 */
const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS conversations (
    channel TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_error TEXT,
    reply_target_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    active_run_id TEXT,
    compaction_seq INTEGER,
    compaction_summary TEXT,
    PRIMARY KEY(channel, conversation_key)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    external_message_id TEXT,
    author_id TEXT,
    text TEXT NOT NULL,
    received_at TEXT NOT NULL,
    run_id TEXT,
    seq INTEGER NOT NULL DEFAULT 0,
    role TEXT NOT NULL DEFAULT 'user',
    metadata_json TEXT NOT NULL,
    FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT,
    last_consumed_seq INTEGER,
    FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_task_messages_external
    ON messages(channel, conversation_key, external_message_id)
    WHERE external_message_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_task_messages_conversation
    ON messages(channel, conversation_key, received_at, id);
  CREATE INDEX IF NOT EXISTS idx_task_messages_run ON messages(run_id);
  CREATE INDEX IF NOT EXISTS idx_task_runs_conversation ON runs(channel, conversation_key, started_at, id);
  CREATE INDEX IF NOT EXISTS idx_task_conversations_status_updated ON conversations(status, updated_at);
`;

/**
 * The authoritative fluffles ledger connection: the generic durable
 * storage kernel configured with this repository's schema and migrations.
 */
export class LedgerDb extends StorageLedgerDb {
  constructor(options: LedgerDbOptions) {
    super({
      filePath: options.filePath,
      schema: BASE_SCHEMA,
      migrations: SCHEMA_MIGRATIONS,
      ...(options.now ? { now: options.now } : {}),
      ...(options.idFactory ? { idFactory: options.idFactory } : {})
    });
  }
}
