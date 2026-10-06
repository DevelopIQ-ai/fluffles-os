import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { LedgerDb } from "@fluffles/storage";
import { BridgeStore, CONVERSATIONS_SCHEMA, ConversationEngine, type ConversationEngineLedger } from "../src";

function openLedger(): LedgerDb {
  const dir = mkdtempSync(path.join(tmpdir(), "conversations-test-"));
  return new LedgerDb({ filePath: path.join(dir, "conversations.sqlite"), schema: CONVERSATIONS_SCHEMA, migrations: [] });
}

test("standalone bridge: admit, run, deliver, confirm, and finish without any embedder code", async () => {
  const db = openLedger();
  try {
    const bridge = new BridgeStore(db);
    const admitted = await bridge.admitMessage({
      channel: "slack",
      conversationKey: "slack:T1:C1:1.0",
      externalMessageId: "m1",
      authorId: "U1",
      text: "hello there"
    }, { actionable: true });
    assert.equal(admitted.disposition, "new_conversation");

    const started = await bridge.startRun("slack", "slack:T1:C1:1.0");
    assert.ok(started);
    assert.equal(started.run.status, "running");
    assert.equal(started.messages.length, 1);

    const delivery = await bridge.createOutboundDelivery({
      channel: "slack",
      conversationKey: "slack:T1:C1:1.0",
      runId: started.run.id,
      provider: "test-provider",
      idempotencyKey: "run-1-reply",
      payload: { text: "hi" },
      assistantMessage: { text: "hi" }
    });
    assert.equal(delivery.status, "pending");

    await bridge.beginOutboundDeliveryDispatch(delivery.id, started.run.id);
    await bridge.markOutboundDeliveryProviderAccepted(delivery.id, started.run.id, { ts: "1.1" });
    const confirmed = await bridge.confirmOutboundDelivery({
      deliveryId: delivery.id,
      runId: started.run.id,
      providerReceipt: { ts: "1.1" }
    });
    assert.equal(confirmed.delivery.status, "delivered");
    assert.equal(confirmed.assistantMessage.role, "assistant");
    assert.equal(confirmed.finish.conversation.status, "done");
  } finally {
    db.close();
  }
});

test("standalone bridge: duplicate admission and stop transition", async () => {
  const db = openLedger();
  try {
    const bridge = new BridgeStore(db);
    const input = {
      channel: "slack" as const,
      conversationKey: "slack:T1:C1:2.0",
      externalMessageId: "m2",
      authorId: "U1",
      text: "do a thing"
    };
    await bridge.admitMessage(input, { actionable: true });
    const duplicate = await bridge.admitMessage(input, { actionable: true });
    assert.equal(duplicate.disposition, "duplicate");

    const stopped = await bridge.stopConversation("slack", "slack:T1:C1:2.0", "user_stop");
    assert.ok(stopped);
    assert.equal(stopped.status, "stopped");
  } finally {
    db.close();
  }
});

test("standalone bridge: key migration fires the injected hook inside the transaction", async () => {
  const db = openLedger();
  try {
    const seen: string[] = [];
    const bridge = new BridgeStore(db, {}, {
      onConversationKeyMigrated: (_db, migration) => {
        seen.push(`${migration.legacyKey}->${migration.canonicalKey}`);
      }
    });
    await bridge.admitMessage({
      channel: "slack",
      conversationKey: "slack:T1:C1:legacy",
      externalMessageId: "m3",
      authorId: "U1",
      text: "legacy thread"
    }, { actionable: true });
    const started = await bridge.startRun("slack", "slack:T1:C1:legacy");
    assert.ok(started);
    await bridge.finishRun("slack", "slack:T1:C1:legacy", started.run.id, "done");

    const migrated = await bridge.migrateConversationKey("slack", "slack:T1:C1:legacy", "slack:T1:C1:canonical");
    assert.ok(migrated);
    assert.equal(migrated.conversationKey, "slack:T1:C1:canonical");
    assert.deepEqual(seen, ["slack:T1:C1:legacy->slack:T1:C1:canonical"]);
  } finally {
    db.close();
  }
});

test("standalone engine: works over a bare bridge store with stub session/snapshot surfaces", async () => {
  const db = openLedger();
  try {
    const bridge = new BridgeStore(db);
    const ledger: ConversationEngineLedger = Object.assign(Object.create(Object.getPrototypeOf(bridge)), bridge, {
      snapshot: async () => ({ total: 0, queued: 0, running: 0, done: 0, failed: 0, stopped: 0, byChannel: {}, oldestQueuedAt: null }),
      deploymentLifecycle: async () => ({ state: "normal" }),
      getCodexSession: async () => null,
      saveCodexSession: async () => { throw new Error("unused"); },
      clearCodexSession: async () => undefined
    });
    const engine = new ConversationEngine({ ledger });
    const result = await engine.admit({
      channel: "slack",
      conversationKey: "slack:T1:C1:3.0",
      externalMessageId: "m4",
      authorId: "U1",
      text: "stop",
      intakeMode: "direct"
    }, { actionable: true, controlText: "stop" });
    assert.equal(result.action.type, "none");
    assert.equal(result.conversation.status, "stopped");
  } finally {
    db.close();
  }
});
