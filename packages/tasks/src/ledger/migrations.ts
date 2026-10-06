import { DatabaseSync } from "node:sqlite";
import { requiredStringField, runtimeRecordArray } from "./rows";

// Migration functions operate on a raw DatabaseSync handle and are listed once
// in SCHEMA_MIGRATIONS in version order. applyMigrations runs any unapplied
// migrations in a single transaction on startup.

// tableName is always a hardcoded literal at every call site; never user input.
function pragmaColumnNames(db: DatabaseSync, tableName: string): string[] {
  return runtimeRecordArray(
    db.prepare(`PRAGMA table_info(${tableName})`).all(),
    `pragma table_info(${tableName})`
  ).map((row) => requiredStringField(row, "name", `pragma table_info(${tableName}) row`));
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return pragmaColumnNames(db, tableName).length > 0;
}

function applyMigration1(db: DatabaseSync): void {
  const messageColumns = pragmaColumnNames(db, "messages");

  if (!messageColumns.includes("seq")) {
    db.exec("ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0");
    // Assign 1-based seq values ordered by (received_at, id), matching the read-back sort order.
    db.exec(`
      UPDATE messages SET seq = (
        SELECT COUNT(*) FROM messages AS m2
        WHERE m2.channel = messages.channel
          AND m2.conversation_key = messages.conversation_key
          AND (m2.received_at < messages.received_at
               OR (m2.received_at = messages.received_at AND m2.id < messages.id))
      ) + 1
      WHERE seq = 0
    `);
  }

  if (!messageColumns.includes("role")) {
    db.exec("ALTER TABLE messages ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }

  const convColumns = pragmaColumnNames(db, "conversations");
  if (!convColumns.includes("active_run_id")) {
    db.exec("ALTER TABLE conversations ADD COLUMN active_run_id TEXT");
  }
  if (!convColumns.includes("compaction_seq")) {
    db.exec("ALTER TABLE conversations ADD COLUMN compaction_seq INTEGER");
  }

  const runColumns = pragmaColumnNames(db, "runs");
  if (!runColumns.includes("last_consumed_seq")) {
    db.exec("ALTER TABLE runs ADD COLUMN last_consumed_seq INTEGER");
  }
}

function applyMigration2(db: DatabaseSync): void {
  const convColumns = pragmaColumnNames(db, "conversations");
  if (!convColumns.includes("compaction_summary")) {
    db.exec("ALTER TABLE conversations ADD COLUMN compaction_summary TEXT");
  }
}

function applyMigration3(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
      progress TEXT,
      next_action TEXT,
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_conversation
      ON tasks(conversation_id)
      WHERE status IN ('pending', 'in_progress');
    CREATE INDEX IF NOT EXISTS idx_tasks_status_updated
      ON tasks(status, updated_at);
  `);
}

function applyMigration4(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_deliveries (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('slack', 'email', 'phone')),
      conversation_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
      payload_json TEXT NOT NULL,
      assistant_message_json TEXT NOT NULL,
      task_result TEXT NOT NULL,
      provider_receipt_json TEXT,
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      attempted_at TEXT NOT NULL,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_deliveries_provider_key
      ON outbound_deliveries(provider, idempotency_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_deliveries_pending_task
      ON outbound_deliveries(task_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_outbound_deliveries_conversation_status
      ON outbound_deliveries(channel, conversation_key, status, created_at, id);
  `);
}

function applyMigration5(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS deployment_lifecycle (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL CHECK (state IN ('normal', 'draining', 'deploying', 'restarting')),
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO deployment_lifecycle (id, state, updated_at)
      VALUES (1, 'normal', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

function applyMigration6(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subagent_runs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subagent_runs_active ON subagent_runs(finished_at, started_at);
  `);
}

function applyMigration7(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) return;
  db.exec(`
    ALTER TABLE subagent_runs ADD COLUMN lease_expires_at TEXT;
    UPDATE subagent_runs
    SET lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 minutes')
    WHERE finished_at IS NULL AND lease_expires_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_subagent_runs_active_lease ON subagent_runs(finished_at, lease_expires_at);
  `);
}

function applyMigration8(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) return;
  db.exec(`
    ALTER TABLE subagent_runs ADD COLUMN owner_pid INTEGER;
    UPDATE subagent_runs
    SET lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 minutes')
    WHERE finished_at IS NULL AND lease_expires_at IS NULL;
    CREATE TRIGGER IF NOT EXISTS subagent_runs_active_lease_on_insert
    AFTER INSERT ON subagent_runs
    WHEN NEW.finished_at IS NULL AND NEW.lease_expires_at IS NULL
    BEGIN
      UPDATE subagent_runs
      SET lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 minutes')
      WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS subagent_runs_active_lease_on_update
    AFTER UPDATE OF finished_at, lease_expires_at ON subagent_runs
    WHEN NEW.finished_at IS NULL AND NEW.lease_expires_at IS NULL
    BEGIN
      UPDATE subagent_runs
      SET lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 minutes')
      WHERE id = NEW.id;
    END;
  `);
}

function applyMigration9(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) return;
  db.exec(`
    ALTER TABLE subagent_runs ADD COLUMN owner_started_at TEXT;
  `);
}

function applyMigration10(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS repair_tasks (
      id TEXT PRIMARY KEY,
      locker_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
      progress TEXT,
      next_action TEXT,
      result TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_tasks_active_locker
      ON repair_tasks(locker_id)
      WHERE status IN ('pending', 'in_progress');
    CREATE INDEX IF NOT EXISTS idx_repair_tasks_status_updated
      ON repair_tasks(status, updated_at);
  `);
}

function applyMigration11(db: DatabaseSync): void {
  if (!tableExists(db, "tasks") || !tableExists(db, "conversations")) return;
  const taskColumns = pragmaColumnNames(db, "tasks");
  if (!taskColumns.includes("task_kind")) {
    db.exec("ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'conversation'");
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_tasks_active_conversation;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_conversation
      ON tasks(conversation_id)
      WHERE task_kind = 'conversation' AND status IN ('pending', 'in_progress');

    CREATE TABLE IF NOT EXISTS scheduled_reminders (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      instruction TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      display_timezone TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('slack', 'email', 'phone')),
      conversation_key TEXT NOT NULL,
      codex_session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'running', 'completed', 'failed', 'cancelled')),
      created_at TEXT NOT NULL,
      fired_at TEXT,
      cancelled_at TEXT,
      run_id TEXT,
      FOREIGN KEY(id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_reminders_due
      ON scheduled_reminders(scheduled_for, created_at, id)
      WHERE status = 'scheduled';
    CREATE INDEX IF NOT EXISTS idx_scheduled_reminders_conversation
      ON scheduled_reminders(channel, conversation_key, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_scheduled_reminders_run ON scheduled_reminders(run_id);
  `);
}

function applyMigration12(db: DatabaseSync): void {
  if (!tableExists(db, "scheduled_reminders") || !tableExists(db, "conversations") || !tableExists(db, "runs")) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_sessions (
      channel TEXT NOT NULL CHECK (channel IN ('slack', 'email', 'phone')),
      conversation_key TEXT NOT NULL,
      codex_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(channel, conversation_key),
      FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS reminder_execution_attempts (
      reminder_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL UNIQUE,
      run_id TEXT UNIQUE,
      phase TEXT NOT NULL CHECK (phase IN ('claimed', 'run_created', 'execution_started', 'completed', 'failed')),
      claimed_at TEXT NOT NULL,
      execution_started_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(reminder_id) REFERENCES scheduled_reminders(id) ON DELETE CASCADE,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_reminder_execution_attempts_phase
      ON reminder_execution_attempts(phase, updated_at, reminder_id)
      WHERE phase IN ('claimed', 'run_created', 'execution_started');
  `);
}

function applyMigration13(db: DatabaseSync): void {
  if (!tableExists(db, "reminder_execution_attempts")) return;
  const columns = pragmaColumnNames(db, "reminder_execution_attempts");
  if (!columns.includes("execution_owner_id")) {
    db.exec("ALTER TABLE reminder_execution_attempts ADD COLUMN execution_owner_id TEXT");
  }
  if (!columns.includes("execution_owner_acquired_at")) {
    db.exec("ALTER TABLE reminder_execution_attempts ADD COLUMN execution_owner_acquired_at TEXT");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reminder_execution_attempts_owner
      ON reminder_execution_attempts(execution_owner_id, reminder_id)
      WHERE execution_owner_id IS NOT NULL;
  `);
}

function applyMigration14(db: DatabaseSync): void {
  if (!tableExists(db, "reminder_execution_attempts")) return;
  const columns = pragmaColumnNames(db, "reminder_execution_attempts");
  if (!columns.includes("execution_owner_lease_expires_at")) {
    db.exec("ALTER TABLE reminder_execution_attempts ADD COLUMN execution_owner_lease_expires_at TEXT");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reminder_execution_attempts_recovery
      ON reminder_execution_attempts(phase, execution_owner_lease_expires_at, reminder_id)
      WHERE phase IN ('claimed', 'run_created');
  `);
}

function applyMigration15(db: DatabaseSync): void {
  if (!tableExists(db, "reminder_execution_attempts")) return;
  const columns = pragmaColumnNames(db, "reminder_execution_attempts");
  if (!columns.includes("delivery_recovery_owner_id")) {
    db.exec("ALTER TABLE reminder_execution_attempts ADD COLUMN delivery_recovery_owner_id TEXT");
  }
  if (!columns.includes("delivery_recovery_lease_expires_at")) {
    db.exec("ALTER TABLE reminder_execution_attempts ADD COLUMN delivery_recovery_lease_expires_at TEXT");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_reminder_execution_attempts_delivery_recovery
      ON reminder_execution_attempts(phase, delivery_recovery_lease_expires_at, reminder_id)
      WHERE phase = 'execution_started';
  `);
}

function applyMigration16(db: DatabaseSync): void {
  if (!tableExists(db, "scheduled_reminders")) return;
  const columns = pragmaColumnNames(db, "scheduled_reminders");
  if (!columns.includes("company_id")) {
    db.exec("ALTER TABLE scheduled_reminders ADD COLUMN company_id TEXT");
  }
}

/**
 * Converges databases created by the pre-merge Step 5 branch, where migration
 * numbers 7 through 13 were already used for reminder state. New databases
 * receive the same schema through the canonical mainline sequence above.
 */
function applyMigration17(db: DatabaseSync): void {
  if (!tableExists(db, "subagent_runs")) return;
  const columns = pragmaColumnNames(db, "subagent_runs");
  if (!columns.includes("lease_expires_at")) {
    db.exec("ALTER TABLE subagent_runs ADD COLUMN lease_expires_at TEXT");
  }
  if (!columns.includes("owner_pid")) {
    db.exec("ALTER TABLE subagent_runs ADD COLUMN owner_pid INTEGER");
  }
  if (!columns.includes("owner_started_at")) {
    db.exec("ALTER TABLE subagent_runs ADD COLUMN owner_started_at TEXT");
  }
  db.exec(`
    UPDATE subagent_runs
    SET lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 minutes')
    WHERE finished_at IS NULL AND lease_expires_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_subagent_runs_active_lease ON subagent_runs(finished_at, lease_expires_at);
    CREATE TRIGGER IF NOT EXISTS subagent_runs_active_lease_on_insert
    AFTER INSERT ON subagent_runs
    WHEN NEW.finished_at IS NULL AND NEW.lease_expires_at IS NULL
    BEGIN
      UPDATE subagent_runs
      SET lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 minutes')
      WHERE id = NEW.id;
    END;
    CREATE TRIGGER IF NOT EXISTS subagent_runs_active_lease_on_update
    AFTER UPDATE OF finished_at, lease_expires_at ON subagent_runs
    WHEN NEW.finished_at IS NULL AND NEW.lease_expires_at IS NULL
    BEGIN
      UPDATE subagent_runs
      SET lease_expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 minutes')
      WHERE id = NEW.id;
    END;
  `);
}

/** Adds durable, bounded retry scheduling without replacing the task registry. */
function applyMigration18(db: DatabaseSync): void {
  if (!tableExists(db, "scheduled_reminders")) return;
  const columns = pragmaColumnNames(db, "scheduled_reminders");
  if (!columns.includes("retry_count")) {
    db.exec("ALTER TABLE scheduled_reminders ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.includes("next_attempt_at")) {
    db.exec("ALTER TABLE scheduled_reminders ADD COLUMN next_attempt_at TEXT");
  }
  if (!columns.includes("last_failure")) {
    db.exec("ALTER TABLE scheduled_reminders ADD COLUMN last_failure TEXT");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_scheduled_reminders_retry_due
      ON scheduled_reminders(status, next_attempt_at, scheduled_for, created_at, id)
      WHERE status = 'scheduled';
    CREATE TABLE IF NOT EXISTS reminder_execution_history (
      reminder_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      run_id TEXT,
      phase TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      execution_started_at TEXT,
      archived_at TEXT NOT NULL,
      failure TEXT NOT NULL,
      PRIMARY KEY(reminder_id, attempt_id),
      FOREIGN KEY(reminder_id) REFERENCES scheduled_reminders(id) ON DELETE CASCADE,
      FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reminder_execution_history_reminder
      ON reminder_execution_history(reminder_id, archived_at, attempt_id);
  `);
}

/** Adds process-fenced run ownership without invalidating legacy running rows. */
function applyMigration19(db: DatabaseSync): void {
  if (!tableExists(db, "runs")) return;
  const columns = pragmaColumnNames(db, "runs");
  if (!columns.includes("owner_id")) db.exec("ALTER TABLE runs ADD COLUMN owner_id TEXT");
  if (!columns.includes("owner_pid")) db.exec("ALTER TABLE runs ADD COLUMN owner_pid INTEGER");
  if (!columns.includes("owner_started_at")) db.exec("ALTER TABLE runs ADD COLUMN owner_started_at TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_active_owner
      ON runs(status, owner_pid, owner_started_at)
      WHERE status = 'running';
  `);
}

/** The engine-owned append-only lifecycle audit. */
function applyMigration20(db: DatabaseSync): void {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_lifecycle_events_conversation
      ON lifecycle_events(channel, conversation_key, occurred_at, id);
    CREATE INDEX IF NOT EXISTS idx_lifecycle_events_run ON lifecycle_events(run_id);
  `);
}

/** Adds a terminal cancellation state for outbound intents stopped before delivery. */
function applyMigration21(db: DatabaseSync): void {
  if (!tableExists(db, "outbound_deliveries")) return;
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_deliveries'").get();
  const tableSql = row == null ? "" : requiredStringField(row, "sql", "outbound deliveries schema");
  if (tableSql.includes("'dispatching'")) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_outbound_deliveries_provider_key;
    DROP INDEX IF EXISTS idx_outbound_deliveries_pending_task;
    DROP INDEX IF EXISTS idx_outbound_deliveries_conversation_status;
    CREATE TABLE outbound_deliveries_v21 (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('slack', 'email', 'phone')),
      conversation_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'delivered', 'failed', 'cancelled')),
      payload_json TEXT NOT NULL,
      assistant_message_json TEXT NOT NULL,
      task_result TEXT NOT NULL,
      provider_receipt_json TEXT,
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      attempted_at TEXT NOT NULL,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
    );
    INSERT INTO outbound_deliveries_v21 (
      id, channel, conversation_key, task_id, run_id, provider, idempotency_key, status,
      payload_json, assistant_message_json, task_result, provider_receipt_json, error,
      attempt_count, attempted_at, delivered_at, created_at, updated_at
    ) SELECT
      id, channel, conversation_key, task_id, run_id, provider, idempotency_key, status,
      payload_json, assistant_message_json, task_result, provider_receipt_json, error,
      attempt_count, attempted_at, delivered_at, created_at, updated_at
    FROM outbound_deliveries;
    DROP TABLE outbound_deliveries;
    ALTER TABLE outbound_deliveries_v21 RENAME TO outbound_deliveries;
    CREATE UNIQUE INDEX idx_outbound_deliveries_provider_key
      ON outbound_deliveries(provider, idempotency_key);
    CREATE UNIQUE INDEX idx_outbound_deliveries_pending_task
      ON outbound_deliveries(task_id)
      WHERE status = 'pending';
    CREATE INDEX idx_outbound_deliveries_conversation_status
      ON outbound_deliveries(channel, conversation_key, status, created_at, id);
  `);
}

/** Separates a revocable dispatch admission from a durably known provider effect. */
function applyMigration22(db: DatabaseSync): void {
  if (!tableExists(db, "outbound_deliveries")) return;
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_deliveries'").get();
  const tableSql = row == null ? "" : requiredStringField(row, "sql", "outbound deliveries schema");
  if (tableSql.includes("'provider_accepted'")) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_outbound_deliveries_provider_key;
    DROP INDEX IF EXISTS idx_outbound_deliveries_pending_task;
    DROP INDEX IF EXISTS idx_outbound_deliveries_conversation_status;
    CREATE TABLE outbound_deliveries_v22 (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('slack', 'email', 'phone')),
      conversation_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'provider_accepted', 'delivered', 'failed', 'cancelled')),
      payload_json TEXT NOT NULL,
      assistant_message_json TEXT NOT NULL,
      task_result TEXT NOT NULL,
      provider_receipt_json TEXT,
      error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 1,
      attempted_at TEXT NOT NULL,
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
    );
    INSERT INTO outbound_deliveries_v22 (
      id, channel, conversation_key, task_id, run_id, provider, idempotency_key, status,
      payload_json, assistant_message_json, task_result, provider_receipt_json, error,
      attempt_count, attempted_at, delivered_at, created_at, updated_at
    ) SELECT
      id, channel, conversation_key, task_id, run_id, provider, idempotency_key, status,
      payload_json, assistant_message_json, task_result, provider_receipt_json, error,
      attempt_count, attempted_at, delivered_at, created_at, updated_at
    FROM outbound_deliveries;
    DROP TABLE outbound_deliveries;
    ALTER TABLE outbound_deliveries_v22 RENAME TO outbound_deliveries;
    CREATE UNIQUE INDEX idx_outbound_deliveries_provider_key
      ON outbound_deliveries(provider, idempotency_key);
    CREATE UNIQUE INDEX idx_outbound_deliveries_pending_task
      ON outbound_deliveries(task_id)
      WHERE status = 'pending';
    CREATE INDEX idx_outbound_deliveries_conversation_status
      ON outbound_deliveries(channel, conversation_key, status, created_at, id);
  `);
}

/** Records provider-acceptance ambiguity separately from a safe retry. */
function applyMigration23(db: DatabaseSync): void {
  if (!tableExists(db, "outbound_deliveries")) return;
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_deliveries'").get();
  const tableSql = row == null ? "" : requiredStringField(row, "sql", "outbound deliveries schema");
  const columns = pragmaColumnNames(db, "outbound_deliveries");
  if (tableSql.includes("'acceptance_unknown'") && columns.includes("acceptance_unknown_at")) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_outbound_deliveries_provider_key;
    DROP INDEX IF EXISTS idx_outbound_deliveries_pending_task;
    DROP INDEX IF EXISTS idx_outbound_deliveries_conversation_status;
    CREATE TABLE outbound_deliveries_v23 (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('slack', 'email', 'phone')),
      conversation_key TEXT NOT NULL,
      task_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'dispatching', 'acceptance_unknown', 'provider_accepted', 'delivered', 'failed', 'cancelled')),
      payload_json TEXT NOT NULL,
      assistant_message_json TEXT NOT NULL,
      task_result TEXT NOT NULL,
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
    INSERT INTO outbound_deliveries_v23 (
      id, channel, conversation_key, task_id, run_id, provider, idempotency_key, status,
      payload_json, assistant_message_json, task_result, provider_receipt_json, error,
      attempt_count, attempted_at, acceptance_unknown_at, delivered_at, created_at, updated_at
    ) SELECT
      id, channel, conversation_key, task_id, run_id, provider, idempotency_key, status,
      payload_json, assistant_message_json, task_result, provider_receipt_json, error,
      attempt_count, attempted_at, NULL, delivered_at, created_at, updated_at
    FROM outbound_deliveries;
    DROP TABLE outbound_deliveries;
    ALTER TABLE outbound_deliveries_v23 RENAME TO outbound_deliveries;
    CREATE UNIQUE INDEX idx_outbound_deliveries_provider_key
      ON outbound_deliveries(provider, idempotency_key);
    CREATE UNIQUE INDEX idx_outbound_deliveries_pending_task
      ON outbound_deliveries(task_id)
      WHERE status = 'pending';
    CREATE INDEX idx_outbound_deliveries_conversation_status
      ON outbound_deliveries(channel, conversation_key, status, created_at, id);
  `);
}

/**
 * Replaces host-local PID recovery with a durable SQLite lease. Existing rows
 * remain readable, but an active legacy row has no lease and is therefore
 * safely recoverable on the next recovery pass.
 */
function applyMigration24(db: DatabaseSync): void {
  if (!tableExists(db, "runs")) return;
  const columns = pragmaColumnNames(db, "runs");
  if (!columns.includes("worker_instance_id")) db.exec("ALTER TABLE runs ADD COLUMN worker_instance_id TEXT");
  if (!columns.includes("lease_id")) db.exec("ALTER TABLE runs ADD COLUMN lease_id TEXT");
  if (!columns.includes("lease_expires_at")) db.exec("ALTER TABLE runs ADD COLUMN lease_expires_at TEXT");
  if (!columns.includes("heartbeat_at")) db.exec("ALTER TABLE runs ADD COLUMN heartbeat_at TEXT");
  if (!columns.includes("fencing_token")) db.exec("ALTER TABLE runs ADD COLUMN fencing_token INTEGER");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_runs_active_lease
      ON runs(channel, conversation_key, status, lease_expires_at, fencing_token)
      WHERE status = 'running';
  `);
}

/** A run lease is one owner and one expiry; drops the unused PID, lease-id, heartbeat, and fencing columns. */
function applyMigration25(db: DatabaseSync): void {
  if (!tableExists(db, "runs")) return;
  const columns = pragmaColumnNames(db, "runs");
  const legacyColumns = ["owner_id", "owner_pid", "owner_started_at", "lease_id", "heartbeat_at", "fencing_token"];
  if (!legacyColumns.some((column) => columns.includes(column))) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_runs_active_owner;
    DROP INDEX IF EXISTS idx_runs_active_lease;
    DROP INDEX IF EXISTS idx_task_runs_conversation;
    CREATE TABLE runs_v25 (
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
    INSERT INTO runs_v25 (
      id, channel, conversation_key, status, started_at, finished_at, error, last_consumed_seq,
      worker_instance_id, lease_expires_at
    ) SELECT
      id, channel, conversation_key, status, started_at, finished_at, error, last_consumed_seq,
      worker_instance_id, lease_expires_at
    FROM runs;
    DROP TABLE runs;
    ALTER TABLE runs_v25 RENAME TO runs;
    CREATE INDEX idx_task_runs_conversation ON runs(channel, conversation_key, started_at, id);
    CREATE INDEX idx_runs_active_lease
      ON runs(channel, conversation_key, status, lease_expires_at)
      WHERE status = 'running';
  `);
}

/**
 * Messages are the single durable conversation record. The mirrored
 * communication_events table is archived, not dropped: message/reply rows were
 * always mirrored into messages, but ack/skip/error/status rows are audit
 * history that must survive the migration.
 */
function applyMigration26(db: DatabaseSync): void {
  if (!tableExists(db, "communication_events")) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_communication_events_external;
    DROP INDEX IF EXISTS idx_communication_events_conversation;
    ALTER TABLE communication_events RENAME TO communication_events_archive;
  `);
}

/**
 * The conversation row and its runs are the only durable conversation state;
 * drops the per-run task mirror from deliveries and closes orphaned mirror rows.
 */
function applyMigration27(db: DatabaseSync): void {
  if (tableExists(db, "tasks")) {
    db.exec(`
      UPDATE tasks
      SET status = 'cancelled', progress = 'cancelled', next_action = NULL,
          result = COALESCE(result, 'closed by migration 27: conversation task mirror removed')
      WHERE task_kind IN ('conversation', 'control') AND status IN ('pending', 'in_progress')
    `);
  }
  if (!tableExists(db, "outbound_deliveries")) return;
  const columns = pragmaColumnNames(db, "outbound_deliveries");
  if (!columns.includes("task_id") && !columns.includes("task_result")) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_outbound_deliveries_provider_key;
    DROP INDEX IF EXISTS idx_outbound_deliveries_pending_task;
    DROP INDEX IF EXISTS idx_outbound_deliveries_conversation_status;
    CREATE TABLE outbound_deliveries_v27 (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL CHECK (channel IN ('slack', 'email', 'phone')),
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
    INSERT INTO outbound_deliveries_v27 (
      id, channel, conversation_key, run_id, provider, idempotency_key, status,
      payload_json, assistant_message_json, provider_receipt_json, error,
      attempt_count, attempted_at, acceptance_unknown_at, delivered_at, created_at, updated_at
    ) SELECT
      id, channel, conversation_key, run_id, provider, idempotency_key, status,
      payload_json, assistant_message_json, provider_receipt_json, error,
      attempt_count, attempted_at, acceptance_unknown_at, delivered_at, created_at, updated_at
    FROM outbound_deliveries;
    DROP TABLE outbound_deliveries;
    ALTER TABLE outbound_deliveries_v27 RENAME TO outbound_deliveries;
    CREATE UNIQUE INDEX idx_outbound_deliveries_provider_key
      ON outbound_deliveries(provider, idempotency_key);
    CREATE UNIQUE INDEX idx_outbound_deliveries_pending_run
      ON outbound_deliveries(run_id)
      WHERE status = 'pending';
    CREATE INDEX idx_outbound_deliveries_conversation_status
      ON outbound_deliveries(channel, conversation_key, status, created_at, id);
  `);
}

/** Repair tasks are keyed by the callable tool (MCP manifest name), not a "locker". */
function applyMigration28(db: DatabaseSync): void {
  if (!tableExists(db, "repair_tasks")) return;
  if (!pragmaColumnNames(db, "repair_tasks").includes("locker_id")) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_repair_tasks_active_locker;
    ALTER TABLE repair_tasks RENAME COLUMN locker_id TO tool_id;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repair_tasks_active_tool
      ON repair_tasks(tool_id)
      WHERE status IN ('pending', 'in_progress');
  `);
}

/**
 * Reminders become scheduled message admissions: one status trio, no execution
 * attempt lifecycle. Anything the old dispatcher left mid-flight (running or
 * failed) returns to scheduled so the next admission sweep delivers it.
 */
function applyMigration29(db: DatabaseSync): void {
  if (!tableExists(db, "scheduled_reminders")) return;
  if (!pragmaColumnNames(db, "scheduled_reminders").includes("codex_session_id")) return;
  db.exec(`
    DROP TABLE IF EXISTS reminder_execution_attempts;
    DROP INDEX IF EXISTS idx_scheduled_reminders_due;
    DROP INDEX IF EXISTS idx_scheduled_reminders_conversation;
    DROP INDEX IF EXISTS idx_scheduled_reminders_run;
    ALTER TABLE scheduled_reminders RENAME TO scheduled_reminders_old;
    CREATE TABLE scheduled_reminders (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      instruction TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      display_timezone TEXT NOT NULL,
      channel TEXT NOT NULL CHECK (channel IN ('slack', 'email', 'phone')),
      conversation_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('scheduled', 'delivered', 'cancelled')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      cancelled_at TEXT,
      FOREIGN KEY(id) REFERENCES tasks(id) ON DELETE CASCADE,
      FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
    );
    INSERT INTO scheduled_reminders (
      id, company_id, instruction, scheduled_for, display_timezone, channel,
      conversation_key, status, created_at, delivered_at, cancelled_at
    )
    SELECT
      id, company_id, instruction, scheduled_for, display_timezone, channel,
      conversation_key,
      CASE status WHEN 'completed' THEN 'delivered' WHEN 'cancelled' THEN 'cancelled' ELSE 'scheduled' END,
      created_at,
      CASE status WHEN 'completed' THEN fired_at END,
      cancelled_at
    FROM scheduled_reminders_old;
    DROP TABLE scheduled_reminders_old;
    CREATE INDEX IF NOT EXISTS idx_scheduled_reminders_due
      ON scheduled_reminders(scheduled_for, created_at, id)
      WHERE status = 'scheduled';
    CREATE INDEX IF NOT EXISTS idx_scheduled_reminders_conversation
      ON scheduled_reminders(channel, conversation_key, created_at, id);
  `);
}

/**
 * Migration 29 dropped `scheduled_reminders_old` and the attempt lifecycle it
 * belonged to, but left `reminder_execution_history` behind still declaring a
 * foreign key to that table. Nothing reads or writes the table, so drop it
 * rather than rebuild it around a reference that cannot resolve.
 */
function applyMigration30(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_reminder_execution_history_reminder;
    DROP TABLE IF EXISTS reminder_execution_history;
  `);
}

/**
 * Admits the browser console as a communication channel. Only three tables
 * constrain the channel value, and SQLite cannot widen a CHECK in place, so
 * each is rebuilt with its indexes recreated.
 */
function applyMigration31(db: DatabaseSync): void {
  for (const rebuild of WEB_CHANNEL_REBUILDS) {
    if (!tableExists(db, rebuild.table)) continue;
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(rebuild.table);
    const tableSql = row == null ? "" : requiredStringField(row, "sql", `${rebuild.table} schema`);
    // A ledger carried forward from before these migrations quoted their string
    // literals spells the constraint with double quotes.
    if (tableSql.includes("'web'") || tableSql.includes('"web"')) continue;
    rebuildWithWebChannel(db, rebuild);
  }
}

interface WebChannelRebuild {
  /** Table whose channel CHECK has to admit `web`. */
  table: string;
  /** Column DDL for the rebuilt table, without the surrounding parentheses. */
  definition: string;
  /** Columns to carry over, in one order used by both copies. */
  columns: string;
  /** Indexes to drop before the rebuild and recreate after it. */
  indexes: readonly { name: string; create: string }[];
}

const WEB_CHANNEL_REBUILDS: readonly WebChannelRebuild[] = [
  {
    table: "codex_sessions",
    definition: `
      channel TEXT NOT NULL CHECK (channel IN ('slack', 'email', 'phone', 'web')),
      conversation_key TEXT NOT NULL,
      codex_session_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(channel, conversation_key),
      FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
    `,
    columns: "channel, conversation_key, codex_session_id, created_at, updated_at",
    indexes: []
  },
  {
    table: "outbound_deliveries",
    definition: `
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
    `,
    columns: `id, channel, conversation_key, run_id, provider, idempotency_key, status,
      payload_json, assistant_message_json, provider_receipt_json, error,
      attempt_count, attempted_at, acceptance_unknown_at, delivered_at, created_at, updated_at`,
    indexes: [
      {
        name: "idx_outbound_deliveries_provider_key",
        create: "CREATE UNIQUE INDEX idx_outbound_deliveries_provider_key ON outbound_deliveries(provider, idempotency_key)"
      },
      {
        name: "idx_outbound_deliveries_pending_run",
        create: "CREATE UNIQUE INDEX idx_outbound_deliveries_pending_run ON outbound_deliveries(run_id) WHERE status = 'pending'"
      },
      {
        name: "idx_outbound_deliveries_conversation_status",
        create: "CREATE INDEX idx_outbound_deliveries_conversation_status ON outbound_deliveries(channel, conversation_key, status, created_at, id)"
      }
    ]
  },
  {
    table: "scheduled_reminders",
    definition: `
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
    `,
    columns: `id, company_id, instruction, scheduled_for, display_timezone, channel,
      conversation_key, status, created_at, delivered_at, cancelled_at`,
    indexes: [
      {
        name: "idx_scheduled_reminders_due",
        create: `CREATE INDEX idx_scheduled_reminders_due ON scheduled_reminders(scheduled_for, created_at, id) WHERE status = 'scheduled'`
      },
      {
        name: "idx_scheduled_reminders_conversation",
        create: "CREATE INDEX idx_scheduled_reminders_conversation ON scheduled_reminders(channel, conversation_key, created_at, id)"
      }
    ]
  }
];

/**
 * Rebuild without `ALTER TABLE ... RENAME`. A rename makes SQLite reparse every
 * object in the schema with the double-quoted-string misfeature off, so on a
 * ledger carried forward from before these migrations quoted their string
 * literals it fails on unrelated legacy SQL such as `WHERE status =
 * "scheduled"`. Staging the rows in a second table and creating the final one
 * under its own name touches only this table's own SQL.
 */
function rebuildWithWebChannel(db: DatabaseSync, rebuild: WebChannelRebuild): void {
  const { table, definition, columns, indexes } = rebuild;
  const staging = `${table}_v31`;
  db.exec(`
    ${indexes.map((index) => `DROP INDEX IF EXISTS ${index.name};`).join("\n    ")}
    CREATE TABLE ${staging} (${definition});
    INSERT INTO ${staging} (${columns}) SELECT ${columns} FROM ${table};
    DROP TABLE ${table};
    CREATE TABLE ${table} (${definition});
    INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${staging};
    DROP TABLE ${staging};
    ${indexes.map((index) => `${index.create};`).join("\n    ")}
  `);
}

export const SCHEMA_MIGRATIONS: ReadonlyArray<readonly [number, (db: DatabaseSync) => void]> = [
  [1, applyMigration1],
  [2, applyMigration2],
  [3, applyMigration3],
  [4, applyMigration4],
  [5, applyMigration5],
  [6, applyMigration6],
  [7, applyMigration7],
  [8, applyMigration8],
  [9, applyMigration9],
  [10, applyMigration10],
  [11, applyMigration11],
  [12, applyMigration12],
  [13, applyMigration13],
  [14, applyMigration14],
  [15, applyMigration15],
  [16, applyMigration16],
  [17, applyMigration17],
  [18, applyMigration18],
  [19, applyMigration19],
  [20, applyMigration20],
  [21, applyMigration21],
  [22, applyMigration22],
  [23, applyMigration23],
  [24, applyMigration24],
  [25, applyMigration25],
  [26, applyMigration26],
  [27, applyMigration27],
  [28, applyMigration28],
  [29, applyMigration29],
  [30, applyMigration30],
  [31, applyMigration31]
];
