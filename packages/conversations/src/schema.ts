/**
 * The complete conversation schema for a standalone embedder that starts from
 * an empty database. An existing embedder with its own migration stream (like
 * fluffles) keeps applying its own migrations instead; this schema is the
 * fully-migrated shape of the same tables.
 */
export const CONVERSATIONS_SCHEMA = `
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
    worker_instance_id TEXT,
    lease_expires_at TEXT,
    FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS lifecycle_events (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    conversation_key TEXT NOT NULL,
    run_id TEXT,
    kind TEXT NOT NULL,
    reason TEXT,
    metadata_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS outbound_deliveries (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL CHECK (channel IN ('slack', 'email', 'phone', 'web')),
    conversation_key TEXT NOT NULL,
    run_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'acceptance_unknown', 'provider_accepted', 'delivered', 'failed', 'cancelled')),
    payload_json TEXT NOT NULL,
    assistant_message_json TEXT NOT NULL,
    provider_receipt_json TEXT,
    error TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 1,
    attempted_at TEXT NOT NULL,
    acceptance_unknown_at TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS codex_sessions (
    channel TEXT NOT NULL CHECK (channel IN ('slack', 'email', 'phone', 'web')),
    conversation_key TEXT NOT NULL,
    codex_session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(channel, conversation_key)
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
  CREATE INDEX IF NOT EXISTS idx_runs_active_lease
    ON runs(channel, conversation_key, status, lease_expires_at)
    WHERE status = 'running';
  CREATE INDEX IF NOT EXISTS idx_task_conversations_status_updated ON conversations(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_lifecycle_events_conversation
    ON lifecycle_events(channel, conversation_key, occurred_at, id);
  CREATE INDEX IF NOT EXISTS idx_lifecycle_events_run ON lifecycle_events(run_id);
  CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_conversation_status
    ON outbound_deliveries(channel, conversation_key, status, created_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_deliveries_pending_run
    ON outbound_deliveries(run_id)
    WHERE status = 'pending';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_deliveries_provider_key
    ON outbound_deliveries(provider, idempotency_key);
`;
