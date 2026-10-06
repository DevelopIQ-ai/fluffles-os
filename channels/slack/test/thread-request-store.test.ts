import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConversationEngine, SQLiteTaskLedger } from "@fluffles/tasks";
import test from "node:test";
import {
  SQLiteThreadRequestStore,
  SlackEventForRequest,
  formatMessagesForPrompt
} from "../src/thread-request-store";

function event(overrides: Partial<SlackEventForRequest> = {}): SlackEventForRequest {
  return {
    teamId: "T123",
    eventId: "Ev1",
    channel: "C123",
    channelType: "channel",
    user: "U123",
    ts: "1000.000100",
    threadTs: null,
    ...overrides
  };
}

async function withStore<T>(
  fn: (store: SQLiteThreadRequestStore, dir: string, ledger: SQLiteTaskLedger) => Promise<T>
): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "thread-request-store-test-"));
  let store: SQLiteThreadRequestStore | null = null;
  let ledger: SQLiteTaskLedger | null = null;
  try {
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
    const idFactory = () => `id-${tick++}`;
    ledger = new SQLiteTaskLedger({
      filePath: path.join(dir, "tasks.sqlite"),
      now,
      idFactory
    });
    store = new SQLiteThreadRequestStore({
      filePath: path.join(dir, "slack-transport.sqlite"),
      now,
      idFactory,
      engine: new ConversationEngine({ ledger })
    });
    return await fn(store, dir, ledger);
  } finally {
    store?.close();
    ledger?.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("records a new Slack thread request as queued in the central ledger", async () => {
  await withStore(async (store, _dir, ledger) => {
    const result = await store.recordMessage({
      key: "thread:C123:1000.000100",
      surface: "ambient",
      text: "rename the repo",
      event: event()
    });

    const conversation = await ledger.getConversation("slack", "thread:C123:1000.000100");
    assert.equal(result.disposition, "new_request");
    assert.equal(result.request.status, "queued");
    assert.equal(result.request.messages.length, 1);
    assert.equal(result.request.rootTs, "1000.000100");
    assert.equal(conversation?.status, "queued");
    assert.equal(conversation?.messages.length, 1);
  });
});

test("starting Slack work opens a durable run on the shared ledger", async () => {
  await withStore(async (store, _dir, ledger) => {
    const key = "thread:C123:1000.000200";
    await store.recordMessage({
      key,
      surface: "ambient",
      text: "rename the repo",
      event: event({ ts: "1000.000200" })
    });
    const started = await store.startRun(key);

    assert.ok(started);
    const conversation = await ledger.getConversation("slack", key);
    assert.equal(conversation?.status, "running");
    assert.equal(conversation?.activeRunId, started?.run.id);
    assert.equal(conversation?.runs[0]?.status, "running");
  });
});

test("migrates a legacy Slack thread key with its transport session", async () => {
  await withStore(async (store, _dir, ledger) => {
    const legacyKey = "thread:C123:1000.000100";
    const canonicalKey = "slack:T123:C123:1000.000100";
    await store.recordMessage({
      key: legacyKey,
      surface: "ambient",
      text: "rename the repo",
      event: event()
    });
    const started = await store.startRun(legacyKey);
    assert.ok(started);
    await store.finishRun(legacyKey, started.run.id, "done");
    await ledger.compact("slack", legacyKey, "legacy checkpoint", 1);
    await store.getOrCreateSession({
      key: legacyKey,
      channel: "C123",
      threadTs: "1000.000100",
      surface: "ambient",
      user: "U123"
    });
    await store.recordMessage({
      key: canonicalKey,
      surface: "ambient",
      text: "canonical history",
      event: event({ eventId: "Ev2", ts: "1000.000200" })
    });

    assert.equal(await store.migrateConversationKey(legacyKey, canonicalKey), true);
    assert.equal(await ledger.getConversation("slack", legacyKey), null);
    const migrated = await ledger.getConversation("slack", canonicalKey);
    assert.deepEqual(migrated?.messages.map((message) => message.text).sort(), ["canonical history", "rename the repo"]);
    assert.deepEqual(migrated?.runs.map((run) => run.status), ["done"]);
    assert.deepEqual((migrated?.metadata.migratedCheckpoints as Array<{ summary: string }>).map((checkpoint) => checkpoint.summary), ["legacy checkpoint"]);
    assert.equal(migrated?.messages.length, 2);
    assert.equal(await store.getSession(legacyKey), null);
    assert.equal((await store.getSession(canonicalKey))?.key, canonicalKey);

    await store.recordMessage({
      key: canonicalKey,
      surface: "ambient",
      text: "canonical follow-up",
      event: event({ eventId: "Ev3", ts: "1000.000300" })
    });
    assert.deepEqual((await ledger.getConversation("slack", canonicalKey))?.messages.map((message) => message.text).sort(), [
      "canonical follow-up",
      "canonical history",
      "rename the repo"
    ]);
  });
});

test("does not migrate an active Slack legacy conversation", async () => {
  await withStore(async (store) => {
    const legacyKey = "thread:C123:1000.000100";
    await store.recordMessage({
      key: legacyKey,
      surface: "ambient",
      text: "rename the repo",
      event: event()
    });
    assert.ok(await store.startRun(legacyKey));

    assert.equal(await store.migrateConversationKey(legacyKey, "slack:T123:C123:1000.000100"), false);
    assert.ok(await store.getRequest(legacyKey));
  });
});

test("transport database stores receipts and sessions, not operational request tables", async () => {
  await withStore(async (store, dir) => {
    await store.recordMessage({
      key: "thread:C123:1000.000100",
      surface: "ambient",
      text: "rename the repo",
      event: event()
    });
    store.close();

    const db = new DatabaseSync(path.join(dir, "slack-transport.sqlite"));
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map((row) => String((row as { name: unknown }).name));
    assert.deepEqual(tables, ["inbound_receipts", "ingress_checkpoints", "metadata", "sessions"]);
    } finally {
      db.close();
    }
  });
});

test("admission is atomic: filtered and stop messages cannot become runnable before their disposition", async () => {
  await withStore(async (store, _dir, ledger) => {
    const key = "slack:T123:C123:1000.000100";
    await store.recordMessage({
      key,
      surface: "ambient",
      text: "low intent ping",
      event: event(),
      admission: { actionable: false, reason: "low_intent" }
    });
    assert.equal(await store.startRun(key), null, "filtered intake is durable history but never runnable");

    await store.recordMessage({
      key,
      surface: "thread",
      text: "do the work",
      event: event({ eventId: "Ev2", ts: "1000.000200", threadTs: "1000.000100" }),
      admission: { actionable: true, controlText: "do the work" }
    });
    assert.ok(await store.startRun(key));

    const stopped = await store.recordMessage({
      key,
      surface: "thread",
      text: "stop",
      event: event({ eventId: "Ev3", ts: "1000.000300", threadTs: "1000.000100" }),
      admission: { actionable: true, controlText: "stop" }
    });
    assert.equal(stopped.request.status, "stopped");
    assert.equal((await ledger.getConversation("slack", key))?.status, "stopped");
    assert.equal(await store.startRun(key), null, "terminal stop leaves no runnable work");
  });
});

test("ingress checkpoints are durable and monotonic across replaying pollers", async () => {
  await withStore(async (store, dir, ledger) => {
    await Promise.all([
      store.advanceIngressCheckpoint("C123", "1000.000200"),
      store.advanceIngressCheckpoint("C123", "1000.000100"),
      store.advanceIngressCheckpoint("C123", "1000.000300")
    ]);
    assert.equal((await store.ingressCheckpoint("C123"))?.lastEventTs, "1000.000300");
    store.close();

    const reopened = new SQLiteThreadRequestStore({
      filePath: path.join(dir, "slack-transport.sqlite"),
      engine: new ConversationEngine({ ledger })
    });
    try {
      assert.equal((await reopened.ingressCheckpoint("C123"))?.lastEventTs, "1000.000300");
      await reopened.advanceIngressCheckpoint("C123", "999.999999");
      assert.equal((await reopened.ingressCheckpoint("C123"))?.lastEventTs, "1000.000300");
    } finally {
      reopened.close();
    }
  });
});

test("deduplicates Slack retries by provider message identity through the central ledger", async () => {
  await withStore(async (store, _dir, ledger) => {
    const input = {
      key: "thread:C123:1000.000100",
      surface: "ambient" as const,
      text: "same message",
      event: event()
    };

    await store.recordMessage(input);
    const duplicate = await store.recordMessage({
      ...input,
      event: event({ eventId: "Ev2" })
    });

    assert.equal(duplicate.disposition, "duplicate");
    assert.equal(duplicate.request.messages.length, 1);
    const conversation = await ledger.getConversation("slack", input.key);
    assert.equal(conversation?.messages[0]?.externalMessageId, "slack:T123:C123:1000.000100");
  });
});

test("deduplicates Slack retries by provider message identity when event id is absent", async () => {
  await withStore(async (store) => {
    const input = {
      key: "thread:C123:1000.000100",
      surface: "ambient" as const,
      text: "same message",
      event: event({ eventId: null })
    };

    await store.recordMessage(input);
    const duplicate = await store.recordMessage(input);

    assert.equal(duplicate.disposition, "duplicate");
    assert.equal(duplicate.request.messages.length, 1);
  });
});

test("does not deduplicate distinct Slack messages that share an event id", async () => {
  await withStore(async (store) => {
    const key = "thread:C123:1000.000100";
    await store.recordMessage({
      key,
      surface: "ambient",
      text: "first message",
      event: event()
    });
    const second = await store.recordMessage({
      key,
      surface: "thread",
      text: "second message",
      event: event({
        eventId: "Ev1",
        ts: "1000.000200",
        threadTs: "1000.000100"
      })
    });

    assert.notEqual(second.disposition, "duplicate");
    assert.equal(second.request.messages.length, 2);
  });
});

test("duplicate Slack retries do not create duplicate transport receipts", async () => {
  await withStore(async (store, dir) => {
    const input = {
      key: "thread:C123:1000.000100",
      surface: "ambient" as const,
      text: "same message",
      event: event()
    };

    await store.recordMessage(input);
    await store.recordMessage(input);
    store.close();

    const db = new DatabaseSync(path.join(dir, "slack-transport.sqlite"));
    try {
      const receiptCount = db.prepare("SELECT COUNT(*) AS count FROM inbound_receipts").get() as { count: number };
      assert.equal(receiptCount.count, 1);
    } finally {
      db.close();
    }
  });
});

test("a deployed event_receipts table folds into the shared inbound receipts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slack-receipt-migration-"));
  const filePath = path.join(dir, "slack-transport.sqlite");
  const ledger = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
  try {
    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      CREATE TABLE event_receipts (
        dedupe_key TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, message_id TEXT NOT NULL,
        event_id TEXT, channel TEXT NOT NULL, channel_type TEXT, user TEXT, ts TEXT NOT NULL,
        thread_ts TEXT, surface TEXT NOT NULL, text TEXT NOT NULL, received_at TEXT NOT NULL
      );
      INSERT INTO event_receipts VALUES (
        'slack:T123:C123:1000.000100', 'thread:C123:1000.000100', 'msg-1', 'Ev1', 'C123',
        'channel', 'U123', '1000.000100', NULL, 'ambient', 'rename the repo', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const store = new SQLiteThreadRequestStore({ filePath, engine: new ConversationEngine({ ledger }) });
    // A retry of the migrated event must still be deduplicated.
    await store.recordMessage({
      key: "thread:C123:1000.000100",
      surface: "ambient",
      text: "rename the repo",
      event: event()
    });
    store.close();

    const db = new DatabaseSync(filePath);
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_receipts'").get();
      assert.equal(tables, undefined);
      const rows = db.prepare("SELECT * FROM inbound_receipts").all() as Array<Record<string, unknown>>;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.provider, "slack");
      assert.equal(rows[0]?.provider_event_id, "slack:T123:C123:1000.000100");
      assert.equal(rows[0]?.task_conversation_key, "thread:C123:1000.000100");
      assert.equal(rows[0]?.received_at, "2026-01-01T00:00:00.000Z");
      assert.deepEqual(JSON.parse(String(rows[0]?.details_json)), {
        messageId: "msg-1",
        eventId: "Ev1",
        channel: "C123",
        channelType: "channel",
        user: "U123",
        ts: "1000.000100",
        threadTs: null,
        surface: "ambient",
        text: "rename the repo"
      });
    } finally {
      db.close();
    }
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Slack fold that fails midway rolls back completely and keeps event_receipts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slack-receipt-rollback-"));
  const filePath = path.join(dir, "slack-transport.sqlite");
  const ledger = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
  try {
    const legacy = new DatabaseSync(filePath);
    legacy.exec(`
      CREATE TABLE event_receipts (
        dedupe_key TEXT PRIMARY KEY, conversation_key TEXT NOT NULL, message_id TEXT NOT NULL,
        event_id TEXT, channel TEXT NOT NULL, channel_type TEXT, user TEXT, ts TEXT NOT NULL,
        thread_ts TEXT, surface TEXT NOT NULL, text TEXT NOT NULL, received_at TEXT NOT NULL
      );
      -- The canonical table rejects the fifth folded row, so the copy fails only
      -- after earlier rows are already written. Failing on the first row would
      -- hold whether or not the fold is transactional.
      CREATE TABLE inbound_receipts (
        provider TEXT NOT NULL, provider_event_id TEXT NOT NULL, action TEXT NOT NULL,
        details_json TEXT NOT NULL, task_conversation_key TEXT, task_disposition TEXT,
        error TEXT, received_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(provider, provider_event_id),
        CHECK (provider_event_id <> 'slack:T123:C123:1000.000500')
      );
    `);
    const legacyInsert = legacy.prepare(`
      INSERT INTO event_receipts VALUES (?, ?, ?, 'Ev', 'C123', 'channel', 'U123', ?, NULL, 'ambient', 'hi', '2026-01-01T00:00:00.000Z')
    `);
    for (let index = 1; index <= 10; index += 1) {
      const ts = `1000.000${index}00`;
      legacyInsert.run(`slack:T123:C123:${ts}`, `thread:C123:${ts}`, `msg-${index}`, ts);
    }
    legacy.close();

    const store = new SQLiteThreadRequestStore({ filePath, engine: new ConversationEngine({ ledger }) });
    // The database opens lazily, so the migration runs on the first access.
    await assert.rejects(() => store.getSession("thread:C123:1000.000100"));
    store.close();

    const db = new DatabaseSync(filePath);
    try {
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_receipts'").get();
      assert.notEqual(table, undefined);
      const count = db.prepare("SELECT COUNT(*) AS n FROM event_receipts").get() as { n: number };
      assert.equal(count.n, 10);
      const folded = db.prepare("SELECT COUNT(*) AS n FROM inbound_receipts").get() as { n: number };
      assert.equal(folded.n, 0, "a half-folded migration must roll back completely");
    } finally {
      db.close();
    }
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("central task state survives loss of Slack transport receipts", async () => {
  await withStore(async (store, dir, ledger) => {
    const transportPath = path.join(dir, "slack-transport.sqlite");
    const key = "thread:C123:1000.000100";
    await store.recordMessage({ key, surface: "ambient", text: "survive transport reset", event: event() });
    store.close();
    await rm(transportPath, { force: true });

    const reopened = new SQLiteThreadRequestStore({
      filePath: transportPath,
      engine: new ConversationEngine({ ledger })
    });
    try {
      const request = await reopened.getRequest(key);
      const started = await reopened.startRun(key);
      assert.equal(request?.messages[0]?.text, "survive transport reset");
      assert.ok(started);
      assert.equal(started.messages.length, 1);
    } finally {
      reopened.close();
    }
  });
});

test("serializes concurrent Slack intake into one central conversation", async () => {
  await withStore(async (store, dir, ledger) => {
    const key = "thread:C123:concurrent";
    const writes = Array.from({ length: 20 }, (_, index) => store.recordMessage({
      key,
      surface: index === 0 ? "ambient" : "thread",
      text: `update ${index}`,
      event: event({
        eventId: `Ev${index}`,
        ts: `1000.000${String(100 + index)}`,
        threadTs: index === 0 ? null : "1000.000100"
      })
    }));

    await Promise.all(writes);

    const conversation = await ledger.getConversation("slack", key);
    const started = await store.startRun(key);
    store.close();
    const db = new DatabaseSync(path.join(dir, "slack-transport.sqlite"));
    try {
      const receiptCount = db.prepare("SELECT COUNT(*) AS count FROM inbound_receipts").get() as { count: number };
      assert.equal(receiptCount.count, 20);
    } finally {
      db.close();
    }

    assert.equal(conversation?.messages.length, 20);
    assert.equal(started?.messages.length, 20);
  });
});

test("starts a run with all currently unhandled messages", async () => {
  await withStore(async (store) => {
    const key = "thread:C123:1000.000100";
    await store.recordMessage({ key, surface: "ambient", text: "first", event: event() });
    await store.recordMessage({
      key,
      surface: "thread",
      text: "second",
      event: event({ eventId: "Ev2", ts: "1000.000200", threadTs: "1000.000100" })
    });

    const started = await store.startRun(key);

    assert.ok(started);
    assert.equal(started.messages.length, 2);
    assert.match(started.promptText, /first/);
    assert.match(started.promptText, /second/);
    assert.equal(started.request.status, "running");
  });
});

test("finishes a run as done when no messages arrived during execution", async () => {
  await withStore(async (store) => {
    const key = "thread:C123:1000.000100";
    await store.recordMessage({ key, surface: "ambient", text: "first", event: event() });
    const started = await store.startRun(key);
    assert.ok(started);

    const finished = await store.finishRun(key, started.run.id, "done");

    assert.ok(finished);
    assert.equal(finished.request.status, "done");
    assert.equal(finished.hasPendingMessages, false);
  });
});

test("keeps a request queued when new messages arrive during a run", async () => {
  await withStore(async (store) => {
    const key = "thread:C123:1000.000100";
    await store.recordMessage({ key, surface: "ambient", text: "first", event: event() });
    const started = await store.startRun(key);
    assert.ok(started);

    const update = await store.recordMessage({
      key,
      surface: "thread",
      text: "actually include github too",
      event: event({ eventId: "Ev2", ts: "1000.000200", threadTs: "1000.000100" })
    });
    assert.equal(update.disposition, "running_update");

    const finished = await store.finishRun(key, started.run.id, "done");

    assert.ok(finished);
    assert.equal(finished.request.status, "queued");
    assert.equal(finished.hasPendingMessages, true);
  });
});

test("claims Slack steering updates into the same active run", async () => {
  await withStore(async (store, _dir, ledger) => {
    const key = "thread:C123:1000.000100";
    await store.recordMessage({ key, surface: "ambient", text: "first", event: event() });
    const started = await store.startRun(key);
    assert.ok(started);
    await store.recordMessage({
      key,
      surface: "thread",
      text: "second",
      event: event({ eventId: "Ev2", ts: "1000.000200", threadTs: "1000.000100" })
    });

    const claimed = await store.claimSteeringMessages(key, started.run.id);
    const duplicateClaim = await store.claimSteeringMessages(key, started.run.id);
    const finished = await store.finishRun(key, started.run.id, "done");
    const conversation = await ledger.getConversation("slack", key);

    assert.deepEqual(claimed.map((message) => message.text), ["second"]);
    assert.equal(claimed[0]?.runId, started.run.id);
    assert.deepEqual(duplicateClaim, []);
    assert.equal(finished?.request.status, "done");
    assert.equal(finished?.hasPendingMessages, false);
    assert.deepEqual(conversation?.runs[0]?.messageIds, [
      started.messages[0]?.id,
      claimed[0]?.id
    ]);
  });
});

test("next run only includes messages not handled by previous runs", async () => {
  await withStore(async (store) => {
    const key = "thread:C123:1000.000100";
    await store.recordMessage({ key, surface: "ambient", text: "first", event: event() });
    const firstRun = await store.startRun(key);
    assert.ok(firstRun);
    await store.recordMessage({
      key,
      surface: "thread",
      text: "second",
      event: event({ eventId: "Ev2", ts: "1000.000200", threadTs: "1000.000100" })
    });
    await store.finishRun(key, firstRun.run.id, "done");

    const secondRun = await store.startRun(key);

    assert.ok(secondRun);
    assert.equal(secondRun.messages.length, 1);
    assert.equal(secondRun.messages[0]?.text, "second");
  });
});

test("recovers interrupted running requests from the central ledger after restart", async () => {
  await withStore(async (store, dir, ledger) => {
    const key = "thread:C123:1000.000100";
    await store.recordMessage({ key, surface: "ambient", text: "first", event: event() });
    const started = await store.startRun(key);
    assert.ok(started);
    await store.recordMessage({
      key,
      surface: "thread",
      text: "pending after crash",
      event: event({ eventId: "Ev2", ts: "1000.000200", threadTs: "1000.000100" })
    });

    store.close();
    ledger.close();
    const recoveredLedger = new SQLiteTaskLedger({
      filePath: path.join(dir, "tasks.sqlite"),
      runProcessExists: () => false,
      runProcessStartedAt: () => null
    });
    const recoveredStore = new SQLiteThreadRequestStore({
      filePath: path.join(dir, "slack-transport.sqlite"),
      engine: new ConversationEngine({ ledger: recoveredLedger })
    });
    const recovery = await recoveredStore.recoverInterruptedRuns();

    assert.deepEqual(recovery.runnableKeys, [key]);
    assert.deepEqual(recovery.recoveredKeys, [key]);
    const request = await recoveredStore.getRequest(key);
    assert.equal(request?.status, "queued");
    assert.equal(request?.runs[0]?.status, "interrupted");
    const retry = await recoveredStore.startRun(key);
    assert.ok(retry);
    assert.deepEqual(retry.messages.map((message) => message.text), ["first", "pending after crash"]);
    recoveredStore.close();
    recoveredLedger.close();
  });
});

test("requeues an interrupted run even when there were no later messages", async () => {
  await withStore(async (store, dir, ledger) => {
    const key = "thread:C123:1000.000100";
    await store.recordMessage({ key, surface: "ambient", text: "only message", event: event() });
    const started = await store.startRun(key);
    assert.ok(started);

    store.close();
    ledger.close();
    const recoveredLedger = new SQLiteTaskLedger({
      filePath: path.join(dir, "tasks.sqlite"),
      runProcessExists: () => false,
      runProcessStartedAt: () => null
    });
    const recoveredStore = new SQLiteThreadRequestStore({
      filePath: path.join(dir, "slack-transport.sqlite"),
      engine: new ConversationEngine({ ledger: recoveredLedger })
    });
    const recovery = await recoveredStore.recoverInterruptedRuns();

    assert.deepEqual(recovery.runnableKeys, [key]);
    const retry = await recoveredStore.startRun(key);
    assert.ok(retry);
    assert.deepEqual(retry.messages.map((message) => message.text), ["only message"]);
    recoveredStore.close();
    recoveredLedger.close();
  });
});

test("markStopped blocks later startRun calls", async () => {
  await withStore(async (store) => {
    const key = "thread:C123:1000.000100";
    await store.recordMessage({ key, surface: "ambient", text: "first", event: event() });
    const stopped = await store.markStopped(key, "user_stop");
    const run = await store.startRun(key);

    assert.equal(stopped?.status, "stopped");
    assert.equal(run, null);
  });
});

test("stopping an active Slack run preserves pending updates without reviving the run", async () => {
  await withStore(async (store) => {
    const key = "thread:C123:1000.000100";
    await store.recordMessage({ key, surface: "ambient", text: "first", event: event() });
    const started = await store.startRun(key);
    assert.ok(started);
    await store.recordMessage({
      key,
      surface: "thread",
      text: "pending update",
      event: event({ eventId: "Ev2", ts: "1000.000200", threadTs: "1000.000100" })
    });

    const stopped = await store.markStopped(key, "user_stop");
    const repeatedStop = await store.markStopped(key, "user_stop");
    const lateFinish = await store.finishRun(key, started.run.id, "done");

    assert.equal(stopped?.status, "stopped");
    assert.equal(stopped?.runs[0]?.status, "stopped");
    assert.equal(stopped?.messages.find((message) => message.text === "pending update")?.runId, null);
    assert.equal(repeatedStop?.status, "stopped");
    assert.equal(lateFinish?.request.status, "stopped");
    assert.equal(lateFinish?.request.runs[0]?.status, "stopped");
  });
});

test("snapshot counts Slack requests from the central ledger only", async () => {
  await withStore(async (store, _dir, ledger) => {
    await store.recordMessage({ key: "thread:C123:1", surface: "ambient", text: "one", event: event({ ts: "1" }) });
    await store.recordMessage({ key: "thread:C123:2", surface: "ambient", text: "two", event: event({ eventId: "Ev2", ts: "2" }) });
    await ledger.recordMessage({
      channel: "email",
      conversationKey: "email:gmail:abc",
      externalMessageId: "gmail-message-1",
      authorId: "person@example.com",
      text: "email task"
    });
    const run = await store.startRun("thread:C123:2");
    assert.ok(run);
    await store.finishRun("thread:C123:2", run.run.id, "failed", "boom");

    const snapshot = await store.snapshot();

    assert.equal(snapshot.total, 2);
    assert.equal(snapshot.queued, 1);
    assert.equal(snapshot.failed, 1);
  });
});

test("message prompt explains multi-message timeline semantics", () => {
  const text = formatMessagesForPrompt([
    {
      id: "m1",
      eventId: "e1",
      channel: "C",
      channelType: "channel",
      user: "U1",
      ts: "1",
      threadTs: null,
      text: "old name is source-code",
      receivedAt: "now",
      runId: null
    },
    {
      id: "m2",
      eventId: "e2",
      channel: "C",
      channelType: "channel",
      user: "U1",
      ts: "2",
      threadTs: "1",
      text: "actually use source",
      receivedAt: "now",
      runId: null
    }
  ]);

  assert.match(text, /same Slack request thread/);
  assert.match(text, /Later messages override earlier ones/);
  assert.match(text, /actually use source/);
});
test("stores Slack sessions in the transport database", async () => {
  await withStore(async (store) => {
    const session = await store.getOrCreateSession({
      key: "thread:C123:1000.000100",
      channel: "C123",
      threadTs: "1000.000100",
      surface: "ambient",
      user: "U123"
    });
    session.codexSessionId = "codex-session-1";
    session.runStatus = "idle";
    await store.saveSession(session);

    const loaded = await store.getSession("thread:C123:1000.000100");

    assert.equal(loaded?.codexSessionId, "codex-session-1");
    assert.equal(loaded?.channel, "C123");
  });
});

test("rejects malformed central ledger rows instead of trusting casts", async () => {
  await withStore(async (store, dir) => {
    const key = "thread:C123:bad-row";
    await store.recordMessage({ key, surface: "ambient", text: "first", event: event({ ts: "bad-row" }) });
    store.close();

    const db = new DatabaseSync(path.join(dir, "tasks.sqlite"));
    try {
      db.prepare("UPDATE conversations SET status = ? WHERE channel = ? AND conversation_key = ?").run("bogus", "slack", key);
    } finally {
      db.close();
    }

    const reopenedLedger = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
    const reopened = new SQLiteThreadRequestStore({
      filePath: path.join(dir, "slack-transport.sqlite"),
      engine: new ConversationEngine({ ledger: reopenedLedger })
    });
    try {
      await assert.rejects(() => reopened.getRequest(key), /status has invalid value/);
    } finally {
      reopened.close();
      reopenedLedger.close();
    }
  });
});
