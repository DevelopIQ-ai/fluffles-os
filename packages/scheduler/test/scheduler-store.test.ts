import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeStore, CONVERSATIONS_SCHEMA } from "@fluffles/conversations";
import { LedgerDb } from "@fluffles/storage";
import { SCHEDULER_SCHEMA, SchedulerStore } from "../src";

function openStores(): { db: LedgerDb; bridge: BridgeStore; scheduler: SchedulerStore } {
  const dir = mkdtempSync(path.join(tmpdir(), "scheduler-test-"));
  const db = new LedgerDb({
    filePath: path.join(dir, "scheduler.sqlite"),
    schema: CONVERSATIONS_SCHEMA + SCHEDULER_SCHEMA,
    migrations: []
  });
  const bridge = new BridgeStore(db);
  return { db, bridge, scheduler: new SchedulerStore(db, bridge) };
}

async function seedConversation(bridge: BridgeStore, conversationKey: string): Promise<void> {
  await bridge.admitMessage({
    channel: "slack",
    conversationKey,
    externalMessageId: `seed-${conversationKey}`,
    authorId: "U1",
    text: "seed"
  }, { actionable: true });
}

async function createDueReminder(scheduler: SchedulerStore, conversationKey: string, instruction: string) {
  const reminder = await scheduler.createReminder({
    instruction,
    scheduledFor: new Date(Date.now() + 50).toISOString(),
    displayTimezone: "UTC",
    channel: "slack",
    conversationKey
  });
  await new Promise((resolve) => setTimeout(resolve, 60));
  return reminder;
}

test("standalone scheduler: create, list, cancel a reminder without any embedder code", async () => {
  const { db, bridge, scheduler } = openStores();
  try {
    await seedConversation(bridge, "slack:T1:C1:1.0");
    const reminder = await scheduler.createReminder({
      instruction: "ping the standup thread",
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      displayTimezone: "UTC",
      channel: "slack",
      conversationKey: "slack:T1:C1:1.0"
    });
    assert.equal(reminder.status, "scheduled");

    const listed = await scheduler.listReminders({ channel: "slack", conversationKey: "slack:T1:C1:1.0" });
    assert.equal(listed.length, 1);

    const cancelled = await scheduler.cancelReminder(reminder.id);
    assert.ok(cancelled);
    assert.equal(cancelled.status, "cancelled");

    assert.deepEqual(await scheduler.admitDueReminders(), []);
  } finally {
    db.close();
  }
});

test("a due reminder is admitted as an ordinary inbound message", async () => {
  const { db, bridge, scheduler } = openStores();
  try {
    await seedConversation(bridge, "slack:T1:C1:2.0");
    const reminder = await createDueReminder(scheduler, "slack:T1:C1:2.0", "send the weekly report");

    const admissions = await scheduler.admitDueReminders();
    assert.deepEqual(admissions.map((admission) => admission.disposition), ["admitted"]);
    assert.equal(admissions[0]?.reminder.status, "delivered");

    const conversation = await bridge.getConversation("slack", "slack:T1:C1:2.0");
    assert.equal(conversation?.status, "queued");
    const instruction = conversation?.messages.find((message) => message.externalMessageId === `reminder:${reminder.id}`);
    assert.equal(instruction?.text, "send the weekly report");
    assert.equal(instruction?.metadata.reminderInstruction, true);
  } finally {
    db.close();
  }
});

test("admitting the same reminder twice cannot deliver it twice", async () => {
  const { db, bridge, scheduler } = openStores();
  try {
    await seedConversation(bridge, "slack:T1:C1:3.0");
    const reminder = await createDueReminder(scheduler, "slack:T1:C1:3.0", "follow up");

    await scheduler.admitDueReminders();
    // Re-running the pass is how recovery works, so it has to be a no-op.
    await db.mutate((raw) => {
      raw.prepare("UPDATE scheduled_reminders SET status = 'scheduled', delivered_at = NULL WHERE id = ?").run(reminder.id);
    });
    const second = await scheduler.admitDueReminders();

    assert.deepEqual(second.map((admission) => admission.disposition), ["duplicate"]);
    const conversation = await bridge.getConversation("slack", "slack:T1:C1:3.0");
    const instructions = conversation?.messages.filter((message) => message.metadata.reminderInstruction === true) ?? [];
    assert.equal(instructions.length, 1);
  } finally {
    db.close();
  }
});

test("a reminder that is not due yet, or is cancelled, is left alone", async () => {
  const { db, bridge, scheduler } = openStores();
  try {
    await seedConversation(bridge, "slack:T1:C1:4.0");
    const future = await scheduler.createReminder({
      instruction: "next week",
      scheduledFor: new Date(Date.now() + 60_000).toISOString(),
      displayTimezone: "UTC",
      channel: "slack",
      conversationKey: "slack:T1:C1:4.0"
    });

    assert.deepEqual(await scheduler.admitDueReminders(), []);
    assert.equal((await scheduler.getReminder(future.id))?.status, "scheduled");

    const admitted = await scheduler.admitDueReminders({ now: new Date(Date.now() + 120_000).toISOString() });
    assert.equal(admitted.length, 1);
  } finally {
    db.close();
  }
});
