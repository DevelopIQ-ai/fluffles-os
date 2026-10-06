import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationEngine,
  ConversationRuntime,
  type ConversationRuntimeTransport,
  SQLiteTaskLedger
} from "@fluffles/tasks";
import { createSlackDeliveryPayload, parseSlackDeliveryPayload, type SlackDeliveryPayload } from "../src/slack-delivery-payload";

type SlackTarget = Pick<SlackDeliveryPayload, "channel" | "sourceTs" | "threadTs" | "surface">;

interface PostedSlackMessage {
  channel: string;
  threadTs: string | null;
  text: string;
  idempotencyKey: string;
}

function transport(target: SlackTarget, posts: PostedSlackMessage[], generated: string[]): ConversationRuntimeTransport<SlackTarget, string> {
  return {
    channel: "slack",
    provider: "slack",
    maxContextTokens: 100_000,
    summaryMaxChars: 2_000,
    prepare: async () => target,
    createSummary: async () => "summary",
    generate: async ({ messages }) => {
      generated.push(messages.map((message) => message.text).join(" | "));
      return `reply ${generated.length}`;
    },
    shouldDeliver: () => true,
    assistantMessage: (response, _target, started) => ({
      channel: "slack",
      conversationKey: started.conversation.conversationKey,
      text: response,
      runId: started.run.id
    }),
    deliveryPayload: (response, target) => createSlackDeliveryPayload({ ...target, text: response }),
    reconcileDelivery: async () => null,
    deliver: async (outbound, started) => {
      const payload = parseSlackDeliveryPayload(outbound);
      posts.push({
        channel: payload.channel,
        threadTs: payload.threadTs,
        text: payload.text,
        idempotencyKey: outbound.idempotencyKey
      });
      return { providerMessageId: `chat.postMessage:${started.run.id}` };
    },
    skipped: async () => {},
    failed: async (error) => {
      throw error;
    }
  };
}

async function ingest(engine: ConversationEngine, key: string, id: string, text: string): Promise<void> {
  await engine.ingest({
    channel: "slack",
    conversationKey: key,
    externalMessageId: id,
    authorId: "U1",
    text,
    intakeMode: "direct"
  });
}

test("a Slack thread continues through repeated replies and invokes one post per run", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const key = "slack:T1:C1:1000.0001";
    const rootTs = "1000.0001";
    const posts: PostedSlackMessage[] = [];
    const generated: string[] = [];

    await ingest(engine, key, "message-0", "initial request");
    assert.deepEqual(await runtime.processConversation(transport({ channel: "C1", sourceTs: rootTs, threadTs: rootTs, surface: "ambient" }, posts, generated), key), [true]);

    for (let turn = 1; turn <= 8; turn += 1) {
      const sourceTs = `1000.000${turn + 1}`;
      await ingest(engine, key, `message-${turn}`, `thread follow-up ${turn}`);
      assert.deepEqual(await runtime.processConversation(transport({ channel: "C1", sourceTs, threadTs: rootTs, surface: "thread" }, posts, generated), key), [true]);
    }

    assert.equal(posts.length, 9);
    assert.deepEqual(posts.map((post) => post.threadTs), Array(9).fill(rootTs));
    assert.equal(new Set(posts.map((post) => post.idempotencyKey)).size, 9);
    assert.equal(generated.length, 9);
    const conversation = await engine.getConversation("slack", key);
    assert.equal(conversation?.status, "done");
    assert.equal(conversation?.messages.length, 18);
    assert.equal(conversation?.runs.length, 9);
    assert.ok(conversation?.runs.every((run) => run.status === "done"));
  } finally {
    ledger.close();
  }
});

test("concurrent Slack threads deliver independently and retries do not duplicate work", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const posts: PostedSlackMessage[] = [];
    const firstKey = "slack:T1:C1:2000.0001";
    const secondKey = "slack:T1:C1:3000.0001";

    await ingest(engine, firstKey, "first-message", "first conversation");
    await ingest(engine, secondKey, "second-message", "second conversation");
    const retry = await engine.ingest({
      channel: "slack",
      conversationKey: firstKey,
      externalMessageId: "first-message",
      authorId: "U1",
      text: "first conversation",
      intakeMode: "direct"
    });
    assert.deepEqual(retry.action, { type: "none", reason: "duplicate" });

    await Promise.all([
      runtime.processConversation(transport({ channel: "C1", sourceTs: "2000.0001", threadTs: "2000.0001", surface: "thread" }, posts, []), firstKey),
      runtime.processConversation(transport({ channel: "C1", sourceTs: "3000.0001", threadTs: "3000.0001", surface: "thread" }, posts, []), secondKey)
    ]);

    assert.equal(posts.length, 2);
    assert.deepEqual(posts.map((post) => post.threadTs).sort(), ["2000.0001", "3000.0001"]);
    assert.equal((await engine.getConversation("slack", firstKey))?.messages.length, 2);
    assert.equal((await engine.getConversation("slack", secondKey))?.messages.length, 2);
  } finally {
    ledger.close();
  }
});
