/**
 * Standalone repair-ledger schema for embedders composing the repair loop over a
 * bare database. Fluffles owns its own base schema and migrations; this
 * schema exists so another agent can adopt the repair ledger without any fluffles
 * code.
 */
export const REPAIR_LEDGER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS repair_tasks (
    id TEXT PRIMARY KEY,
    tool_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
    progress TEXT,
    next_action TEXT,
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_tasks_active_tool
    ON repair_tasks(tool_id)
    WHERE status IN ('pending', 'in_progress');
  CREATE INDEX IF NOT EXISTS idx_repair_tasks_status_updated
    ON repair_tasks(status, updated_at);
`;
