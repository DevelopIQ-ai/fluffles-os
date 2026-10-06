import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConversationEngine, ConversationRuntime, type ConversationRuntimeTransport, SQLiteTaskLedger } from "@fluffles/tasks";

const key = "slack:T1:C1:1000.0001";

test("failed chat.postMessage records a durable error without assistant history", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    await engine.ingest({
      channel: "slack",
      conversationKey: key,
      externalMessageId: "slack:T1:C1:1000.0001",
      authorId: "U1",
      text: "please reply",
      intakeMode: "direct"
    });
    const transport: ConversationRuntimeTransport<{ channel: string; ts: string }, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 100_000,
      summaryMaxChars: 2_000,
      prepare: async () => ({ channel: "C1", ts: "1000.0001" }),
      createSummary: async () => "summary",
      generate: async () => "undelivered Slack reply",
      shouldDeliver: () => true,
      assistantMessage: (_decision, _target, started) => ({
        channel: "slack",
        conversationKey: started.conversation.conversationKey,
        text: "undelivered Slack reply",
        runId: started.run.id
      }),
      deliveryPayload: () => ({ channel: "C1", body: "undelivered Slack reply" }),
      reconcileDelivery: async () => null,
      deliver: async () => {
        throw new Error("chat.postMessage failed: ratelimited");
      },
      skipped: async () => {},
      failed: async () => {}
    };

    assert.deepEqual(await runtime.processConversation(transport, key), [false]);
    const conversation = await engine.getConversation("slack", key);
    const context = await engine.buildContext("slack", key);
    const lifecycle = await ledger.lifecycleEvents("slack", key);

    assert.deepEqual(conversation?.messages.map((message) => message.role), ["user"]);
    assert.deepEqual(context?.messages.map((message) => message.role), ["user"]);
    assert.equal(conversation?.lastError, "chat.postMessage failed: ratelimited");
    const failedEvent = [...lifecycle].reverse().find((event) => event.kind === "failed");
    assert.equal(failedEvent?.reason, "chat.postMessage failed: ratelimited");
  } finally {
    ledger.close();
  }
});

test("Slack reconciles an accepted reply after provider uncertainty without another model response", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slack-delivery-recovery-"));
  const filePath = path.join(dir, "tasks.sqlite");
  const visible: string[] = [];
  let generateCalls = 0;
  let crash = true;
  const transport = (): ConversationRuntimeTransport<null, string> => ({
    channel: "slack",
    provider: "slack",
    maxContextTokens: 100_000,
    summaryMaxChars: 2_000,
    prepare: async () => null,
    createSummary: async () => "summary",
    generate: async () => {
      generateCalls += 1;
      return "durable Slack reply";
    },
    shouldDeliver: () => true,
    assistantMessage: (_decision, _target, started) => ({ channel: "slack", conversationKey: started.conversation.conversationKey, text: "durable Slack reply", runId: started.run.id }),
    deliveryPayload: () => ({ channel: "C1", threadTs: "1000.0001", text: "durable Slack reply" }),
    reconcileDelivery: async (delivery) => visible.includes(delivery.idempotencyKey) ? { providerMessageId: "reply-1", reconciled: true } : null,
    deliver: async (delivery) => {
      visible.push(delivery.idempotencyKey);
      if (crash) throw deliveryInterruptedError();
      return { providerMessageId: "reply-1" };
    },
    skipped: async () => {},
    failed: async () => {}
  });
  try {
    const firstLedger = new SQLiteTaskLedger({ filePath });
    const firstEngine = new ConversationEngine({ ledger: firstLedger });
    await firstEngine.ingest({ channel: "slack", conversationKey: key, externalMessageId: "message-1", authorId: "U1", text: "please reply", intakeMode: "direct" });
    assert.deepEqual(await new ConversationRuntime(firstEngine).processConversation(transport(), key), [true]);
    const conversation = await firstEngine.getConversation("slack", key);
    assert.equal(generateCalls, 1);
    assert.equal(visible.length, 1);
    assert.deepEqual(conversation?.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal(conversation?.messages.at(-1)?.text, "durable Slack reply");
    assert.equal(conversation?.status, "done");
    firstLedger.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function deliveryInterruptedError(): Error {
  const error = new Error("provider accepted delivery before runtime confirmation");
  error.name = "DeliveryInterruptedError";
  return error;
}
