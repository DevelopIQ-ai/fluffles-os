import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ConversationEngine } from "../src/conversation-engine";
import {
  CodexProcessRunner,
  ConversationRuntime,
  DEPLOYMENT_CHECKPOINT_REASON,
  DeliveryInterruptedError,
  type ConversationRuntimeTransport
} from "../src/conversation-runtime";
import { deploymentUpdateNotice } from "../src/deployment-notice";
import { SQLiteTaskLedger } from "../src/task-ledger";

const emailKey = "email:account:thread";
const slackKey = "slack:T1:C1:1000.0001";

test("runtime startRun honors durable deployment admission state", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    await ledger.setDeploymentLifecycle("draining");
    await engine.ingest({
      channel: "email",
      conversationKey: emailKey,
      externalMessageId: "drain-message-1",
      authorId: "person@example.com",
      text: "keep this message",
      intakeMode: "direct"
    });

    assert.equal(await runtime.startRun("email", emailKey), null, "runtime does not start work while draining");
    assert.equal((await ledger.getConversation("email", emailKey))?.messages.length, 1, "intake remains durable while draining");

    await ledger.setDeploymentLifecycle("normal");
    assert.ok(await runtime.startRun("email", emailKey), "runtime starts the queued work after deployment reopens admission");
  } finally {
    ledger.close();
  }
});

test("Slack stop, status, and ambient replies use durable ambiguity recovery without duplicate assistant history", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    await engine.ingest({ channel: "slack", conversationKey: slackKey, externalMessageId: "control-source", authorId: "U1", text: "work", intakeMode: "direct" });
    await engine.stop("slack", slackKey, "user_stop");
    let sends = 0;
    const runtime = new ConversationRuntime(engine, undefined, { deliveryErrorsMayBeAmbiguous: true, acceptanceUnknownRetryDelayMs: 1 });
    for (const [index, control] of [
      ["stop", "Stopped queued work."],
      ["status", "No active run in this thread."],
      ["ambient", "here."]
    ] as const) {
      let visible = false;
      const input = {
        channel: "slack" as const,
        conversationKey: slackKey,
        provider: "slack",
        idempotencyKey: `00000000-0000-4000-8000-00000000000${index === "stop" ? "1" : index === "status" ? "2" : "3"}`,
        payload: { text: control },
        assistantMessage: { text: control },
        reconcileDelivery: async () => visible ? { providerMessageId: `control-${index}` } : null,
        deliver: async () => {
          sends += 1;
          visible = true;
          throw Object.assign(new Error("Slack timeout after acceptance"), { code: "ETIMEDOUT" });
        }
      };

      assert.equal(await runtime.deliverControlReply(input), false);
      assert.equal((await engine.outboundDeliveries("slack", slackKey)).at(-1)?.status, "acceptance_unknown");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const restarted = new ConversationRuntime(engine, undefined, { deliveryErrorsMayBeAmbiguous: true, acceptanceUnknownRetryDelayMs: 1 });
      assert.deepEqual(await restarted.recoverControlReplies("slack", { reconcileDelivery: input.reconcileDelivery, deliver: input.deliver }), [true]);
    }
    assert.equal(sends, 3);
    assert.deepEqual((await engine.getConversation("slack", slackKey))?.messages.map((message) => message.role), ["user", "assistant", "assistant", "assistant"]);
    assert.ok((await engine.lifecycleEvents("slack", slackKey)).some((event) => event.kind === "delivery_confirmed"));
  } finally {
    ledger.close();
  }
});

test("concurrent control-delivery callers send one Slack reply and persist one assistant message", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const conversationKey = "slack:T1:C1:control-race";
    const engine = new ConversationEngine({ ledger });
    await engine.ingest({ channel: "slack", conversationKey, externalMessageId: "control-race-source", authorId: "U1", text: "work", intakeMode: "direct" });
    await engine.stop("slack", conversationKey, "user_stop");
    const firstRuntime = new ConversationRuntime(engine);
    const secondRuntime = new ConversationRuntime(engine);
    let sends = 0;
    const control = {
      channel: "slack" as const,
      conversationKey,
      provider: "slack",
      idempotencyKey: "00000000-0000-4000-8000-000000000002",
      payload: { text: "Stopped queued work." },
      assistantMessage: { text: "Stopped queued work." },
      reconcileDelivery: async () => null
    };

    const first = firstRuntime.deliverControlReply({
      ...control,
      deliver: async () => {
        sends += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { providerMessageId: "control-race" };
      }
    });
    const second = secondRuntime.deliverControlReply({
      ...control,
      deliver: async () => {
        sends += 1;
        return { providerMessageId: "control-race-duplicate" };
      }
    });
    assert.deepEqual(await Promise.all([first, second]), [true, false]);
    assert.equal(sends, 1);
    assert.deepEqual((await engine.getConversation("slack", conversationKey))?.messages.map((message) => message.role), ["user", "assistant"]);
  } finally {
    ledger.close();
  }
});

test("runtime fails safely before model execution when the current request exceeds the context budget", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const key = "slack:T1:C1:context-budget";
    await engine.ingest({
      channel: "slack",
      conversationKey: key,
      externalMessageId: "context-budget-message",
      authorId: "U1",
      text: "this request cannot fit",
      intakeMode: "direct"
    });
    let modelCalls = 0;
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 2,
      summaryMaxChars: 2_000,
      prepare: async () => null,
      createSummary: async () => "summary",
      generate: async () => { modelCalls += 1; return "should not run"; },
      shouldDeliver: () => false,
      assistantMessage: () => ({ channel: "slack", conversationKey: key, text: "should not run" }),
      deliveryPayload: () => ({ body: "should not run" }),
      reconcileDelivery: async () => null,
      deliver: async () => ({ providerMessageId: "should-not-deliver" }),
      skipped: async () => {},
      failed: async () => {}
    };

    assert.deepEqual(await runtime.processConversation(transport, key), [false]);
    assert.equal(modelCalls, 0);
    assert.equal((await engine.getConversation("slack", key))?.status, "failed");
    assert.equal((await engine.lifecycleEvents("slack", key)).at(-1)?.kind, "failed");
  } finally {
    ledger.close();
  }
});

test("runtime reserves budget for task and resume inputs before model execution", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const key = "slack:T1:C1:runtime-context-budget";
    await engine.ingest({
      channel: "slack",
      conversationKey: key,
      externalMessageId: "runtime-context-budget-message",
      authorId: "U1",
      text: "fit",
      intakeMode: "direct"
    });
    let modelCalls = 0;
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 10,
      summaryMaxChars: 2_000,
      prepare: async () => null,
      createSummary: async () => "summary",
      generate: async () => { modelCalls += 1; return "should not run"; },
      shouldDeliver: () => false,
      assistantMessage: () => ({ channel: "slack", conversationKey: key, text: "should not run" }),
      deliveryPayload: () => ({ body: "should not run" }),
      reconcileDelivery: async () => null,
      deliver: async () => ({ providerMessageId: "should-not-deliver" }),
      skipped: async () => {},
      failed: async () => {}
    };

    assert.deepEqual(await runtime.processConversation(transport, key), [false]);
    assert.equal(modelCalls, 0);
    assert.equal((await engine.getConversation("slack", key))?.status, "failed");
  } finally {
    ledger.close();
  }
});

test("runtime owns memory injection and reserves fixed prompt capacity before selecting context", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    let memoryLoads = 0;
    const runtime = new ConversationRuntime(engine, undefined, {
      loadMemoryContext: async () => {
        memoryLoads += 1;
        return "durable shared memory that must be budgeted";
      },
      maxMemoryContextTokens: 100
    });
    const key = "slack:T1:C1:runtime-memory-budget";
    await engine.admit({
      channel: "slack",
      conversationKey: key,
      externalMessageId: "runtime-memory-message",
      authorId: "U1",
      text: "fit this request",
      intakeMode: "direct"
    }, { actionable: true });
    const instructions = ["provider instruction"];
    let prompt = "";
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 1_000,
      summaryMaxChars: 2_000,
      providerInstructions: instructions,
      prepare: async () => null,
      createSummary: async () => "summary",
      generate: async (input) => {
        prompt = input.prompt ?? "";
        return "ok";
      },
      shouldDeliver: () => false,
      assistantMessage: () => ({ channel: "slack", conversationKey: key, text: "not delivered" }),
      deliveryPayload: () => ({ body: "not delivered" }),
      reconcileDelivery: async () => null,
      deliver: async () => ({ providerMessageId: "not delivered" }),
      skipped: async () => {},
      failed: async () => {}
    };

    assert.deepEqual(await runtime.processConversation(transport, key), [true]);
    assert.equal(memoryLoads, 1);
    assert.match(prompt, /provider instruction/);
    assert.match(prompt, /durable shared/);
    assert.match(prompt, /"conversationKey"/);
  } finally {
    ledger.close();
  }
});

test("runtime builds the compaction prompt before calling a transport summary executor", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const key = "email:account:runtime-compaction-prompt";
    const firstRequest = "first request that needs a durable handoff. ".repeat(100);
    const secondRequest = "second request after the completed run. ".repeat(100);
    await engine.admit({
      channel: "email",
      conversationKey: key,
      externalMessageId: "compaction-first",
      authorId: "person@example.com",
      text: firstRequest,
      intakeMode: "direct"
    }, { actionable: true });
    const first = await runtime.startRun("email", key);
    assert.ok(first);
    await runtime.finishRun("email", key, first.run.id, "done");
    await engine.admit({
      channel: "email",
      conversationKey: key,
      externalMessageId: "compaction-second",
      authorId: "person@example.com",
      text: secondRequest,
      intakeMode: "direct"
    }, { actionable: true });

    let observedPrompt = "";
    assert.equal(await runtime.compactIfNeeded({
      channel: "email",
      conversationKey: key,
      maxContextTokens: 5_000,
      summaryMaxChars: 2_000,
      createSummary: async (_previous, _messages, prompt) => {
        observedPrompt = prompt;
        return "runtime-owned checkpoint";
      }
    }), true);

    assert.match(observedPrompt, /Create a concise handoff summary/);
    assert.match(observedPrompt, /first request that needs a durable handoff/);
    assert.equal((await engine.getConversation("email", key))?.compactionSummary, "runtime-owned checkpoint");
  } finally {
    ledger.close();
  }
});

test("Slack, email, and phone transports receive prompts from the same runtime pipeline", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    for (const [channel, key] of [
      ["slack", "slack:T1:C1:shared-prompt"],
      ["email", "email:account:shared-prompt"],
      ["phone", "phone:shared-prompt"]
    ] as const) {
      await engine.admit({
        channel,
        conversationKey: key,
        externalMessageId: `${channel}-prompt-message`,
        authorId: "person-1",
        text: `request through ${channel}`,
        intakeMode: "direct"
      }, { actionable: true });
      let prompt = "";
      const transport: ConversationRuntimeTransport<null, string> = {
        channel,
        provider: `${channel}-provider`,
        maxContextTokens: 10_000,
        summaryMaxChars: 2_000,
        providerInstructions: [`provider instruction for ${channel}`],
        prepare: async () => null,
        createSummary: async () => "summary",
        generate: async (input) => {
          prompt = input.prompt ?? "";
          return "no delivery";
        },
        shouldDeliver: () => false,
        assistantMessage: () => ({ channel, conversationKey: key, text: "not delivered" }),
        deliveryPayload: () => ({ body: "not delivered" }),
        reconcileDelivery: async () => null,
        deliver: async () => ({ providerMessageId: "not delivered" }),
        skipped: async () => {},
        failed: async () => {}
      };
      assert.deepEqual(await runtime.processConversation(transport, key), [true]);
      assert.match(prompt, new RegExp(`provider instruction for ${channel}`));
      assert.match(prompt, new RegExp(`request through ${channel}`));
      assert.match(prompt, /"checkpointSummary"/);
      assert.match(prompt, /"messages"/);
      assert.match(prompt, /Assistant response:/);
    }
  } finally {
    ledger.close();
  }
});

test("provider timeout reconciles an accepted delivery before the runtime releases dispatch", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const key = "slack:T1:C1:dispatch-timeout";
    await engine.admit({
      channel: "slack",
      conversationKey: key,
      externalMessageId: "dispatch-timeout-message",
      authorId: "U1",
      text: "reply once",
      intakeMode: "direct"
    }, { actionable: true });
    let deliveries = 0;
    let reconciliations = 0;
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 1_000,
      summaryMaxChars: 2_000,
      prepare: async () => null,
      createSummary: async () => "summary",
      generate: async () => "accepted response",
      shouldDeliver: () => true,
      assistantMessage: (decision) => ({ channel: "slack", conversationKey: key, text: decision }),
      deliveryPayload: () => ({ text: "accepted response" }),
      reconcileDelivery: async () => {
        reconciliations += 1;
        return { providerMessageId: "slack-ts-accepted", reconciled: true };
      },
      deliver: async () => {
        deliveries += 1;
        throw new Error("provider timeout after request write");
      },
      skipped: async () => {},
      failed: async () => {}
    };

    assert.deepEqual(await runtime.processConversation(transport, key), [true]);
    assert.equal(deliveries, 1);
    assert.equal(reconciliations, 1);
    const conversation = await engine.getConversation("slack", key);
    assert.equal(conversation?.status, "done");
    assert.equal(conversation?.messages.filter((message) => message.role === "assistant").length, 1);
  } finally {
    ledger.close();
  }
});

test("an ambiguous Gmail timeout is durably reconciled and cannot resend before its retry delay", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:", now: () => now });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine, undefined, {
      deliveryErrorsMayBeAmbiguous: true,
      acceptanceUnknownRetryDelayMs: 1_000,
      now: () => now
    });
    const key = "email:account:ambiguous-timeout";
    await engine.admit({
      channel: "email", conversationKey: key, externalMessageId: "ambiguous-timeout-message",
      authorId: "person@example.com", text: "reply once", intakeMode: "direct"
    }, { actionable: true });
    let sends = 0;
    let reconciliations = 0;
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "email", provider: "gmail", maxContextTokens: 1_000, summaryMaxChars: 2_000,
      prepare: async () => null, createSummary: async () => "summary", generate: async () => "reply",
      shouldDeliver: () => true,      assistantMessage: (decision) => ({ channel: "email", conversationKey: key, text: decision }),
      deliveryPayload: () => ({ body: "reply" }),
      reconcileDelivery: async () => { reconciliations += 1; return null; },
      deliver: async () => {
        sends += 1;
        if (sends === 1) throw Object.assign(new Error("Gmail request timed out"), { code: "ETIMEDOUT" });
        return { providerMessageId: "gmail-retry" };
      },
      skipped: async () => {}, failed: async () => {}
    };

    assert.deepEqual(await runtime.processConversation(transport, key), [false]);
    let delivery = (await engine.outboundDeliveries("email", key))[0];
    assert.equal(delivery?.status, "acceptance_unknown");
    assert.equal(delivery?.attemptCount, 1);
    assert.equal(delivery?.acceptanceUnknownAt, now.toISOString());
    assert.equal((await engine.getConversation("email", key))?.status, "queued");
    assert.equal((await engine.getConversation("email", key))?.messages.filter((message) => message.role === "assistant").length, 0);

    assert.deepEqual(await runtime.processConversation(transport, key), [false]);
    assert.equal(sends, 1, "a negative reconciliation cannot immediately resend Gmail");
    assert.equal(reconciliations, 2);
    assert.equal((await engine.outboundDeliveries("email", key))[0]?.status, "acceptance_unknown");

    now = new Date(now.getTime() + 1_000);
    assert.deepEqual(await runtime.processConversation(transport, key), [true]);
    delivery = (await engine.outboundDeliveries("email", key))[0];
    assert.equal(sends, 2);
    assert.equal(delivery?.status, "delivered");
    assert.equal(delivery?.attemptCount, 2);
    assert.equal((await engine.getConversation("email", key))?.messages.filter((message) => message.role === "assistant").length, 1);
    assert.ok((await engine.lifecycleEvents("email", key)).some((event) => event.kind === "delivery_acceptance_unknown"));
  } finally {
    ledger.close();
  }
});

test("a Gmail network partition survives restart and confirms an eventually visible provider acceptance without resend", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gmail-acceptance-unknown-restart-"));
  let now = new Date("2026-01-01T00:00:00.000Z");
  const ledgerPath = path.join(dir, "tasks.sqlite");
  let providerAccepted = false;
  let reconciliationAvailable = false;
  let sends = 0;
  const transport = (key: string): ConversationRuntimeTransport<null, string> => ({
    channel: "email", provider: "gmail", maxContextTokens: 1_000, summaryMaxChars: 2_000,
    prepare: async () => null, createSummary: async () => "summary", generate: async () => "must not execute again",
    shouldDeliver: () => true,    assistantMessage: (decision) => ({ channel: "email", conversationKey: key, text: decision }),
    deliveryPayload: () => ({ body: "reply" }),
    reconcileDelivery: async () => {
      if (!reconciliationAvailable) throw new Error("Gmail network partition");
      return providerAccepted ? { providerMessageId: "gmail-eventually-visible", reconciled: true } : null;
    },
    deliver: async () => {
      sends += 1;
      throw Object.assign(new Error("Gmail socket reset after request write"), { code: "ECONNRESET" });
    },
    skipped: async () => {}, failed: async () => {}
  });
  const key = "email:account:partition-restart";
  const firstLedger = new SQLiteTaskLedger({ filePath: ledgerPath, now: () => now, runProcessExists: () => false });
  try {
    const firstEngine = new ConversationEngine({ ledger: firstLedger });
    const firstRuntime = new ConversationRuntime(firstEngine, undefined, {
      deliveryErrorsMayBeAmbiguous: true,
      acceptanceUnknownRetryDelayMs: 60_000,
      now: () => now
    });
    await firstEngine.admit({
      channel: "email", conversationKey: key, externalMessageId: "partition-message",
      authorId: "person@example.com", text: "reply once", intakeMode: "direct"
    }, { actionable: true });
    assert.deepEqual(await firstRuntime.processConversation(transport(key), key), [false]);
    assert.equal((await firstEngine.outboundDeliveries("email", key))[0]?.status, "acceptance_unknown");
  } finally {
    firstLedger.close();
  }

  providerAccepted = true;
  reconciliationAvailable = true;
  const restartedLedger = new SQLiteTaskLedger({ filePath: ledgerPath, now: () => now, runProcessExists: () => false });
  try {
    const restartedEngine = new ConversationEngine({ ledger: restartedLedger });
    const restartedRuntime = new ConversationRuntime(restartedEngine, undefined, {
      deliveryErrorsMayBeAmbiguous: true,
      acceptanceUnknownRetryDelayMs: 60_000,
      now: () => now
    });
    await restartedRuntime.recover("email");
    assert.deepEqual(await restartedRuntime.processConversation(transport(key), key), [true]);
    assert.equal(sends, 1, "restart reconciles the original idempotency key instead of sending again");
    assert.equal((await restartedEngine.outboundDeliveries("email", key))[0]?.status, "delivered");
    assert.equal((await restartedEngine.getConversation("email", key))?.messages.filter((message) => message.role === "assistant").length, 1);
  } finally {
    restartedLedger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Slack and Phone retain ambiguous deliveries through concurrent recovery and confirm delayed provider visibility without resend", async () => {
  for (const [channel, key, provider] of [
    ["slack", "slack:T1:C1:delayed-provider-visibility", "slack"],
    ["phone", "phone:delayed-provider-visibility", "agentphone"]
  ] as const) {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const ledger = new SQLiteTaskLedger({ filePath: ":memory:", now: () => now });
    try {
      const engine = new ConversationEngine({ ledger });
      const runtime = new ConversationRuntime(engine, undefined, {
        deliveryErrorsMayBeAmbiguous: true,
        acceptanceUnknownRetryDelayMs: 60_000,
        now: () => now
      });
      let providerVisible = false;
      let sends = 0;
      let generated = 0;
      const transport: ConversationRuntimeTransport<null, string> = {
        channel,
        provider,
        maxContextTokens: 1_000,
        summaryMaxChars: 2_000,
        prepare: async () => null,
        createSummary: async () => "summary",
        generate: async () => {
          generated += 1;
          return `${channel} response`;
        },
        shouldDeliver: () => true,
        assistantMessage: (decision) => ({ channel, conversationKey: key, text: decision }),
        deliveryPayload: () => ({ text: `${channel} response` }),
        reconcileDelivery: async (delivery) => providerVisible
          ? { providerMessageId: `${channel}-eventually-visible`, idempotencyKey: delivery.idempotencyKey, reconciled: true }
          : null,
        deliver: async () => {
          sends += 1;
          throw Object.assign(new Error(`${channel} provider timeout after accepting request`), { code: "ETIMEDOUT" });
        },
        skipped: async () => {},
        failed: async () => {}
      };

      await engine.admit({
        channel,
        conversationKey: key,
        externalMessageId: `${channel}-ambiguous-message`,
        authorId: "person-1",
        text: "reply once",
        intakeMode: "direct"
      }, { actionable: true });
      assert.deepEqual(await runtime.processConversation(transport, key), [false]);
      assert.equal((await engine.outboundDeliveries(channel, key))[0]?.status, "acceptance_unknown");
      assert.equal(sends, 1);

      await Promise.all([
        runtime.processTransport(transport, 1),
        runtime.processTransport(transport, 1)
      ]);
      assert.equal(sends, 1, `${channel} cannot resend while provider acceptance remains unknown`);

      providerVisible = true;
      assert.deepEqual(await runtime.processConversation(transport, key), [true]);
      const conversation = await engine.getConversation(channel, key);
      const delivery = (await engine.outboundDeliveries(channel, key))[0];
      assert.equal(sends, 1, `${channel} confirms the existing provider effect without another send`);
      assert.equal(generated, 1, `${channel} does not regenerate the model reply`);
      assert.equal(delivery?.status, "delivered");
      assert.equal(conversation?.messages.filter((message) => message.role === "assistant").length, 1);
    } finally {
      ledger.close();
    }
  }
});

test("Slack and Phone retry an unresolved ambiguous delivery only after the runtime reconciliation delay", async () => {
  for (const [channel, key, provider] of [
    ["slack", "slack:T1:C1:ambiguous-retry-delay", "slack"],
    ["phone", "phone:ambiguous-retry-delay", "agentphone"]
  ] as const) {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const ledger = new SQLiteTaskLedger({ filePath: ":memory:", now: () => now });
    try {
      const engine = new ConversationEngine({ ledger });
      const runtime = new ConversationRuntime(engine, undefined, {
        deliveryErrorsMayBeAmbiguous: true,
        acceptanceUnknownRetryDelayMs: 1_000,
        now: () => now
      });
      let sends = 0;
      const transport: ConversationRuntimeTransport<null, string> = {
        channel,
        provider,
        maxContextTokens: 1_000,
        summaryMaxChars: 2_000,
        prepare: async () => null,
        createSummary: async () => "summary",
        generate: async () => `${channel} response`,
        shouldDeliver: () => true,
        assistantMessage: (decision) => ({ channel, conversationKey: key, text: decision }),
        deliveryPayload: () => ({ text: `${channel} response` }),
        reconcileDelivery: async () => null,
        deliver: async () => {
          sends += 1;
          if (sends === 1) throw Object.assign(new Error(`${channel} provider timeout`), { code: "ETIMEDOUT" });
          return { providerMessageId: `${channel}-retry` };
        },
        skipped: async () => {},
        failed: async () => {}
      };

      await engine.admit({
        channel,
        conversationKey: key,
        externalMessageId: `${channel}-retry-message`,
        authorId: "person-1",
        text: "reply once",
        intakeMode: "direct"
      }, { actionable: true });
      assert.deepEqual(await runtime.processConversation(transport, key), [false]);
      assert.deepEqual(await runtime.processConversation(transport, key), [false]);
      assert.equal(sends, 1, `${channel} must not retry before the reconciliation window expires`);

      now = new Date(now.getTime() + 1_000);
      assert.deepEqual(await runtime.processConversation(transport, key), [true]);
      const delivery = (await engine.outboundDeliveries(channel, key))[0];
      assert.equal(sends, 2);
      assert.equal(delivery?.attemptCount, 2);
      assert.equal(delivery?.status, "delivered");
      assert.equal((await engine.getConversation(channel, key))?.messages.filter((message) => message.role === "assistant").length, 1);
    } finally {
      ledger.close();
    }
  }
});

test("Slack and Phone restart recovery reconciles an acceptance_unknown delivery exactly once across concurrent workers", async () => {
  for (const [channel, key, provider] of [
    ["slack", "slack:T1:C1:ambiguous-restart", "slack"],
    ["phone", "phone:ambiguous-restart", "agentphone"]
  ] as const) {
    const dir = await mkdtemp(path.join(os.tmpdir(), `${channel}-acceptance-unknown-restart-`));
    const filePath = path.join(dir, "tasks.sqlite");
    let providerVisible = false;
    let sends = 0;
    const transport: ConversationRuntimeTransport<null, string> = {
      channel,
      provider,
      maxContextTokens: 1_000,
      summaryMaxChars: 2_000,
      prepare: async () => null,
      createSummary: async () => "summary",
      generate: async () => "must not regenerate",
      shouldDeliver: () => true,
      assistantMessage: (decision) => ({ channel, conversationKey: key, text: decision }),
      deliveryPayload: () => ({ text: `${channel} response` }),
      reconcileDelivery: async (delivery) => providerVisible
        ? { providerMessageId: `${channel}-reconciled`, idempotencyKey: delivery.idempotencyKey, reconciled: true }
        : null,
      deliver: async () => {
        sends += 1;
        throw Object.assign(new Error(`${channel} timed out after provider acceptance`), { code: "ETIMEDOUT" });
      },
      skipped: async () => {},
      failed: async () => {}
    };
    const firstLedger = new SQLiteTaskLedger({ filePath, runProcessExists: () => false });
    try {
      const firstEngine = new ConversationEngine({ ledger: firstLedger });
      const firstRuntime = new ConversationRuntime(firstEngine, undefined, {
        deliveryErrorsMayBeAmbiguous: true,
        acceptanceUnknownRetryDelayMs: 60_000
      });
      await firstEngine.admit({
        channel,
        conversationKey: key,
        externalMessageId: `${channel}-restart-message`,
        authorId: "person-1",
        text: "reply once",
        intakeMode: "direct"
      }, { actionable: true });
      assert.deepEqual(await firstRuntime.processConversation(transport, key), [false]);
      assert.equal((await firstEngine.outboundDeliveries(channel, key))[0]?.status, "acceptance_unknown");
    } finally {
      firstLedger.close();
    }

    const leftLedger = new SQLiteTaskLedger({ filePath, runProcessExists: () => false });
    const rightLedger = new SQLiteTaskLedger({ filePath, runProcessExists: () => false });
    try {
      const leftRuntime = new ConversationRuntime(new ConversationEngine({ ledger: leftLedger }), undefined, {
        deliveryErrorsMayBeAmbiguous: true,
        acceptanceUnknownRetryDelayMs: 60_000
      });
      const rightEngine = new ConversationEngine({ ledger: rightLedger });
      const rightRuntime = new ConversationRuntime(rightEngine, undefined, {
        deliveryErrorsMayBeAmbiguous: true,
        acceptanceUnknownRetryDelayMs: 60_000
      });
      await Promise.all([leftRuntime.recover(channel), rightRuntime.recover(channel)]);
      providerVisible = true;
      await Promise.all([
        leftRuntime.processTransport(transport, 1),
        rightRuntime.processTransport(transport, 1)
      ]);
      const delivery = (await rightEngine.outboundDeliveries(channel, key))[0];
      const conversation = await rightEngine.getConversation(channel, key);
      assert.equal(sends, 1, `${channel} recovery must not replay an eventually visible provider effect`);
      assert.equal(delivery?.status, "delivered");
      assert.equal(conversation?.messages.filter((message) => message.role === "assistant").length, 1);
    } finally {
      leftLedger.close();
      rightLedger.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("durable run leases prevent stale dispatch and let concurrent recovery deliver exactly once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "conversation-runtime-run-lease-"));
  const filePath = path.join(dir, "tasks.sqlite");
  const key = "slack:T1:C1:run-lease";
  let now = Date.parse("2026-01-01T00:00:00.000Z");
  const clock = () => new Date(now);
  let sends = 0;
  const transport: ConversationRuntimeTransport<null, string> = {
    channel: "slack",
    provider: "slack",
    maxContextTokens: 100_000,
    summaryMaxChars: 2_000,
    prepare: async () => null,
    createSummary: async () => "summary",
    generate: async () => "must not regenerate",
    shouldDeliver: () => true,
    assistantMessage: () => ({ channel: "slack", conversationKey: key, text: "lease-protected reply" }),
    deliveryPayload: () => ({ body: "lease-protected reply" }),
    reconcileDelivery: async () => null,
    deliver: async () => {
      sends += 1;
      return { providerMessageId: "lease-protected-reply" };
    },
    skipped: async () => {},
    failed: async () => {}
  };
  try {
    const firstLedger = new SQLiteTaskLedger({ filePath, now: clock });
    const firstEngine = new ConversationEngine({ ledger: firstLedger });
    const firstRuntime = new ConversationRuntime(firstEngine, undefined, {
      workerInstanceId: "worker-a",
      runLeaseDurationMs: 1_000,
      runLeaseHeartbeatMs: 100,
      now: clock
    });
    await firstEngine.admit({
      channel: "slack", conversationKey: key, externalMessageId: "lease-message", authorId: "U1",
      text: "send one reply", intakeMode: "direct"
    }, { actionable: true });
    const started = await firstRuntime.startRun("slack", key);
    assert.ok(started);
    const delivery = await firstEngine.createOutboundDelivery({
      channel: "slack", conversationKey: key, runId: started.run.id,
      provider: "slack", idempotencyKey: "run-lease-idempotency", payload: { body: "lease-protected reply" },
      assistantMessage: { text: "lease-protected reply" }
    });
    const staleLease = {
      workerInstanceId: started.run.workerInstanceId!,
      leaseExpiresAt: started.run.leaseExpiresAt!
    };

    now += 1_001;
    const secondLedger = new SQLiteTaskLedger({ filePath, now: clock });
    const thirdLedger = new SQLiteTaskLedger({ filePath, now: clock });
    const secondRuntime = new ConversationRuntime(new ConversationEngine({ ledger: secondLedger }), undefined, {
      workerInstanceId: "worker-b", runLeaseDurationMs: 1_000, runLeaseHeartbeatMs: 100, now: clock
    });
    const thirdRuntime = new ConversationRuntime(new ConversationEngine({ ledger: thirdLedger }), undefined, {
      workerInstanceId: "worker-c", runLeaseDurationMs: 1_000, runLeaseHeartbeatMs: 100, now: clock
    });

    const recovery = await Promise.all([secondRuntime.recover("slack"), thirdRuntime.recover("slack")]);
    assert.equal(recovery.filter((result) => result.recoveredKeys.includes(key)).length, 1);
    await assert.rejects(
      firstEngine.beginOutboundDeliveryDispatch(delivery.id, started.run.id, staleLease),
      /inactive run|no longer owned/
    );

    await Promise.all([
      secondRuntime.processTransport(transport, 10),
      thirdRuntime.processTransport(transport, 10)
    ]);
    assert.equal(sends, 1, "only the current lease holder can dispatch the durable idempotency key");
    assert.equal((await secondLedger.outboundDeliveries("slack", key))[0]?.status, "delivered");
    assert.equal((await secondLedger.getConversation("slack", key))?.messages.filter((message) => message.role === "assistant").length, 1);
    firstLedger.close();
    secondLedger.close();
    thirdLedger.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a channel error-reporting failure cannot leave a failed run active", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const key = "slack:T1:C1:error-reporting-failure";
    await engine.ingest({
      channel: "slack",
      conversationKey: key,
      externalMessageId: "error-reporting-message",
      authorId: "U1",
      text: "please work on this",
      intakeMode: "direct"
    });
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 100_000,
      summaryMaxChars: 2_000,
      prepare: async () => null,
      createSummary: async () => "summary",
      generate: async () => { throw new Error("model execution failed"); },
      shouldDeliver: () => false,
      assistantMessage: () => ({ channel: "slack", conversationKey: key, text: "not used" }),
      deliveryPayload: () => ({ body: "not used" }),
      reconcileDelivery: async () => null,
      deliver: async () => ({ providerMessageId: "not used" }),
      skipped: async () => {},
      failed: async () => { throw new Error("channel error reporting failed"); }
    };

    await assert.rejects(
      runtime.processConversation(transport, key),
      /channel error reporting failed/
    );
    const conversation = await engine.getConversation("slack", key);
    assert.equal(conversation?.status, "failed");
    assert.equal(conversation?.runs[0]?.status, "failed");
    assert.equal(conversation?.runs[0]?.error, "model execution failed");
    assert.equal(conversation?.lastError, "model execution failed");
  } finally {
    ledger.close();
  }
});

test("Slack, email, and phone resume queued work after a restart to a durable result", async () => {
  for (const channel of ["slack", "email", "phone"] as const) {
    const dir = await mkdtemp(path.join(os.tmpdir(), `conversation-runtime-${channel}-task-registry-`));
    const filePath = path.join(dir, "tasks.sqlite");
    const key = `${channel}:task-registry`;
    const objective = `finish ${channel} work`;
    const result = `${channel} work completed`;
    try {
      const firstLedger = new SQLiteTaskLedger({ filePath });
      const firstEngine = new ConversationEngine({ ledger: firstLedger });
      await firstEngine.ingest({
        channel,
        conversationKey: key,
        externalMessageId: `${channel}-task-message`,
        authorId: "user",
        text: objective,
        intakeMode: "direct"
      });
      const firstRuntime = new ConversationRuntime(firstEngine, undefined, { workerInstanceId: `${channel}-worker` });
      const started = await firstRuntime.startRun(channel, key);
      assert.ok(started, "the run starts before the simulated crash");
      firstLedger.close();

      const restartedLedger = new SQLiteTaskLedger({ filePath });
      const restartedEngine = new ConversationEngine({ ledger: restartedLedger });
      const runtime = new ConversationRuntime(restartedEngine, undefined, { workerInstanceId: `${channel}-worker` });
      const recovery = await runtime.recover(channel, { reclaimOwnLeases: true });
      assert.ok(recovery.runnableKeys.includes(key), `${channel} recovery re-queues the interrupted conversation`);
      const transport: ConversationRuntimeTransport<null, string> = {
        channel,
        provider: `${channel}-provider`,
        maxContextTokens: 100_000,
        summaryMaxChars: 2_000,
        prepare: async () => null,
        createSummary: async () => "summary",
        generate: async () => result,
        shouldDeliver: () => false,
        assistantMessage: () => ({ channel, conversationKey: key, text: result }),
        deliveryPayload: () => ({ body: result }),
        reconcileDelivery: async () => null,
        deliver: async () => ({ providerMessageId: "not-used" }),
        skipped: async () => {},
        failed: async () => {}
      };

      assert.deepEqual(await runtime.processConversation(transport, key), [true]);
      const conversation = await restartedEngine.getConversation(channel, key);
      assert.equal(conversation?.status, "done");
      assert.equal(conversation?.runs.at(-1)?.status, "done");
      restartedLedger.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("failed Slack delivery does not persist assistant output into future context", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    await engine.ingest({
      channel: "slack",
      conversationKey: slackKey,
      externalMessageId: "message-1",
      authorId: "U1",
      text: "please reply",
      intakeMode: "direct"
    });
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 100_000,
      summaryMaxChars: 2_000,
      prepare: async () => null,
      createSummary: async () => "summary",
      generate: async () => "undelivered response",
      shouldDeliver: () => true,
      assistantMessage: (_decision, _target, started) => ({
        channel: "slack",
        conversationKey: started.conversation.conversationKey,
        text: "undelivered response",
        runId: started.run.id
      }),
      deliveryPayload: () => ({ channel: "C1", body: "undelivered response" }),
      reconcileDelivery: async () => null,
      deliver: async () => {
        throw new Error("Slack send failed");
      },
      skipped: async () => {},
      failed: async () => {}
    };

    assert.deepEqual(await runtime.processConversation(transport, slackKey), [false]);
    const conversation = await engine.getConversation("slack", slackKey);
    const context = await engine.buildContext("slack", slackKey);
    const lifecycle = await ledger.lifecycleEvents("slack", slackKey);

    assert.equal(conversation?.status, "failed");
    assert.deepEqual(conversation?.messages.map((message) => message.role), ["user"]);
    assert.deepEqual(context?.messages.map((message) => message.role), ["user"]);
    const failedEvent = [...lifecycle].reverse().find((event) => event.kind === "failed");
    assert.match(failedEvent?.reason ?? "", /Slack send failed/);
  } finally {
    ledger.close();
  }
});

test("failed deliveries recover once after restart without another model turn for Slack, email, and phone", async () => {
  for (const channel of ["slack", "email", "phone"] as const) {
    const dir = await mkdtemp(path.join(os.tmpdir(), `conversation-runtime-${channel}-delivery-recovery-`));
    const filePath = path.join(dir, "tasks.sqlite");
    let generated = 0;
    const deliveredKeys: string[] = [];
    let failDelivery = true;
    const key = `${channel}:recovery`;
    const transport = (): ConversationRuntimeTransport<null, string> => ({
      channel,
      provider: `${channel}-provider`,
      maxContextTokens: 100_000,
      summaryMaxChars: 2_000,
      prepare: async () => null,
      createSummary: async () => "summary",
      generate: async () => { generated += 1; return `${channel} reply`; },
      shouldDeliver: () => true,
      assistantMessage: (_decision, _target, started) => ({
        channel,
        conversationKey: started.conversation.conversationKey,
        text: `${channel} reply`,
        runId: started.run.id
      }),
      deliveryPayload: () => ({ body: `${channel} reply` }),
      reconcileDelivery: async () => null,
      deliver: async (delivery) => {
        deliveredKeys.push(delivery.idempotencyKey);
        if (failDelivery) throw new Error(`${channel} provider unavailable`);
        return { providerMessageId: `${channel}-reply` };
      },
      skipped: async () => {},
      failed: async () => {}
    });

    try {
      const firstLedger = new SQLiteTaskLedger({ filePath });
      const firstEngine = new ConversationEngine({ ledger: firstLedger });
      const firstRuntime = new ConversationRuntime(firstEngine);
      await firstEngine.ingest({
        channel,
        conversationKey: key,
        externalMessageId: `${channel}-message-1`,
        authorId: "user",
        text: "reply please",
        intakeMode: "direct"
      });
      assert.deepEqual(await firstRuntime.processConversation(transport(), key), [false]);
      assert.equal((await firstLedger.outboundDeliveries(channel, key))[0]?.status, "failed");
      firstLedger.close();

      failDelivery = false;
      const restartedLedger = new SQLiteTaskLedger({ filePath });
      const restartedEngine = new ConversationEngine({ ledger: restartedLedger });
      const restartedRuntime = new ConversationRuntime(restartedEngine);
      const recovery = await restartedRuntime.recover(channel);
      assert.deepEqual(recovery.runnableKeys, [key]);
      assert.deepEqual(await restartedRuntime.processTransport(transport(), 5), [true]);

      const conversation = await restartedEngine.getConversation(channel, key);
      const deliveries = await restartedLedger.outboundDeliveries(channel, key);
      assert.equal(generated, 1);
      assert.deepEqual(deliveredKeys, [deliveries[0]?.idempotencyKey, deliveries[0]?.idempotencyKey]);
      assert.equal(deliveries[0]?.status, "delivered");
      assert.deepEqual(conversation?.messages.map((message) => message.role), ["user", "assistant"]);
      restartedLedger.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("a resumed delivery failure is released, persisted, and recovered without a model retry", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const key = "slack:T1:C1:resumed-delivery-failure";
    await engine.ingest({
      channel: "slack",
      conversationKey: key,
      externalMessageId: "resumed-delivery-message",
      authorId: "U1",
      text: "send the response",
      intakeMode: "direct"
    });
    const started = await runtime.startRun("slack", key);
    assert.ok(started);
    const delivery = await engine.createOutboundDelivery({
      channel: "slack",
      conversationKey: key,
      runId: started.run.id,
      provider: "slack",
      idempotencyKey: "resumed-delivery-key",
      payload: { body: "response" },
      assistantMessage: { text: "response" }
    });
    let generated = 0;
    let failDelivery = true;
    const deliveredKeys: string[] = [];
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 100_000,
      summaryMaxChars: 2_000,
      prepare: async () => { throw new Error("delivery recovery must not prepare a new model turn"); },
      createSummary: async () => "summary",
      generate: async () => { generated += 1; return "must not run"; },
      shouldDeliver: () => true,
      assistantMessage: () => ({ channel: "slack", conversationKey: key, text: "must not run" }),
      deliveryPayload: () => ({ body: "must not run" }),
      reconcileDelivery: async () => null,
      deliver: async (attempt) => {
        deliveredKeys.push(attempt.idempotencyKey);
        if (failDelivery) throw new Error("provider temporarily unavailable");
        return { providerMessageId: "resumed-delivery-confirmed" };
      },
      skipped: async () => {},
      failed: async () => {}
    };

    assert.equal(await runtime.runTransport(transport, started), false);
    assert.equal((await ledger.outboundDeliveries("slack", key))[0]?.status, "failed");
    assert.equal((await engine.getConversation("slack", key))?.status, "failed");
    assert.ok((await engine.lifecycleEvents("slack", key)).some((event) => event.kind === "delivery_failed"));

    failDelivery = false;
    assert.deepEqual((await runtime.recover("slack")).runnableKeys, [key]);
    assert.deepEqual(await runtime.processTransport(transport, 1), [true]);
    const persisted = (await ledger.outboundDeliveries("slack", key))[0];
    assert.equal(generated, 0);
    assert.deepEqual(deliveredKeys, [delivery.idempotencyKey, delivery.idempotencyKey]);
    assert.equal(persisted?.status, "delivered");
  } finally {
    ledger.close();
  }
});

test("a reconciliation confirmation failure preserves the known provider effect for retry", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const key = "slack:T1:C1:reconciliation-confirmation-failure";
    await engine.ingest({
      channel: "slack",
      conversationKey: key,
      externalMessageId: "reconciliation-message",
      authorId: "U1",
      text: "send the response",
      intakeMode: "direct"
    });
    const started = await runtime.startRun("slack", key);
    assert.ok(started);
    const delivery = await engine.createOutboundDelivery({
      channel: "slack",
      conversationKey: key,
      runId: started.run.id,
      provider: "slack",
      idempotencyKey: "reconciliation-confirmation-key",
      payload: { body: "response" },
      assistantMessage: { text: "response" }
    });
    const originalConfirm = engine.confirmOutboundDelivery.bind(engine);
    let failConfirmation = true;
    engine.confirmOutboundDelivery = async (input) => {
      if (failConfirmation) throw new Error("SQLite confirmation write failed");
      return originalConfirm(input);
    };
    let providerCalls = 0;
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 100_000,
      summaryMaxChars: 2_000,
      prepare: async () => { throw new Error("reconciliation must not prepare a new model turn"); },
      createSummary: async () => "summary",
      generate: async () => { throw new Error("reconciliation must not generate a new model turn"); },
      shouldDeliver: () => true,
      assistantMessage: () => ({ channel: "slack", conversationKey: key, text: "not used" }),
      deliveryPayload: () => ({ body: "not used" }),
      reconcileDelivery: async () => ({ providerMessageId: "already-sent", reconciled: true }),
      deliver: async () => { providerCalls += 1; return { providerMessageId: "must-not-send" }; },
      skipped: async () => {},
      failed: async () => { throw new Error("known provider effect must not be reported as failed"); }
    };

    await assert.rejects(
      runtime.runTransport(transport, started),
      (error: unknown) => error instanceof DeliveryInterruptedError && /SQLite confirmation write failed/.test(error.message)
    );
    assert.equal((await ledger.outboundDeliveries("slack", key))[0]?.status, "pending");
    assert.equal((await engine.getConversation("slack", key))?.status, "running");
    assert.equal(providerCalls, 0);

    failConfirmation = false;
    assert.equal(await runtime.runTransport(transport, started), true);
    assert.equal((await ledger.outboundDeliveries("slack", key))[0]?.status, "delivered");
    assert.equal((await engine.getConversation("slack", key))?.status, "done");
    assert.equal(providerCalls, 0);
  } finally {
    ledger.close();
  }
});

test("a stop that wins after dispatch admission prevents the provider call and restart recovery", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const key = "phone:stop-before-provider-call";
    await engine.ingest({
      channel: "phone", conversationKey: key, externalMessageId: "stop-race-message",
      authorId: "+15550000000", text: "reply", intakeMode: "direct"
    });
    const started = await runtime.startRun("phone", key);
    assert.ok(started);

    const originalBegin = engine.beginOutboundDeliveryDispatch.bind(engine);
    let admitted!: () => void;
    let continueDispatch!: () => void;
    const admittedPromise = new Promise<void>((resolve) => { admitted = resolve; });
    const continuePromise = new Promise<void>((resolve) => { continueDispatch = resolve; });
    engine.beginOutboundDeliveryDispatch = async (deliveryId, runId) => {
      const dispatch = await originalBegin(deliveryId, runId);
      admitted();
      await continuePromise;
      return dispatch;
    };
    let providerCalls = 0;
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "phone", provider: "agentphone", maxContextTokens: 100_000, summaryMaxChars: 2_000,
      prepare: async () => null, createSummary: async () => "summary", generate: async () => "response",
      shouldDeliver: () => true,      assistantMessage: () => ({ channel: "phone", conversationKey: key, text: "response" }),
      deliveryPayload: () => ({ body: "response" }), reconcileDelivery: async () => null,
      deliver: async () => { providerCalls += 1; return { providerMessageId: "must-not-send" }; },
      skipped: async () => {}, failed: async () => {}
    };

    const running = runtime.runTransport(transport, started);
    await admittedPromise;
    await engine.stop("phone", key, "user_stop");
    continueDispatch();

    assert.equal(await running, false);
    assert.equal(providerCalls, 0);
    assert.equal((await ledger.outboundDeliveries("phone", key))[0]?.status, "cancelled");
    assert.deepEqual((await runtime.recover("phone")).runnableKeys, []);
    assert.equal(await runtime.startRun("phone", key), null);
  } finally {
    ledger.close();
  }
});

test("a provider-accepted delivery confirms after stop without a second provider call", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const key = "phone:stop-after-provider-acceptance";
    await engine.ingest({
      channel: "phone", conversationKey: key, externalMessageId: "accepted-stop-message",
      authorId: "+15550000001", text: "reply", intakeMode: "direct"
    });
    const started = await runtime.startRun("phone", key);
    assert.ok(started);
    const originalConfirm = engine.confirmOutboundDelivery.bind(engine);
    let failConfirmation = true;
    engine.confirmOutboundDelivery = async (input) => {
      if (failConfirmation) throw new Error("confirmation persistence interrupted");
      return originalConfirm(input);
    };
    let providerCalls = 0;
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "phone", provider: "agentphone", maxContextTokens: 100_000, summaryMaxChars: 2_000,
      prepare: async () => null, createSummary: async () => "summary", generate: async () => "response",
      shouldDeliver: () => true,      assistantMessage: () => ({ channel: "phone", conversationKey: key, text: "response" }),
      deliveryPayload: () => ({ body: "response" }), reconcileDelivery: async () => null,
      deliver: async () => { providerCalls += 1; return { providerMessageId: "accepted-on-provider" }; },
      skipped: async () => {}, failed: async () => {}
    };

    await assert.rejects(runtime.runTransport(transport, started), /confirmation persistence interrupted/);
    assert.equal((await ledger.outboundDeliveries("phone", key))[0]?.status, "provider_accepted");
    await engine.stop("phone", key, "user_stop");
    failConfirmation = false;

    assert.deepEqual((await runtime.recover("phone")).runnableKeys, []);
    assert.equal((await ledger.outboundDeliveries("phone", key))[0]?.status, "delivered");
    assert.equal((await engine.getConversation("phone", key))?.status, "stopped");
    assert.equal(providerCalls, 1);
  } finally {
    ledger.close();
  }
});

test("bounded conversation batches preserve queued work for the next drain", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const key = "slack:T1:C1:bounded-drain";
    const posts: string[] = [];
    let nextMessage = 1;
    await engine.ingest({ channel: "slack", conversationKey: key, externalMessageId: "message-0", authorId: "U1", text: "start", intakeMode: "direct" });
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 100_000,
      summaryMaxChars: 2_000,
      prepare: async () => null,
      createSummary: async () => "summary",
      generate: async () => "reply",
      shouldDeliver: () => true,
      assistantMessage: (_decision, _target, started) => ({ channel: "slack", conversationKey: key, text: "reply", runId: started.run.id }),
      deliveryPayload: () => ({ body: "reply" }),
      reconcileDelivery: async () => null,
      deliver: async () => {
        posts.push("reply");
        if (nextMessage <= 20) {
          await engine.ingest({
            channel: "slack",
            conversationKey: key,
            externalMessageId: `message-${nextMessage}`,
            authorId: "U1",
            text: `follow-up ${nextMessage}`,
            intakeMode: "direct"
          });
          nextMessage += 1;
        }
        return { providerMessageId: `reply-${posts.length}` };
      },
      skipped: async () => {},
      failed: async () => {}
    };

    const firstBatch = await runtime.processConversation(transport, key, 20);
    assert.equal(firstBatch.length, 20);
    assert.equal((await engine.getConversation("slack", key))?.status, "queued");
    assert.deepEqual(await runtime.processConversation(transport, key, 20), [true]);
    assert.equal(posts.length, 21);
    assert.equal((await engine.getConversation("slack", key))?.status, "done");
  } finally {
    ledger.close();
  }
});

test("reminder delivery failure remains pending and resumes with the original idempotency key", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    await engine.ingest({
      channel: "slack",
      conversationKey: slackKey,
      externalMessageId: "reminder-delivery-recovery-message",
      authorId: "U1",
      text: "please reply",
      intakeMode: "direct"
    });
    const started = await runtime.startRun("slack", slackKey);
    assert.ok(started);
    let generated = 0;
    const deliveredKeys: string[] = [];
    let failDelivery = true;
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 100_000,
      summaryMaxChars: 2_000,
      retainPendingDeliveryOnFailure: true,
      prepare: async () => null,
      createSummary: async () => "summary",
      generate: async () => { generated += 1; return "durable reminder reply"; },
      shouldDeliver: () => true,
      assistantMessage: (_decision, _target, run) => ({ channel: "slack", conversationKey: slackKey, text: "durable reminder reply", runId: run.run.id }),
      deliveryPayload: () => ({ channel: "C1", body: "durable reminder reply" }),
      reconcileDelivery: async () => null,
      deliver: async (delivery) => {
        deliveredKeys.push(delivery.idempotencyKey);
        if (failDelivery) throw new Error("temporary Slack outage");
        return { providerMessageId: "recovered-reply" };
      },
      skipped: async () => {},
      failed: async () => {}
    };
    assert.equal(await runtime.runTransport(transport, started), false);
    const pending = await ledger.pendingOutboundDelivery("slack", slackKey);
    assert.ok(pending);
    assert.equal((await engine.getConversation("slack", slackKey))?.runs.find((run) => run.id === started.run.id)?.status, "running");

    failDelivery = false;
    assert.equal(await runtime.resumePendingOutboundDelivery(transport, started), true);
    assert.equal(generated, 1);
    assert.deepEqual(deliveredKeys, [pending.idempotencyKey, pending.idempotencyKey]);
    assert.equal(await ledger.pendingOutboundDelivery("slack", slackKey), null);
  } finally {
    ledger.close();
  }
});
test("delivery-only recovery never falls through to a new Codex execution", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    await engine.ingest({
      channel: "slack",
      conversationKey: slackKey,
      externalMessageId: "delivery-recovery-message",
      authorId: "U1",
      text: "please reply",
      intakeMode: "direct"
    });
    const started = await runtime.startRun("slack", slackKey);
    assert.ok(started);
    await ledger.createOutboundDelivery({
      channel: "slack",
      conversationKey: slackKey,
      runId: started.run.id,
      provider: "slack",
      idempotencyKey: "delivery-recovery",
      payload: { channel: "C1", body: "already generated" },
      assistantMessage: { text: "already generated" }
    });
    let generations = 0;
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 100_000,
      summaryMaxChars: 2_000,
      prepare: async () => null,
      createSummary: async () => "summary",
      generate: async () => { generations += 1; return "must not run"; },
      shouldDeliver: () => true,
      assistantMessage: (_decision, _target, run) => ({ channel: "slack", conversationKey: slackKey, text: "must not run", runId: run.run.id }),
      deliveryPayload: () => ({ channel: "C1", body: "must not run" }),
      reconcileDelivery: async () => null,
      deliver: async () => ({ ts: "reply-1" }),
      skipped: async () => {},
      failed: async () => {}
    };

    assert.equal(await runtime.resumePendingOutboundDelivery(transport, started), true);
    assert.equal(await runtime.resumePendingOutboundDelivery(transport, started), false);
    assert.equal(generations, 0);
  } finally {
    ledger.close();
  }
});

test("a deployment drain checkpoints the active run at a turn boundary and the run resumes with update context", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "conversation-runtime-checkpoint-"));
  const filePath = path.join(dir, "tasks.sqlite");
  const key = "slack:T1:C1:checkpoint";
  const observed: Array<{ updateNotice: string | null }> = [];
  let generations = 0;
  const transport = (): ConversationRuntimeTransport<null, string> => ({
    channel: "slack",
    provider: "slack",
    maxContextTokens: 100_000,
    summaryMaxChars: 2_000,
    prepare: async () => null,
    createSummary: async () => "summary",
    generate: async (input) => {
      generations += 1;
      observed.push({ updateNotice: input.updateNotice });
      return "deployment reply";
    },
    shouldDeliver: () => true,
    assistantMessage: (_decision, _target, started) => ({ channel: "slack", conversationKey: key, text: "deployment reply", runId: started.run.id }),
    deliveryPayload: () => ({ channel: "C1", body: "deployment reply" }),
    reconcileDelivery: async () => null,
    deliver: async () => ({ providerMessageId: "deployment-reply" }),
    skipped: async () => {},
    failed: async () => {}
  });

  try {
    const firstLedger = new SQLiteTaskLedger({ filePath });
    const firstEngine = new ConversationEngine({ ledger: firstLedger });
    const firstRuntime = new ConversationRuntime(firstEngine);
    await firstEngine.ingest({
      channel: "slack",
      conversationKey: key,
      externalMessageId: "checkpoint-message-1",
      authorId: "U1",
      text: "work on the long task",
      intakeMode: "direct"
    });
    const started = await firstRuntime.startRun("slack", key);
    assert.ok(started);
    await firstEngine.saveCodexSession("slack", key, "codex-session-before-deploy");

    // The deployer moves the durable lifecycle to draining while this run is
    // between turns; the next turn boundary checkpoints instead of executing.
    await firstLedger.setDeploymentLifecycle("draining");
    assert.equal(await firstRuntime.runTransport(transport(), started), false);
    assert.equal(generations, 0, "no model turn starts after the drain began");

    const checkpointed = await firstEngine.getConversation("slack", key);
    const checkpointedRun = checkpointed?.runs.find((run) => run.id === started.run.id);
    assert.equal(checkpointedRun?.status, "interrupted");
    assert.equal(checkpointedRun?.error, DEPLOYMENT_CHECKPOINT_REASON);
    assert.equal(checkpointed?.status, "queued", "the checkpointed conversation is queued for after the restart");
    assert.equal(checkpointed?.activeRunId, null);
    assert.deepEqual(checkpointed?.messages.map((message) => message.text), ["work on the long task"], "conversation history survives the checkpoint");
    assert.equal((await firstLedger.outboundDeliveries("slack", key)).length, 0, "no delivery exists for the checkpointed turn");
    assert.equal(await firstRuntime.startRun("slack", key), null, "admission stays closed until the deployment finishes");

    await firstEngine.ingest({
      channel: "slack",
      conversationKey: key,
      externalMessageId: "checkpoint-message-2",
      authorId: "U1",
      text: "also handle this while you restart",
      intakeMode: "direct"
    });
    firstLedger.close();

    // The deployment applied merged main; the receipt is what the resumed run reads.
    const receiptPath = path.join(dir, "last-run.json");
    await writeFile(receiptPath, JSON.stringify({
      ok: true,
      status: "deployed",
      ranAt: new Date().toISOString(),
      deployedSha: "f".repeat(40),
      addedManagedPaths: ["bin/new-tool"],
      modifiedManagedPaths: ["channels/slack/src/server.ts"],
      deletedManagedPaths: []
    }));

    const restartedLedger = new SQLiteTaskLedger({ filePath });
    const restartedEngine = new ConversationEngine({ ledger: restartedLedger });
    const restartedRuntime = new ConversationRuntime(restartedEngine, undefined, {
      updateNotice: (checkpointedAt) => deploymentUpdateNotice(checkpointedAt, receiptPath)
    });
    await restartedLedger.setDeploymentLifecycle("normal");
    const recovery = await restartedRuntime.recover("slack");
    assert.deepEqual(recovery.runnableKeys, [key], "the checkpointed conversation is runnable after restart");

    assert.deepEqual(await restartedRuntime.processConversation(transport(), key), [true]);
    assert.equal(generations, 1);
    assert.match(observed[0]?.updateNotice ?? "", /checkpointed while the harness source was updated from main/);
    assert.match(observed[0]?.updateNotice ?? "", new RegExp(`commit ${"f".repeat(40)}`), "the resumed run learns which commit is now deployed");
    assert.match(observed[0]?.updateNotice ?? "", /1 added, 1 modified, 0 deleted/);

    const resumed = await restartedEngine.getConversation("slack", key);
    assert.deepEqual(
      resumed?.messages.map((message) => message.text),
      ["work on the long task", "also handle this while you restart", "deployment reply"],
      "pre-checkpoint history, drain-time intake, and the resumed reply stay ordered"
    );
    assert.equal((await restartedEngine.getCodexSession("slack", key))?.codexSessionId, "codex-session-before-deploy", "Codex session continuity survives the deployment");
    assert.equal(resumed?.status, "done");
    restartedLedger.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run that never checkpointed does not receive a deployment notice", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "conversation-runtime-no-notice-"));
  const receiptPath = path.join(dir, "last-run.json");
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  try {
    await writeFile(receiptPath, JSON.stringify({
      ok: true,
      status: "deployed",
      ranAt: new Date().toISOString(),
      deployedSha: "a".repeat(40),
      addedManagedPaths: [],
      modifiedManagedPaths: [],
      deletedManagedPaths: []
    }));
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine, undefined, {
      updateNotice: (checkpointedAt) => deploymentUpdateNotice(checkpointedAt, receiptPath)
    });
    const notices: Array<string | null> = [];
    await engine.ingest({
      channel: "slack",
      conversationKey: slackKey,
      externalMessageId: "no-notice-message",
      authorId: "U1",
      text: "just reply",
      intakeMode: "direct"
    });
    const transport: ConversationRuntimeTransport<null, string> = {
      channel: "slack",
      provider: "slack",
      maxContextTokens: 100_000,
      summaryMaxChars: 2_000,
      prepare: async () => null,
      createSummary: async () => "summary",
      generate: async (input) => { notices.push(input.updateNotice); return "plain reply"; },
      shouldDeliver: () => true,
      assistantMessage: (_decision, _target, started) => ({ channel: "slack", conversationKey: slackKey, text: "plain reply", runId: started.run.id }),
      deliveryPayload: () => ({ channel: "C1", body: "plain reply" }),
      reconcileDelivery: async () => null,
      deliver: async () => ({ providerMessageId: "plain-reply" }),
      skipped: async () => {},
      failed: async () => {}
    };
    assert.deepEqual(await runtime.processConversation(transport, slackKey), [true]);
    assert.deepEqual(notices, [null], "a normal run carries no deployment notice");
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deploymentUpdateNotice only reports a successful deployment that happened after the checkpoint", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deployment-notice-"));
  const receiptPath = path.join(dir, "last-run.json");
  try {
    assert.equal(deploymentUpdateNotice(null, path.join(dir, "missing.json")), null, "a missing receipt yields no notice");

    await writeFile(receiptPath, JSON.stringify({ ok: false, status: "rollback_failed", ranAt: new Date().toISOString(), deployedSha: "" }));
    assert.equal(deploymentUpdateNotice(null, receiptPath), null, "a failed deployment yields no notice");

    const deployedAt = "2026-07-30T00:00:00.000Z";
    await writeFile(receiptPath, JSON.stringify({
      ok: true,
      status: "deployed",
      ranAt: deployedAt,
      deployedSha: "c".repeat(40),
      addedManagedPaths: ["one"],
      modifiedManagedPaths: [],
      deletedManagedPaths: ["two", "three"]
    }));
    assert.equal(deploymentUpdateNotice("2026-07-30T01:00:00.000Z", receiptPath), null, "a deployment older than the checkpoint yields no notice");
    const notice = deploymentUpdateNotice("2026-07-29T23:00:00.000Z", receiptPath);
    assert.match(notice ?? "", /1 added, 0 modified, 2 deleted/);
    assert.match(notice ?? "", new RegExp(`commit ${"c".repeat(40)}`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime persists and resumes Codex sessions through the shared ledger for every supported channel", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  const spawnCalls: string[][] = [];
  const runner = new CodexProcessRunner(((command: string, args: string[]) => {
    spawnCalls.push([...args]);
    const child = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    (child as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stdout = stdout;
    (child as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stderr = stderr;
    const resumedSessionId = args.includes("resume") ? args[args.lastIndexOf("-") - 1] : null;
    queueMicrotask(() => {
      if (!resumedSessionId) {
        stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "thread.started", thread_id: `session-${spawnCalls.length}` })}\n`));
      }
      stdout.emit("data", Buffer.from(`${JSON.stringify({ type: "agent_message", text: "normal reply" })}\n`));
      child.emit("close", 0, null);
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn);

  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine, runner);
    for (const [channel, conversationKey] of [
      ["slack", "slack:T1:C1:runtime-session"],
      ["email", "email:account:runtime-session"],
      ["phone", "phone:runtime-session"]
    ] as const) {
      await engine.ingest({
        channel,
        conversationKey,
        externalMessageId: `message:${channel}`,
        authorId: "person-1",
        text: "please continue",
        intakeMode: "direct"
      });
      const first = await runtime.runCodexConversation({
        channel,
        conversationKey,
        request: { command: "codex", args: ["exec", "--sandbox", "read-only", "-"], cwd: process.cwd(), env: process.env, timeoutMs: 1_000 }
      });
      assert.equal(first.output, "normal reply");
      assert.equal(first.codexSessionId, `session-${spawnCalls.length}`);
      assert.equal((await engine.getCodexSession(channel, conversationKey))?.codexSessionId, first.codexSessionId);

      const second = await runtime.runCodexConversation({
        channel,
        conversationKey,
        request: { command: "codex", args: ["exec", "--sandbox", "read-only", "-"], cwd: process.cwd(), env: process.env, timeoutMs: 1_000 }
      });
      assert.equal(second.codexSessionId, first.codexSessionId);
      const resumeArgs = spawnCalls.at(-1)!;
      assert.deepEqual(resumeArgs.slice(0, 3), ["exec", "resume", "--json"]);
      assert.equal(resumeArgs.at(-2), first.codexSessionId);

      await engine.saveCodexSession(channel, conversationKey, "session-after-scheduling");
      const third = await runtime.runCodexConversation({
        channel,
        conversationKey,
        request: { command: "codex", args: ["exec", "--sandbox", "read-only", "-"], cwd: process.cwd(), env: process.env, timeoutMs: 1_000 }
      });
      assert.equal(third.codexSessionId, "session-after-scheduling");
      assert.equal(spawnCalls.at(-1)!.at(-2), "session-after-scheduling");
    }
  } finally {
    ledger.close();
  }
});
