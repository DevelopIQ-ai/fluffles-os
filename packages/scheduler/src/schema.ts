/**
 * Standalone scheduler schema for embedders composing the scheduler over a
 * bare conversations database. Fluffles owns its own base schema and
 * migrations; this schema exists so another agent can adopt the scheduler
 * without any fluffles code. The tasks table is shared with any embedder task
 * registry: the scheduler only touches rows with task_kind 'reminder'.
 */
export const SCHEDULER_SCHEMA = `
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
  CREATE TABLE IF NOT EXISTS scheduled_reminders (
    id TEXT PRIMARY KEY,
    company_id TEXT,
    instruction TEXT NOT NULL,
    scheduled_for TEXT NOT NULL,
    display_timezone TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('slack', 'email', 'phone', 'web')),
    conversation_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('scheduled', 'delivered', 'cancelled')),
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    cancelled_at TEXT,
    FOREIGN KEY(id) REFERENCES tasks(id) ON DELETE CASCADE,
    FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_reminders_due
    ON scheduled_reminders(scheduled_for, created_at, id)
    WHERE status = 'scheduled';
  CREATE INDEX IF NOT EXISTS idx_scheduled_reminders_conversation
    ON scheduled_reminders(channel, conversation_key, created_at, id);
`;
