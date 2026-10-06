import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LedgerDb } from "@fluffles/storage";
import { REPAIR_LEDGER_SCHEMA, RepairStore } from "../src";

function openStore(): { db: LedgerDb; store: RepairStore } {
  const dir = mkdtempSync(path.join(tmpdir(), "repair-ledger-test-"));
  const db = new LedgerDb({
    filePath: path.join(dir, "repair-ledger.sqlite"),
    schema: REPAIR_LEDGER_SCHEMA,
    migrations: []
  });
  return { db, store: new RepairStore(db) };
}

test("standalone store: repair task lifecycle from upsert to completion", async () => {
  const { db, store } = openStore();
  try {
    const task = await store.upsertRepairTask({
      toolId: "tool-1",
      objective: "slack service is down",
      nextAction: "inspect the launchd job"
    });
    assert.equal(task.status, "pending");

    const started = await store.startRepairTask(task.id);
    assert.equal(started.status, "in_progress");

    const again = await store.upsertRepairTask({ toolId: "tool-1", objective: "ignored", progress: "restarting" });
    assert.equal(again.id, task.id);
    assert.equal(again.progress, "restarting");

    const unfinished = await store.unfinishedRepairTasks();
    assert.equal(unfinished.length, 1);

    const done = await store.completeRepairTask(task.id, "restarted the service");
    assert.equal(done.status, "completed");
    assert.equal(done.result, "restarted the service");
    assert.equal((await store.unfinishedRepairTasks()).length, 0);
    assert.equal(await store.activeRepairTaskForTool("tool-1"), null);
  } finally {
    db.close();
  }
});
