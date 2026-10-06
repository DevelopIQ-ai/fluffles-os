import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { CodexProcessRunner, ConversationEngine, SQLiteTaskLedger } from "@fluffles/tasks";
import { buildEmailLedgerInput, recordEmailTask, type EmailClassification, type NormalizedEmail } from "../src/email-task-adapter";
import {
  CodexEmailReplyGenerator,
  defaultEmailChannelConfig,
  EmailChannel,
  type EmailChannelConfig,
  type EmailGwsClient,
  type EmailReplyDecision,
  type EmailReplyGenerator,
  type EmailReplyGeneratorInput
} from "../src/email-channel";
import type { GmailMessage } from "../src/email-normalize";
import type { GwsAuthStatus } from "../src/gws-client";

async function withConfig<T>(fn: (config: EmailChannelConfig) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "email-channel-runner-test-"));
  // A turn links the harness standing rules into its scratch workdir and
  // refuses to run without them, so a home fixture has to carry the file.
  await writeFile(path.join(dir, "AGENTS.md"), "<identity>You are Fluffles.</identity>\n");
  try {
    const config: EmailChannelConfig = {
      home: dir,
      stateRoot: path.join(dir, "state"),
      taskLedgerPath: path.join(dir, "state", "tasks", "tasks.sqlite"),
      transportStorePath: path.join(dir, "state", "channels", "email", "email-transport.sqlite"),
      statusPath: path.join(dir, "state", "channels", "email", "status.json"),
      pollQuery: "in:inbox is:unread",
      pollMaxResults: 10,
      pollingEnabled: true,
      webhookEnabled: true,
      mailboxId: "fluffles@puffle.ai",
      mailboxAddresses: ["fluffles@puffle.ai"],
      gmailPubSubSubscription: null,
      outboundMode: "draft",
      fromAddress: "fluffles@puffle.ai",
      codexPath: path.join(dir, "bin", "codex"),
      codexSchemaPath: path.join(dir, "reply-schema.json"),
      codexTimeoutMs: 1000,
      codexModel: "test-model",
      codexReasoningEffort: "low",
      codexServiceTier: "fast",
      deliveryReconciliationDelayMs: 1_000,
      contextLimitsPath: path.join(dir, "config", "context-limits.json"),
      contextLimits: {
        recentMessagesLimit: 20,
        maxContextChars: 12000,
        recentUserMessageTokenLimit: 20000,
        summaryMaxChars: 2000,
        openLoopsMaxChars: 1000
      }
    };
    return await fn(config);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

class FakeGws implements EmailGwsClient {
  auth: GwsAuthStatus = { token_valid: true };
  ids: { id: string; threadId: string | null }[] = [];
  messages = new Map<string, GmailMessage>();
  replies: { messageId: string; body: string; from?: string | null; draft: boolean; idempotencyKey?: string }[] = [];
  replyAttempts = 0;
  replyError: Error | null = null;
  crashAfterAccept = false;
  deliveryKeys = new Set<string>();
  getCalls = 0;
  listPageCalls: Array<string | null> = [];
  listQueries: string[] = [];
  profileHistoryId: string | null = "100";
  historyCalls: Array<{ startHistoryId: string; pageToken: string | null }> = [];
  messagePages: Array<{ messages: { id: string; threadId: string | null }[]; nextPageToken: string | null }> = [];
  historyPages: Array<{ messages: { id: string; threadId: string | null }[]; nextPageToken: string | null; historyId: string | null }> = [];
  transientGetFailures = new Set<string>();
  messageFailures = new Map<string, Error>();
  historyFailure: Error | null = null;
  historyFailurePageToken: string | null = null;

  async authStatus(): Promise<GwsAuthStatus> {
    return this.auth;
  }

  async listMessages(_query: string, _maxResults: number): Promise<{ id: string; threadId: string | null }[]> {
    return this.ids;
  }

  async listMessagesPage(_query: string, _maxResults: number, pageToken?: string | null) {
    this.listQueries.push(_query);
    this.listPageCalls.push(pageToken ?? null);
    return this.messagePages.shift() ?? { messages: this.ids, nextPageToken: null };
  }

  async getProfile(): Promise<{ historyId: string }> {
    if (!this.profileHistoryId) throw new Error("missing fake profile history id");
    return { historyId: this.profileHistoryId };
  }

  async listHistory(startHistoryId: string, _maxResults: number, pageToken?: string | null) {
    this.historyCalls.push({ startHistoryId, pageToken: pageToken ?? null });
    if (this.historyFailure && (this.historyFailurePageToken == null || this.historyFailurePageToken === (pageToken ?? null))) {
      const failure = this.historyFailure;
      this.historyFailure = null;
      this.historyFailurePageToken = null;
      throw failure;
    }
    return this.historyPages.shift() ?? { messages: [], nextPageToken: null, historyId: startHistoryId };
  }

  async getMessage(id: string): Promise<GmailMessage> {
    this.getCalls += 1;
    const failure = this.messageFailures.get(id);
    if (failure) {
      this.messageFailures.delete(id);
      throw failure;
    }
    if (this.transientGetFailures.delete(id)) throw new Error(`transient Gmail read failure for ${id}`);
    const message = this.messages.get(id);
    if (!message) throw new Error(`missing fake message ${id}`);
    return message;
  }

  async reply(input: { messageId: string; body: string; from?: string | null; draft: boolean; idempotencyKey?: string }): Promise<{ ok: boolean; mode: "draft" | "send"; response: unknown }> {
    this.replyAttempts += 1;
    if (this.replyError) throw this.replyError;
    this.replies.push(input);
    if (input.idempotencyKey) this.deliveryKeys.add(input.idempotencyKey);
    if (this.crashAfterAccept) throw deliveryInterruptedError();
    return { ok: true, mode: input.draft ? "draft" : "send", response: { id: `reply-${input.messageId}` } };
  }

  async findDelivery(_messageId: string, idempotencyKey: string) {
    return this.deliveryKeys.has(idempotencyKey) ? { idempotencyKey, reconciled: true } : null;
  }
}

class FixedReplyGenerator implements EmailReplyGenerator {
  constructor(private readonly decision: EmailReplyDecision) {}

  async generate(_input: EmailReplyGeneratorInput): Promise<EmailReplyDecision> {
    return this.decision;
  }
}

class CountingEmailReplyGenerator extends FixedReplyGenerator {
  calls = 0;

  override async generate(input: EmailReplyGeneratorInput): Promise<EmailReplyDecision> {
    this.calls += 1;
    return super.generate(input);
  }
}

class CapturingEmailReplyGenerator extends FixedReplyGenerator {
  input: EmailReplyGeneratorInput | null = null;

  override async generate(input: EmailReplyGeneratorInput): Promise<EmailReplyDecision> {
    this.input = input;
    return super.generate(input);
  }
}

class SteeringEmailReplyGenerator implements EmailReplyGenerator {
  readonly inputs: EmailReplyGeneratorInput[] = [];

  constructor(private readonly engine: ConversationEngine) {}

  async generate(input: EmailReplyGeneratorInput): Promise<EmailReplyDecision> {
    this.inputs.push(input);
    if (this.inputs.length === 1) {
      await this.engine.ingest({
        ...buildEmailLedgerInput(
          acceptedEmail({
            id: "gmail-message-2",
            messageId: "<gmail-message-2@example.com>",
            text: "actually include the calendar too"
          }),
          acceptedClassification()
        ),
        intakeMode: "direct"
      });
      return {
        shouldReply: true,
        reason: "first-pass",
        subject: "Re: can you check email?",
        body: "first draft"
      };
    }
    return {
      shouldReply: true,
      reason: "steered",
      subject: "Re: can you check email?",
      body: "updated draft"
    };
  }
}

function gmailMessage(id: string, overrides: { from?: string; subject?: string; text?: string; labels?: string[]; threadId?: string; internalDate?: string } = {}): GmailMessage {
  const from = overrides.from || "Kush <kush@puffle.ai>";
  const subject = overrides.subject || "can you check email?";
  const text = overrides.text || "can you check that email works?";
  return {
    id,
    threadId: overrides.threadId || "thread-1",
    ...(overrides.internalDate ? { internalDate: overrides.internalDate } : {}),
    labelIds: overrides.labels || ["INBOX", "UNREAD"],
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: "Fluffles <fluffles@puffle.ai>" },
        { name: "Subject", value: subject },
        { name: "Date", value: "Mon, 29 Jun 2026 10:00:00 -0700" },
        { name: "Message-ID", value: `<${id}@example.com>` }
      ],
      body: {
        data: base64Url(text)
      }
    }
  };
}

function acceptedEmail(overrides: Partial<NormalizedEmail> = {}): NormalizedEmail {
  return {
    provider: "gmail",
    id: "gmail-message-1",
    threadId: "thread-1",
    from: "Kush <kush@puffle.ai>",
    to: "Fluffles <fluffles@puffle.ai>",
    subject: "can you check email?",
    date: "Mon, 29 Jun 2026 10:00:00 -0700",
    messageId: "<gmail-message-1@example.com>",
    references: [],
    inReplyTo: null,
    headers: {
      "message-id": "<gmail-message-1@example.com>"
    },
    text: "can you check that email works?",
    labels: ["INBOX", "UNREAD"],
    ...overrides
  };
}

function acceptedClassification(): EmailClassification {
  return {
    shouldReply: true,
    confidence: "medium",
    reason: "clear-human-ask",
    sender: "kush@puffle.ai",
    subject: "can you check email?"
  };
}

test("pollOnce reads Gmail, filters mail, and writes accepted work to the central ledger", async () => {
  await withConfig(async (config) => {
    const gws = new FakeGws();
    gws.ids = [
      { id: "gmail-message-1", threadId: "thread-1" },
      { id: "newsletter-1", threadId: "thread-2" }
    ];
    gws.messages.set("gmail-message-1", gmailMessage("gmail-message-1"));
      gws.messages.set("newsletter-1", gmailMessage("newsletter-1", {
      threadId: "thread-2",
      from: "Newsletter <newsletter@example.com>",
      subject: "weekly newsletter",
      text: "unsubscribe here"
    }));
    const channel = new EmailChannel({ config, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
    try {
      const result = await channel.pollOnce();
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-1");
        const skipped = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-2");
        const runnable = await ledger.runnableConversations("email");
        const status = await channel.snapshotStatus();

        assert.deepEqual(result, { accepted: 1, skipped: 1, duplicates: 0, errors: 0 });
        assert.equal(conversation?.status, "queued");
        assert.equal(conversation?.messages.length, 1);
        assert.equal(skipped?.status, "done");
        assert.equal(skipped?.messages.length, 1);
        assert.equal(skipped?.messages[0]?.metadata.nonActionable, true);
        assert.deepEqual(runnable.map((item) => item.conversationKey), ["email:fluffles@puffle.ai:thread-1"]);
        assert.equal(status.transport?.inboundAccepted, 1);
        assert.equal(status.transport?.inboundSkipped, 1);
      } finally {
        ledger.close();
      }
    } finally {
      channel.close();
    }
  });
});

test("pollOnce advances the durable cursor so already-seen Gmail messages are not reread", async () => {
  await withConfig(async (config) => {
    const gws = new FakeGws();
    gws.ids = [{ id: "gmail-message-1", threadId: "thread-1" }];
    gws.messages.set("gmail-message-1", gmailMessage("gmail-message-1"));
    const channel = new EmailChannel({ config, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
    try {
      assert.equal((await channel.pollOnce()).accepted, 1);
      const duplicate = await channel.pollOnce();

      assert.equal(duplicate.duplicates, 0);
      assert.equal(gws.getCalls, 1);
    } finally {
      channel.close();
    }
  });
});

test("polling processes every Gmail page in chronological provider order", async () => {
  await withConfig(async (config) => {
    const gws = new FakeGws();
    gws.messagePages = [
      { messages: [{ id: "newer", threadId: "thread-pages" }], nextPageToken: "older-page" },
      { messages: [{ id: "older", threadId: "thread-pages" }], nextPageToken: null }
    ];
    gws.messages.set("newer", gmailMessage("newer", { threadId: "thread-pages", text: "newer request", internalDate: "200" }));
    gws.messages.set("older", gmailMessage("older", { threadId: "thread-pages", text: "older request", internalDate: "100" }));
    const channel = new EmailChannel({ config, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
    try {
      const result = await channel.pollOnce();
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-pages");
        assert.deepEqual(result, { accepted: 2, skipped: 0, duplicates: 0, errors: 0 });
        assert.deepEqual(gws.listPageCalls, [null, "older-page"]);
        assert.deepEqual(conversation?.messages.map((message) => message.text.split("\n").at(-1)), ["older request", "newer request"]);
      } finally {
        ledger.close();
      }
    } finally {
      channel.close();
    }
  });
});

test("a transient Gmail read failure is retried without recording a terminal inbound receipt", async () => {
  await withConfig(async (config) => {
    const gws = new FakeGws();
    gws.ids = [{ id: "retry-message", threadId: "thread-retry" }];
    gws.messages.set("retry-message", gmailMessage("retry-message", { threadId: "thread-retry" }));
    gws.transientGetFailures.add("retry-message");
    const channel = new EmailChannel({ config, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
    try {
      assert.deepEqual(await channel.pollOnce(), { accepted: 0, skipped: 0, duplicates: 0, errors: 1 });
      assert.deepEqual(await channel.pollOnce(), { accepted: 1, skipped: 0, duplicates: 0, errors: 0 });
      assert.equal(gws.getCalls, 2);
    } finally {
      channel.close();
    }
  });
});

test("durable polling uses an inbox baseline and does not advance its cursor after a transient failure", async () => {
  await withConfig(async (config) => {
    const gws = new FakeGws();
    gws.ids = [{ id: "lossless-message", threadId: "thread-lossless" }];
    gws.messages.set("lossless-message", gmailMessage("lossless-message", { threadId: "thread-lossless", text: "do not lose me" }));
    gws.transientGetFailures.add("lossless-message");
    const channel = new EmailChannel({ config, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
    try {
      assert.equal((await channel.pollOnce()).errors, 1);
      const replay = await channel.pollOnce();
      assert.equal(replay.accepted + replay.skipped, 1);
      assert.deepEqual(gws.listQueries, ["in:inbox", "in:inbox"]);
      const push = { source: "email", event: "inbound", pubsub: { message: { messageId: "after-baseline", data: Buffer.from(JSON.stringify({ emailAddress: "fluffles@puffle.ai", historyId: "101" })).toString("base64") }, subscription: "projects/puffle/subscriptions/gmail" } };
      await channel.ingestWebhook(push);
      assert.deepEqual(gws.historyCalls, [{ startHistoryId: "100", pageToken: null }]);
    } finally { channel.close(); }
  });
});

test("ingestWebhook accepts inbound events and writes accepted work to the central ledger", async () => {
  await withConfig(async (config) => {
    const channel = new EmailChannel({ config, gws: new FakeGws(), replyGenerator: new FixedReplyGenerator(skipDecision()) });
    try {
      const result = await channel.ingestWebhook({
        inbound: {
          provider: "gmail",
          providerMessageId: "gmail-webhook-1",
          threadId: "thread-webhook-1",
          from: "Kush <kush@puffle.ai>",
          to: "Fluffles <fluffles@puffle.ai>",
          subject: "can you review this?",
          date: "Tue, 30 Jun 2026 06:20:00 -0700",
          messageId: "<gmail-webhook-1@example.com>",
          text: "can you review this and let me know?",
          labels: ["INBOX", "UNREAD"]
        }
      });
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-webhook-1");
        const status = await channel.snapshotStatus();

        assert.deepEqual(result, { accepted: 1, skipped: 0, duplicates: 0, errors: 0 });
        assert.equal(conversation?.status, "queued");
        assert.equal(conversation?.messages[0]?.metadata.providerMessageId, "gmail-webhook-1");
        assert.equal(status.transport?.inboundAccepted, 1);
        assert.equal(status.lastWebhookAccepted, 1);
      } finally {
        ledger.close();
      }
    } finally {
      channel.close();
    }
  });
});

test("ingestWebhook handles Gmail Pub/Sub push by fetching the inbox through Gmail", async () => {
  await withConfig(async (config) => {
    const gws = new FakeGws();
    gws.ids = [{ id: "gmail-pubsub-1", threadId: "thread-pubsub-1" }];
    gws.messages.set("gmail-pubsub-1", gmailMessage("gmail-pubsub-1", {
      subject: "can you check the webhook?",
      text: "can you confirm this webhook email landed?"
    }));
    const channel = new EmailChannel({ config, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
    try {
      const result = await channel.ingestWebhook({
        source: "email",
        event: "inbound",
        pubsub: {
          message: {
            messageId: "pubsub-message-1",
            data: Buffer.from(JSON.stringify({
              emailAddress: "fluffles@puffle.ai",
              historyId: 9650
            }), "utf8").toString("base64")
          },
          subscription: "projects/your-gcp-project/subscriptions/fluffles-gmail-inbound-push"
        }
      });
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-1");
        const status = await channel.snapshotStatus();

        assert.deepEqual(result, { accepted: 1, skipped: 0, duplicates: 0, errors: 0 });
        assert.equal(gws.getCalls, 1);
        assert.equal(conversation?.status, "queued");
        assert.equal(status.lastWebhookAccepted, 1);
        assert.equal(status.lastGmailPushHistoryId, "9650");
      } finally {
        ledger.close();
      }
    } finally {
      channel.close();
    }
  });
});

test("concurrent duplicate webhooks create one durable message and one runnable conversation", async () => {
  await withConfig(async (config) => {
    const channel = new EmailChannel({ config, gws: new FakeGws(), replyGenerator: new FixedReplyGenerator(skipDecision()) });
    const webhook = {
      inbound: {
        provider: "gmail",
        providerMessageId: "concurrent-webhook-1",
        threadId: "thread-concurrent",
        from: "Kush <kush@puffle.ai>",
        to: "Fluffles <fluffles@puffle.ai>",
        subject: "concurrent delivery",
        date: "Tue, 30 Jun 2026 06:20:00 -0700",
        messageId: "<concurrent-webhook-1@example.com>",
        text: "please process this once",
        labels: ["INBOX", "UNREAD"]
      }
    };
    try {
      const results = await Promise.all(Array.from({ length: 8 }, () => channel.ingestWebhook(webhook)));
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-concurrent");
        assert.equal(results.filter((result) => result.accepted === 1).length, 1);
        assert.equal(results.reduce((total, result) => total + result.duplicates, 0), 7);
        assert.equal(conversation?.messages.length, 1);
        assert.equal((await ledger.runnableConversations("email")).length, 1);
      } finally {
        ledger.close();
      }
    } finally {
      channel.close();
    }
  });
});

test("authenticated mailbox identity keeps a Gmail thread stable across recipient aliases", async () => {
  await withConfig(async (config) => {
    const channel = new EmailChannel({ config, gws: new FakeGws(), replyGenerator: new FixedReplyGenerator(skipDecision()) });
    const inbound = (providerMessageId: string, to: string) => ({
      inbound: {
        provider: "gmail", providerMessageId, threadId: "thread-alias", from: "Kush <kush@puffle.ai>", to,
        subject: "alias test", date: "Tue, 30 Jun 2026 06:20:00 -0700", messageId: `<${providerMessageId}@example.com>`,
        text: "please keep this thread together", labels: ["INBOX", "UNREAD"]
      }
    });
    try {
      assert.equal((await channel.ingestWebhook(inbound("alias-1", "fluffles@puffle.ai"))).accepted, 1);
      assert.equal((await channel.ingestWebhook(inbound("alias-2", "fluffles+demo@puffle.ai"))).accepted, 1);
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-alias");
        assert.equal(conversation?.messages.length, 2);
      } finally {
        ledger.close();
      }
    } finally {
      channel.close();
    }
  });
});

test("Gmail Pub/Sub advances a durable history cursor and uses targeted history on the next push", async () => {
  await withConfig(async (config) => {
    const gws = new FakeGws();
    gws.ids = [{ id: "initial-message", threadId: "thread-history" }];
    gws.messages.set("initial-message", gmailMessage("initial-message", { threadId: "thread-history", text: "initial request" }));
    gws.messages.set("history-message", gmailMessage("history-message", { threadId: "thread-history", text: "later request", internalDate: "200" }));
    gws.historyPages.push({ messages: [{ id: "history-message", threadId: "thread-history" }], nextPageToken: null, historyId: "101" });
    const channel = new EmailChannel({ config, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
    const push = (historyId: number) => ({
      source: "email",
      event: "inbound",
      pubsub: {
        message: { messageId: `push-${historyId}`, data: Buffer.from(JSON.stringify({ emailAddress: "fluffles@puffle.ai", historyId }), "utf8").toString("base64") },
        subscription: "projects/puffle/subscriptions/gmail"
      }
    });
    try {
      assert.equal((await channel.ingestWebhook(push(100))).accepted, 1);
      assert.equal((await channel.ingestWebhook(push(101))).accepted, 1);
      assert.deepEqual(gws.historyCalls, [{ startHistoryId: "100", pageToken: null }]);
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-history");
        assert.deepEqual(conversation?.messages.map((message) => message.text.split("\n").at(-1)), ["initial request", "later request"]);
      } finally {
        ledger.close();
      }
    } finally {
      channel.close();
    }
  });
});

test("a transient Gmail history message read failure replays the same cursor even after the message is archived", async () => {
  await withConfig(async (config) => {
    const gws = new FakeGws();
    const channel = new EmailChannel({ config, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
    try {
      // Establish the durable baseline first.
      assert.equal((await channel.pollOnce()).errors, 0);
      const inboxScansBeforeFailure = gws.listQueries.length;
      gws.messages.set("archived-history", gmailMessage("archived-history", {
        threadId: "thread-archived-history",
        labels: ["ARCHIVED"],
        text: "this must survive history replay"
      }));
      gws.historyPages.push({ messages: [{ id: "archived-history", threadId: "thread-archived-history" }], nextPageToken: null, historyId: "101" });
      gws.transientGetFailures.add("archived-history");

      assert.equal((await channel.pollOnce()).errors, 1);
      // A transient history failure never falls back to an inbox scan or
      // advances past a message that no longer has the INBOX label.
      assert.equal(gws.listQueries.length, inboxScansBeforeFailure);
      gws.historyPages.push({ messages: [{ id: "archived-history", threadId: "thread-archived-history" }], nextPageToken: null, historyId: "101" });
      const replay = await channel.pollOnce();
      assert.equal(replay.accepted + replay.skipped, 1);
      assert.deepEqual(gws.historyCalls.map((call) => call.startHistoryId), ["100", "100"]);
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        assert.equal((await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-archived-history"))?.messages.length, 1);
      } finally {
        ledger.close();
      }
    } finally {
      channel.close();
    }
  });
});

test("a 404 while fetching a history message is retried as the same range, not treated as cursor expiry", async () => {
  await withConfig(async (config) => {
    const gws = new FakeGws();
    const channel = new EmailChannel({ config, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
    try {
      await channel.pollOnce();
      const inboxScansBeforeFailure = gws.listQueries.length;
      gws.messages.set("history-message-404", gmailMessage("history-message-404", { threadId: "thread-history-404" }));
      gws.historyPages.push({ messages: [{ id: "history-message-404", threadId: "thread-history-404" }], nextPageToken: null, historyId: "101" });
      gws.messageFailures.set("history-message-404", Object.assign(new Error("message no longer visible"), { status: 404 }));

      assert.equal((await channel.pollOnce()).errors, 1);
      assert.equal(gws.listQueries.length, inboxScansBeforeFailure);
      gws.historyPages.push({ messages: [{ id: "history-message-404", threadId: "thread-history-404" }], nextPageToken: null, historyId: "101" });
      assert.equal((await channel.pollOnce()).accepted, 1);
      assert.deepEqual(gws.historyCalls.map((call) => call.startHistoryId), ["100", "100"]);
    } finally {
      channel.close();
    }
  });
});

test("a partial Gmail history page failure survives restart and replays moved messages at the original cursor", async () => {
  await withConfig(async (config) => {
    const gws = new FakeGws();
    const first = new EmailChannel({ config, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
    try {
      await first.pollOnce();
      gws.messages.set("moved-history", gmailMessage("moved-history", {
        threadId: "thread-moved-history",
        labels: ["PROJECTS"],
        text: "this moved message must not be skipped"
      }));
      gws.historyPages.push({ messages: [{ id: "moved-history", threadId: "thread-moved-history" }], nextPageToken: "second-page", historyId: "101" });
      gws.historyFailure = new Error("temporary Gmail history page failure");
      gws.historyFailurePageToken = "second-page";
      assert.equal((await first.pollOnce()).errors, 1);
      first.close();

      const restarted = new EmailChannel({ config, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
      try {
        gws.historyPages.push(
          { messages: [{ id: "moved-history", threadId: "thread-moved-history" }], nextPageToken: "second-page", historyId: "101" },
          { messages: [], nextPageToken: null, historyId: "101" }
        );
        const replay = await restarted.pollOnce();
        assert.equal(replay.accepted + replay.skipped, 1);
        assert.deepEqual(gws.historyCalls.map((call) => call.startHistoryId), ["100", "100", "100", "100"]);
      } finally {
        restarted.close();
      }
    } finally {
      first.close();
    }
  });
});

test("only an explicit expired Gmail history cursor triggers a baseline rebuild", async () => {
  await withConfig(async (config) => {
    const gws = new FakeGws();
    const channel = new EmailChannel({ config, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
    try {
      await channel.pollOnce();
      gws.ids = [{ id: "rebuild-message", threadId: "thread-rebuild" }];
      gws.messages.set("rebuild-message", gmailMessage("rebuild-message", { threadId: "thread-rebuild" }));
      gws.profileHistoryId = "102";
      gws.historyFailure = Object.assign(new Error("Gmail historyId not found"), { status: 404 });
      assert.equal((await channel.pollOnce()).accepted, 1);
      // One baseline scan established cursor 100; the explicit expiration
      // causes exactly one controlled rebuild.
      assert.equal(gws.listQueries.length, 2);
      assert.equal((await channel.pollOnce()).duplicates, 0);
      assert.deepEqual(gws.historyCalls.at(-1), { startHistoryId: "102", pageToken: null });
    } finally {
      channel.close();
    }
  });
});

test("processQueued drafts an email reply and marks the central run done", async () => {
  await withConfig(async (config) => {
    await recordEmailTask(acceptedEmail(), acceptedClassification(), { ledgerPath: config.taskLedgerPath });
    const gws = new FakeGws();
    const channel = new EmailChannel({
      config,
      gws,
      replyGenerator: new FixedReplyGenerator({
        shouldReply: true,
        reason: "clear-human-ask",
        subject: "Re: can you check email?",
        body: "I checked it."
      })
    });
    try {
      const result = await channel.processQueued();
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-1");
        const status = await channel.snapshotStatus();

        assert.deepEqual(result, { processed: 1, failed: 0 });
        assert.equal(gws.replies.length, 1);
        assert.equal(gws.replies[0]?.messageId, "gmail-message-1");
        assert.equal(gws.replies[0]?.draft, true);
        assert.equal(gws.replies[0]?.from, "fluffles@puffle.ai");
        assert.equal(conversation?.status, "done");
        assert.equal(conversation?.runs[0]?.status, "done");
        assert.deepEqual(conversation?.messages.map((message) => message.role), ["user", "assistant"]);
        assert.equal(conversation?.messages[1]?.text, "I checked it.");
        assert.equal(status.transport?.outboundDrafted, 1);
      } finally {
        ledger.close();
      }
    } finally {
      channel.close();
    }
  });
});


test("CodexEmailReplyGenerator invokes current Codex exec config flags", async () => {
  await withConfig(async (config) => {
    const calls: { command: string; args: string[] }[] = [];
    const runner = successfulCodexRunner('{"should_reply":true,"reason":"ok","subject":null,"body":"ok"}', (command, args) => {
      calls.push({ command, args });
    });
    {
      const generator = new CodexEmailReplyGenerator(config, runner);
      const decision = await generator.generate({ conversationKey: "email:main:test", prompt: "runtime-built prompt" });
      const args = calls[0]?.args ?? [];

      assert.equal(decision.body, "ok");
      assert.ok(args.includes("exec"));
      assert.ok(args.includes("-c"));
      assert.ok(args.includes('model_reasoning_effort="low"'));
      assert.ok(args.includes('service_tier="fast"'));
      assert.ok(!args.includes("--reasoning-effort"));
      assert.ok(!args.includes("--service-tier"));
    }
  });
});

test("CodexEmailReplyGenerator rejects when codex closes stdin with EPIPE", async () => {
  await withConfig(async (config) => {
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const runner = new CodexProcessRunner((() => {
      const child = new EventEmitter() as ChildProcess;
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback(epipe);
        }
      });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      return child;
    }) as typeof spawn);
    const generator = new CodexEmailReplyGenerator(config, runner);
    await assert.rejects(
      generator.generate({
        conversationKey: "email:main:epipe",
        prompt: "runtime-built prompt"
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /stdin failed/);
        assert.equal((error as Error & { code?: string }).code, "STDIN_FAILED");
        return true;
      }
    );
  });
});

test("email stop cancels an active Codex child without delivering its stale reply", async () => {
  await withConfig(async (config) => {
    const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
    const engine = new ConversationEngine({ ledger });
    const gws = new FakeGws();
    let signalStarted: (() => void) | null = null;
    const childStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    const runner = new CodexProcessRunner((() => {
      const child = new EventEmitter() as ChildProcess;
      child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal?: NodeJS.Signals | number) => {
        queueMicrotask(() => child.emit("close", null, typeof signal === "string" ? signal : "SIGTERM"));
        return true;
      };
      signalStarted?.();
      return child;
    }) as typeof spawn);
    const channel = new EmailChannel({ config, engine, ledger, gws, codexRunner: runner });
    try {
      await engine.ingest({ ...buildEmailLedgerInput(acceptedEmail({ id: "gmail-active", threadId: "thread-stop-active" }), acceptedClassification()), intakeMode: "direct" });
      const processing = channel.processQueued();
      await childStarted;

      gws.ids = [{ id: "gmail-stop-active", threadId: "thread-stop-active" }];
      gws.messages.set("gmail-stop-active", gmailMessage("gmail-stop-active", { threadId: "thread-stop-active", text: "stop" }));
      await channel.pollOnce();
      assert.deepEqual(await processing, { processed: 1, failed: 1 });

      const conversation = await engine.getConversation("email", "email:fluffles@puffle.ai:thread-stop-active");
      assert.equal(conversation?.status, "stopped");
      assert.equal(conversation?.runs[0]?.status, "stopped");
      assert.equal(conversation?.messages.find((message) => message.externalMessageId === "<gmail-stop-active@example.com>")?.metadata.nonActionable, true);
      assert.deepEqual(gws.replies, []);
      assert.equal(runner.activeCount, 0);
    } finally {
      channel.close();
      ledger.close();
    }
  });
});

test("processQueued records failed runs when Gmail auth is invalid", async () => {
  await withConfig(async (config) => {
    await recordEmailTask(acceptedEmail(), acceptedClassification(), { ledgerPath: config.taskLedgerPath });
    const gws = new FakeGws();
    gws.auth = { token_valid: false, token_error: "reauth related error (invalid_rapt)" };
    const channel = new EmailChannel({
      config,
      gws,
      replyGenerator: new FixedReplyGenerator({
        shouldReply: true,
        reason: "clear-human-ask",
        subject: "Re: can you check email?",
        body: "I checked it."
      })
    });
    try {
      const result = await channel.processQueued();
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-1");
        const status = await channel.snapshotStatus();

        assert.deepEqual(result, { processed: 1, failed: 1 });
        assert.equal(gws.replies.length, 0);
        assert.equal(conversation?.status, "failed");
        assert.equal(conversation?.runs[0]?.status, "failed");
        assert.match(conversation?.lastError || "", /invalid_rapt/);
        assert.equal(status.transport?.outboundFailed, 1);
      } finally {
        ledger.close();
      }
    } finally {
      channel.close();
    }
  });
});

test("processQueued automatically compacts long email conversations before generating replies", async () => {
  await withConfig(async (config) => {
    const runner = successfulCodexRunner("email checkpoint");
    const longEmail = (marker: string) => `${"context ".repeat(560)}\n${marker}`;
    const compactConfig: EmailChannelConfig = {
      ...config,
      contextLimits: {
        ...config.contextLimits,
        maxContextChars: 9_000,
        maxContextTokens: 9_000
      }
    };
    const ledger = new SQLiteTaskLedger({ filePath: compactConfig.taskLedgerPath });
    try {
      await recordEmailTask(acceptedEmail({ id: "gmail-message-1", messageId: "<gmail-message-1@example.com>", text: longEmail("first long email") }), acceptedClassification(), { ledgerPath: compactConfig.taskLedgerPath });
      await recordEmailTask(acceptedEmail({ id: "gmail-message-2", messageId: "<gmail-message-2@example.com>", text: longEmail("second long email") }), acceptedClassification(), { ledgerPath: compactConfig.taskLedgerPath });
      const first = await ledger.startRun("email", "email:fluffles@puffle.ai:thread-1");
      assert.ok(first);
      await ledger.finishRun("email", "email:fluffles@puffle.ai:thread-1", first.run.id, "done");
      await recordEmailTask(acceptedEmail({ id: "gmail-message-3", messageId: "<gmail-message-3@example.com>", text: longEmail("third email after checkpoint") }), acceptedClassification(), { ledgerPath: compactConfig.taskLedgerPath });

      const channel = new EmailChannel({
        config: compactConfig,
        gws: new FakeGws(),
        codexRunner: runner,
        replyGenerator: new FixedReplyGenerator(skipDecision())
      });
      try {
        await channel.processQueued();

        const firstCompaction = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-1");
        assert.equal(firstCompaction?.compactionSeq, 1);
        assert.equal(firstCompaction?.compactionSummary, "email checkpoint");
        const firstContext = await ledger.buildContext("email", "email:fluffles@puffle.ai:thread-1");
        assert.deepEqual(firstContext?.messages.map((message) => message.text.split("\n").at(-1)), ["second long email", "third email after checkpoint"]);
        assert.deepEqual(
          firstCompaction?.messages
            .filter((message) => message.role === "user")
            .map((message) => message.text.split("\n").at(-1))
            .sort(),
          ["first long email", "second long email", "third email after checkpoint"]
        );

        await recordEmailTask(
          acceptedEmail({ id: "gmail-message-4", messageId: "<gmail-message-4@example.com>", text: longEmail("fourth email after second checkpoint") }),
          acceptedClassification(),
          { ledgerPath: compactConfig.taskLedgerPath }
        );
        await channel.processQueued();
      } finally {
        channel.close();
      }

      const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-1");
      assert.ok((conversation?.compactionSeq ?? 0) >= 2);
      assert.equal(conversation?.compactionSummary, "email checkpoint");
      const context = await ledger.buildContext("email", "email:fluffles@puffle.ai:thread-1");
      assert.deepEqual(
        context?.messages.map((message) => message.text.split("\n").at(-1)),
        ["third email after checkpoint", "fourth email after second checkpoint"]
      );
      assert.deepEqual(
        conversation?.messages
          .filter((message) => message.role === "user")
          .map((message) => message.text.split("\n").at(-1))
          .sort(),
        ["first long email", "fourth email after second checkpoint", "second long email", "third email after checkpoint"]
      );
    } finally {
      ledger.close();
    }
  });
});

test("email compaction fails safely when its source prompt cannot fit the hard context budget", async () => {
  await withConfig(async (config) => {
    const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const runner = new CodexProcessRunner((() => {
      const child = new EventEmitter() as ChildProcess;
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback(epipe);
        }
      });
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      return child;
    }) as typeof spawn);
    const compactConfig: EmailChannelConfig = {
      ...config,
      contextLimits: { ...config.contextLimits, maxContextTokens: 1 }
    };
    try {
      await recordEmailTask(acceptedEmail({ id: "gmail-epipe-1", messageId: "<gmail-epipe-1@example.com>", text: "first email" }), acceptedClassification(), { ledgerPath: config.taskLedgerPath });
      await recordEmailTask(acceptedEmail({ id: "gmail-epipe-2", messageId: "<gmail-epipe-2@example.com>", text: "second email" }), acceptedClassification(), { ledgerPath: config.taskLedgerPath });
      const first = await ledger.startRun("email", "email:fluffles@puffle.ai:thread-1");
      assert.ok(first);
      await ledger.finishRun("email", "email:fluffles@puffle.ai:thread-1", first.run.id, "done");
      await recordEmailTask(acceptedEmail({ id: "gmail-epipe-3", messageId: "<gmail-epipe-3@example.com>", text: "third email" }), acceptedClassification(), { ledgerPath: config.taskLedgerPath });

      const channel = new EmailChannel({
        config: compactConfig,
        gws: new FakeGws(),
        codexRunner: runner,
        replyGenerator: new FixedReplyGenerator(skipDecision())
      });
      try {
        assert.deepEqual(await channel.processQueued(), { processed: 1, failed: 1 });
      } finally {
        channel.close();
      }

      const conversation = await ledger.getConversation("email", "email:fluffles@puffle.ai:thread-1");
      assert.equal(conversation?.compactionSeq, null);
      assert.equal(conversation?.compactionSummary, null);
      assert.equal(conversation?.status, "failed");
      assert.equal(conversation?.runs.at(-1)?.status, "failed");
      assert.deepEqual(
        conversation?.messages
          .filter((message) => message.role === "user")
          .map((message) => message.externalMessageId)
          .sort(),
        ["<gmail-epipe-1@example.com>", "<gmail-epipe-2@example.com>", "<gmail-epipe-3@example.com>"]
      );
    } finally {
      ledger.close();
    }
  });
});

function skipDecision(): EmailReplyDecision {
  return {
    shouldReply: false,
    reason: "not needed",
    subject: null,
    body: ""
  };
}

function successfulCodexRunner(output: string, onSpawn?: (command: string, args: string[]) => void): CodexProcessRunner {
  return new CodexProcessRunner(((command: string, args: readonly string[] | undefined) => {
    onSpawn?.(command, [...(args ?? [])]);
    const child = new EventEmitter() as ChildProcess;
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      (child.stdout as PassThrough).end(`${output}\n`);
      child.emit("close", 0, null);
    });
    return child;
  }) as typeof spawn);
}

function base64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

test("pollOnce routes accepted email through ConversationEngine", async () => {
  await withConfig(async (config) => {
    const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
    const engine = new ConversationEngine({ ledger });
    const gws = new FakeGws();
    gws.ids = [{ id: "gmail-eng-1", threadId: "thread-1" }];
    gws.messages.set("gmail-eng-1", gmailMessage("gmail-eng-1"));
    const channel = new EmailChannel({ config, engine, ledger, gws, replyGenerator: new FixedReplyGenerator(skipDecision()) });
    try {
      const result = await channel.pollOnce();
      // gmailMessage() sets threadId: "thread-1", so emailConversationKey produces this key
      const conversation = await engine.getConversation("email", "email:fluffles@puffle.ai:thread-1");

      assert.deepEqual(result, { accepted: 1, skipped: 0, duplicates: 0, errors: 0 });
      assert.ok(conversation, "conversation must appear in the injected engine, not a separate ledger");
      assert.equal(conversation.status, "queued");
      assert.equal(conversation.messages[0]?.metadata.intakeMode, "direct");
    } finally {
      channel.close();
      ledger.close();
    }
  });
});

test("processQueued routes run lifecycle through ConversationEngine", async () => {
  await withConfig(async (config) => {
    const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
    const engine = new ConversationEngine({ ledger });
    const gws = new FakeGws();
    const channel = new EmailChannel({
      config,
      engine,
      ledger,
      gws,
      replyGenerator: new FixedReplyGenerator({ shouldReply: true, reason: "ok", subject: null, body: "hello" })
    });
    try {
      await engine.ingest({ ...buildEmailLedgerInput(acceptedEmail(), acceptedClassification()), intakeMode: "direct" });
      const result = await channel.processQueued();
      const conversation = await engine.getConversation("email", "email:fluffles@puffle.ai:thread-1");

      assert.deepEqual(result, { processed: 1, failed: 0 });
      assert.equal(conversation?.status, "done");
      assert.equal(conversation?.runs[0]?.status, "done");
    } finally {
      channel.close();
      ledger.close();
    }
  });
});

test("processQueued does not deliver email when a stop wins before delivery", async () => {
  await withConfig(async (config) => {
    const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
    const engine = new ConversationEngine({ ledger });
    const gws = new FakeGws();
    const channel = new EmailChannel({
      config,
      engine,
      ledger,
      gws,
      replyGenerator: {
        async generate() {
          await engine.stop("email", "email:fluffles@puffle.ai:thread-1", "user_stop");
          return { shouldReply: true, reason: "ok", subject: null, body: "must not send" };
        }
      }
    });
    try {
      await engine.ingest({ ...buildEmailLedgerInput(acceptedEmail(), acceptedClassification()), intakeMode: "direct" });

      assert.deepEqual(await channel.processQueued(), { processed: 1, failed: 1 });
      assert.deepEqual(gws.replies, []);
      const conversation = await engine.getConversation("email", "email:fluffles@puffle.ai:thread-1");
      assert.equal(conversation?.status, "stopped");
      assert.equal(conversation?.messages.filter((message) => message.role === "assistant").length, 0);
    } finally {
      channel.close();
      ledger.close();
    }
  });
});

test("ambiguous Gmail delivery does not persist assistant output or retry before reconciliation delay", async () => {
  await withConfig(async (config) => {
    const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
    const engine = new ConversationEngine({ ledger });
    const gws = new FakeGws();
    gws.replyError = new Error("Gmail draft creation failed");
    const channel = new EmailChannel({
      config,
      engine,
      ledger,
      gws,
      replyGenerator: new FixedReplyGenerator({ shouldReply: true, reason: "ok", subject: null, body: "undelivered email reply" })
    });
    try {
      await engine.ingest({ ...buildEmailLedgerInput(acceptedEmail(), acceptedClassification()), intakeMode: "direct" });

      assert.deepEqual(await channel.processQueued(), { processed: 1, failed: 1 });
      const conversation = await engine.getConversation("email", "email:fluffles@puffle.ai:thread-1");
      const context = await engine.buildContext("email", "email:fluffles@puffle.ai:thread-1");
      const delivery = (await engine.outboundDeliveries("email", "email:fluffles@puffle.ai:thread-1"))[0];

      assert.deepEqual(gws.replies, []);
      assert.equal(gws.replyAttempts, 1);
      assert.equal(delivery?.status, "acceptance_unknown");
      assert.deepEqual(conversation?.messages.map((message) => message.role), ["user"]);
      assert.deepEqual(context?.messages.map((message) => message.role), ["user"]);
      assert.equal(conversation?.status, "queued");
      assert.deepEqual(await channel.processQueued(), { processed: 1, failed: 1 });
      assert.equal(gws.replyAttempts, 1, "Gmail cannot be resent until its reconciliation delay expires");
    } finally {
      channel.close();
      ledger.close();
    }
  });
});

test("Gmail recovery confirms an accepted draft without generating a second reply", async () => {
  await withConfig(async (config) => {
    const gws = new FakeGws();
    const generator = new CountingEmailReplyGenerator({ shouldReply: true, reason: "ok", subject: null, body: "durable email reply" });
    const firstLedger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
    const firstEngine = new ConversationEngine({ ledger: firstLedger });
    const firstChannel = new EmailChannel({ config, engine: firstEngine, ledger: firstLedger, gws, replyGenerator: generator });
    try {
      gws.crashAfterAccept = true;
      await firstEngine.ingest({ ...buildEmailLedgerInput(acceptedEmail(), acceptedClassification()), intakeMode: "direct" });
      assert.deepEqual(await firstChannel.processQueued(), { processed: 1, failed: 0 });
      assert.deepEqual((await firstEngine.getConversation("email", "email:fluffles@puffle.ai:thread-1"))?.messages.map((message) => message.role), ["user", "assistant"]);
      firstChannel.close();
      firstLedger.close();

      gws.crashAfterAccept = false;
      const restartedLedger = new SQLiteTaskLedger({
        filePath: config.taskLedgerPath,
        runProcessStartedAt: () => null,
        runProcessExists: () => false
      });
      const restartedEngine = new ConversationEngine({ ledger: restartedLedger });
      const restartedChannel = new EmailChannel({ config, engine: restartedEngine, ledger: restartedLedger, gws, replyGenerator: generator });
      try {
        await restartedChannel.recoverInterruptedRuns();
        assert.deepEqual(await restartedChannel.processQueued(), { processed: 0, failed: 0 });
        const conversation = await restartedEngine.getConversation("email", "email:fluffles@puffle.ai:thread-1");
        assert.equal(generator.calls, 1);
        assert.equal(gws.replies.length, 1);
        assert.equal(gws.replies[0]?.body, "durable email reply");
        assert.deepEqual(conversation?.messages.map((message) => message.role), ["user", "assistant"]);
        assert.equal(conversation?.messages.at(-1)?.text, "durable email reply");
        assert.equal(conversation?.status, "done");
      } finally {
        restartedChannel.close();
        restartedLedger.close();
      }
    } finally {
      firstChannel.close();
      firstLedger.close();
    }
  });
});

test("processQueued consumes email steering messages in the same run", async () => {
  await withConfig(async (config) => {
    const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
    const engine = new ConversationEngine({ ledger });
    const gws = new FakeGws();
    const replyGenerator = new SteeringEmailReplyGenerator(engine);
    const channel = new EmailChannel({ config, engine, ledger, gws, replyGenerator });
    try {
      await engine.ingest({ ...buildEmailLedgerInput(acceptedEmail(), acceptedClassification()), intakeMode: "direct" });
      const result = await channel.processQueued();
      const conversation = await engine.getConversation("email", "email:fluffles@puffle.ai:thread-1");
      const runnable = await engine.runnableConversations("email");

      assert.deepEqual(result, { processed: 1, failed: 0 });
      assert.equal(replyGenerator.inputs.length, 2);
      assert.match(replyGenerator.inputs[1]?.prompt ?? "", /can you check that email works\?/);
      assert.match(replyGenerator.inputs[1]?.prompt ?? "", /actually include the calendar too/);
      assert.equal(gws.replies.length, 1);
      assert.equal(gws.replies[0]?.body, "updated draft");
      assert.equal(conversation?.status, "done");
      assert.equal(conversation?.runs[0]?.status, "done");
      assert.deepEqual(
        conversation?.messages.filter((message) => message.role === "user").map((message) => message.runId),
        [conversation?.runs[0]?.id, conversation?.runs[0]?.id]
      );
      assert.deepEqual(runnable, []);
    } finally {
      channel.close();
      ledger.close();
    }
  });
});

test("a due email reminder runs through the ordinary processing tick and replies", async () => {
  await withConfig(async (config) => {
    const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
    const engine = new ConversationEngine({ ledger });
    const gws = new FakeGws();
    const replyGenerator = new CapturingEmailReplyGenerator({ shouldReply: true, reason: "reminder", subject: "Re: reminder", body: "followed up" });
    const channel = new EmailChannel({ config, engine, ledger, gws, replyGenerator });
    try {
      const input = buildEmailLedgerInput(acceptedEmail(), acceptedClassification());
      await engine.ingest({ ...input, intakeMode: "direct" });
      const conversationKey = input.conversationKey;
      await channel.processQueued();

      const reminder = await ledger.createReminder({
        companyId: "company-email",
        instruction: "follow up",
        scheduledFor: new Date(Date.now() + 50).toISOString(),
        displayTimezone: "America/Los_Angeles",
        channel: "email",
        conversationKey
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await channel.processQueued();
      assert.equal(result.processed, 1);
      assert.equal(result.failed, 0);
      assert.equal((await ledger.getReminder(reminder.id))?.status, "delivered");
      assert.match(replyGenerator.input?.prompt ?? "", /follow up/);

      const conversation = await ledger.getConversation("email", conversationKey);
      assert.equal(conversation?.status, "done");
      const run = conversation?.runs.at(-1);
      assert.equal(run?.status, "done");
      assert.equal(conversation?.messages.filter((message) => message.metadata.reminderId === reminder.id).length, 1);
    } finally {
      channel.close();
      ledger.close();
    }
  });
});

test("email stop is persisted and interrupts the active run without sending a reply", async () => {
  await withConfig(async (config) => {
    const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
    const engine = new ConversationEngine({ ledger });
    const gws = new FakeGws();
    gws.ids = [{ id: "gmail-stop", threadId: "thread-stop" }];
    gws.messages.set("gmail-stop", gmailMessage("gmail-stop", { threadId: "thread-stop", text: "stop" }));
    const channel = new EmailChannel({ config, engine, ledger, gws, replyGenerator: new FixedReplyGenerator({ shouldReply: true, reason: "test", subject: null, body: "stale" }) });
    try {
      await engine.ingest({ ...buildEmailLedgerInput(acceptedEmail({ id: "gmail-running", threadId: "thread-stop" }), acceptedClassification()), intakeMode: "direct" });
      const started = await engine.startRun("email", "email:fluffles@puffle.ai:thread-stop");
      assert.ok(started);

      await channel.pollOnce();
      await channel.processQueued();

      const conversation = await engine.getConversation("email", "email:fluffles@puffle.ai:thread-stop");
      assert.equal(conversation?.status, "stopped");
      assert.equal(conversation?.runs[0]?.status, "stopped");
      const stopMessage = conversation?.messages.find((message) => message.text.endsWith("stop"));
      assert.equal(stopMessage?.runId, null);
      assert.equal(stopMessage?.metadata.nonActionable, true);
      assert.deepEqual(gws.replies, []);
    } finally {
      channel.close();
      ledger.close();
    }
  });
});

test("the default reply schema path is a file the runtime actually has", () => {
  const home = path.resolve(__dirname, "..", "..", "..");
  const config = defaultEmailChannelConfig({ HOME: home, FLUFFLES_HOME: home } as NodeJS.ProcessEnv);
  assert.equal(config.codexSchemaPath, path.join(home, "channels", "email", "reply-schema.json"));
  assert.ok(existsSync(config.codexSchemaPath), `${config.codexSchemaPath} must exist in the deployed tree`);
});

function deliveryInterruptedError(): Error {
  const error = new Error("provider accepted delivery before runtime confirmation");
  error.name = "DeliveryInterruptedError";
  return error;
}
