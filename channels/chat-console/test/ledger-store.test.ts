import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SQLiteTaskLedger, type TaskLedgerMessageInput } from "@fluffles/tasks";
import { LedgerChatStore } from "../src/ledger-store";

async function withStore<T>(fn: (store: LedgerChatStore, ledger: SQLiteTaskLedger) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chat-console-test-"));
  const ledger = new SQLiteTaskLedger({
    filePath: path.join(dir, "tasks.sqlite"),
    now: clock(),
    idFactory: idFactory()
  });
  const store = new LedgerChatStore({ ledgerPath: path.join(dir, "tasks.sqlite") });
  try {
    return await fn(store, ledger);
  } finally {
    store.close();
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test("lists Slack, email, and phone conversations from the central ledger", async () => {
  await withStore(async (store, ledger) => {
    await ledger.recordMessage(message("slack", "thread:C123:1000.000100", "slack hello"));
    await ledger.recordMessage(message("email", "email:gmail:t1", "email hello"));
    await ledger.recordMessage(message("phone", "phone:main", "sms hello"));

    const snapshot = store.snapshot();
    const conversations = store.listConversations({ limit: 20 });

    assert.equal(snapshot.total, 3);
    assert.equal(snapshot.byChannel.slack.total, 1);
    assert.equal(snapshot.byChannel.email.total, 1);
    assert.equal(snapshot.byChannel.phone.total, 1);
    assert.deepEqual(new Set(conversations.map((conversation) => conversation.channel)), new Set(["slack", "email", "phone"]));
  });
});

test("loads full conversation messages and run history", async () => {
  await withStore(async (store, ledger) => {
    const key = "phone:main";
    await ledger.recordMessage(message("phone", key, "first text"));
    const run = await ledger.startRun("phone", key);
    assert.ok(run);
    await ledger.recordAssistantMessage({
      channel: "phone",
      conversationKey: key,
      externalMessageId: "sent-1",
      authorId: "+14155550000",
      text: "got it",
      runId: run.run.id
    });
    await ledger.finishRun("phone", key, run.run.id, "done");

    const conversation = store.getConversation("phone", key);

    assert.equal(conversation?.channel, "phone");
    assert.equal(conversation?.messages.length, 2);
    assert.equal(conversation?.messages[0]?.text, "first text");
    assert.equal(conversation?.messages[0]?.direction, "inbound");
    assert.equal(conversation?.messages[1]?.text, "got it");
    assert.equal(conversation?.messages[1]?.direction, "outbound");
    assert.equal(conversation?.runs.length, 1);
    assert.deepEqual(conversation?.runs[0]?.messageIds, [
      conversation?.messages[0]?.taskMessageId,
      conversation?.messages[1]?.id
    ]);
  });
});

test("filters conversations by channel, status, and search", async () => {
  await withStore(async (store, ledger) => {
    await ledger.recordMessage(message("slack", "thread:C123:1000.000100", "slack deploy question"));
    await ledger.recordMessage(message("email", "email:gmail:t1", "email invoice question"));
    const emailRun = await ledger.startRun("email", "email:gmail:t1");
    assert.ok(emailRun);
    await ledger.finishRun("email", "email:gmail:t1", emailRun.run.id, "failed", "auth failed");

    const channelMatches = store.listConversations({ channels: ["slack"] });
    const failedMatches = store.listConversations({ status: "failed" });
    const searchMatches = store.listConversations({ search: "invoice" });

    assert.deepEqual(channelMatches.map((conversation) => conversation.channel), ["slack"]);
    assert.deepEqual(failedMatches.map((conversation) => conversation.conversationKey), ["email:gmail:t1"]);
    assert.deepEqual(searchMatches.map((conversation) => conversation.conversationKey), ["email:gmail:t1"]);
  });
});

function message(channel: "slack" | "email" | "phone", conversationKey: string, text: string): TaskLedgerMessageInput {
  return {
    channel,
    conversationKey,
    externalMessageId: `${channel}:${conversationKey}:${text}`,
    authorId: channel === "email" ? "person@example.com" : "U123",
    text,
    receivedAt: "2026-01-01T00:00:00.000Z",
    title: text,
    replyTarget: { type: `${channel}_thread` },
    metadata: { channel }
  };
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++));
}

function idFactory(): () => string {
  let tick = 0;
  return () => `id-${tick++}`;
}
