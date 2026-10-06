/**
 * Standalone schema for embedders composing automations over a bare
 * database. Fluffles opens its own `LedgerDb` with this schema; another
 * project can do the same without adopting anything else.
 */
export const AUTOMATIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS automation_trigger_state (
    automation_id TEXT NOT NULL,
    trigger_index INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    next_run_at TEXT,
    last_fired_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (automation_id, trigger_index)
  );
  CREATE TABLE IF NOT EXISTS automation_active_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_automation_active_runs_automation
    ON automation_active_runs(automation_id);
  CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL,
    trigger_kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'rejected')),
    event TEXT NOT NULL,
    steps TEXT NOT NULL,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_automation_runs_automation_started
    ON automation_runs(automation_id, started_at DESC);
  CREATE TABLE IF NOT EXISTS automation_inbound_events (
    key TEXT PRIMARY KEY,
    received_at TEXT NOT NULL,
    response TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_automation_inbound_events_received
    ON automation_inbound_events(received_at);
`;
