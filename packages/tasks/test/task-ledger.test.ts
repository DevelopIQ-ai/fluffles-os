import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ConversationEngine } from "../src/conversation-engine";
import { ConversationRuntime } from "../src/conversation-runtime";
import {
  ConversationKey,
  ContextBudgetExceededError,
  getChannelContextLimits,
  loadContextLimits,
  resolveContextLimitsPath,
  assertAuthoritativeLedgerDurability,
  SQLiteTaskLedger,
  TaskLedgerMessageInput
} from "../src/task-ledger";

async function withLedger<T>(fn: (ledger: SQLiteTaskLedger, dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-ledger-test-"));
  let ledger: SQLiteTaskLedger | null = null;
  try {
    let tick = 0;
    ledger = new SQLiteTaskLedger({
      filePath: path.join(dir, "tasks.sqlite"),
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
      idFactory: () => `id-${tick++}`,
      // This helper advances one second per durable write, so one-millisecond
      // leases model a crashed worker before each explicit recovery call.
      runLeaseDurationMs: 1
    });
    return await fn(ledger, dir);
  } finally {
    ledger?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function slackMessage(overrides: Partial<TaskLedgerMessageInput> = {}): TaskLedgerMessageInput {
  return {
    channel: "slack",
    conversationKey: "thread:C123:1000.000100",
    externalMessageId: "Ev1",
    authorId: "U123",
    text: "rename the repo",
    receivedAt: "2026-01-01T00:00:00.000Z",
    title: "rename the repo",
    replyTarget: {
      type: "slack_thread",
      channel: "C123",
      threadTs: "1000.000100"
    },
    metadata: {
      surface: "ambient",
      rootTs: "1000.000100"
    },
    ...overrides
  };
}

async function completeRunLifecycle(ledger: SQLiteTaskLedger, conversationKey: string, externalMessageId: string): Promise<string> {
  const intake = await ledger.recordMessage(slackMessage({ conversationKey, externalMessageId }));
  const started = await ledger.startRun("slack", conversationKey);
  assert.ok(started);
  const finished = await ledger.finishRun("slack", conversationKey, started.run.id, "done", null);
  assert.ok(finished);
  return intake.conversation.id;
}

function waitForWorkerLock(worker: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!worker.stdout) {
      reject(new Error("contention worker has no stdout"));
      return;
    }
    let stdout = "";
    worker.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("locked\n")) resolve();
    });
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`contention worker exited ${code} before acquiring its lock`)));
  });
}

const contentionWorkerSource = `
  const { SQLiteTaskLedger } = require(process.argv[1]);
  const filePath = process.argv[2];
  let id = 0;
  let lockHeld = false;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  const ledger = new SQLiteTaskLedger({
    filePath,
    idFactory: () => {
      id += 1;
      if (!lockHeld) {
        lockHeld = true;
        process.stdout.write("locked\\n");
        Atomics.wait(signal, 0, 0, 250);
      }
      return "worker-" + id;
    }
  });

  (async () => {
    const conversationKey = "slack:T1:C1:worker-contention";
    const intake = await ledger.recordMessage({
      channel: "slack",
      conversationKey,
      externalMessageId: "worker-contention-message",
      authorId: "U-worker",
      text: "worker intake"
    });
    const started = await ledger.startRun("slack", conversationKey);
    if (!started) throw new Error("worker did not start its run");
    await ledger.finishRun("slack", conversationKey, started.run.id, "done", null);
    ledger.close();
  })().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
`;

test("loads editable context limits and applies channel env overrides", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "context-limits-test-"));
  try {
    const configPath = path.join(dir, "context-limits.json");
    await writeFile(configPath, JSON.stringify({
      channels: {
        phone: {
          recentMessagesLimit: 3,
          maxContextChars: 456,
          maxContextTokens: 42
        }
      }
    }), "utf8");
    const env: NodeJS.ProcessEnv = {
      HOME: dir,
      FLUFFLES_CONTEXT_LIMITS_PATH: configPath,
      PHONE_CONTEXT_MAX_CHARS: "123",
      PHONE_CONTEXT_MAX_TOKENS: "17"
    };

    assert.equal(resolveContextLimitsPath(env), configPath);
    const loaded = loadContextLimits(env);
    assert.equal(loaded.channels.phone.recentMessagesLimit, 3);
    assert.equal(loaded.channels.phone.maxContextChars, 456);
    assert.equal(loaded.channels.phone.maxContextTokens, 42);
    assert.equal(loaded.channels.phone.recentUserMessageTokenLimit, 20000);
    assert.equal(loaded.channels.phone.summaryMaxChars, 1500);

    const active = getChannelContextLimits("phone", env);
    assert.equal(active.recentMessagesLimit, 3);
    assert.equal(active.maxContextChars, 123);
    assert.equal(active.maxContextTokens, 17);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the authoritative ledger verifies WAL plus FULL durability and rejects a weakened connection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-ledger-durability-test-"));
  const dbPath = path.join(dir, "tasks.sqlite");
  try {
    const ledger = new SQLiteTaskLedger({ filePath: dbPath });
    try {
      // Startup initializes this exact authoritative connection and verifies
      // the contract before any conversation state can be written.
      ledger.assertAuthoritativeDurability();
    } finally {
      ledger.close();
    }

    const db = new DatabaseSync(dbPath);
    try {
      const journalMode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      assert.equal(journalMode.journal_mode.toLowerCase(), "wal");

      db.exec("PRAGMA synchronous = NORMAL");
      assert.throws(
        () => assertAuthoritativeLedgerDurability(db),
        /requires synchronous=FULL/
      );

      db.exec("PRAGMA synchronous = FULL");
      assert.doesNotThrow(() => assertAuthoritativeLedgerDurability(db));

      db.exec("PRAGMA journal_mode = MEMORY");
      assert.throws(
        () => assertAuthoritativeLedgerDurability(db),
        /requires journal_mode=WAL/
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("admits the web channel on a ledger whose legacy schema quotes string literals with double quotes", async () => {
  // The mini's dev ledger predates these migrations quoting their string
  // literals, so its schema holds `CHECK (channel IN ("slack", ...))` and
  // `WHERE status = "scheduled"`. Any ALTER TABLE RENAME reparses the whole
  // schema with that misfeature off and fails on the legacy SQL, so the web
  // channel rebuild must not rename.
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-ledger-legacy-quotes-test-"));
  const dbPath = path.join(dir, "tasks.sqlite");
  try {
    new SQLiteTaskLedger({ filePath: dbPath }).close();

    const planted = new DatabaseSync(dbPath);
    const sqlOf = (name: string): string => {
      const row = planted.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name) as { sql: string } | undefined;
      if (!row) throw new Error(`missing schema object ${name}`);
      return row.sql;
    };
    const legacyTable = sqlOf("scheduled_reminders").replace("('slack', 'email', 'phone', 'web')", '("slack", "email", "phone")');
    const legacyIndex = sqlOf("idx_scheduled_reminders_due").replace("'scheduled'", '"scheduled"');
    planted.exec("PRAGMA writable_schema = ON");
    const rewrite = planted.prepare("UPDATE sqlite_master SET sql = ? WHERE name = ?");
    rewrite.run(legacyTable, "scheduled_reminders");
    rewrite.run(legacyIndex, "idx_scheduled_reminders_due");
    planted.exec("PRAGMA writable_schema = OFF");
    planted.prepare("DELETE FROM schema_migrations WHERE version = 31").run();
    planted.close();

    const reopened = new SQLiteTaskLedger({ filePath: dbPath });
    reopened.close();

    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'scheduled_reminders'").get() as { sql: string };
      assert.match(row.sql, /'web'/, "the rebuilt table admits web");
      assert.doesNotMatch(row.sql, /"slack"/, "the rebuilt table drops the legacy quoting");
      const dueIndex = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_scheduled_reminders_due'").get() as { sql: string };
      assert.match(dueIndex.sql, /'scheduled'/, "the recreated index is quoted correctly");
    } finally {
      db.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("records a new channel conversation as queued", async () => {
  await withLedger(async (ledger) => {
    const result = await ledger.recordMessage(slackMessage());

    assert.equal(result.disposition, "new_conversation");
    assert.equal(result.conversation.channel, "slack");
    assert.equal(result.conversation.conversationKey, "thread:C123:1000.000100");
    assert.equal(result.conversation.status, "queued");
    assert.equal(result.conversation.messages.length, 1);
    assert.deepEqual(result.conversation.replyTarget, {
      type: "slack_thread",
      channel: "C123",
      threadTs: "1000.000100"
    });
  });
});

test("links pending messages to the run that claims them", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    const result = await ledger.recordMessage(slackMessage({ conversationKey: key }));
    assert.equal(result.message.runId, null);

    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    const conversation = await ledger.getConversation("slack", key);
    assert.equal(conversation?.messages[0]?.runId, started.run.id);
  });
});

test("deduplicates repeated source messages", async () => {
  await withLedger(async (ledger) => {
    await ledger.recordMessage(slackMessage());
    const duplicate = await ledger.recordMessage(slackMessage());
    const conversation = await ledger.getConversation("slack", "thread:C123:1000.000100");

    assert.equal(duplicate.disposition, "duplicate");
    assert.equal(conversation?.messages.length, 1);
  });
});

test("preserves channel-specific messages in one central table", async () => {
  await withLedger(async (ledger) => {
    await ledger.recordMessage(slackMessage());
    await ledger.recordMessage(slackMessage({
      channel: "email",
      conversationKey: "email:gmail:abc",
      externalMessageId: "gmail-message-1",
      authorId: "person@example.com",
      text: "can you review this?",
      title: "can you review this?",
      replyTarget: {
        type: "email_thread",
        threadId: "abc",
        messageId: "gmail-message-1"
      },
      metadata: {
        from: "person@example.com",
        subject: "review"
      }
    }));

    const snapshot = await ledger.snapshot();

    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.byChannel.slack, 1);
    assert.equal(snapshot.byChannel.email, 1);
    assert.equal(snapshot.queued, 2);
  });
});

test("tracks running, pending update, and done states", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    assert.equal(started.messages.length, 1);
    assert.equal(started.conversation.status, "running");

    const update = await ledger.recordMessage(slackMessage({
      conversationKey: key,
      externalMessageId: "Ev2",
      text: "actually include github too"
    }));
    assert.equal(update.disposition, "running_update");

    const finished = await ledger.finishRun("slack", key, started.run.id, "done");
    assert.ok(finished);
    assert.equal(finished.conversation.status, "queued");
    assert.equal(finished.hasPendingMessages, true);

    const second = await ledger.startRun("slack", key);
    assert.ok(second);
    assert.deepEqual(second.messages.map((message) => message.text), ["actually include github too"]);
    const done = await ledger.finishRun("slack", key, second.run.id, "done");
    assert.equal(done?.conversation.status, "done");
  });
});

test("claims steering messages into the active run", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    await ledger.recordMessage(slackMessage({
      conversationKey: key,
      externalMessageId: "Ev2",
      text: "actually include github too"
    }));

    const claimed = await ledger.claimSteeringMessages("slack", key, started.run.id);
    const finished = await ledger.finishRun("slack", key, started.run.id, "done");
    const conversation = await ledger.getConversation("slack", key);

    assert.deepEqual(claimed.map((message) => message.text), ["actually include github too"]);
    assert.equal(claimed[0]?.runId, started.run.id);
    assert.equal(finished?.hasPendingMessages, false);
    assert.equal(conversation?.status, "done");
    assert.deepEqual(conversation?.runs[0]?.messageIds, [
      started.messages[0]?.id,
      claimed[0]?.id
    ]);
  });
});

test("does not consume claimed or duplicate steering messages twice", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    await ledger.recordMessage(slackMessage({
      conversationKey: key,
      externalMessageId: "Ev2",
      text: "actually include github too"
    }));

    const firstClaim = await ledger.claimSteeringMessages("slack", key, started.run.id);
    const secondClaim = await ledger.claimSteeringMessages("slack", key, started.run.id);
    const duplicate = await ledger.recordMessage(slackMessage({
      conversationKey: key,
      externalMessageId: "Ev2",
      text: "duplicate retry"
    }));
    const thirdClaim = await ledger.claimSteeringMessages("slack", key, started.run.id);

    assert.equal(firstClaim.length, 1);
    assert.deepEqual(secondClaim, []);
    assert.equal(duplicate.disposition, "duplicate");
    assert.deepEqual(thirdClaim, []);
  });
});

test("lists runnable conversations by channel only", async () => {
  await withLedger(async (ledger) => {
    await ledger.recordMessage(slackMessage({ conversationKey: "thread:C123:1", externalMessageId: "Ev1" }));
    await ledger.recordMessage(slackMessage({
      channel: "email",
      conversationKey: "email:gmail:abc",
      externalMessageId: "gmail-message-1",
      authorId: "person@example.com",
      text: "email task"
    }));

    const slack = await ledger.runnableConversations("slack");
    const email = await ledger.runnableConversations("email");
    const slackSnapshot = await ledger.snapshot("slack");

    assert.deepEqual(slack.map((conversation) => conversation.conversationKey), ["thread:C123:1"]);
    assert.deepEqual(email.map((conversation) => conversation.conversationKey), ["email:gmail:abc"]);
    assert.equal(slackSnapshot.total, 1);
    assert.equal(slackSnapshot.byChannel.slack, 1);
  });
});

test("recovers interrupted runs inside the central ledger", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    await ledger.recordMessage(slackMessage({
      conversationKey: key,
      externalMessageId: "Ev2",
      text: "pending after restart"
    }));

    const recovery = await ledger.recoverInterruptedRuns("slack");
    const conversation = await ledger.getConversation("slack", key);
    const runnable = await ledger.runnableConversations("slack");

    assert.deepEqual(recovery.recoveredKeys, [key]);
    assert.deepEqual(recovery.runnableKeys, [key]);
    assert.equal(conversation?.status, "queued");
    assert.equal(conversation?.lastError, "interrupted_by_restart");
    assert.equal(conversation?.runs[0]?.status, "interrupted");
    assert.deepEqual(runnable.map((item) => item.conversationKey), [key]);
  });
});

test("restart recovery requeues messages claimed into an interrupted run", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev1", text: "first" }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev2", text: "steering update" }));
    const claimed = await ledger.claimSteeringMessages("slack", key, started.run.id);
    assert.equal(claimed.length, 1);

    const recovery = await ledger.recoverInterruptedRuns("slack");
    const retry = await ledger.startRun("slack", key);

    assert.deepEqual(recovery.recoveredKeys, [key]);
    assert.ok(retry);
    assert.deepEqual(retry.messages.map((message) => message.text), ["first", "steering update"]);
  });
});

test("recovers only the requested channel", async () => {
  await withLedger(async (ledger) => {
    const slackKey = "thread:C123:1000.000100";
    const emailKey = "email:gmail:abc";
    await ledger.recordMessage(slackMessage({ conversationKey: slackKey }));
    await ledger.recordMessage(slackMessage({
      channel: "email",
      conversationKey: emailKey,
      externalMessageId: "gmail-message-1",
      authorId: "person@example.com",
      text: "email task"
    }));
    assert.ok(await ledger.startRun("slack", slackKey));
    assert.ok(await ledger.startRun("email", emailKey));

    const recovery = await ledger.recoverInterruptedRuns("slack");
    const slack = await ledger.getConversation("slack", slackKey);
    const email = await ledger.getConversation("email", emailKey);

    assert.deepEqual(recovery.recoveredKeys, [slackKey]);
    assert.equal(slack?.status, "queued");
    assert.equal(slack?.runs[0]?.status, "interrupted");
    assert.equal(email?.status, "running");
    assert.equal(email?.runs[0]?.status, "running");
  });
});

test("serializes concurrent message writes to one conversation", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:concurrent";
    const writes = Array.from({ length: 30 }, (_, index) => ledger.recordMessage(slackMessage({
      conversationKey: key,
      externalMessageId: `Ev${index}`,
      text: `message ${index}`,
      receivedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`
    })));

    await Promise.all(writes);

    const conversation = await ledger.getConversation("slack", key);
    assert.equal(conversation?.messages.length, 30);
    assert.deepEqual(
      conversation?.messages.slice(0, 3).map((message) => message.text),
      ["message 0", "message 1", "message 2"]
    );
  });
});

test("independent ledger instances retry SQLite lock contention across a task lifecycle", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-ledger-contention-test-"));
  const filePath = path.join(dir, "tasks.sqlite");
  const primary = new SQLiteTaskLedger({ filePath });
  try {
    await primary.snapshot();
    const modulePath = path.join(__dirname, "..", "src", "task-ledger.js");
    const worker = spawn(process.execPath, ["-e", contentionWorkerSource, modulePath, filePath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    worker.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    const workerExit = new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`contention worker exited ${code}: ${stderr}`)));
    });
    await waitForWorkerLock(worker);

    const primaryConversationId = await completeRunLifecycle(
      primary,
      "slack:T1:C1:primary-contention",
      "primary-contention-message"
    );
    assert.ok(primaryConversationId);
    await workerExit;

    const conversations = await primary.conversations("slack");
    assert.deepEqual(
      conversations.map((conversation) => conversation.conversationKey).sort(),
      ["slack:T1:C1:primary-contention", "slack:T1:C1:worker-contention"]
    );
    for (const conversation of conversations) {
      assert.equal(conversation.runs.at(-1)?.status, "done");
    }
  } finally {
    primary.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed runs can be resumed by a later message", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:failure";
    await ledger.recordMessage(slackMessage({ conversationKey: key }));
    const first = await ledger.startRun("slack", key);
    assert.ok(first);
    const failed = await ledger.finishRun("slack", key, first.run.id, "failed", "boom");
    assert.equal(failed?.conversation.status, "failed");

    const update = await ledger.recordMessage(slackMessage({
      conversationKey: key,
      externalMessageId: "Ev2",
      text: "retry with this correction"
    }));
    const retry = await ledger.startRun("slack", key);

    assert.equal(update.conversation.status, "queued");
    assert.ok(retry);
    assert.deepEqual(retry.messages.map((message) => message.text), ["retry with this correction"]);
  });
});

test("stopping cancels unclaimed work and a later message starts a new run", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:stop";
    await ledger.recordMessage(slackMessage({ conversationKey: key }));
    const stopped = await ledger.setConversationStatus("slack", key, "stopped", "user_stop");
    const blocked = await ledger.startRun("slack", key);
    assert.equal(stopped?.status, "stopped");
    assert.equal(blocked, null);

    await ledger.recordMessage(slackMessage({
      conversationKey: key,
      externalMessageId: "Ev2",
      text: "new request after stop"
    }));
    const restarted = await ledger.startRun("slack", key);
    assert.ok(restarted);
    assert.deepEqual(restarted.messages.map((message) => message.text), ["new request after stop"]);
    const conversation = await ledger.getConversation("slack", key);
    assert.equal(conversation?.messages[0]?.metadata.nonActionable, true);
    assert.equal(conversation?.messages[0]?.metadata.cancellationReason, "user_stop");
  });
});

test("durable run leases fence recovery, renew atomically, and reject a stale worker", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-ledger-live-owner-test-"));
  const filePath = path.join(dir, "tasks.sqlite");
  const key = "thread:C123:live-owner";
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = () => new Date(now);
  try {
    const first = new SQLiteTaskLedger({
      filePath,
      now: clock
    });
    await first.recordMessage(slackMessage({ conversationKey: key }));
    const started = await first.startRun("slack", key, {
      workerInstanceId: "worker-a",
      leaseDurationMs: 1_000
    });
    assert.ok(started);
    const lease = {
      workerInstanceId: "worker-a",
      leaseExpiresAt: started.run.leaseExpiresAt!
    };

    const observingWorker = new SQLiteTaskLedger({
      filePath,
      now: clock
    });
    assert.deepEqual(await observingWorker.recoverInterruptedRuns("slack"), {
      recoveredKeys: [],
      runnableKeys: []
    });
    assert.equal((await observingWorker.getConversation("slack", key))?.status, "running");
    const renewed = await first.heartbeatRunLease("slack", key, started.run.id, lease, 1_000);
    assert.ok(renewed, "only the current worker can renew its lease");
    now += 999;
    assert.deepEqual(await observingWorker.recoverInterruptedRuns("slack"), { recoveredKeys: [], runnableKeys: [] });

    now += 2;
    const replacementWorker = new SQLiteTaskLedger({ filePath, now: clock });
    const recovered = await Promise.all([
      observingWorker.recoverInterruptedRuns("slack"),
      replacementWorker.recoverInterruptedRuns("slack")
    ]);
    assert.equal(recovered.filter((result) => result.recoveredKeys.includes(key)).length, 1);
    assert.equal((await replacementWorker.getConversation("slack", key))?.status, "queued");
    await assert.rejects(first.assertRunLease("slack", key, started.run.id, lease), /no longer owned/);
    const replacement = await replacementWorker.startRun("slack", key, {
      workerInstanceId: "worker-c", leaseDurationMs: 1_000
    });
    assert.ok(replacement);
    assert.equal(replacement.run.workerInstanceId, "worker-c", "a reclaimed run is owned by the new worker");
    replacementWorker.close();
    observingWorker.close();
    first.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a restarted worker reclaims its own crashed run inside the lease window", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-ledger-self-reclaim-test-"));
  const filePath = path.join(dir, "tasks.sqlite");
  const key = "thread:C123:self-reclaim";
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = () => new Date(now);
  try {
    const crashed = new SQLiteTaskLedger({ filePath, now: clock });
    await crashed.recordMessage(slackMessage({ conversationKey: key }));
    const started = await crashed.startRun("slack", key, {
      workerInstanceId: "slack:host-a",
      leaseDurationMs: 60_000
    });
    assert.ok(started);
    crashed.close();

    // The lease is still unexpired: a different worker must not reclaim it.
    now += 1_000;
    const restarted = new SQLiteTaskLedger({ filePath, now: clock });
    assert.deepEqual(
      await restarted.recoverInterruptedRuns("slack", "slack:host-b"),
      { recoveredKeys: [], runnableKeys: [] }
    );

    // The same worker identity restarted after a crash reclaims immediately,
    // without waiting out the lease window.
    const recovery = await restarted.recoverInterruptedRuns("slack", "slack:host-a");
    assert.deepEqual(recovery.recoveredKeys, [key]);
    const conversation = await restarted.getConversation("slack", key);
    assert.equal(conversation?.status, "queued");
    assert.equal(conversation?.runs[0]?.status, "interrupted");
    restarted.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stopping an active run is terminal, cancels pending messages, and survives recovery", async () => {
  await withLedger(async (ledger) => {
    const key = "slack:T1:C123:stop-active";
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "message-1", text: "first" }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "message-2", text: "pending update" }));

    const stopped = await ledger.setConversationStatus("slack", key, "stopped", "user_stop");
    const repeatedStop = await ledger.setConversationStatus("slack", key, "stopped", "user_stop");
    const lateAssistant = await ledger.recordAssistantMessage({
      channel: "slack",
      conversationKey: key,
      text: "late reply",
      runId: started.run.id
    });
    const lateFinish = await ledger.finishRun("slack", key, started.run.id, "done");
    const recovery = await ledger.recoverInterruptedRuns("slack");

    assert.equal(stopped?.status, "stopped");
    assert.equal(stopped?.activeRunId, null);
    assert.equal(stopped?.runs[0]?.status, "stopped");
    assert.equal(stopped?.messages.find((message) => message.text === "pending update")?.runId, null);
    assert.equal(stopped?.messages.find((message) => message.text === "pending update")?.metadata.nonActionable, true);
    assert.equal(repeatedStop?.runs[0]?.status, "stopped");
    assert.equal(lateAssistant, null);
    assert.equal(lateFinish?.conversation.status, "stopped");
    assert.equal(lateFinish?.conversation.runs[0]?.status, "stopped");
    assert.deepEqual(recovery, { recoveredKeys: [], runnableKeys: [] });
  });
});

test("rejects malformed SQLite rows instead of trusting casts", async () => {
  await withLedger(async (ledger, dir) => {
    const dbPath = path.join(dir, "tasks.sqlite");
    await ledger.recordMessage(slackMessage());
    ledger.close();

    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("UPDATE conversations SET status = ? WHERE channel = ? AND conversation_key = ?")
        .run("bogus", "slack", "thread:C123:1000.000100");
    } finally {
      db.close();
    }

    const reopened = new SQLiteTaskLedger({ filePath: dbPath });
    try {
      await assert.rejects(
        () => reopened.getConversation("slack", "thread:C123:1000.000100"),
        /status has invalid value/
      );
    } finally {
      reopened.close();
    }
  });
});

test("message seq is auto-assigned in insertion order within each conversation", async () => {
  await withLedger(async (ledger) => {
    const key1 = "thread:C1:seq-a";
    const key2 = "thread:C2:seq-b";

    const r1 = await ledger.recordMessage(slackMessage({ conversationKey: key1, externalMessageId: "Ev1" }));
    const r2 = await ledger.recordMessage(slackMessage({ conversationKey: key1, externalMessageId: "Ev2", text: "second" }));
    const r3 = await ledger.recordMessage(slackMessage({ conversationKey: key1, externalMessageId: "Ev3", text: "third" }));
    const r4 = await ledger.recordMessage(slackMessage({ conversationKey: key2, externalMessageId: "Ev4" }));
    const r5 = await ledger.recordMessage(slackMessage({ conversationKey: key2, externalMessageId: "Ev5", text: "second in key2" }));

    assert.equal(r1.message.seq, 1);
    assert.equal(r2.message.seq, 2);
    assert.equal(r3.message.seq, 3);
    assert.equal(r4.message.seq, 1, "second conversation starts seq from 1");
    assert.equal(r5.message.seq, 2);

    // Verify seq is preserved when reading back through getConversation
    const conv = await ledger.getConversation("slack", key1);
    assert.deepEqual(conv?.messages.map((m) => m.seq), [1, 2, 3]);
  });
});

test("message role defaults to user and can be overridden", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C1:roles";
    const r1 = await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev1" }));
    const r2 = await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev2", role: "assistant", text: "reply" }));
    const r3 = await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev3", role: "system", text: "system msg" }));

    assert.equal(r1.message.role, "user");
    assert.equal(r2.message.role, "assistant");
    assert.equal(r3.message.role, "system");

    const conv = await ledger.getConversation("slack", key);
    assert.deepEqual(conv?.messages.map((m) => m.role), ["user", "assistant", "system"]);
  });
});

test("conversation has null activeRunId and compactionSeq on creation", async () => {
  await withLedger(async (ledger) => {
    const result = await ledger.recordMessage(slackMessage());
    assert.equal(result.conversation.activeRunId, null);
    assert.equal(result.conversation.compactionSeq, null);

    const fetched = await ledger.getConversation("slack", "thread:C123:1000.000100");
    assert.equal(fetched?.activeRunId, null);
    assert.equal(fetched?.compactionSeq, null);
  });
});

test("run has null lastConsumedSeq on creation", async () => {
  await withLedger(async (ledger) => {
    await ledger.recordMessage(slackMessage());
    const started = await ledger.startRun("slack", "thread:C123:1000.000100");
    assert.ok(started);
    assert.equal(started.run.lastConsumedSeq, null);

    // Also verify it round-trips through the conversation fetch
    const conv = await ledger.getConversation("slack", "thread:C123:1000.000100");
    assert.equal(conv?.runs[0]?.lastConsumedSeq, null);
  });
});

test("ConversationKey helpers build and parse every channel format", () => {
  const slackKey = ConversationKey.forSlack("T123", "C456", "1609459200.123456");
  assert.equal(slackKey, "slack:T123:C456:1609459200.123456");
  assert.deepEqual(ConversationKey.parse(slackKey), {
    channel: "slack",
    teamId: "T123",
    channelId: "C456",
    rootTs: "1609459200.123456"
  });

  const emailKey = ConversationKey.forEmail("gmail", "thread-abc123");
  assert.equal(emailKey, "email:gmail:thread-abc123");
  assert.deepEqual(ConversationKey.parse(emailKey), {
    channel: "email",
    accountId: "gmail",
    threadId: "thread-abc123"
  });

  const phoneKey = ConversationKey.forPhone("conv-abc123");
  assert.equal(phoneKey, "phone:conv-abc123");
  assert.deepEqual(ConversationKey.parse(phoneKey), { channel: "phone", conversationId: "conv-abc123" });
  assert.deepEqual(ConversationKey.parse("phone:main"), { channel: "phone", conversationId: "main" });

  // threadId containing a colon (e.g. a namespaced ID) round-trips correctly
  const emailWithColon = ConversationKey.forEmail("acct", "ns:thread-99");
  assert.deepEqual(ConversationKey.parse(emailWithColon), {
    channel: "email",
    accountId: "acct",
    threadId: "ns:thread-99"
  });

  assert.equal(ConversationKey.parse("bogus"), null);
  assert.equal(ConversationKey.parse("slack:T1:C1"), null, "missing rootTs segment");
  assert.equal(ConversationKey.parse("email:acct"), null, "missing threadId segment");
  assert.equal(ConversationKey.parse("slack::C1:ts"), null, "empty teamId");
  assert.equal(ConversationKey.parse("phone:"), null, "missing phone conversation id");

  const webKey = ConversationKey.forWeb("chat-42_A");
  assert.equal(webKey, "web:chat-42_A");
  assert.deepEqual(ConversationKey.parse(webKey), { channel: "web", chatId: "chat-42_A" });
  assert.equal(ConversationKey.parse("web:"), null, "missing web chat id");
  assert.equal(ConversationKey.parse("web:has spaces"), null, "web chat ids stay url-safe");
  assert.throws(() => ConversationKey.forWeb("has spaces"), /url-safe/);
});

test("migrates a completed legacy conversation key without losing history", async () => {
  await withLedger(async (ledger) => {
    const legacyKey = "thread:C123:1000.000100";
    const canonicalKey = "slack:T123:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: legacyKey }));
    const started = await ledger.startRun("slack", legacyKey);
    assert.ok(started);
    await ledger.finishRun("slack", legacyKey, started.run.id, "done");

    const migrated = await ledger.migrateConversationKey("slack", legacyKey, canonicalKey);

    assert.equal(await ledger.getConversation("slack", legacyKey), null);
    assert.equal(migrated?.conversationKey, canonicalKey);
    assert.equal(migrated?.messages.length, 1);
    assert.equal(migrated?.runs[0]?.id, started.run.id);
  });
});

test("refuses to migrate an active legacy conversation key", async () => {
  await withLedger(async (ledger) => {
    const legacyKey = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: legacyKey }));
    assert.ok(await ledger.startRun("slack", legacyKey));

    await assert.rejects(
      () => ledger.migrateConversationKey("slack", legacyKey, "slack:T123:C123:1000.000100"),
      /Cannot migrate active conversation/
    );
  });
});

test("retains persisted phone:main conversations for recovery", async () => {
  await withLedger(async (ledger) => {
    await ledger.recordMessage(slackMessage({ channel: "phone", conversationKey: "phone:main" }));
    const started = await ledger.startRun("phone", "phone:main");
    assert.ok(started);
    await ledger.finishRun("phone", "phone:main", started.run.id, "done");

    assert.equal((await ledger.getConversation("phone", "phone:main"))?.status, "done");
  });
});

test("startRun sets activeRunId on the conversation", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);

    const conv = await ledger.getConversation("slack", key);
    assert.equal(conv?.activeRunId, started.run.id);
  });
});

test("finishRun clears activeRunId and records lastConsumedSeq", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev1" }));
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev2", text: "second" }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);

    await ledger.finishRun("slack", key, started.run.id, "done");

    const conv = await ledger.getConversation("slack", key);
    assert.equal(conv?.activeRunId, null);
    assert.equal(conv?.runs[0]?.lastConsumedSeq, 2);
  });
});

test("recoverInterruptedRuns clears activeRunId on interrupted conversations", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);

    const running = await ledger.getConversation("slack", key);
    assert.equal(running?.activeRunId, started.run.id);

    await ledger.recoverInterruptedRuns("slack");

    const recovered = await ledger.getConversation("slack", key);
    assert.equal(recovered?.activeRunId, null);
  });
});

test("conversation has null compactionSummary on creation", async () => {
  await withLedger(async (ledger) => {
    const result = await ledger.recordMessage(slackMessage());
    assert.equal(result.conversation.compactionSummary, null);

    const fetched = await ledger.getConversation("slack", "thread:C123:1000.000100");
    assert.equal(fetched?.compactionSummary, null);
  });
});

test("compact advances compaction_seq and stores the summary", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    await ledger.finishRun("slack", key, started.run.id, "done");

    const result = await ledger.compact("slack", key, "user asked to rename the repo", 1);
    assert.ok(result);
    assert.equal(result.compactionSeq, 1);
    assert.equal(result.compactionSummary, "user asked to rename the repo");

    const fetched = await ledger.getConversation("slack", key);
    assert.equal(fetched?.compactionSeq, 1);
    assert.equal(fetched?.compactionSummary, "user asked to rename the repo");
  });
});

test("compact rejects upToSeq beyond the last done run lastConsumedSeq", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev1" }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    await ledger.finishRun("slack", key, started.run.id, "done");

    await assert.rejects(
      () => ledger.compact("slack", key, "too far", 2),
      /Cannot compact/
    );
  });
});

test("compact rejects when no done runs exist", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key }));

    await assert.rejects(
      () => ledger.compact("slack", key, "premature", 1),
      /Cannot compact/
    );
  });
});

test("buildContext returns all messages when no compaction exists", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev1" }));
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev2", text: "second" }));

    const ctx = await ledger.buildContext("slack", key);
    assert.ok(ctx);
    assert.equal(ctx.summary, null);
    assert.equal(ctx.messages.length, 2);
    assert.deepEqual(ctx.messages.map((m) => m.seq), [1, 2]);
  });
});

test("buildContext returns post-checkpoint messages ordered by seq after compaction", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev1" }));
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev2", text: "second" }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    await ledger.finishRun("slack", key, started.run.id, "done");
    await ledger.compact("slack", key, "first two messages summarized", 2);

    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev3", text: "third" }));

    const ctx = await ledger.buildContext("slack", key);
    assert.ok(ctx);
    assert.equal(ctx.summary, "first two messages summarized");
    assert.deepEqual(ctx.recentUserMessages.map((message) => message.seq), [1, 2]);
    assert.equal(ctx.messages.length, 1);
    assert.equal(ctx.messages[0]?.seq, 3);
    assert.equal(ctx.messages[0]?.text, "third");
  });
});

test("buildContext retains recent raw user messages alongside checkpoint summary", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:retention";
    for (let index = 1; index <= 4; index += 1) {
      await ledger.recordMessage(slackMessage({
        conversationKey: key,
        externalMessageId: `Ev${index}`,
        text: `message ${index}`
      }));
    }
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    await ledger.finishRun("slack", key, started.run.id, "done");
    await ledger.compact("slack", key, "first four messages summarized", 4);
    await ledger.recordMessage(slackMessage({
      conversationKey: key,
      externalMessageId: "Ev5",
      text: "after checkpoint"
    }));

    const previousLimit = process.env.SLACK_RECENT_USER_MESSAGE_TOKEN_LIMIT;
    process.env.SLACK_RECENT_USER_MESSAGE_TOKEN_LIMIT = "18";
    try {
      const ctx = await ledger.buildContext("slack", key);
      assert.ok(ctx);
      assert.equal(ctx.summary, "first four messages summarized");
      assert.deepEqual(ctx.recentUserMessages.map((message) => message.text), ["message 3", "message 4"]);
      assert.deepEqual(ctx.messages.map((message) => message.text), ["after checkpoint"]);
    } finally {
      if (previousLimit == null) delete process.env.SLACK_RECENT_USER_MESSAGE_TOKEN_LIMIT;
      else process.env.SLACK_RECENT_USER_MESSAGE_TOKEN_LIMIT = previousLimit;
    }
  });
});

test("pending messages survive compaction and appear in buildContext", async () => {
  await withLedger(async (ledger) => {
    const key = "thread:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev1" }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    // Ev2 arrives during the run — it is pending, not consumed by this run
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev2", text: "pending" }));
    await ledger.finishRun("slack", key, started.run.id, "done");

    // lastConsumedSeq = 1, so upToSeq=1 is the maximum valid compaction
    await ledger.compact("slack", key, "first message summarized", 1);

    const ctx = await ledger.buildContext("slack", key);
    assert.ok(ctx);
    assert.equal(ctx.summary, "first message summarized");
    assert.equal(ctx.recentUserMessages.length, 1);
    assert.equal(ctx.recentUserMessages[0]?.text, "rename the repo");
    assert.equal(ctx.messages.length, 1);
    assert.equal(ctx.messages[0]?.text, "pending");
    assert.equal(ctx.messages[0]?.seq, 2);
  });
});

test("buildContext returns null for an unknown conversation", async () => {
  await withLedger(async (ledger) => {
    const ctx = await ledger.buildContext("slack", "thread:C0:no-such-key");
    assert.equal(ctx, null);
  });
});

test("rejects direct lifecycle status mutations other than the legacy stop entrypoint", async () => {
  await withLedger(async (ledger) => {
    const key = "slack:T1:C123:lifecycle-authority";
    await ledger.recordMessage(slackMessage({ conversationKey: key }));

    await assert.rejects(
      ledger.setConversationStatus("slack", key, "running"),
      /Direct conversation status transitions are not supported/
    );
    const conversation = await ledger.getConversation("slack", key);
    assert.equal(conversation?.status, "queued");
    assert.equal(conversation?.activeRunId, null);
  });
});

test("buildBoundedContext keeps the current request and enforces a hard budget", async () => {
  await withLedger(async (ledger) => {
    const runtime = new ConversationRuntime(new ConversationEngine({ ledger }));
    const key = "thread:C123:bounded-context";
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev1", text: "first request" }));
    const first = await ledger.startRun("slack", key);
    assert.ok(first);
    await ledger.finishRun("slack", key, first.run.id, "done");
    await ledger.compact("slack", key, "a long durable summary that must be truncated before current work", 1);
    await ledger.recordMessage(slackMessage({
      conversationKey: key,
      externalMessageId: "Ev2",
      text: "current request"
    }));
    const second = await ledger.startRun("slack", key);
    assert.ok(second);

    const context = await runtime.buildBoundedContext("slack", key, second.run.id, 15);
    assert.ok(context);
    assert.ok(context.tokenCount <= context.maxTokens);
    assert.deepEqual(context.messages.map((message) => message.text), ["current request"]);
    assert.equal(context.truncated, true);

    await assert.rejects(
      runtime.buildBoundedContext("slack", key, second.run.id, 14),
      ContextBudgetExceededError
    );
    await assert.rejects(
      runtime.buildBoundedContext("slack", key, second.run.id, 15, 1),
      ContextBudgetExceededError,
      "runtime-owned input reservations reduce the durable conversation budget"
    );
  });
});

test("startRun refuses a second active run for the same conversation", async () => {
  await withLedger(async (ledger) => {
    const key = "slack:T1:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev1" }));
    const first = await ledger.startRun("slack", key);
    assert.ok(first);
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev2", text: "steer" }));
    const second = await ledger.startRun("slack", key);
    assert.equal(second, null);
    const conv = await ledger.getConversation("slack", key);
    assert.equal(conv?.activeRunId, first.run.id);
  });
});

test("non-actionable messages remain persisted but do not start a run", async () => {
  await withLedger(async (ledger) => {
    const key = "slack:T1:C123:ambient.1";
    const recorded = await ledger.recordMessage(slackMessage({ conversationKey: key, text: "yo" }));
    const marked = await ledger.markMessagesNonActionable("slack", key, [recorded.message.id]);
    assert.ok(marked);
    assert.equal(marked.status, "done");
    assert.equal(marked.messages[0]?.metadata.nonActionable, true);
    assert.equal(await ledger.startRun("slack", key), null);
    const runnable = await ledger.runnableConversations("slack");
    assert.equal(runnable.length, 0);
    const conv = await ledger.getConversation("slack", key);
    assert.equal(conv?.messages.length, 1);
    assert.equal(conv?.messages[0]?.text, "yo");
  });
});

test("recordAssistantMessage appends assistant output without claiming a run", async () => {
  await withLedger(async (ledger) => {
    const key = "slack:T1:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    const assistant = await ledger.recordAssistantMessage({
      channel: "slack",
      conversationKey: key,
      text: "working on it",
      runId: started.run.id
    });
    assert.ok(assistant);
    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.seq, 2);
    const finished = await ledger.finishRun("slack", key, started.run.id, "done");
    assert.ok(finished);
    assert.equal(finished.hasPendingMessages, false);
    const conv = await ledger.getConversation("slack", key);
    assert.deepEqual(conv?.messages.map((message) => message.role), ["user", "assistant"]);
  });
});

test("message roles survive close and reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-ledger-assistant-backfill-test-"));
  const dbPath = path.join(dir, "tasks.sqlite");
  try {
    const ledger = new SQLiteTaskLedger({ filePath: dbPath });
    const key = "email:gmail:thread-1";
    await ledger.recordMessage(slackMessage({
      channel: "email",
      conversationKey: key,
      externalMessageId: "email-1",
      authorId: "person@example.com",
      text: "hello"
    }));
    const started = await ledger.startRun("email", key);
    assert.ok(started);
    await ledger.recordAssistantMessage({
      channel: "email",
      conversationKey: key,
      text: "reply",
      runId: started.run.id
    });
    ledger.close();

    const reopened = new SQLiteTaskLedger({ filePath: dbPath });
    try {
      const conversation = await reopened.getConversation("email", key);
      assert.deepEqual(conversation?.messages.map((message) => message.role), ["user", "assistant"]);
      assert.equal(conversation?.messages[0]?.text, "hello");
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compact rejects regressing the checkpoint", async () => {
  await withLedger(async (ledger) => {
    const key = "slack:T1:C123:1000.000100";
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev1" }));
    await ledger.recordMessage(slackMessage({ conversationKey: key, externalMessageId: "Ev2", text: "two" }));
    const started = await ledger.startRun("slack", key);
    assert.ok(started);
    await ledger.finishRun("slack", key, started.run.id, "done");
    await ledger.compact("slack", key, "first checkpoint", 2);
    await assert.rejects(
      () => ledger.compact("slack", key, "regress", 1),
      /compaction already covers/
    );
  });
});

test("schema migration backfills seq and adds new columns to an existing database", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-ledger-migration-test-"));
  try {
    const dbPath = path.join(dir, "tasks.sqlite");

    // Build a database with the original schema, before the new columns were added.
    {
      const oldDb = new DatabaseSync(dbPath);
      try {
        oldDb.exec(`
          PRAGMA journal_mode = WAL;
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
            metadata_json TEXT NOT NULL,
            FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
          );
          CREATE TABLE runs (
            id TEXT PRIMARY KEY,
            channel TEXT NOT NULL,
            conversation_key TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT,
            error TEXT,
            FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
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
            created_at TEXT NOT NULL,
            FOREIGN KEY(channel, conversation_key) REFERENCES conversations(channel, conversation_key) ON DELETE CASCADE
          );
        `);
        oldDb.prepare(`
          INSERT INTO conversations
            (channel, conversation_key, id, title, status, created_at, updated_at, last_error,
             reply_target_json, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `).run("slack", "thread:pre-migration", "conv-pre", "old task", "queued",
               "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "null", "{}");
        oldDb.prepare(`
          INSERT INTO messages
            (id, channel, conversation_key, external_message_id, author_id, text,
             received_at, run_id, metadata_json)
          VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?)
        `).run("msg-pre", "slack", "thread:pre-migration", "ext-pre",
               "old message", "2026-01-01T00:00:00.000Z", "{}");
        oldDb.prepare(`
          INSERT INTO communication_events
            (id, channel, conversation_key, direction, kind, external_event_id, actor_id, text,
             occurred_at, run_id, task_message_id, metadata_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
        `).run("evt-pre", "slack", "thread:pre-migration", "outbound", "skip", null, "B1",
               "no reply requested", "2026-01-01T00:00:01.000Z", "{}", "2026-01-01T00:00:01.000Z");
      } finally {
        oldDb.close();
      }
    }

    // Open via SQLiteTaskLedger — this triggers migration 1.
    const ledger = new SQLiteTaskLedger({ filePath: dbPath });
    try {
      // The pre-existing message should have been backfilled to seq=1.
      // A new message added here should receive seq=2.
      const result = await ledger.recordMessage({
        channel: "slack",
        conversationKey: "thread:pre-migration",
        externalMessageId: "ext-new",
        authorId: "U1",
        text: "post-migration message"
      });

      assert.equal(result.message.seq, 2, "new message gets seq after backfilled rows");
      assert.equal(result.message.role, "user");
      assert.equal(result.disposition, "queued_update");

      const conv = await ledger.getConversation("slack", "thread:pre-migration");
      assert.ok(conv);
      assert.equal(conv.messages.length, 2);
      assert.equal(conv.messages[0]?.seq, 1, "pre-migration message backfilled to seq=1");
      assert.equal(conv.messages[0]?.role, "user", "pre-migration message role defaults to user");
      assert.equal(conv.activeRunId, null);
      assert.equal(conv.compactionSeq, null);
      assert.equal(conv.compactionSummary, null, "migration 2 adds compaction_summary defaulting to null");
    } finally {
      ledger.close();
    }

    // Confirm every migration applied, including run ownership and lifecycle audit.
    const verifyDb = new DatabaseSync(dbPath);
    try {
      for (let version = 1; version <= 27; version += 1) {
        const migration = verifyDb.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version);
        assert.ok(migration != null, `schema_migrations should contain version ${version}`);
      }
      const journalMode = verifyDb.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      assert.equal(journalMode.journal_mode.toLowerCase(), "wal", "legacy databases preserve WAL when opened by the ledger");
      const runColumns = verifyDb.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
      const runColumnNames = runColumns.map((column) => column.name);
      assert.deepEqual(
        runColumnNames.filter((name) => ["worker_instance_id", "lease_expires_at"].includes(name)),
        ["worker_instance_id", "lease_expires_at"],
        "a run lease is one durable owner and one expiry"
      );
      assert.deepEqual(
        runColumnNames.filter((name) => ["owner_id", "owner_pid", "owner_started_at", "lease_id", "heartbeat_at", "fencing_token"].includes(name)),
        [],
        "legacy ownership machinery columns are dropped"
      );
      assert.ok(verifyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lifecycle_events'").get());
      assert.equal(
        verifyDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'communication_events'").get(),
        undefined,
        "messages are the single durable conversation record"
      );
      const archived = verifyDb.prepare("SELECT id, kind, text FROM communication_events_archive").all() as Array<{ id: string; kind: string; text: string }>;
      assert.equal(archived.length, 1, "historical communication events are archived, not destroyed");
      assert.equal(archived[0]?.id, "evt-pre");
      assert.equal(archived[0]?.kind, "skip");
      assert.equal(archived[0]?.text, "no reply requested");
      const deliveryColumnNames = (verifyDb.prepare("PRAGMA table_info(outbound_deliveries)").all() as Array<{ name: string }>).map((column) => column.name);
      assert.deepEqual(
        deliveryColumnNames.filter((name) => ["task_id", "task_result"].includes(name)),
        [],
        "deliveries carry no per-run task mirror"
      );
      const deliveryColumns = verifyDb.prepare("PRAGMA table_info(outbound_deliveries)").all() as Array<{ name: string }>;
      assert.ok(deliveryColumns.some((column) => column.name === "acceptance_unknown_at"));
      const deliverySchema = verifyDb.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'outbound_deliveries'").get() as { sql: string };
      assert.match(deliverySchema.sql, /'acceptance_unknown'/);
    } finally {
      verifyDb.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repair tasks deduplicate active work by tool and preserve lifecycle", async () => {
  await withLedger(async (ledger) => {
    const created = await ledger.upsertRepairTask({
      toolId: "local:gws",
      objective: "restore gws health",
      progress: "token invalid",
      nextAction: "example-agent repair"
    });
    const updated = await ledger.upsertRepairTask({
      toolId: "local:gws",
      objective: "ignored while repair is active",
      progress: "still failing"
    });
    assert.equal(updated.id, created.id);
    assert.equal(updated.objective, "restore gws health");
    assert.equal(updated.progress, "still failing");
    assert.equal((await ledger.startRepairTask(created.id)).status, "in_progress");
    assert.equal((await ledger.completeRepairTask(created.id, "registry check passed")).status, "completed");
    assert.equal(await ledger.activeRepairTaskForTool("local:gws"), null);
    const reopened = await ledger.upsertRepairTask({ toolId: "local:gws", objective: "new failure" });
    assert.notEqual(reopened.id, created.id);
    assert.equal((await ledger.unfinishedRepairTasks()).length, 1);
  });
});

test("deployment lifecycle preserves intake while preventing new runs until normal resumes", async () => {
  await withLedger(async (ledger) => {
    const activeKey = "thread:C123:deployment-active";
    const queuedKey = "thread:C123:deployment-queued";
    const activeIntake = await ledger.recordMessage(slackMessage({
      conversationKey: activeKey,
      externalMessageId: "deployment-active-message"
    }));
    const activeRun = await ledger.startRun("slack", activeKey);
    assert.ok(activeRun, "an existing run starts while deployment state is normal");

    const draining = await ledger.setDeploymentLifecycle("draining");
    assert.equal(draining.state, "draining");
    assert.equal((await ledger.deploymentLifecycle()).state, "draining");

    const queuedIntake = await ledger.recordMessage(slackMessage({
      conversationKey: queuedKey,
      externalMessageId: "deployment-queued-message"
    }));
    assert.equal(queuedIntake.conversation.status, "queued", "inbound work remains durable during drain");
    assert.equal(await ledger.startRun("slack", queuedKey), null, "draining rejects new execution starts");
    assert.equal((await ledger.getConversation("slack", queuedKey))?.messages.length, 1, "draining does not discard inbound work");
    assert.equal((await ledger.snapshot()).running, 1, "the active run remains visible while draining");

    const finished = await ledger.finishRun("slack", activeKey, activeRun.run.id, "done");
    assert.ok(finished, "an existing run can finish during drain");
    assert.equal((await ledger.snapshot()).running, 0, "the ledger becomes idle only after the active run finishes");

    for (const state of ["deploying", "restarting"] as const) {
      await ledger.setDeploymentLifecycle(state);
      assert.equal(await ledger.startRun("slack", queuedKey), null, `${state} rejects new execution starts`);
    }

    const normal = await ledger.setDeploymentLifecycle("normal");
    assert.equal(normal.state, "normal");
    assert.ok(await ledger.startRun("slack", queuedKey), "queued work resumes once deployment admission returns to normal");
    assert.equal(activeIntake.conversation.id.length > 0, true);
  });
});

test("subagent runs are durable, drain-aware, and clear after completion", async () => {
  await withLedger(async (ledger) => {
    const first = await ledger.startSubagentRun("subagent-1", "example-agent");
    assert.ok(first);
    assert.equal((await ledger.activeSubagentRuns()).length, 1);

    await ledger.setDeploymentLifecycle("draining");
    assert.equal(await ledger.startSubagentRun("subagent-2", "example-agent"), null, "draining rejects new subagent execution");
    assert.equal((await ledger.activeSubagentRuns()).length, 1, "an active subagent remains visible during drain");

    await ledger.finishSubagentRun("subagent-1");
    assert.deepEqual(await ledger.activeSubagentRuns(), [], "finished subagents no longer block deployment");
  });
});

test("reconciles an orphaned subagent run after its lease expires", async () => {
  let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  await withLedger(async (_ledger, dir) => {
    const filePath = path.join(dir, "orphaned-subagent.sqlite");
    const ledger = new SQLiteTaskLedger({
      filePath,
      now: () => new Date(nowMs),
      subagentLeaseMs: 1000,
      subagentProcessStartedAt: () => null,
      subagentProcessExists: () => false
    });
    try {
      assert.ok(await ledger.startSubagentRun("orphaned-subagent", "example-agent", 4242, "owner-start-a"));
      nowMs += 1001;

      assert.deepEqual(await ledger.activeSubagentRuns(), [], "an unrenewed run is no longer considered active after lease expiry");
      assert.equal(await ledger.heartbeatSubagentRun("orphaned-subagent"), false, "reconciliation closes the stale unfinished row");

      const db = new DatabaseSync(filePath);
      try {
        const row = db.prepare("SELECT finished_at AS finishedAt FROM subagent_runs WHERE id = ?").get("orphaned-subagent") as { finishedAt: string | null };
        assert.ok(row.finishedAt, "reconciliation persists the orphaned run completion");
      } finally {
        db.close();
      }
    } finally {
      ledger.close();
    }
  });
});

test("pid reuse cannot keep stale subagent work active", async () => {
  let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  let observedStart: string | null = "owner-start-a";
  let processExists = true;
  await withLedger(async (_ledger, dir) => {
    const ledger = new SQLiteTaskLedger({
      filePath: path.join(dir, "pid-reuse.sqlite"),
      now: () => new Date(nowMs),
      subagentLeaseMs: 1000,
      subagentProcessStartedAt: () => observedStart,
      subagentProcessExists: () => processExists
    });
    try {
      assert.ok(await ledger.startSubagentRun("reused-pid", "example-agent", 4242, "owner-start-a"));
      nowMs += 1001;
      assert.equal((await ledger.activeSubagentRuns()).length, 1, "the original process identity remains active");

      observedStart = null;
      assert.equal((await ledger.activeSubagentRuns()).length, 1, "an identity lookup failure fails closed while the pid still exists");

      observedStart = "owner-start-b";
      assert.deepEqual(await ledger.activeSubagentRuns(), [], "the same pid with a new process identity is reconciled as stale");
    } finally {
      ledger.close();
    }
  });
});

test("an expired lease never reconciles a live subagent process", async () => {
  let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const childPid = child.pid;
  assert.ok(childPid);
  try {
    await withLedger(async (_ledger, dir) => {
      const ledger = new SQLiteTaskLedger({
        filePath: path.join(dir, "live-subagent.sqlite"),
        now: () => new Date(nowMs),
        subagentLeaseMs: 1000
      });
      try {
        assert.ok(await ledger.startSubagentRun("live-subagent", "example-agent", childPid));
        nowMs += 1001;
        assert.equal((await ledger.activeSubagentRuns()).length, 1, "a live owner keeps work active after its lease expires");

        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
        assert.deepEqual(await ledger.activeSubagentRuns(), [], "a dead owner is reconciled after lease expiry");
      } finally {
        ledger.close();
      }
    });
  } finally {
    if (!child.killed) child.kill("SIGKILL");
  }
});

test("a subagent heartbeat renews its lease before stale-run reconciliation", async () => {
  let nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
  await withLedger(async (_ledger, dir) => {
    const ledger = new SQLiteTaskLedger({
      filePath: path.join(dir, "subagent-heartbeat.sqlite"),
      now: () => new Date(nowMs),
      subagentLeaseMs: 1000,
      subagentProcessStartedAt: () => null,
      subagentProcessExists: () => false
    });
    try {
      assert.ok(await ledger.startSubagentRun("live-subagent", "example-agent", 4242, "owner-start-a"));
      nowMs += 900;
      assert.equal(await ledger.heartbeatSubagentRun("live-subagent"), true);
      nowMs += 600;
      assert.equal((await ledger.activeSubagentRuns()).length, 1, "a renewed lease keeps a live subagent active");
    } finally {
      ledger.close();
    }
  });
});

test("migration preserves legacy active work and prevents active rows without a lease", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-ledger-legacy-subagent-"));
  const filePath = path.join(dir, "tasks.sqlite");
  const db = new DatabaseSync(filePath);
  try {
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations (version, applied_at)
      VALUES (1, '2026-01-01T00:00:00.000Z'), (2, '2026-01-01T00:00:00.000Z'),
        (3, '2026-01-01T00:00:00.000Z'), (4, '2026-01-01T00:00:00.000Z'),
        (5, '2026-01-01T00:00:00.000Z'), (6, '2026-01-01T00:00:00.000Z'),
        (7, '2026-01-01T00:00:00.000Z');
      CREATE TABLE deployment_lifecycle (id INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO deployment_lifecycle VALUES (1, 'normal', '2026-01-01T00:00:00.000Z');
      CREATE TABLE subagent_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        lease_expires_at TEXT
      );
      INSERT INTO subagent_runs VALUES ('legacy-live', 'example-agent', '2026-01-01T00:00:00.000Z', NULL, NULL);
    `);
  } finally {
    db.close();
  }

  let nowMs = Date.now();
  let legacyRunnerAlive = true;
  const ledger = new SQLiteTaskLedger({
    filePath,
    now: () => new Date(nowMs),
    subagentProcessStartedAt: () => null,
    isLegacySubagentProcessAlive: () => legacyRunnerAlive
  });
  try {
    const legacy = await ledger.activeSubagentRuns();
    assert.equal(legacy.length, 1, "an active worker from before owner tracking remains protected during upgrade");
    const verify = new DatabaseSync(filePath);
    try {
      const row = verify.prepare("SELECT lease_expires_at AS leaseExpiresAt, owner_pid AS ownerPid, owner_started_at AS ownerStartedAt FROM subagent_runs WHERE id = 'legacy-live'").get() as { leaseExpiresAt: string | null; ownerPid: number | null; ownerStartedAt: string | null };
      assert.ok(row.leaseExpiresAt, "migration backfills a non-null lease for legacy active work");
      assert.equal(row.ownerPid, null, "legacy work is explicitly distinguished from pid-tracked work");
      assert.equal(row.ownerStartedAt, null, "legacy work remains compatible without fabricated process identity");
      verify.prepare("INSERT INTO subagent_runs (id, name, started_at, finished_at) VALUES ('mixed-version', 'example-agent', ?, NULL)").run(new Date(nowMs).toISOString());
      const mixed = verify.prepare("SELECT lease_expires_at AS leaseExpiresAt FROM subagent_runs WHERE id = 'mixed-version'").get() as { leaseExpiresAt: string | null };
      assert.ok(mixed.leaseExpiresAt, "the compatibility trigger prevents a mixed-version insert from leaving an active null-lease row");
    } finally {
      verify.close();
    }
    nowMs += 31 * 60 * 1000;
    assert.equal((await ledger.activeSubagentRuns()).length, 2, "a matching legacy runner keeps live pre-upgrade work protected after its lease expires");
    legacyRunnerAlive = false;
    assert.deepEqual(await ledger.activeSubagentRuns(), [], "a legacy orphan is reconciled once no matching old runner remains");
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("converges a pre-merge Step 5 migration history with mainline subagent ownership", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "task-ledger-step5-merge-history-"));
  const filePath = path.join(dir, "tasks.sqlite");
  const db = new DatabaseSync(filePath);
  try {
    db.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE subagent_runs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);
    for (let version = 1; version <= 13; version += 1) {
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(version, "2026-01-01T00:00:00.000Z");
    }
    db.prepare("INSERT INTO subagent_runs (id, name, started_at, finished_at) VALUES (?, ?, ?, NULL)")
      .run("pre-merge-step5", "example-agent", "2026-01-01T00:00:00.000Z");
  } finally {
    db.close();
  }

  const ledger = new SQLiteTaskLedger({ filePath, isLegacySubagentProcessAlive: () => true });
  try {
    const active = await ledger.activeSubagentRuns();
    assert.equal(active.length, 1, "the legacy active run remains protected during convergence");
    assert.ok(active[0]?.leaseExpiresAt, "convergence supplies the missing lease");
    const verify = new DatabaseSync(filePath);
    try {
      const columns = verify.prepare("PRAGMA table_info(subagent_runs)").all() as Array<{ name: string }>;
      assert.deepEqual(
        columns.map((column) => column.name).filter((name) => ["lease_expires_at", "owner_pid", "owner_started_at"].includes(name)),
        ["lease_expires_at", "owner_pid", "owner_started_at"]
      );
      assert.ok(verify.prepare("SELECT version FROM schema_migrations WHERE version = 17").get());
    } finally {
      verify.close();
    }
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function createPendingOutboundDelivery(
  ledger: SQLiteTaskLedger,
  key = "slack:T1:C123:1000.000100"
) {
  const recorded = await ledger.recordMessage(slackMessage({ conversationKey: key }));
  const started = await ledger.startRun("slack", key);
  assert.ok(started);
  const delivery = await ledger.createOutboundDelivery({
    channel: "slack",
    conversationKey: key,
    runId: started.run.id,
    provider: "slack",
    idempotencyKey: `delivery:${key}`,
    payload: { channel: "C123", threadTs: "1000.000100", text: "Repository renamed." },
    assistantMessage: {
      text: "Repository renamed.",
      authorId: "B1",
      metadata: { provider: "slack", surface: "thread" }
    }
  });
  return { recorded, started, delivery };
}

test("stop terminally cancels an undelivered intent and recovery cannot replay it", async () => {
  await withLedger(async (ledger) => {
    const key = "slack:T1:C123:stop-delivery";
    const { delivery } = await createPendingOutboundDelivery(ledger, key);

    const stopped = await ledger.stopConversation("slack", key, "user_stop");
    const deliveries = await ledger.outboundDeliveries("slack", key);
    assert.equal(stopped?.status, "stopped");
    assert.equal(deliveries[0]?.status, "cancelled");
    assert.equal(deliveries[0]?.error, "user_stop");
    assert.equal(await ledger.pendingOutboundDelivery("slack", key), null);
    assert.equal(await ledger.recoverableOutboundDelivery("slack", key), null);
    await assert.rejects(
      ledger.startOutboundDeliveryAttempt(delivery.id),
      /from cancelled/
    );
    const recoveryResults = await Promise.all([
      ledger.recoverInterruptedRuns("slack"),
      ledger.recoverInterruptedRuns("slack")
    ]);
    assert.deepEqual(recoveryResults, [{
      recoveredKeys: [],
      runnableKeys: []
    }, {
      recoveredKeys: [],
      runnableKeys: []
    }]);

    await ledger.recordMessage(slackMessage({
      conversationKey: key,
      externalMessageId: "message-after-stop",
      text: "fresh request"
    }));
    const restarted = await ledger.startRun("slack", key);
    assert.ok(restarted);
    assert.deepEqual(restarted.messages.map((message) => message.text), ["fresh request"]);
  });
});

test("stop cancels dispatch admission before provider acceptance and restart recovery cannot revive it", async () => {
  await withLedger(async (ledger, dir) => {
    const key = "slack:T1:C123:stop-dispatch-before-provider";
    const { started, delivery } = await createPendingOutboundDelivery(ledger, key);
    assert.equal((await ledger.beginOutboundDeliveryDispatch(delivery.id, started.run.id)).status, "dispatching");

    await ledger.stopConversation("slack", key, "user_stop");
    assert.equal((await ledger.outboundDeliveries("slack", key))[0]?.status, "cancelled");
    assert.deepEqual(await ledger.recoverInterruptedRuns("slack"), {
      recoveredKeys: [],
      runnableKeys: []
    });
    await assert.rejects(
      ledger.assertOutboundDeliveryDispatchable(delivery.id, started.run.id),
      /from cancelled/
    );
    ledger.close();

    const restarted = new SQLiteTaskLedger({
      filePath: path.join(dir, "tasks.sqlite"),
      runProcessStartedAt: () => null,
      runProcessExists: () => false
    });
    try {
      assert.equal((await restarted.outboundDeliveries("slack", key))[0]?.status, "cancelled");
      assert.deepEqual(await Promise.all([
        restarted.recoverInterruptedRuns("slack"),
        restarted.recoverInterruptedRuns("slack")
      ]), [{ recoveredKeys: [], runnableKeys: [] }, { recoveredKeys: [], runnableKeys: [] }]);
    } finally {
      restarted.close();
    }
  });
});

test("a stop from a second ledger instance fences a provider-call admission and finalizes after release", async () => {
  await withLedger(async (ledger, dir) => {
    const key = "slack:T1:C123:cross-process-stop-fence";
    const { started, delivery } = await createPendingOutboundDelivery(ledger, key);
    await ledger.beginOutboundDeliveryDispatch(delivery.id, started.run.id);
    await ledger.assertOutboundDeliveryDispatchable(delivery.id, started.run.id);
    const secondWorker = new SQLiteTaskLedger({
      filePath: path.join(dir, "tasks.sqlite"), runProcessStartedAt: () => null, runProcessExists: () => false
    });
    try {
      const requested = await secondWorker.stopConversation("slack", key, "user_stop");
      assert.equal(requested?.status, "running", "terminal stop waits for the admitted provider call");
      await assert.rejects(ledger.assertOutboundDeliveryDispatchable(delivery.id, started.run.id), /inactive run/);
      await ledger.releaseOutboundDeliveryDispatch(delivery.id);
      assert.equal((await secondWorker.outboundDeliveries("slack", key))[0]?.status, "cancelled");
      assert.equal((await secondWorker.getConversation("slack", key))?.status, "stopped");
      assert.deepEqual(await secondWorker.recoverInterruptedRuns("slack"), { recoveredKeys: [], runnableKeys: [] });
    } finally { secondWorker.close(); }
  });
});

test("a durably accepted provider effect confirms after stop without reopening the conversation", async () => {
  await withLedger(async (ledger) => {
    const key = "slack:T1:C123:stop-dispatch";
    const { started, delivery } = await createPendingOutboundDelivery(ledger, key);
    const dispatch = await ledger.beginOutboundDeliveryDispatch(delivery.id, started.run.id);
    assert.equal(dispatch.status, "dispatching");
    const accepted = await ledger.markOutboundDeliveryProviderAccepted(
      delivery.id,
      started.run.id,
      { providerMessageId: "reply-after-stop" }
    );
    assert.equal(accepted.status, "provider_accepted");

    await ledger.stopConversation("slack", key, "user_stop");
    const confirmed = await ledger.confirmOutboundDelivery({
      deliveryId: delivery.id,
      runId: started.run.id,
      providerReceipt: { providerMessageId: "reply-after-stop" }
    });
    const conversation = await ledger.getConversation("slack", key);

    assert.equal(confirmed.delivery.status, "delivered");
    assert.equal(conversation?.status, "stopped");
    assert.deepEqual(conversation?.messages.map((message) => message.role), ["user", "assistant"]);
  });
});

test("a durably provider-accepted delivery survives restart and confirms without replaying provider work", async () => {
  await withLedger(async (ledger, dir) => {
    const key = "slack:T1:C123:provider-accepted-restart";
    const { started, delivery } = await createPendingOutboundDelivery(ledger, key);
    await ledger.beginOutboundDeliveryDispatch(delivery.id, started.run.id);
    const accepted = await ledger.markOutboundDeliveryProviderAccepted(
      delivery.id,
      started.run.id,
      { providerMessageId: "accepted-before-crash" }
    );
    assert.equal(accepted.status, "provider_accepted");
    ledger.close();

    const restarted = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
    try {
      restarted.assertAuthoritativeDurability();
      const persisted = await restarted.outboundDeliveries("slack", key);
      assert.equal(persisted[0]?.status, "provider_accepted");
      const confirmed = await restarted.confirmOutboundDelivery({
        deliveryId: delivery.id,
        runId: started.run.id,
        providerReceipt: { providerMessageId: "accepted-before-crash" }
      });
      assert.equal(confirmed.delivery.status, "delivered");
      assert.deepEqual(
        (await restarted.getConversation("slack", key))?.messages.map((message) => message.role),
        ["user", "assistant"]
      );
    } finally {
      restarted.close();
    }
  });
});

test("persists a pending outbound delivery outside model-visible message history", async () => {
  await withLedger(async (ledger) => {
    const { delivery } = await createPendingOutboundDelivery(ledger);
    const pending = await ledger.pendingOutboundDelivery("slack", delivery.conversationKey);
    const conversation = await ledger.getConversation("slack", delivery.conversationKey);

    assert.deepEqual(pending, delivery);
    assert.equal(conversation?.messages.length, 1);
    assert.deepEqual(conversation?.messages.map((message) => message.role), ["user"]);

    pending!.payload.text = "mutated";
    const reread = await ledger.pendingOutboundDelivery("slack", delivery.conversationKey);
    assert.equal(reread?.payload.text, "Repository renamed.");
  });
});

test("pending outbound deliveries survive a ledger restart without entering history", async () => {
  await withLedger(async (ledger, dir) => {
    const { delivery } = await createPendingOutboundDelivery(ledger);
    ledger.close();

    const restarted = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
    try {
      const pending = await restarted.pendingOutboundDelivery("slack", delivery.conversationKey);
      const conversation = await restarted.getConversation("slack", delivery.conversationKey);
      assert.equal(pending?.id, delivery.id);
      assert.equal(pending?.status, "pending");
      assert.deepEqual(conversation?.messages.map((message) => message.role), ["user"]);
    } finally {
      restarted.close();
    }
  });
});

test("confirms delivery, assistant history, and run completion atomically", async () => {
  await withLedger(async (ledger) => {
    const { started, delivery } = await createPendingOutboundDelivery(ledger);
    const confirmed = await ledger.confirmOutboundDelivery({
      deliveryId: delivery.id,
      runId: started.run.id,
      providerReceipt: { providerMessageId: "slack-ts-1" }
    });
    const conversation = await ledger.getConversation("slack", delivery.conversationKey);
    const deliveries = await ledger.outboundDeliveries("slack", delivery.conversationKey);

    assert.equal(confirmed.delivery.status, "delivered");
    assert.deepEqual(confirmed.delivery.providerReceipt, { providerMessageId: "slack-ts-1" });
    assert.equal(confirmed.assistantMessage.text, "Repository renamed.");
    assert.equal(confirmed.finish.conversation.status, "done");
    assert.equal(await ledger.pendingOutboundDelivery("slack", delivery.conversationKey), null);
    assert.deepEqual(conversation?.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(conversation?.runs[0]?.status, "done");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.status, "delivered");
  });
});

test("persists engine lifecycle audit events through delivery confirmation", async () => {
  await withLedger(async (ledger) => {
    const { started, delivery } = await createPendingOutboundDelivery(ledger, "slack:T1:C123:lifecycle-audit");
    await ledger.confirmOutboundDelivery({
      deliveryId: delivery.id,
      runId: started.run.id,
      providerReceipt: { providerMessageId: "slack-ts-audit" }
    });

    const events = await ledger.lifecycleEvents("slack", delivery.conversationKey);
    assert.deepEqual(events.map((event) => event.kind), [
      "admitted",
      "run_started",
      "delivery_intended",
      "completed",
      "delivery_confirmed"
    ]);
    assert.deepEqual(events.at(-1)?.metadata, {
      deliveryId: delivery.id,
      provider: "slack",
      attemptCount: 1
    });
  });
});

test("rejects confirmation for an inactive run without leaking assistant history", async () => {
  await withLedger(async (ledger) => {
    const { delivery } = await createPendingOutboundDelivery(ledger);
    await assert.rejects(
      ledger.confirmOutboundDelivery({
        deliveryId: delivery.id,
        runId: "wrong-run",
        providerReceipt: { providerMessageId: "slack-ts-1" }
      }),
      /inactive run/
    );

    const conversation = await ledger.getConversation("slack", delivery.conversationKey);
    const persisted = await ledger.pendingOutboundDelivery("slack", delivery.conversationKey);
    assert.deepEqual(conversation?.messages.map((message) => message.role), ["user"]);
    assert.equal(persisted?.status, "pending");
  });
});

test("retains failed outbound delivery receipts without assistant history", async () => {
  await withLedger(async (ledger) => {
    const { delivery } = await createPendingOutboundDelivery(ledger);
    const failed = await ledger.failOutboundDelivery(
      delivery.id,
      "chat.postMessage failed: ratelimited",
      { error: "ratelimited" }
    );
    const conversation = await ledger.getConversation("slack", delivery.conversationKey);
    const deliveries = await ledger.outboundDeliveries("slack", delivery.conversationKey);

    assert.equal(failed.status, "failed");
    assert.equal(failed.error, "chat.postMessage failed: ratelimited");
    assert.deepEqual(failed.providerReceipt, { error: "ratelimited" });
    assert.equal(await ledger.pendingOutboundDelivery("slack", delivery.conversationKey), null);
    assert.deepEqual(conversation?.messages.map((message) => message.role), ["user"]);
    assert.equal(deliveries[0]?.status, "failed");
  });
});

test("persists each pending delivery retry attempt before a later transport call", async () => {
  await withLedger(async (ledger) => {
    const { delivery } = await createPendingOutboundDelivery(ledger);
    const retried = await ledger.startOutboundDeliveryAttempt(delivery.id);

    assert.equal(retried.status, "pending");
    assert.equal(retried.attemptCount, 2);
    assert.notEqual(retried.attemptedAt, delivery.attemptedAt);
  });
});

test("deduplicates delivery creation by provider idempotency key", async () => {
  await withLedger(async (ledger) => {
    const { started, delivery } = await createPendingOutboundDelivery(ledger);
    const repeated = await ledger.createOutboundDelivery({
      channel: "slack",
      conversationKey: delivery.conversationKey,
      runId: started.run.id,
      provider: "slack",
      idempotencyKey: delivery.idempotencyKey,
      payload: { channel: "C123", threadTs: "1000.000100", text: "different text" },
      assistantMessage: { text: "different text" }
    });

    assert.equal(repeated.id, delivery.id);
    assert.equal((await ledger.outboundDeliveries("slack", delivery.conversationKey)).length, 1);
  });
});

test("migrates settled outbound deliveries with their conversation key", async () => {
  await withLedger(async (ledger) => {
    const legacyKey = "thread:C123:1000.000100";
    const canonicalKey = "slack:T1:C123:1000.000100";
    const { started, delivery } = await createPendingOutboundDelivery(ledger, legacyKey);
    await ledger.confirmOutboundDelivery({
      deliveryId: delivery.id,
      runId: started.run.id,
      providerReceipt: { providerMessageId: "slack-ts-1" }
    });

    await ledger.migrateConversationKey("slack", legacyKey, canonicalKey);
    const migrated = await ledger.outboundDeliveries("slack", canonicalKey);

    assert.equal(migrated.length, 1);
    assert.equal(migrated[0]?.id, delivery.id);
    assert.equal(migrated[0]?.conversationKey, canonicalKey);
  });
});
