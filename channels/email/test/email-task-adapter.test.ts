import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SQLiteTaskLedger } from "@fluffles/tasks";
import {
  buildEmailLedgerInput,
  emailConversationKey,
  legacyEmailConversationKeys,
  recordEmailTask,
  resolveEmailConversationKey,
  type EmailClassification,
  type NormalizedEmail
} from "../src/email-task-adapter";

async function withLedgerPath<T>(fn: (ledgerPath: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "email-channel-test-"));
  try {
    return await fn(path.join(dir, "tasks.sqlite"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function email(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    provider: "gmail",
    id: "gmail-id-1",
    threadId: "gmail-thread-1",
    from: "Kush <kush@puffle.ai>",
    to: "Fluffles <fluffles@puffle.ai>",
    subject: "can you check the ledger?",
    date: "Mon, 29 Jun 2026 10:00:00 -0700",
    messageId: "<message-1@example.com>",
    references: [],
    inReplyTo: null,
    headers: {
      "message-id": "<message-1@example.com>"
    },
    text: "can you check whether the email queue is wired into the central ledger?",
    labels: ["INBOX"],
    ...overrides
  };
}

function accepted(overrides: Partial<EmailClassification> = {}): EmailClassification {
  return {
    shouldReply: true,
    confidence: "medium",
    reason: "clear-human-ask",
    sender: "kush@puffle.ai",
    subject: "can you check the ledger?",
    ...overrides
  };
}

test("builds a central ledger input for accepted email", () => {
  const input = buildEmailLedgerInput(email(), accepted());

  assert.equal(input.channel, "email");
  assert.equal(input.conversationKey, "email:fluffles@puffle.ai:gmail-thread-1");
  assert.equal(input.externalMessageId, "<message-1@example.com>");
  assert.equal(input.authorId, "kush@puffle.ai");
  assert.equal(input.receivedAt, "2026-06-29T17:00:00.000Z");
  assert.match(input.text, /Subject: can you check the ledger\?/);
  assert.deepEqual(input.replyTarget, {
    type: "email_thread",
    provider: "gmail",
    providerMessageId: "gmail-id-1",
    threadId: "gmail-thread-1",
    messageId: "<message-1@example.com>",
    references: [],
    inReplyTo: null,
    from: "Kush <kush@puffle.ai>",
    to: "Fluffles <fluffles@puffle.ai>",
    subject: "can you check the ledger?"
  });
});

test("records accepted email as a queued email conversation", async () => {
  await withLedgerPath(async (ledgerPath) => {
    const result = await recordEmailTask(email(), accepted(), { ledgerPath });

    assert.equal(result.disposition, "new_conversation");
    assert.equal(result.conversation.channel, "email");
    assert.equal(result.conversation.status, "queued");
    assert.equal(result.conversation.messages.length, 1);
    assert.equal(result.ledgerPath, ledgerPath);
  });
});

test("migrates a legacy provider-thread key into the canonical email key", async () => {
  await withLedgerPath(async (ledgerPath) => {
    const legacyKey = "gmail-thread:gmail-thread-1";
    const canonicalKey = "email:fluffles@puffle.ai:gmail-thread-1";
    const ledger = new SQLiteTaskLedger({ filePath: ledgerPath });
    try {
      await ledger.recordMessage({ ...buildEmailLedgerInput(email(), accepted()), conversationKey: legacyKey });
      const resolved = await resolveEmailConversationKey(ledger, email());

      assert.equal(resolved, canonicalKey);
      assert.equal(await ledger.getConversation("email", legacyKey), null);
      assert.equal((await ledger.getConversation("email", canonicalKey))?.messages.length, 1);
    } finally {
      ledger.close();
    }
  });
});

test("recognizes the legacy provider-message key for emails without a thread", () => {
  const unthreaded = email({ threadId: null, references: [], inReplyTo: null });

  assert.deepEqual(legacyEmailConversationKeys(unthreaded), ["gmail-message:<message-1@example.com>"]);
});

test("deduplicates repeated email provider messages", async () => {
  await withLedgerPath(async (ledgerPath) => {
    await recordEmailTask(email(), accepted(), { ledgerPath });
    const duplicate = await recordEmailTask(email(), accepted(), { ledgerPath });

    const ledger = new SQLiteTaskLedger({ filePath: ledgerPath });
    try {
      const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:gmail-thread-1");
      assert.equal(duplicate.disposition, "duplicate");
      assert.equal(conversation?.messages.length, 1);
    } finally {
      ledger.close();
    }
  });
});

test("keeps multiple messages in one email thread runnable together", async () => {
  await withLedgerPath(async (ledgerPath) => {
    await recordEmailTask(email(), accepted(), { ledgerPath });
    const second = await recordEmailTask(email({
      id: "gmail-id-2",
      messageId: "<message-2@example.com>",
      text: "also include the local smoke test please"
    }), accepted(), { ledgerPath });

    const ledger = new SQLiteTaskLedger({ filePath: ledgerPath });
    try {
      const runnable = await ledger.runnableConversations("email");
      assert.equal(second.disposition, "queued_update");
      assert.deepEqual(runnable.map((conversation) => conversation.conversationKey), ["email:fluffles@puffle.ai:gmail-thread-1"]);
      assert.equal(runnable[0]?.messages.length, 2);
    } finally {
      ledger.close();
    }
  });
});

test("groups replies without provider thread ids by referenced root message", () => {
  const first = email({
    id: "event-1",
    threadId: null,
    messageId: "<reply-1@example.com>",
    references: ["<root@example.com>"],
    inReplyTo: "<root@example.com>"
  });
  const second = email({
    id: "event-2",
    threadId: null,
    messageId: "<reply-2@example.com>",
    references: ["<root@example.com>", "<reply-1@example.com>"],
    inReplyTo: "<reply-1@example.com>"
  });

  assert.equal(emailConversationKey(first), "email:fluffles@puffle.ai:<root@example.com>");
  assert.equal(emailConversationKey(second), "email:fluffles@puffle.ai:<root@example.com>");
});

test("email recovery respects a live durable lease and deterministically reclaims it only after expiry", async () => {
  await withLedgerPath(async (ledgerPath) => {
    const key = "email:fluffles@puffle.ai:gmail-thread-1";
    await recordEmailTask(email(), accepted(), { ledgerPath });

    let now = new Date("2026-01-01T00:00:00.000Z");
    const ledger = new SQLiteTaskLedger({ filePath: ledgerPath, now: () => now });
    try {
      const started = await ledger.startRun("email", key);
      assert.ok(started);
      assert.equal(started.conversation.status, "running");

      const update = await recordEmailTask(email({
        id: "gmail-id-2",
        messageId: "<message-2@example.com>",
        text: "new detail while the run is active"
      }), accepted(), { ledgerPath });
      assert.equal(update.disposition, "running_update");

      const whileLeased = await ledger.recoverInterruptedRuns("email");
      assert.deepEqual(whileLeased.recoveredKeys, []);
      assert.equal((await ledger.getConversation("email", key))?.status, "running");

      now = new Date("2026-01-01T00:01:01.000Z");
      const recovery = await ledger.recoverInterruptedRuns("email");
      const conversation = await ledger.getConversation("email", key);
      const runnable = await ledger.runnableConversations("email");

      assert.deepEqual(recovery.recoveredKeys, [key]);
      assert.equal(conversation?.status, "queued");
      assert.equal(conversation?.runs[0]?.status, "interrupted");
      assert.deepEqual(runnable.map((item) => item.conversationKey), [key]);
    } finally {
      ledger.close();
    }
  });
});

test("handles burst writes to one email thread without duplicate or lost messages", async () => {
  await withLedgerPath(async (ledgerPath) => {
    const writes = Array.from({ length: 30 }, (_, index) => recordEmailTask(email({
      id: `gmail-id-${index}`,
      messageId: `<message-${index}@example.com>`,
      date: `Mon, 29 Jun 2026 10:00:${String(index).padStart(2, "0")} -0700`,
      text: `message ${index}: can you include this detail?`
    }), accepted(), { ledgerPath }));

    await Promise.all(writes);

    const ledger = new SQLiteTaskLedger({ filePath: ledgerPath });
    try {
      const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:gmail-thread-1");

      assert.equal(conversation?.messages.length, 30);
      assert.deepEqual(
        conversation?.messages.slice(0, 3).map((message) => message.text.split("\n").at(-1)),
        [
          "message 0: can you include this detail?",
          "message 1: can you include this detail?",
          "message 2: can you include this detail?"
        ]
      );
    } finally {
      ledger.close();
    }
  });
});

test("refuses to enqueue classifier-rejected email", async () => {
  await assert.rejects(
    () => recordEmailTask(email(), { shouldReply: false, reason: "newsletter" }, { ledgerPath: ":memory:" }),
    /Refusing to enqueue/
  );
});
