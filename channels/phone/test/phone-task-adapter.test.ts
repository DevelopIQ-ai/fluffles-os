import assert from "node:assert/strict";
import test from "node:test";
import { ConversationEngine, SQLiteTaskLedger } from "@fluffles/tasks";
import { AGENTPHONE_FROM_NUMBER } from "../src/agentphone-client";
import { buildPhoneCallLedgerInput, buildPhoneMessageLedgerInput, phoneCallConversationKey, phoneConversationKey, resolvePhoneConversationKey } from "../src/phone-task-adapter";
import type { NormalizedPhoneCall, NormalizedPhoneMessage } from "../src/phone-normalize";

function message(overrides: Partial<NormalizedPhoneMessage> = {}): NormalizedPhoneMessage {
  return {
    provider: "agentphone",
    id: "msg-1",
    numberId: "number-1",
    conversationId: "conv-1",
    fromNumber: "+14155550123",
    toNumber: AGENTPHONE_FROM_NUMBER,
    direction: "inbound",
    channel: "sms",
    body: "can you help?",
    mediaUrls: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    raw: { id: "msg-1" },
    ...overrides
  };
}

function call(overrides: Partial<NormalizedPhoneCall> = {}): NormalizedPhoneCall {
  return {
    provider: "agentphone",
    callId: "call-1",
    numberId: "number-1",
    conversationId: "conv-1",
    fromNumber: "+14155550123",
    toNumber: AGENTPHONE_FROM_NUMBER,
    direction: "inbound",
    status: "completed",
    summary: "caller asked for help",
    transcript: "caller: can you help?",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    raw: { id: "call-1" },
    ...overrides
  };
}

test("keys phone messages by provider conversation id", () => {
  assert.equal(phoneConversationKey(message()), "phone:conv-1");
});

test("does not use caller number in the phone conversation key", () => {
  assert.equal(phoneConversationKey(message({ fromNumber: "(415) 555-0123" })), "phone:conv-1");
  assert.equal(phoneConversationKey(message({ fromNumber: "+1 415 555 0123" })), "phone:conv-1");
});

test("fails clearly when a phone message has no provider conversation id", () => {
  assert.throws(
    () => phoneConversationKey(message({ conversationId: null })),
    /missing provider conversation id/
  );
});

test("keys calls and messages with the same provider conversation id together", () => {
  assert.equal(phoneCallConversationKey(call()), "phone:conv-1");
  assert.equal(phoneCallConversationKey(call({ fromNumber: "+1 (415) 555-0123" })), phoneConversationKey(message()));
});

test("fails clearly when a phone call has no provider conversation id", () => {
  assert.throws(
    () => phoneCallConversationKey(call({ conversationId: null })),
    /missing provider conversation id/
  );
});

test("builds central ledger input for inbound phone messages", () => {
  const input = buildPhoneMessageLedgerInput(message());
  assert.equal(input.channel, "phone");
  assert.equal(input.conversationKey, "phone:conv-1");
  assert.equal(input.externalMessageId, "msg-1");
  assert.equal(input.authorId, "+14155550123");
  assert.equal(input.replyTarget?.type, "agentphone_conversation");
  assert.equal(input.replyTarget?.fromNumber, "+14155550123");
  assert.equal(input.replyTarget?.numberId, "number-1");
  const metadata = input.metadata as Record<string, unknown>;
  assert.equal(metadata.numberId, "number-1");
  assert.match(input.text, /can you help\?/);
});

test("builds central ledger input for inbound phone calls", () => {
  const input = buildPhoneCallLedgerInput(call());
  assert.equal(input.channel, "phone");
  assert.equal(input.conversationKey, "phone:conv-1");
  assert.equal(input.externalMessageId, "call-1");
  assert.equal(input.replyTarget?.type, "agentphone_call");
});

test("migrates an idle legacy lane with one proven provider conversation id", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  const engine = new ConversationEngine({ ledger });
  const legacyKey = "phone:+14155550123";
  const canonicalKey = "phone:conv-migrate";
  try {
    await engine.ingest({
      ...buildPhoneMessageLedgerInput(message({ id: "legacy-message", conversationId: "conv-migrate" })),
      conversationKey: legacyKey,
      intakeMode: "direct"
    });

    assert.equal(await resolvePhoneConversationKey(engine, message({ id: "current-message", conversationId: "conv-migrate" })), canonicalKey);
    assert.equal(await engine.getConversation("phone", legacyKey), null);
    const migrated = await engine.getConversation("phone", canonicalKey);
    assert.deepEqual(migrated?.messages.map((item) => item.externalMessageId), ["legacy-message"]);
  } finally {
    ledger.close();
  }
});

test("leaves unproven, active, call-only, and conflicting legacy lanes untouched", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  const engine = new ConversationEngine({ ledger });
  const conversationId = "conv-target";
  const ambiguousKey = "phone:+14155550101";
  const incompleteKey = "phone:+14155550102";
  const conflictingKey = "phone:+14155550103";
  const activeKey = "phone:+14155550104";
  const callOnlyKey = "phone:+14155550105";
  const duplicateKey = "phone:+14155550106";
  try {
    await engine.ingest({ ...buildPhoneMessageLedgerInput(message({ id: "ambiguous-a", conversationId })), conversationKey: ambiguousKey, intakeMode: "direct" });
    await engine.ingest({ ...buildPhoneMessageLedgerInput(message({ id: "ambiguous-b", conversationId: "conv-other" })), conversationKey: ambiguousKey, intakeMode: "direct" });

    const incomplete = buildPhoneMessageLedgerInput(message({ id: "incomplete", conversationId }));
    await engine.ingest({ ...incomplete, conversationKey: incompleteKey, metadata: { ...incomplete.metadata, conversationId: null }, intakeMode: "direct" });

    const conflicting = buildPhoneMessageLedgerInput(message({ id: "conflicting", conversationId }));
    await engine.ingest({ ...conflicting, conversationKey: conflictingKey, replyTarget: { ...conflicting.replyTarget, conversationId: "conv-other" }, intakeMode: "direct" });

    await engine.ingest({ ...buildPhoneMessageLedgerInput(message({ id: "active", conversationId })), conversationKey: activeKey, intakeMode: "direct" });
    assert.ok(await engine.startRun("phone", activeKey));

    await engine.ingest({ ...buildPhoneCallLedgerInput(call({ callId: "call-only", conversationId })), conversationKey: callOnlyKey, intakeMode: "direct" });

    await engine.ingest({ ...buildPhoneMessageLedgerInput(message({ id: "duplicate", conversationId })), intakeMode: "direct" });
    await engine.ingest({ ...buildPhoneMessageLedgerInput(message({ id: "duplicate", conversationId })), conversationKey: duplicateKey, intakeMode: "direct" });

    assert.equal(await resolvePhoneConversationKey(engine, message({ id: "current", conversationId })), "phone:conv-target");
    for (const legacyKey of [ambiguousKey, incompleteKey, conflictingKey, activeKey, callOnlyKey, duplicateKey]) {
      assert.ok(await engine.getConversation("phone", legacyKey), `${legacyKey} must remain untouched`);
    }
  } finally {
    ledger.close();
  }
});
