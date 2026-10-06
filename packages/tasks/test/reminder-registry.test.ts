import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";
import {
  normalizeReminderUtc,
  reminderLocalDateTimeToUtc,
  SQLiteTaskLedger,
  type CreateScheduledReminderInput,
  type TaskLedgerMessageInput,
} from "../src/task-ledger";

const execFile = promisify(execFileCallback);

const now = "2026-01-01T00:00:00.000Z";
const future = "2026-01-01T01:00:00.000Z";

async function withLedger<T>(fn: (ledger: SQLiteTaskLedger, filePath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scheduled-reminder-test-"));
  const filePath = path.join(dir, "tasks.sqlite");
  const ledger = new SQLiteTaskLedger({ filePath, now: () => new Date(now) });
  try {
    return await fn(ledger, filePath);
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function slackMessage(conversationKey = "slack:T1:C1:1000.000001"): TaskLedgerMessageInput {
  return {
    channel: "slack",
    conversationKey,
    externalMessageId: `message:${conversationKey}`,
    authorId: "U1",
    text: "please remember this",
    replyTarget: { type: "slack_thread", channel: "C1", threadTs: "1000.000001" },
    metadata: {}
  };
}

function reminderInput(conversationKey = "slack:T1:C1:1000.000001"): CreateScheduledReminderInput {
  return {
    companyId: "company-test",
    instruction: "follow up with Sam",
    scheduledFor: future,
    displayTimezone: "America/Los_Angeles",
    channel: "slack",
    conversationKey
  };
}

function channelMessage(
  channel: "slack" | "email" | "phone",
  conversationKey: string
): TaskLedgerMessageInput {
  return {
    channel,
    conversationKey,
    externalMessageId: `message:${channel}:${conversationKey}`,
    authorId: "person-1",
    text: "continue this conversation",
    replyTarget: {},
    metadata: {}
  };
}

test("creates, fetches, and lists durable scheduled reminders", async () => {
  await withLedger(async (ledger) => {
    await ledger.recordMessage(slackMessage());
    const reminder = await ledger.createReminder(reminderInput());
    assert.equal(reminder.status, "scheduled");
    assert.equal(reminder.companyId, "company-test");
    assert.equal(reminder.scheduledFor, future);
    assert.equal(reminder.deliveredAt, null);
    assert.equal(reminder.cancelledAt, null);
    assert.deepEqual(await ledger.getReminder(reminder.id), reminder);
    assert.deepEqual((await ledger.listReminders({ channel: "slack" })).map((item) => item.id), [reminder.id]);
  });
});

test("a due reminder becomes an ordinary inbound message the channel already knows how to run", async () => {
  await withLedger(async (ledger) => {
    const recorded = await ledger.recordMessage(slackMessage());
    const key = recorded.conversation.conversationKey;
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    await ledger.finishRun("slack", key, started.run.id, "done", null);

    const reminder = await ledger.createReminder(reminderInput(key));
    assert.deepEqual(await ledger.admitDueReminders({ now }), []);

    const [admission] = await ledger.admitDueReminders({ now: future });
    assert.equal(admission?.disposition, "admitted");
    assert.equal(admission?.reminder.status, "delivered");

    const conversation = await ledger.getConversation("slack", key);
    assert.equal(conversation?.status, "queued");
    const message = conversation?.messages.at(-1);
    assert.equal(message?.text, "follow up with Sam");
    assert.equal(message?.metadata.reminderId, reminder.id);
    assert.equal(message?.metadata.reminderInstruction, true);

    // The normal worker path picks it up, so the run carries a normal lease.
    const claimed = await ledger.startRun("slack", key);
    assert.equal(claimed?.messages.at(-1)?.metadata.reminderId, reminder.id);
    assert.ok(claimed?.run.leaseExpiresAt);
    assert.ok(claimed?.run.workerInstanceId);
  });
});

test("a crash between admission and the delivered write cannot admit the reminder twice", async () => {
  await withLedger(async (ledger, filePath) => {
    const recorded = await ledger.recordMessage(slackMessage());
    const reminder = await ledger.createReminder(reminderInput(recorded.conversation.conversationKey));
    await ledger.admitDueReminders({ now: future });
    ledger.close();

    const db = new DatabaseSync(filePath);
    try {
      db.prepare("UPDATE scheduled_reminders SET status = 'scheduled', delivered_at = NULL WHERE id = ?").run(reminder.id);
    } finally {
      db.close();
    }

    const restarted = new SQLiteTaskLedger({ filePath, now: () => new Date(now) });
    try {
      const [readmission] = await restarted.admitDueReminders({ now: future });
      assert.equal(readmission?.disposition, "duplicate");
      const conversation = await restarted.getConversation("slack", recorded.conversation.conversationKey);
      const reminderMessages = conversation?.messages.filter((message) => message.metadata.reminderId === reminder.id);
      assert.equal(reminderMessages?.length, 1);
    } finally {
      restarted.close();
    }
  });
});

test("cancels and reschedules only reminders that have not been admitted", async () => {
  await withLedger(async (ledger) => {
    await ledger.recordMessage(slackMessage());
    const reminder = await ledger.createReminder(reminderInput());
    const rescheduled = await ledger.rescheduleReminder(reminder.id, "2026-01-01T02:00:00Z", "Asia/Kolkata");
    assert.equal(rescheduled?.scheduledFor, "2026-01-01T02:00:00.000Z");
    assert.equal(rescheduled?.displayTimezone, "Asia/Kolkata");

    const cancelled = await ledger.cancelReminder(reminder.id);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.cancelledAt, now);
    assert.deepEqual(await ledger.admitDueReminders({ now: "2026-01-01T03:00:00Z" }), []);
    await assert.rejects(
      ledger.rescheduleReminder(reminder.id, "2026-01-01T04:00:00Z"),
      /Cannot reschedule scheduled reminder .* from cancelled/
    );
  });
});

test("task-control creates a reminder from the production conversation command path", async () => {
  await withLedger(async (ledger, filePath) => {
    const recorded = await ledger.recordMessage(slackMessage());
    await ledger.saveCodexSession("slack", recorded.conversation.conversationKey, "persisted-session");
    ledger.close();
    const scheduledFor = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const entrypoint = path.join(process.cwd(), "dist", "src", "task-control.js");
    const { stdout } = await execFile(process.execPath, [
      entrypoint,
      "reminder-create",
      "--channel", "slack",
      "--conversation-key", recorded.conversation.conversationKey,
      "--company-id", "company-cli",
      "--instruction", "follow up with Sam",
      "--scheduled-for", scheduledFor,
      "--display-timezone", "America/Los_Angeles"
    ], {
      env: { ...process.env, FLUFFLES_TASK_LEDGER_PATH: filePath }
    });
    const response = JSON.parse(stdout) as { ok: boolean; reminder: { id: string; companyId: string | null } };
    assert.equal(response.ok, true);
    assert.equal(response.reminder.companyId, "company-cli");

    const recovered = new SQLiteTaskLedger({ filePath, now: () => new Date(now) });
    try {
      assert.equal((await recovered.getReminder(response.reminder.id))?.instruction, "follow up with Sam");
    } finally {
      recovered.close();
    }
  });
});

test("migrates multiple reminders to a new conversation key without orphaning their backing tasks", async () => {
  await withLedger(async (ledger, filePath) => {
    const legacyKey = "slack:T1:C1:legacy-reminders";
    const canonicalKey = "slack:T1:C1:canonical-reminders";
    await ledger.recordMessage(slackMessage(legacyKey));
    const first = await ledger.createReminder(reminderInput(legacyKey));
    const second = await ledger.createReminder({ ...reminderInput(legacyKey), instruction: "send the notes" });

    const migrated = await ledger.migrateConversationKey("slack", legacyKey, canonicalKey);
    assert.ok(migrated);
    assert.deepEqual(
      (await ledger.listReminders({ conversationKey: canonicalKey })).map((reminder) => reminder.id).sort(),
      [first.id, second.id].sort()
    );
    assert.equal(await ledger.migrateConversationKey("slack", legacyKey, canonicalKey), null);

    const [admitted] = await ledger.admitDueReminders({ now: future });
    assert.equal(admitted?.reminder.conversationKey, canonicalKey);

    ledger.close();
    const db = new DatabaseSync(filePath);
    try {
      const linked = db.prepare(`
        SELECT COUNT(*) AS count
        FROM scheduled_reminders reminder
        JOIN tasks task ON task.id = reminder.id
        WHERE reminder.channel = ? AND reminder.conversation_key = ? AND task.conversation_id = ?
      `).get("slack", canonicalKey, migrated.id) as { count: number };
      const orphaned = db.prepare(`
        SELECT COUNT(*) AS count
        FROM tasks task
        LEFT JOIN scheduled_reminders reminder ON reminder.id = task.id
        WHERE task.task_kind = 'reminder' AND reminder.id IS NULL
      `).get() as { count: number };
      assert.equal(linked.count, 2);
      assert.equal(orphaned.count, 0);
    } finally {
      db.close();
    }
  });
});

test("migrates reminders when the canonical conversation already exists", async () => {
  await withLedger(async (ledger) => {
    const legacyKey = "slack:T1:C1:legacy-reminders-existing";
    const canonicalKey = "slack:T1:C1:canonical-reminders-existing";
    await ledger.recordMessage(slackMessage(legacyKey));
    await ledger.recordMessage(slackMessage(canonicalKey));
    const first = await ledger.createReminder(reminderInput(legacyKey));
    const second = await ledger.createReminder({ ...reminderInput(legacyKey), instruction: "review the proposal" });

    await ledger.migrateConversationKey("slack", legacyKey, canonicalKey);
    assert.deepEqual(
      (await ledger.listReminders({ conversationKey: canonicalKey })).map((reminder) => reminder.id).sort(),
      [first.id, second.id].sort()
    );
  });
});

test("strictly validates UTC reminder timestamps without normalizing invalid calendar values", () => {
  assert.equal(normalizeReminderUtc("2024-02-29T23:59:59.1Z"), "2024-02-29T23:59:59.100Z");

  for (const value of [
    "2026-02-30T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-00-01T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-01-00T00:00:00Z",
    "2026-01-32T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:60:00Z",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00Z",
    "2026-01-01Z",
    "2026-01-01 00:00:00Z",
    "2026-01-01T00:00:00+00:00",
    "2026-01-01T00:00:00+00:00Z",
    "2026-01-01T00:00:00.Z",
    "2026-01-01T00:00:00.1234Z",
    "2026-01-01T00:00:00Zjunk",
    " 2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z ",
    "\t2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z\t",
    "\n2026-01-01T00:00:00Z",
    "2026-01-01T00:00:00Z\r\n",
    " \t2026-01-01T00:00:00Z\n"
  ]) {
    assert.throws(() => normalizeReminderUtc(value), /UTC timestamp|valid ISO-8601 UTC timestamp/);
  }
});

test("converts timezone-local reminder times to UTC and rejects daylight-saving gaps and repeats", () => {
  assert.equal(
    reminderLocalDateTimeToUtc("2026-07-01T09:00", "America/Los_Angeles"),
    "2026-07-01T16:00:00.000Z"
  );
  assert.equal(
    reminderLocalDateTimeToUtc("2026-01-01T09:00", "Asia/Kolkata"),
    "2026-01-01T03:30:00.000Z"
  );
  assert.throws(
    () => reminderLocalDateTimeToUtc("2026-03-08T02:30", "America/Los_Angeles"),
    /does not exist/
  );
  assert.throws(
    () => reminderLocalDateTimeToUtc("2026-11-01T01:30", "America/Los_Angeles"),
    /is ambiguous/
  );
});

test("migration 8 preserves existing tasks and adds the reminder registry to a version 7 database", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "scheduled-reminder-migration-test-"));
  const filePath = path.join(dir, "tasks.sqlite");
  try {
    const oldDb = new DatabaseSync(filePath);
    try {
      oldDb.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE conversations (
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
        CREATE TABLE messages (
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
          metadata_json TEXT NOT NULL
        );
        CREATE TABLE runs (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          conversation_key TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          error TEXT,
          last_consumed_seq INTEGER
        );
        CREATE TABLE communication_events (
          id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          conversation_key TEXT NOT NULL,
          direction TEXT NOT NULL,
          kind TEXT NOT NULL,
          external_event_id TEXT,
          actor_id TEXT,
          text TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          run_id TEXT,
          task_message_id TEXT,
          metadata_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE tasks (
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
        CREATE UNIQUE INDEX idx_tasks_active_conversation
          ON tasks(conversation_id) WHERE status IN ('pending', 'in_progress');
      `);
      oldDb.prepare(`INSERT INTO conversations VALUES (?, ?, ?, NULL, 'queued', ?, ?, NULL, '{}', '{}', NULL, NULL, NULL)`)
        .run("slack", "slack:T1:C1:migration", "conversation-1", now, now);
      oldDb.prepare(`INSERT INTO tasks VALUES (?, ?, ?, 'pending', NULL, NULL, NULL, ?, ?)`)
        .run("existing-task", "conversation-1", "existing task", now, now);
      for (let version = 1; version <= 7; version += 1) {
        oldDb.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(version, now);
      }
    } finally {
      oldDb.close();
    }

    const ledger = new SQLiteTaskLedger({ filePath, now: () => new Date(now) });
    try {
      const reminder = await ledger.createReminder(reminderInput("slack:T1:C1:migration"));
      assert.equal(reminder.status, "scheduled");
    } finally {
      ledger.close();
    }

    const verify = new DatabaseSync(filePath);
    try {
      assert.ok(verify.prepare("SELECT version FROM schema_migrations WHERE version = 8").get());
      assert.ok(verify.prepare("SELECT version FROM schema_migrations WHERE version = 9").get());
      assert.ok(verify.prepare("SELECT version FROM schema_migrations WHERE version = 10").get());
      assert.ok(verify.prepare("SELECT version FROM schema_migrations WHERE version = 11").get());
      assert.ok(verify.prepare("SELECT version FROM schema_migrations WHERE version = 12").get());
      assert.ok(verify.prepare("SELECT version FROM schema_migrations WHERE version = 13").get());
      assert.ok((verify.prepare("PRAGMA table_info(scheduled_reminders)").all() as Array<{ name: string }>).some((column) => column.name === "company_id"));
      assert.ok(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scheduled_reminders'").get());
      assert.ok(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'codex_sessions'").get());
      assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminder_execution_attempts'").get(), undefined);
      assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'reminder_execution_history'").get(), undefined);
      assert.deepEqual(verify.prepare("PRAGMA foreign_key_check").all(), []);
      assert.ok(verify.prepare("SELECT task_kind FROM tasks WHERE id = 'existing-task'").get());
    } finally {
      verify.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("migration 30 drops the reminder execution history left pointing at a table migration 29 removed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "reminder-history-migration-test-"));
  const filePath = path.join(dir, "tasks.sqlite");
  try {
    new SQLiteTaskLedger({ filePath, now: () => new Date(now) }).close();

    const legacy = new DatabaseSync(filePath);
    try {
      legacy.exec(`
        CREATE TABLE reminder_execution_history (
          reminder_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          run_id TEXT,
          phase TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          execution_started_at TEXT,
          archived_at TEXT NOT NULL,
          failure TEXT NOT NULL,
          PRIMARY KEY(reminder_id, attempt_id),
          FOREIGN KEY(reminder_id) REFERENCES scheduled_reminders_old(id) ON DELETE CASCADE,
          FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE SET NULL
        );
        CREATE INDEX idx_reminder_execution_history_reminder
          ON reminder_execution_history(reminder_id, archived_at, attempt_id);
        DELETE FROM schema_migrations WHERE version = 30;
      `);
    } finally {
      legacy.close();
    }

    const ledger = new SQLiteTaskLedger({ filePath, now: () => new Date(now) });
    ledger.close();

    const verify = new DatabaseSync(filePath);
    try {
      assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'reminder_execution_history'").get(), undefined);
      assert.equal(verify.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_reminder_execution_history_reminder'").get(), undefined);
      assert.ok(verify.prepare("SELECT version FROM schema_migrations WHERE version = 30").get());
    } finally {
      verify.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

test("persists Codex session ownership centrally for Slack, email, and phone across database recovery", async () => {
  await withLedger(async (ledger, filePath) => {
    const sessions = [
      ["slack", "slack:T1:C1:session", "slack-session"],
      ["email", "email:account:thread-session", "email-session"],
      ["phone", "phone:conversation-session", "phone-session"]
    ] as const;
    for (const [channel, conversationKey, codexSessionId] of sessions) {
      await ledger.recordMessage(channelMessage(channel, conversationKey));
      const stored = await ledger.saveCodexSession(channel, conversationKey, codexSessionId);
      assert.equal(stored.codexSessionId, codexSessionId);
      assert.equal((await ledger.getCodexSession(channel, conversationKey))?.codexSessionId, codexSessionId);
    }

    const legacyKey = "email:account:legacy-session";
    const canonicalKey = "email:account:canonical-session";
    await ledger.recordMessage(channelMessage("email", legacyKey));
    await ledger.saveCodexSession("email", legacyKey, "migrated-email-session");
    await ledger.migrateConversationKey("email", legacyKey, canonicalKey);
    assert.equal(await ledger.getCodexSession("email", legacyKey), null);
    assert.equal((await ledger.getCodexSession("email", canonicalKey))?.codexSessionId, "migrated-email-session");

    ledger.close();
    const recovered = new SQLiteTaskLedger({ filePath, now: () => new Date(now) });
    try {
      for (const [channel, conversationKey, codexSessionId] of sessions) {
        assert.equal((await recovered.getCodexSession(channel, conversationKey))?.codexSessionId, codexSessionId);
      }
      assert.equal((await recovered.getCodexSession("email", canonicalKey))?.codexSessionId, "migrated-email-session");
    } finally {
      recovered.close();
    }
  });
});

