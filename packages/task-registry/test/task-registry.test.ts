import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeStore, CONVERSATIONS_SCHEMA } from "@fluffles/conversations";
import { LedgerDb } from "@fluffles/storage";
import { TASKS_SCHEMA, TaskRegistryStore, cancelOpenConversationTasksInDb } from "../src";

function openStores(): { db: LedgerDb; bridge: BridgeStore; registry: TaskRegistryStore } {
  const dir = mkdtempSync(path.join(tmpdir(), "task-registry-test-"));
  const db = new LedgerDb({
    filePath: path.join(dir, "tasks.sqlite"),
    schema: CONVERSATIONS_SCHEMA + TASKS_SCHEMA,
    migrations: []
  });
  const bridge = new BridgeStore(db);
  return { db, bridge, registry: new TaskRegistryStore(db, bridge) };
}

test("standalone registry: create, update, and finish a conversation task", async () => {
  const { db, bridge, registry } = openStores();
  try {
    await bridge.admitMessage({
      channel: "slack",
      conversationKey: "slack:T1:C1:1.0",
      externalMessageId: "m1",
      authorId: "U1",
      text: "please do the thing"
    }, { actionable: true });

    const task = await registry.createConversationTask({
      channel: "slack",
      conversationKey: "slack:T1:C1:1.0",
      objective: "do the thing",
      nextAction: "start step 1"
    });
    assert.equal(task.status, "in_progress");

    const unfinished = await registry.unfinishedConversationTask("slack", "slack:T1:C1:1.0");
    assert.ok(unfinished);
    assert.equal(unfinished.id, task.id);
    assert.equal(unfinished.nextAction, "start step 1");

    const done = await registry.updateConversationTask(task.id, { status: "completed", result: "did the thing" });
    assert.equal(done.status, "completed");
    assert.equal(done.result, "did the thing");
    assert.equal(await registry.unfinishedConversationTask("slack", "slack:T1:C1:1.0"), null);
  } finally {
    db.close();
  }
});

test("standalone registry: cancelOpenConversationTasksInDb cancels active work", async () => {
  const { db, bridge, registry } = openStores();
  try {
    await bridge.admitMessage({
      channel: "slack",
      conversationKey: "slack:T1:C1:2.0",
      externalMessageId: "m2",
      authorId: "U1",
      text: "seed"
    }, { actionable: true });
    const task = await registry.createConversationTask({
      channel: "slack",
      conversationKey: "slack:T1:C1:2.0",
      objective: "long-running work"
    });

    await db.mutate((raw) => {
      cancelOpenConversationTasksInDb(raw, task.conversationId, "conversation stopped", db.isoNow());
    });

    const tasks = await registry.conversationTasks("slack", "slack:T1:C1:2.0");
    assert.equal(tasks.length, 1);
    const cancelled = tasks[0];
    assert.ok(cancelled);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.result, "conversation stopped");
  } finally {
    db.close();
  }
});
