/**
 * Standalone task registry schema for embedders composing the registry over a
 * bare conversations database. Fluffles owns its own base schema and
 * migrations; this schema exists so another agent can adopt the registry
 * without any fluffles code. The tasks table is shared by design: other
 * task_kind values (e.g. the scheduler's 'reminder') never collide with the
 * registry's 'conversation' rows.
 */
export const TASKS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    objective TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
    progress TEXT,
    next_action TEXT,
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    task_kind TEXT NOT NULL DEFAULT 'conversation'
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_conversation
    ON tasks(conversation_id)
    WHERE task_kind = 'conversation' AND status IN ('pending', 'in_progress');
  CREATE INDEX IF NOT EXISTS idx_tasks_status_updated
    ON tasks(status, updated_at);
`;
