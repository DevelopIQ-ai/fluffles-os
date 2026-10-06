import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationEngine,
  SQLiteTaskLedger,
  type ConversationAction,
  type ConversationEngineIngestInput,
} from "../src/task-ledger";

function makeEngine() {
  let tick = 0;
  const ledger = new SQLiteTaskLedger({
    filePath: ":memory:",
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    idFactory: () => `id-${tick++}`,
    runLeaseDurationMs: 1,
  });
  return { engine: new ConversationEngine({ ledger }), ledger };
}

const KEY = "thread:C1:1000.0001";

function base(overrides: Partial<ConversationEngineIngestInput> = {}): ConversationEngineIngestInput {
  return {
    channel: "slack",
    conversationKey: KEY,
    externalMessageId: "Ev1",
    authorId: "U1",
    text: "deploy the app",
    intakeMode: "direct",
    ...overrides,
  };
}

// ── action decisions ─────────────────────────────────────────────────────────

test("first message produces start_run", async () => {
  const { engine } = makeEngine();
  const result = await engine.ingest(base());
  assert.equal(result.action.type, "start_run");
  assert.equal(result.conversation.status, "queued");
});

test("second message to idle conversation produces start_run", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  const result = await engine.ingest(base({ externalMessageId: "Ev2", text: "actually never mind" }));
  assert.equal(result.action.type, "start_run");
});

test("message during active run produces steer", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  const started = await engine.startRun("slack", KEY);
  assert.ok(started, "run should start");
  const result = await engine.ingest(base({ externalMessageId: "Ev2", text: "wait, change that" }));
  assert.equal(result.action.type, "steer");
  assert.equal(result.conversation.status, "running");
});

test("duplicate message produces none(duplicate)", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  const result = await engine.ingest(base({ externalMessageId: "Ev1" }));
  assert.equal(result.action.type, "none");
  assert.equal((result.action as Extract<ConversationAction, { type: "none" }>).reason, "duplicate");
});

test("message after failed run produces restart with previousRunStatus", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  await engine.finishRun("slack", KEY, started.run.id, "failed", "codex timeout");
  const result = await engine.ingest(base({ externalMessageId: "Ev2", text: "try again" }));
  assert.equal(result.action.type, "restart");
  const action = result.action as Extract<ConversationAction, { type: "restart" }>;
  assert.equal(action.previousRunStatus, "failed");
});

test("message after stopped run produces restart with previousRunStatus", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  await engine.finishRun("slack", KEY, started.run.id, "stopped");
  const result = await engine.ingest(base({ externalMessageId: "Ev2", text: "continue" }));
  assert.equal(result.action.type, "restart");
  const action = result.action as Extract<ConversationAction, { type: "restart" }>;
  assert.equal(action.previousRunStatus, "stopped");
});

test("message after interrupted run produces restart with previousRunStatus", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  await engine.finishRun("slack", KEY, started.run.id, "interrupted");
  const result = await engine.ingest(base({ externalMessageId: "Ev2", text: "continue" }));
  assert.equal(result.action.type, "restart");
  const action = result.action as Extract<ConversationAction, { type: "restart" }>;
  assert.equal(action.previousRunStatus, "interrupted");
});

test("message after successful run produces start_run, not restart", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  await engine.finishRun("slack", KEY, started.run.id, "done");
  const result = await engine.ingest(base({ externalMessageId: "Ev2", text: "new task" }));
  assert.equal(result.action.type, "start_run");
});

// ── intakeMode stored in metadata ────────────────────────────────────────────

test("intakeMode is stored in message metadata", async () => {
  const { engine } = makeEngine();
  const direct = await engine.ingest(base({ externalMessageId: "Ev1", intakeMode: "direct" }));
  assert.equal(direct.message.metadata["intakeMode"], "direct");

  const ambient = await engine.ingest(
    base({ conversationKey: "thread:C2:2000.0001", externalMessageId: "Ev2", intakeMode: "ambient" })
  );
  assert.equal(ambient.message.metadata["intakeMode"], "ambient");
});

// ── run lifecycle ────────────────────────────────────────────────────────────

test("startRun returns started run with pending messages", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base());
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  assert.equal(started.conversation.status, "running");
  assert.equal(started.messages.length, 1);
  assert.equal(started.messages[0]?.text, "deploy the app");
});

test("startRun returns null when no pending messages exist", async () => {
  const { engine } = makeEngine();
  const started = await engine.startRun("slack", KEY);
  assert.equal(started, null);
});

test("startRun returns null when run is already active", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  const first = await engine.startRun("slack", KEY);
  assert.ok(first);
  const second = await engine.startRun("slack", KEY);
  assert.equal(second, null);
});

test("finishRun marks run done and conversation done when no pending messages remain", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base());
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  const result = await engine.finishRun("slack", KEY, started.run.id, "done");
  assert.ok(result);
  assert.equal(result.conversation.status, "done");
  assert.equal(result.hasPendingMessages, false);
});

test("finishRun leaves conversation queued when pending messages remain", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  await engine.ingest(base({ externalMessageId: "Ev2", text: "and also this" }));
  const result = await engine.finishRun("slack", KEY, started.run.id, "done");
  assert.ok(result);
  assert.equal(result.conversation.status, "queued");
  assert.equal(result.hasPendingMessages, true);
});

test("claimSteeringMessages consumes pending updates into the same run", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  await engine.ingest(base({ externalMessageId: "Ev2", text: "and also this" }));

  const claimed = await engine.claimSteeringMessages("slack", KEY, started.run.id);
  const duplicateClaim = await engine.claimSteeringMessages("slack", KEY, started.run.id);
  const result = await engine.finishRun("slack", KEY, started.run.id, "done");

  assert.deepEqual(claimed.map((message) => message.text), ["and also this"]);
  assert.equal(claimed[0]?.runId, started.run.id);
  assert.deepEqual(duplicateClaim, []);
  assert.ok(result);
  assert.equal(result.conversation.status, "done");
  assert.equal(result.hasPendingMessages, false);
});

// ── recover ───────────────────────────────────────────────────────────────────

test("recover marks interrupted runs and re-queues their conversations", async () => {
  let tick = 0;
  const ledger = new SQLiteTaskLedger({
    filePath: ":memory:",
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    idFactory: () => `id-${tick++}`,
    runLeaseDurationMs: 1,
  });
  const engine = new ConversationEngine({ ledger });

  await engine.ingest(base());
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  assert.equal(started.conversation.status, "running");

  const recovery = await engine.recover("slack");
  assert.ok(recovery.recoveredKeys.includes(KEY));

  const conversation = await engine.getConversation("slack", KEY);
  assert.ok(conversation);
  assert.equal(conversation.status, "queued");
  assert.equal(conversation.runs[0]?.status, "interrupted");
  ledger.close();
});

// ── stop ─────────────────────────────────────────────────────────────────────

test("stop transitions conversation to stopped and startRun returns null", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base());
  const stopped = await engine.stop("slack", KEY, "user_stop");
  assert.ok(stopped);
  assert.equal(stopped.status, "stopped");
  const started = await engine.startRun("slack", KEY);
  assert.equal(started, null);
});

test("new message after stop re-queues conversation", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  await engine.stop("slack", KEY, "user_stop");
  const result = await engine.ingest(base({ externalMessageId: "Ev2", text: "continue" }));
  assert.equal(result.conversation.status, "queued");
});

// ── runnableConversations and snapshot ────────────────────────────────────────

test("runnableConversations returns conversations with pending work", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ conversationKey: "thread:C1:1.0", externalMessageId: "Ev1" }));
  await engine.ingest(base({ conversationKey: "thread:C2:2.0", externalMessageId: "Ev2" }));
  const conv2Started = await engine.startRun("slack", "thread:C2:2.0");
  assert.ok(conv2Started);
  const runnable = await engine.runnableConversations("slack");
  assert.equal(runnable.length, 1);
  assert.equal(runnable[0]?.conversationKey, "thread:C1:1.0");
});

test("snapshot reflects conversation counts by status", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ conversationKey: "thread:C1:1.0", externalMessageId: "Ev1" }));
  await engine.ingest(base({ conversationKey: "thread:C2:2.0", externalMessageId: "Ev2" }));
  const started = await engine.startRun("slack", "thread:C1:1.0");
  assert.ok(started);
  const snap = await engine.snapshot("slack");
  assert.equal(snap.running, 1);
  assert.equal(snap.queued, 1);
  assert.equal(snap.total, 2);
});

// ── getConversation ───────────────────────────────────────────────────────────

// ── compact and buildContext ──────────────────────────────────────────────────

test("compact advances compactionSeq and persists the summary", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  await engine.finishRun("slack", KEY, started.run.id, "done");

  const result = await engine.compact("slack", KEY, "user asked to deploy the app", 1);
  assert.ok(result);
  assert.equal(result.compactionSeq, 1);
  assert.equal(result.compactionSummary, "user asked to deploy the app");
});

test("buildContext returns all messages before any compaction", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  await engine.ingest(base({ externalMessageId: "Ev2", text: "second request" }));

  const ctx = await engine.buildContext("slack", KEY);
  assert.ok(ctx);
  assert.equal(ctx.summary, null);
  assert.equal(ctx.messages.length, 2);
  assert.deepEqual(ctx.messages.map((m) => m.seq), [1, 2]);
});

test("buildContext returns the summary and post-checkpoint messages after compaction", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base({ externalMessageId: "Ev1" }));
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  await engine.finishRun("slack", KEY, started.run.id, "done");
  await engine.compact("slack", KEY, "deployment request handled", 1);

  await engine.ingest(base({ externalMessageId: "Ev2", text: "new request after compaction" }));

  const ctx = await engine.buildContext("slack", KEY);
  assert.ok(ctx);
  assert.equal(ctx.summary, "deployment request handled");
  assert.equal(ctx.messages.length, 1);
  assert.equal(ctx.messages[0]?.text, "new request after compaction");
  assert.equal(ctx.messages[0]?.seq, 2);
});

test("buildContext returns null for an unknown conversation key", async () => {
  const { engine } = makeEngine();
  const ctx = await engine.buildContext("slack", "thread:C0:no-such");
  assert.equal(ctx, null);
});

test("compact rejects when no runs have completed", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base());

  await assert.rejects(
    () => engine.compact("slack", KEY, "too early", 1),
    /Cannot compact/
  );
});

test("markMessagesNonActionable prevents start_run for low-intent ambient chatter", async () => {
  const { engine } = makeEngine();
  const key = "slack:T1:Cambient:1.0";
  const ingested = await engine.ingest(base({
    conversationKey: key,
    externalMessageId: "EvAmbient1",
    text: "yo",
    intakeMode: "ambient"
  }));
  assert.equal(ingested.action.type, "start_run");
  const marked = await engine.markMessagesNonActionable("slack", key, [ingested.message.id]);
  assert.ok(marked);
  assert.equal(marked.status, "done");
  assert.equal(await engine.startRun("slack", key), null);
  const ctx = await engine.buildContext("slack", key);
  assert.ok(ctx);
  assert.equal(ctx.messages.length, 1);
  assert.equal(ctx.messages[0]?.text, "yo");
});

test("admit atomically persists a filtered message without making it runnable", async () => {
  const { engine } = makeEngine();
  const key = "phone:filtered";
  const result = await engine.admit(base({ channel: "phone", conversationKey: key, externalMessageId: "filtered-1", text: "outbound echo", intakeMode: "direct" }), {
    actionable: false,
    reason: "outbound echo"
  });
  assert.equal(result.action.type, "none");
  assert.equal(result.conversation.status, "done");
  assert.equal(result.message.metadata.nonActionable, true);
  assert.equal(await engine.startRun("phone", key), null);
});

test("admit atomically stops active work before another worker can claim the stop message", async () => {
  const { engine } = makeEngine();
  const key = "phone:stop";
  await engine.ingest(base({ channel: "phone", conversationKey: key, externalMessageId: "work-1", text: "work", intakeMode: "direct" }));
  const started = await engine.startRun("phone", key);
  assert.ok(started);
  const result = await engine.admit(base({ channel: "phone", conversationKey: key, externalMessageId: "stop-1", text: "stop", intakeMode: "direct" }), {
    actionable: true
  });
  assert.equal(result.action.type, "none");
  assert.equal(result.conversation.status, "stopped");
  assert.equal(await engine.startRun("phone", key), null);
});

test("recordAssistantMessage persists assistant text into buildContext", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base());
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  await engine.recordAssistantMessage({
    channel: "slack",
    conversationKey: KEY,
    text: "done",
    runId: started.run.id
  });
  await engine.finishRun("slack", KEY, started.run.id, "done");
  const ctx = await engine.buildContext("slack", KEY);
  assert.ok(ctx);
  assert.deepEqual(ctx.messages.map((message) => message.role), ["user", "assistant"]);
});

test("getConversation returns null for unknown key", async () => {
  const { engine } = makeEngine();
  const result = await engine.getConversation("slack", "thread:C0:0.0");
  assert.equal(result, null);
});

test("getConversation returns existing conversation with messages and runs", async () => {
  const { engine } = makeEngine();
  await engine.ingest(base());
  const started = await engine.startRun("slack", KEY);
  assert.ok(started);
  await engine.finishRun("slack", KEY, started.run.id, "done");
  const conv = await engine.getConversation("slack", KEY);
  assert.ok(conv);
  assert.equal(conv.messages.length, 1);
  assert.equal(conv.runs.length, 1);
  assert.equal(conv.runs[0]?.status, "done");
});
