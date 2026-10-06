import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { CodexProcessRunner, ConversationEngine, SQLiteTaskLedger, type TaskLedgerMessage } from "@fluffles/tasks";
import { AGENTPHONE_FROM_NUMBER, type AgentPhoneListCallsInput, type AgentPhoneListMessagesInput, type AgentPhoneSendMessageInput, type AgentPhoneSendMessageResult, type PhoneAgentPhoneClient } from "../src/agentphone-client";
import { PhoneChannel, defaultPhoneChannelConfig, type PhoneReplyGenerator, type PhoneReplyGeneratorInput } from "../src/phone-channel";
import type { NormalizedPhoneCall, NormalizedPhoneMessage } from "../src/phone-normalize";
import { buildPhoneMessageLedgerInput } from "../src/phone-task-adapter";
import { SQLitePhoneTransportStore } from "../src/phone-transport-store";

class FakeAgentPhoneClient implements PhoneAgentPhoneClient {
  messages: NormalizedPhoneMessage[] = [];
  calls: NormalizedPhoneCall[] = [];
  sent: AgentPhoneSendMessageInput[] = [];
  sendError: Error | null = null;
  crashAfterAccept = false;
  transcriptResponse: Record<string, unknown> = { transcript: [] };
  failMessagePageBefore: string | null = null;
  failCallPageOffset: number | null = null;
  messageRequests: AgentPhoneListMessagesInput[] = [];
  callRequests: AgentPhoneListCallsInput[] = [];
  private failedMessagePage = false;
  private failedCallPage = false;

  async listMessages(input: AgentPhoneListMessagesInput): Promise<NormalizedPhoneMessage[]> {
    this.messageRequests.push({ ...input });
    const before = input.before ?? null;
    if (this.failMessagePageBefore !== null && before === this.failMessagePageBefore && !this.failedMessagePage) {
      this.failedMessagePage = true;
      throw new Error("temporary AgentPhone message page failure");
    }
    const start = before == null ? 0 : this.messages.findIndex((message) => message.id === before) + 1;
    if (before != null && start === 0) return [];
    return this.messages.slice(start, start + (input.limit ?? this.messages.length));
  }

  async listCalls(input: AgentPhoneListCallsInput): Promise<NormalizedPhoneCall[]> {
    this.callRequests.push({ ...input });
    const offset = input.offset ?? 0;
    if (this.failCallPageOffset === offset && !this.failedCallPage) {
      this.failedCallPage = true;
      throw new Error("temporary AgentPhone call page failure");
    }
    return this.calls.slice(offset, offset + (input.limit ?? this.calls.length));
  }

  async getCallTranscript(_callId: string): Promise<Record<string, unknown>> {
    return this.transcriptResponse;
  }

  async sendMessage(input: AgentPhoneSendMessageInput): Promise<AgentPhoneSendMessageResult> {
    if (this.sendError) throw this.sendError;
    this.sent.push(input);
    if (input.idempotencyKey) {
      this.messages.push(phoneMessage(`sent-${this.sent.length}`, input.body, {
        direction: "outbound",
        fromNumber: AGENTPHONE_FROM_NUMBER,
        toNumber: input.toNumber,
        raw: { id: `sent-${this.sent.length}`, idempotency_key: input.idempotencyKey }
      }));
    }
    if (this.crashAfterAccept) throw deliveryInterruptedError();
    return { providerMessageId: `sent-${this.sent.length}`, response: { id: `sent-${this.sent.length}` } };
  }
}

class BlockingFirstPollAgentPhoneClient extends FakeAgentPhoneClient {
  private firstRequest = true;
  private signalFirstRequest: (() => void) | null = null;
  private releaseFirstRequest: (() => void) | null = null;
  readonly firstRequestStarted = new Promise<void>((resolve) => { this.signalFirstRequest = resolve; });
  private readonly firstRequestReleased = new Promise<void>((resolve) => { this.releaseFirstRequest = resolve; });

  override async listMessages(input: AgentPhoneListMessagesInput): Promise<NormalizedPhoneMessage[]> {
    if (this.firstRequest) {
      this.firstRequest = false;
      this.signalFirstRequest?.();
      await this.firstRequestReleased;
    }
    return super.listMessages(input);
  }

  releaseFirstPage(): void {
    this.releaseFirstRequest?.();
  }
}

class BlockingFirstCallPollAgentPhoneClient extends FakeAgentPhoneClient {
  private firstRequest = true;
  private signalFirstRequest: (() => void) | null = null;
  private releaseFirstRequest: (() => void) | null = null;
  readonly firstRequestStarted = new Promise<void>((resolve) => { this.signalFirstRequest = resolve; });
  private readonly firstRequestReleased = new Promise<void>((resolve) => { this.releaseFirstRequest = resolve; });

  override async listCalls(input: AgentPhoneListCallsInput): Promise<NormalizedPhoneCall[]> {
    if (this.firstRequest) {
      this.firstRequest = false;
      this.signalFirstRequest?.();
      await this.firstRequestReleased;
    }
    return super.listCalls(input);
  }

  releaseFirstPage(): void {
    this.releaseFirstRequest?.();
  }
}

class StaticReplyGenerator implements PhoneReplyGenerator {
  async generate(_input?: PhoneReplyGeneratorInput): Promise<{ shouldReply: boolean; reason: string; body: string }> {
    return { shouldReply: true, reason: "test", body: "got it" };
  }
}

class CountingPhoneReplyGenerator implements PhoneReplyGenerator {
  calls = 0;

  async generate(): Promise<{ shouldReply: boolean; reason: string; body: string }> {
    this.calls += 1;
    return { shouldReply: true, reason: "test", body: "durable phone reply" };
  }
}

class CapturingPhoneReplyGenerator extends StaticReplyGenerator {
  input: PhoneReplyGeneratorInput | null = null;

  override async generate(input: PhoneReplyGeneratorInput): Promise<{ shouldReply: boolean; reason: string; body: string }> {
    this.input = input;
    return super.generate();
  }
}

class SteeringPhoneReplyGenerator implements PhoneReplyGenerator {
  readonly inputs: PhoneReplyGeneratorInput[] = [];

  constructor(private readonly engine: ConversationEngine) {}

  async generate(input: PhoneReplyGeneratorInput): Promise<{ shouldReply: boolean; reason: string; body: string }> {
    this.inputs.push(input);
    if (this.inputs.length === 1) {
      await this.engine.ingest({
        ...buildPhoneMessageLedgerInput(phoneMessage("msg-2", "actually use the latest phone detail", { conversationId: "conv-steering" })),
        intakeMode: "direct"
      });
      return { shouldReply: true, reason: "first-pass", body: "first text" };
    }
    return { shouldReply: true, reason: "steered", body: "updated text" };
  }
}

async function withChannel<T>(fn: (channel: PhoneChannel, client: FakeAgentPhoneClient, dir: string) => Promise<T>): Promise<T> {
  const dir = await harnessHome("phone-channel-test-");
  const client = new FakeAgentPhoneClient();
  const config = defaultPhoneChannelConfig({
    HOME: dir,
    PHONE_TASK_LEDGER_PATH: path.join(dir, "tasks.sqlite"),
    PHONE_TRANSPORT_STORE_PATH: path.join(dir, "phone-transport.sqlite"),
    PHONE_CHANNEL_STATUS_PATH: path.join(dir, "status.json"),
    PHONE_OUTBOUND_MODE: "send",
    PHONE_PROCESSING_ENABLED: "1",
    PHONE_POLL_CALLS_ENABLED: "0"
  });
  const channel = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
  try {
    return await fn(channel, client, dir);
  } finally {
    channel.close();
    await rm(dir, { recursive: true, force: true });
  }
}

// A turn links the harness standing rules into its scratch workdir and refuses
// to run without them, so a home fixture has to carry the file.
async function harnessHome(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  await writeFile(path.join(dir, "AGENTS.md"), "<identity>You are Fluffles.</identity>\n");
  return dir;
}

function ledgerMessage(index: number, text = `message ${index}`): TaskLedgerMessage {
  return {
    id: `message-${index}`,
    seq: index,
    role: "user",
    externalMessageId: `external-${index}`,
    authorId: "+14155550123",
    text,
    receivedAt: `2026-01-01T00:00:0${index}.000Z`,
    runId: null,
    metadata: { index }
  };
}

test("ingests a message with a valid provider conversation id and sends a reply", async () => {
  await withChannel(async (channel, client, dir) => {
    client.messages = [{
      provider: "agentphone",
      id: "msg-1",
      numberId: "number-1",
      conversationId: "conv-1",
      fromNumber: "+14155550123",
      toNumber: AGENTPHONE_FROM_NUMBER,
      direction: "inbound",
      channel: "sms",
      body: "hello",
      mediaUrls: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      receivedAt: "2026-01-01T00:00:00.000Z",
      raw: { id: "msg-1" }
    }];

    const poll = await channel.pollOnce();
    assert.deepEqual(poll, { accepted: 1, skipped: 0, duplicates: 0, errors: 0 });

    const duplicate = await channel.pollOnce();
    assert.deepEqual(duplicate, { accepted: 0, skipped: 0, duplicates: 1, errors: 0 });

    const processed = await channel.processQueued();
    assert.deepEqual(processed, { processed: 1, failed: 0 });
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0]?.toNumber, "+14155550123");
    assert.equal(client.sent[0]?.body, "got it");
    assert.equal(client.sent[0]?.replyToMessageId, undefined);

    const ledger = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
    try {
      const conversation = await ledger.getConversation("phone", "phone:conv-1");
      assert.deepEqual(conversation?.messages.map((message) => message.role), ["user", "assistant"]);
      assert.equal(conversation?.messages[1]?.text, "got it");
      assert.equal(conversation?.status, "done");
      assert.equal(conversation?.runs[0]?.status, "done");
    } finally {
      ledger.close();
    }
  });
});

test("concurrent duplicate polls admit one phone message and one runnable conversation", async () => {
  await withChannel(async (channel, client, dir) => {
    client.messages = [phoneMessage("concurrent-duplicate", "hello once", { conversationId: "conv-concurrent" })];

    const [first, second] = await Promise.all([channel.pollOnce(), channel.pollOnce()]);
    assert.equal(first.accepted + second.accepted, 1);
    assert.equal(first.duplicates + second.duplicates, 0);
    assert.deepEqual(await channel.processQueued(), { processed: 1, failed: 0 });

    const ledger = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
    try {
      const conversation = await ledger.getConversation("phone", "phone:conv-concurrent");
      assert.deepEqual(conversation?.messages.map((message) => message.role), ["user", "assistant"]);
      assert.equal(client.sent.length, 1);
    } finally {
      ledger.close();
    }
  });
});

test("independent Phone workers use the durable polling ownership fence", async () => {
  const dir = await harnessHome("phone-poll-ownership-");
  const client = new BlockingFirstPollAgentPhoneClient();
  const config = phonePollingConfig(dir, 2);
  const first = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
  const second = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
  try {
    client.messages = [phoneMessage("multi-worker-1", "one admission", { conversationId: "multi-worker" })];
    const firstPoll = first.pollOnce();
    await client.firstRequestStarted;
    const secondPoll = await second.pollOnce();
    client.releaseFirstPage();
    const firstPollResult = await firstPoll;

    assert.deepEqual(firstPollResult, { accepted: 1, skipped: 0, duplicates: 0, errors: 0 });
    assert.deepEqual(secondPoll, { accepted: 0, skipped: 0, duplicates: 0, errors: 0 });
    const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
    try {
      const conversation = await ledger.getConversation("phone", "phone:multi-worker");
      assert.deepEqual(conversation?.messages.map((message) => message.externalMessageId), ["multi-worker-1"]);
    } finally {
      ledger.close();
    }
  } finally {
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lossless phone polling pages a high-volume backlog before admitting it oldest first", async () => {
  const dir = await harnessHome("phone-lossless-polling-");
  const client = new FakeAgentPhoneClient();
  const config = phonePollingConfig(dir, 3);
  const channel = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
  try {
    client.messages = Array.from({ length: 11 }, (_, offset) => {
      const id = String(11 - offset).padStart(2, "0");
      return phoneMessage(`poll-${id}`, `message ${id}`, { conversationId: `conv-${id}` });
    });

    assert.deepEqual(await channel.pollOnce(), { accepted: 11, skipped: 0, duplicates: 0, errors: 0 });
    assert.deepEqual(client.messageRequests.map((request) => request.before ?? null), [null, "poll-09", "poll-06", "poll-03"]);

    const store = new SQLitePhoneTransportStore({ filePath: config.transportStorePath });
    try {
      const checkpoint = store.pollCheckpoint("agentphone-message");
      assert.equal(checkpoint?.provider, "agentphone-message");
      assert.equal(checkpoint?.providerCursor, null);
      assert.equal(checkpoint?.lastProcessedId, "poll-11");
      assert.match(checkpoint?.checkpointTimestamp ?? "", /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(checkpoint?.activeScanId, null);
      assert.equal(checkpoint?.nextPageIndex, 0);
    } finally {
      store.close();
    }

    const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
    try {
      const first = await ledger.getConversation("phone", "phone:conv-01");
      const last = await ledger.getConversation("phone", "phone:conv-11");
      assert.equal(first?.messages[0]?.externalMessageId, "poll-01");
      assert.equal(last?.messages[0]?.externalMessageId, "poll-11");
    } finally {
      ledger.close();
    }

    assert.deepEqual(await channel.pollOnce(), { accepted: 0, skipped: 0, duplicates: 1, errors: 0 });
  } finally {
    channel.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed Phone page resumes from its durable cursor after restart without losing messages", async () => {
  const dir = await harnessHome("phone-poll-restart-");
  const client = new FakeAgentPhoneClient();
  const config = phonePollingConfig(dir, 2);
  const first = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
  try {
    client.messages = Array.from({ length: 6 }, (_, offset) => {
      const id = String(6 - offset);
      return phoneMessage(`retry-${id}`, `message ${id}`, { conversationId: `retry-${id}` });
    });
    client.failMessagePageBefore = "retry-5";

    const failed = await first.pollOnce();
    assert.equal(failed.errors, 1);
    assert.equal(failed.accepted, 0);
    first.close();

    const restarted = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
    try {
      assert.deepEqual(await restarted.pollOnce(), { accepted: 6, skipped: 0, duplicates: 0, errors: 0 });
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        for (let id = 1; id <= 6; id += 1) {
          assert.equal((await ledger.getConversation("phone", `phone:retry-${id}`))?.messages[0]?.externalMessageId, `retry-${id}`);
        }
      } finally {
        ledger.close();
      }
      const store = new SQLitePhoneTransportStore({ filePath: config.transportStorePath });
      try {
        assert.equal(store.pollCheckpoint("agentphone-message")?.lastProcessedId, "retry-6");
      } finally {
        store.close();
      }
    } finally {
      restarted.close();
    }
  } finally {
    first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a crash after engine admission replays the staged Phone message without admitting it twice", async () => {
  const dir = await harnessHome("phone-poll-crash-recovery-");
  const client = new FakeAgentPhoneClient();
  const config = phonePollingConfig(dir, 2);
  const crashingStore = new CrashAfterAdmissionTransportStore({ filePath: config.transportStorePath });
  const first = new PhoneChannel({
    config,
    agentPhone: client,
    transportStore: crashingStore,
    replyGenerator: new StaticReplyGenerator()
  });
  try {
    client.messages = [phoneMessage("crash-1", "do not admit twice", { conversationId: "crash" })];
    const interrupted = await first.pollOnce();
    assert.deepEqual(interrupted, { accepted: 1, skipped: 0, duplicates: 0, errors: 1 });
    first.close();

    const restarted = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
    try {
      const recovered = await restarted.pollOnce();
      assert.equal(recovered.accepted, 0);
      assert.equal(recovered.duplicates, 1);
      assert.equal(recovered.errors, 0);
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        const conversation = await ledger.getConversation("phone", "phone:crash");
        assert.deepEqual(conversation?.messages.map((message) => message.externalMessageId), ["crash-1"]);
      } finally {
        ledger.close();
      }
    } finally {
      restarted.close();
    }
  } finally {
    first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("lossless completed-call polling stages a backlog oldest first and advances its durable checkpoint", async () => {
  const dir = await harnessHome("phone-call-lossless-polling-");
  const client = new FakeAgentPhoneClient();
  const config = phonePollingConfig(dir, 3, true);
  const channel = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
  try {
    client.calls = Array.from({ length: 11 }, (_, offset) => {
      const id = String(11 - offset).padStart(2, "0");
      return phoneCall(`call-${id}`, { summary: `call ${id}` });
    });

    assert.deepEqual(await channel.pollOnce(), { accepted: 11, skipped: 0, duplicates: 0, errors: 0 });
    assert.deepEqual(client.callRequests.map((request) => request.offset ?? 0), [0, 3, 6, 9]);

    const store = new SQLitePhoneTransportStore({ filePath: config.transportStorePath });
    try {
      const checkpoint = store.pollCheckpoint("agentphone-call");
      assert.equal(checkpoint?.providerCursor, null);
      assert.equal(checkpoint?.lastProcessedId, "call-11");
      assert.equal(checkpoint?.activeScanId, null);
    } finally {
      store.close();
    }
    const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
    try {
      assert.equal((await ledger.getConversation("phone", "phone:call-conv-01"))?.messages[0]?.externalMessageId, "call-01");
      assert.equal((await ledger.getConversation("phone", "phone:call-conv-11"))?.messages[0]?.externalMessageId, "call-11");
    } finally {
      ledger.close();
    }
    assert.equal((await channel.pollOnce()).accepted, 0);
  } finally {
    channel.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("completed-call paging resumes after a provider page failure without losing calls", async () => {
  const dir = await harnessHome("phone-call-poll-recovery-");
  const client = new FakeAgentPhoneClient();
  const config = phonePollingConfig(dir, 2, true);
  const first = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
  try {
    client.calls = Array.from({ length: 5 }, (_, offset) => phoneCall(`call-retry-${5 - offset}`, { summary: "ready" }));
    client.failCallPageOffset = 2;
    assert.equal((await first.pollOnce()).errors, 1);
    first.close();

    const restarted = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
    try {
      assert.deepEqual(await restarted.pollOnce(), { accepted: 5, skipped: 0, duplicates: 0, errors: 0 });
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        for (let id = 1; id <= 5; id += 1) {
          assert.equal((await ledger.getConversation("phone", `phone:call-conv-retry-${id}`))?.messages.length, 1);
        }
      } finally {
        ledger.close();
      }
    } finally {
      restarted.close();
    }
  } finally {
    first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a completed call staged before a checkpoint crash replays without duplicate engine admission", async () => {
  const dir = await harnessHome("phone-call-poll-crash-recovery-");
  const client = new FakeAgentPhoneClient();
  const config = phonePollingConfig(dir, 2, true);
  const crashingStore = new CrashAfterAdmissionTransportStore({ filePath: config.transportStorePath });
  const first = new PhoneChannel({
    config,
    agentPhone: client,
    replyGenerator: new StaticReplyGenerator(),
    transportStore: crashingStore
  });
  try {
    client.calls = [phoneCall("call-checkpoint-crash", { summary: "ready" })];
    const interrupted = await first.pollOnce();
    assert.equal(interrupted.accepted, 1);
    assert.equal(interrupted.errors, 1);
    first.close();

    const restarted = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
    try {
      const replay = await restarted.pollOnce();
      assert.equal(replay.accepted, 0);
      assert.ok(replay.duplicates >= 1);
      const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
      try {
        assert.equal((await ledger.getConversation("phone", "phone:call-conv-checkpoint-crash"))?.messages.length, 1);
      } finally {
        ledger.close();
      }
    } finally {
      restarted.close();
    }
  } finally {
    first.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("independent workers cannot scan or admit the same completed-call pages", async () => {
  const dir = await harnessHome("phone-call-poll-ownership-");
  const client = new BlockingFirstCallPollAgentPhoneClient();
  const config = phonePollingConfig(dir, 2, true);
  const first = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
  const second = new PhoneChannel({ config, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
  try {
    client.calls = [phoneCall("call-concurrent", { summary: "ready" })];
    const firstPoll = first.pollOnce();
    await client.firstRequestStarted;
    const secondPoll = await second.pollOnce();
    client.releaseFirstPage();
    assert.equal((await firstPoll).accepted, 1);
    assert.deepEqual(secondPoll, { accepted: 0, skipped: 0, duplicates: 0, errors: 0 });
    const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
    try {
      assert.equal((await ledger.getConversation("phone", "phone:call-conv-concurrent"))?.messages.length, 1);
    } finally {
      ledger.close();
    }
  } finally {
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("AgentPhone recovery reconciles an accepted message without generating a second reply", async () => {
  const dir = await harnessHome("phone-delivery-recovery-");
  const client = new FakeAgentPhoneClient();
  const config = defaultPhoneChannelConfig({
    HOME: dir,
    PHONE_TASK_LEDGER_PATH: path.join(dir, "tasks.sqlite"),
    PHONE_TRANSPORT_STORE_PATH: path.join(dir, "phone-transport.sqlite"),
    PHONE_CHANNEL_STATUS_PATH: path.join(dir, "status.json"),
    PHONE_OUTBOUND_MODE: "send",
    PHONE_POLL_CALLS_ENABLED: "0"
  });
  const generator = new CountingPhoneReplyGenerator();
  const staleProcess = { runProcessStartedAt: () => null, runProcessExists: () => false };
  const firstLedger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath, ...staleProcess });
  const firstEngine = new ConversationEngine({ ledger: firstLedger });
  const firstChannel = new PhoneChannel({ config, engine: firstEngine, ledger: firstLedger, agentPhone: client, replyGenerator: generator });
  try {
    client.crashAfterAccept = true;
    await firstEngine.ingest({ ...buildPhoneMessageLedgerInput(phoneMessage("recovery-inbound", "please reply", { conversationId: "conv-recovery" })), intakeMode: "direct" });
    assert.deepEqual(await firstChannel.processQueued(), { processed: 1, failed: 0 });
    assert.deepEqual((await firstEngine.getConversation("phone", "phone:conv-recovery"))?.messages.map((message) => message.role), ["user", "assistant"]);
    firstChannel.close();
    firstLedger.close();

    client.crashAfterAccept = false;
    const restartedLedger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath, ...staleProcess });
    const restartedEngine = new ConversationEngine({ ledger: restartedLedger });
    const restartedChannel = new PhoneChannel({ config, engine: restartedEngine, ledger: restartedLedger, agentPhone: client, replyGenerator: generator });
    try {
      await restartedChannel.recoverInterruptedRuns();
      assert.deepEqual(await restartedChannel.processQueued(), { processed: 0, failed: 0 });
      const conversation = await restartedEngine.getConversation("phone", "phone:conv-recovery");
      assert.equal(generator.calls, 1);
      assert.equal(client.sent.length, 1);
      assert.equal(client.sent[0]?.body, "durable phone reply");
      assert.deepEqual(conversation?.messages.map((message) => message.role), ["user", "assistant"]);
      assert.equal(conversation?.messages.at(-1)?.text, "durable phone reply");
      assert.equal(conversation?.status, "done");
    } finally {
      restartedChannel.close();
      restartedLedger.close();
    }
  } finally {
    firstChannel.close();
    firstLedger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("delayed call transcripts are durably retried and admitted exactly once", async () => {
  const dir = await harnessHome("phone-call-transcript-retry-");
  const client = new FakeAgentPhoneClient();
  let currentTime = new Date("2026-01-01T00:00:00.000Z");
  const config = defaultPhoneChannelConfig({
    HOME: dir,
    PHONE_TASK_LEDGER_PATH: path.join(dir, "tasks.sqlite"),
    PHONE_TRANSPORT_STORE_PATH: path.join(dir, "phone-transport.sqlite"),
    PHONE_CHANNEL_STATUS_PATH: path.join(dir, "status.json"),
    PHONE_OUTBOUND_MODE: "send",
    PHONE_POLL_CALLS_ENABLED: "1"
  });
  const store = new SQLitePhoneTransportStore({ filePath: config.transportStorePath, now: () => currentTime });
  const channel = new PhoneChannel({ config, agentPhone: client, transportStore: store, replyGenerator: new StaticReplyGenerator() });
  try {
    client.calls = [phoneCall("call-delayed-transcript")];
    assert.deepEqual(await channel.pollOnce(), { accepted: 0, skipped: 1, duplicates: 0, errors: 0 });
    assert.equal(store.hasInboundReceipt("agentphone-call", "call-delayed-transcript"), false);

    client.transcriptResponse = { transcript: "caller: please follow up" };
    currentTime = new Date("2026-01-01T00:00:06.000Z");
    assert.deepEqual(await channel.processQueued(), { processed: 1, failed: 0 });
    assert.deepEqual(await channel.processQueued(), { processed: 0, failed: 0 });

    const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
    try {
      const conversation = await ledger.getConversation("phone", "phone:call-conv-delayed-transcript");
      assert.deepEqual(conversation?.messages.map((message) => message.role), ["user", "assistant"]);
      assert.equal(conversation?.messages[0]?.externalMessageId, "call-delayed-transcript");
      assert.equal(client.sent.length, 1);
    } finally {
      ledger.close();
    }
  } finally {
    channel.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects an inbound message without a provider conversation id before ledger ingestion", async () => {
  await withChannel(async (channel, client, dir) => {
    client.messages = [phoneMessage("msg-missing-conversation", "hello", { conversationId: null })];

    const poll = await channel.pollOnce();
    assert.deepEqual(poll, { accepted: 0, skipped: 0, duplicates: 0, errors: 1 });

    const ledger = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
    const transportStore = new SQLitePhoneTransportStore({ filePath: path.join(dir, "phone-transport.sqlite") });
    try {
      assert.deepEqual(await ledger.conversations("phone"), []);
      assert.deepEqual(transportStore.snapshot(), {
        inboundTotal: 1,
        inboundAccepted: 0,
        inboundSkipped: 0,
        inboundErrors: 1,
        outboundTotal: 0,
        outboundSent: 0,
        outboundFailed: 0
      });
    } finally {
      transportStore.close();
      ledger.close();
    }
  });
});

test("ambiguous phone sends do not persist assistant output or create a terminal delivery failure", async () => {
  await withChannel(async (channel, client, dir) => {
    client.messages = [phoneMessage("msg-send-failure", "hello", { conversationId: "conv-send-failure" })];
    client.sendError = new Error("AgentPhone unavailable");

    assert.deepEqual(await channel.pollOnce(), { accepted: 1, skipped: 0, duplicates: 0, errors: 0 });
    assert.deepEqual(await channel.processQueued(), { processed: 1, failed: 1 });

    const ledger = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
    const transportStore = new SQLitePhoneTransportStore({ filePath: path.join(dir, "phone-transport.sqlite") });
    try {
      const conversation = await ledger.getConversation("phone", "phone:conv-send-failure");
      const context = await ledger.buildContext("phone", "phone:conv-send-failure");
      assert.deepEqual(conversation?.messages.map((message) => message.role), ["user"]);
      assert.deepEqual(context?.messages.map((message) => message.role), ["user"]);
      assert.equal((await ledger.outboundDeliveries("phone", "phone:conv-send-failure"))[0]?.status, "acceptance_unknown");
      assert.equal(transportStore.snapshot().outboundFailed, 0);
    } finally {
      transportStore.close();
      ledger.close();
    }
  });
});

test("skips outbound echoes", async () => {
  await withChannel(async (channel, client, dir) => {
    client.messages = [{
      provider: "agentphone",
      id: "msg-outbound",
      numberId: "number-1",
      conversationId: "conv-2",
      fromNumber: AGENTPHONE_FROM_NUMBER,
      toNumber: "+14155550123",
      direction: "outbound",
      channel: "sms",
      body: "already sent",
      mediaUrls: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      receivedAt: "2026-01-01T00:00:00.000Z",
      raw: { id: "msg-outbound" }
    }];

    const poll = await channel.pollOnce();
    assert.deepEqual(poll, { accepted: 0, skipped: 1, duplicates: 0, errors: 0 });
    const processed = await channel.processQueued();
    assert.deepEqual(processed, { processed: 0, failed: 0 });

    const ledger = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
    try {
      const conversation = await ledger.getConversation("phone", "phone:conv-2");
      const runnable = await ledger.runnableConversations("phone");
      assert.equal(conversation?.status, "done");
      assert.equal(conversation?.messages.length, 1);
      assert.equal(conversation?.messages[0]?.metadata.nonActionable, true);
      assert.deepEqual(runnable, []);
    } finally {
      ledger.close();
    }
  });
});

test("skips messages for a different destination number", async () => {
  await withChannel(async (channel, client, dir) => {
    client.messages = [{
      provider: "agentphone",
      id: "msg-other-number",
      numberId: "number-2",
      conversationId: "conv-other",
      fromNumber: "+14155550123",
      toNumber: "+14155550199",
      direction: "inbound",
      channel: "sms",
      body: "wrong number",
      mediaUrls: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      receivedAt: "2026-01-01T00:00:00.000Z",
      raw: { id: "msg-other-number" }
    }];

    const poll = await channel.pollOnce();
    assert.deepEqual(poll, { accepted: 0, skipped: 1, duplicates: 0, errors: 0 });
    const processed = await channel.processQueued();
    assert.deepEqual(processed, { processed: 0, failed: 0 });

    const ledger = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
    try {
      const conversation = await ledger.getConversation("phone", "phone:conv-other");
      const runnable = await ledger.runnableConversations("phone");
      assert.equal(conversation?.status, "done");
      assert.equal(conversation?.messages.length, 1);
      assert.equal(conversation?.messages[0]?.metadata.nonActionable, true);
      assert.deepEqual(runnable, []);
    } finally {
      ledger.close();
    }
  });
});

test("separates messages from the same caller by provider conversation id", async () => {
  await withChannel(async (channel, client, dir) => {
    client.messages = [
      phoneMessage("msg-a", "first conversation", { conversationId: "conv-a" }),
      phoneMessage("msg-b", "second conversation", { conversationId: "conv-b", fromNumber: "+1 (415) 555-0456" }),
      phoneMessage("msg-c", "same caller, different provider thread", { conversationId: "conv-c", fromNumber: "(415) 555-0123" })
    ];

    const poll = await channel.pollOnce();
    assert.deepEqual(poll, { accepted: 3, skipped: 0, duplicates: 0, errors: 0 });

    const ledger = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
    try {
      const convA = await ledger.getConversation("phone", "phone:conv-a");
      const convB = await ledger.getConversation("phone", "phone:conv-b");
      const convC = await ledger.getConversation("phone", "phone:conv-c");
      const runnable = await ledger.runnableConversations("phone");
      const contextA = await ledger.buildContext("phone", "phone:conv-a");
      const contextC = await ledger.buildContext("phone", "phone:conv-c");

      assert.deepEqual(convA?.messages.map((message) => message.text.split("\n").at(-1)), ["first conversation"]);
      assert.equal(convB?.messages[0]?.text.split("\n").at(-1), "second conversation");
      assert.equal(convC?.messages[0]?.text.split("\n").at(-1), "same caller, different provider thread");
      assert.deepEqual(contextA?.messages.map((message) => message.text.split("\n").at(-1)), ["first conversation"]);
      assert.deepEqual(contextC?.messages.map((message) => message.text.split("\n").at(-1)), ["same caller, different provider thread"]);
      assert.deepEqual(runnable.map((item) => item.conversationKey).sort(), ["phone:conv-a", "phone:conv-b", "phone:conv-c"]);
    } finally {
      ledger.close();
    }
  });
});

test("pollOnce routes accepted messages through ConversationEngine", async () => {
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  const engine = new ConversationEngine({ ledger });
  const client = new FakeAgentPhoneClient();
  client.messages = [{
    provider: "agentphone",
    id: "msg-eng-1",
    numberId: "number-1",
    conversationId: "conv-eng-1",
    fromNumber: "+14155550123",
    toNumber: AGENTPHONE_FROM_NUMBER,
    direction: "inbound",
    channel: "sms",
    body: "route this through the engine",
    mediaUrls: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    raw: { id: "msg-eng-1" }
  }];
  // A fixed name under /tmp belongs to whichever account ran the suite first,
  // and every other account then fails to write it.
  const scratch = await harnessHome("phone-channel-engine-");
  const config = defaultPhoneChannelConfig({
    HOME: scratch,
    PHONE_TASK_LEDGER_PATH: path.join(scratch, "should-not-be-used.sqlite"),
    PHONE_TRANSPORT_STORE_PATH: ":memory:",
    PHONE_CHANNEL_STATUS_PATH: path.join(scratch, "phone-status.json"),
    PHONE_OUTBOUND_MODE: "send"
  });
  const channel = new PhoneChannel({ config, engine, ledger, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
  try {
    const result = await channel.pollOnce();
    const conversation = await engine.getConversation("phone", "phone:conv-eng-1");

    assert.deepEqual(result, { accepted: 1, skipped: 0, duplicates: 0, errors: 0 });
    assert.ok(conversation, "conversation must appear in the injected engine, not a separate ledger");
    assert.equal(conversation.status, "queued");
    assert.equal(conversation.messages[0]?.metadata.intakeMode, "direct");
  } finally {
    channel.close();
    ledger.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

test("processQueued consumes phone steering messages in the same run", async () => {
  const dir = await harnessHome("phone-steering-test-");
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  const engine = new ConversationEngine({ ledger });
  const client = new FakeAgentPhoneClient();
  const config = defaultPhoneChannelConfig({
    HOME: dir,
    PHONE_TASK_LEDGER_PATH: path.join(dir, "tasks.sqlite"),
    PHONE_TRANSPORT_STORE_PATH: path.join(dir, "phone-transport.sqlite"),
    PHONE_CHANNEL_STATUS_PATH: path.join(dir, "status.json"),
    PHONE_OUTBOUND_MODE: "send",
    PHONE_POLL_CALLS_ENABLED: "0"
  });
  const replyGenerator = new SteeringPhoneReplyGenerator(engine);
  const channel = new PhoneChannel({ config, engine, ledger, agentPhone: client, replyGenerator });
  try {
    await engine.ingest({ ...buildPhoneMessageLedgerInput(phoneMessage("msg-1", "hello", { conversationId: "conv-steering" })), intakeMode: "direct" });
    const result = await channel.processQueued();
    const conversation = await engine.getConversation("phone", "phone:conv-steering");
    const runnable = await engine.runnableConversations("phone");

    assert.deepEqual(result, { processed: 1, failed: 0 });
    assert.equal(replyGenerator.inputs.length, 2);
    assert.match(replyGenerator.inputs[1]?.prompt ?? "", /hello/);
    assert.match(replyGenerator.inputs[1]?.prompt ?? "", /actually use the latest phone detail/);
    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0]?.body, "updated text");
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
    await rm(dir, { recursive: true, force: true });
  }
});

test("processQueued does not deliver phone output when a stop wins before assistant persistence", async () => {
  const dir = await harnessHome("phone-channel-stop-before-persist-test-");
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  const engine = new ConversationEngine({ ledger });
  const client = new FakeAgentPhoneClient();
  const config = defaultPhoneChannelConfig({
    HOME: dir,
    PHONE_TASK_LEDGER_PATH: ":memory:",
    PHONE_TRANSPORT_STORE_PATH: path.join(dir, "phone-transport.sqlite"),
    PHONE_CHANNEL_STATUS_PATH: path.join(dir, "status.json"),
    PHONE_OUTBOUND_MODE: "send",
    PHONE_POLL_CALLS_ENABLED: "0"
  });
  const channel = new PhoneChannel({
    config,
    engine,
    ledger,
    agentPhone: client,
    replyGenerator: {
      async generate() {
        await engine.stop("phone", "phone:conv-compact", "user_stop");
        return { shouldReply: true, reason: "ok", body: "must not send" };
      }
    }
  });
  try {
    await engine.ingest({ ...buildPhoneMessageLedgerInput(phoneMessage("phone-stop-before-persist", "work")), intakeMode: "direct" });

    assert.deepEqual(await channel.processQueued(), { processed: 1, failed: 1 });
    assert.deepEqual(client.sent, []);
    const conversation = await engine.getConversation("phone", "phone:conv-compact");
    assert.equal(conversation?.status, "stopped");
    assert.equal(conversation?.messages.filter((message) => message.role === "assistant").length, 0);
  } finally {
    channel.close();
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("phone stop is persisted and interrupts the active run without sending a reply", async () => {
  const dir = await harnessHome("phone-channel-stop-test-");
  const client = new FakeAgentPhoneClient();
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  const engine = new ConversationEngine({ ledger });
  const config = defaultPhoneChannelConfig({
    HOME: dir,
    PHONE_TASK_LEDGER_PATH: ":memory:",
    PHONE_TRANSPORT_STORE_PATH: path.join(dir, "phone-transport.sqlite"),
    PHONE_CHANNEL_STATUS_PATH: path.join(dir, "status.json"),
    PHONE_OUTBOUND_MODE: "send",
    PHONE_POLL_CALLS_ENABLED: "0"
  });
  const channel = new PhoneChannel({ config, engine, ledger, agentPhone: client, replyGenerator: new StaticReplyGenerator() });
  try {
    await engine.ingest({ ...buildPhoneMessageLedgerInput(phoneMessage("phone-running", "work", { conversationId: "conv-stop" })), intakeMode: "direct" });
    const started = await engine.startRun("phone", "phone:conv-stop");
    assert.ok(started);
    client.messages = [phoneMessage("phone-stop", "stop", { conversationId: "conv-stop" })];

    await channel.pollOnce();
    await channel.processQueued();

    const conversation = await engine.getConversation("phone", "phone:conv-stop");
    assert.equal(conversation?.status, "stopped");
    assert.equal(conversation?.runs[0]?.status, "stopped");
    const stopMessage = conversation?.messages.find((message) => message.externalMessageId === "phone-stop");
    assert.equal(stopMessage?.runId, null);
    assert.equal(stopMessage?.metadata.nonActionable, true);
    assert.deepEqual(client.sent, []);
  } finally {
    channel.close();
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("phone stop cancels an active Codex child without delivering its stale reply", async () => {
  const dir = await harnessHome("phone-channel-active-stop-test-");
  const client = new FakeAgentPhoneClient();
  const ledger = new SQLiteTaskLedger({ filePath: ":memory:" });
  const engine = new ConversationEngine({ ledger });
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
  const config = defaultPhoneChannelConfig({
    HOME: dir,
    PHONE_TASK_LEDGER_PATH: ":memory:",
    PHONE_TRANSPORT_STORE_PATH: path.join(dir, "phone-transport.sqlite"),
    PHONE_CHANNEL_STATUS_PATH: path.join(dir, "status.json"),
    PHONE_OUTBOUND_MODE: "send",
    PHONE_POLL_CALLS_ENABLED: "0"
  });
  const channel = new PhoneChannel({ config, engine, ledger, agentPhone: client, codexRunner: runner });
  try {
    await engine.ingest({ ...buildPhoneMessageLedgerInput(phoneMessage("phone-active", "work", { conversationId: "conv-active-stop" })), intakeMode: "direct" });
    const processing = channel.processQueued();
    await childStarted;

    client.messages = [phoneMessage("phone-stop-active", "stop", { conversationId: "conv-active-stop" })];
    await channel.pollOnce();
    assert.deepEqual(await processing, { processed: 1, failed: 1 });

    const conversation = await engine.getConversation("phone", "phone:conv-active-stop");
    assert.equal(conversation?.status, "stopped");
    assert.equal(conversation?.runs[0]?.status, "stopped");
    assert.equal(conversation?.messages.find((message) => message.externalMessageId === "phone-stop-active")?.metadata.nonActionable, true);
    assert.deepEqual(client.sent, []);
    assert.equal(runner.activeCount, 0);
  } finally {
    channel.close();
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a due phone reminder runs through the ordinary processing tick and replies", async () => {
  const dir = await harnessHome("phone-reminder-session-test-");
  const client = new FakeAgentPhoneClient();
  const config = defaultPhoneChannelConfig({
    HOME: dir,
    PHONE_TASK_LEDGER_PATH: path.join(dir, "tasks.sqlite"),
    PHONE_TRANSPORT_STORE_PATH: path.join(dir, "phone-transport.sqlite"),
    PHONE_CHANNEL_STATUS_PATH: path.join(dir, "status.json"),
    PHONE_OUTBOUND_MODE: "send",
    PHONE_POLL_CALLS_ENABLED: "0"
  });
  const ledger = new SQLiteTaskLedger({ filePath: config.taskLedgerPath });
  const engine = new ConversationEngine({ ledger });
  const replyGenerator = new CapturingPhoneReplyGenerator();
  const channel = new PhoneChannel({ config, engine, ledger, agentPhone: client, replyGenerator });
  try {
    const inbound = phoneMessage("reminder-source", "remind me", { conversationId: "conv-reminder" });
    const input = buildPhoneMessageLedgerInput(inbound);
    await engine.ingest({ ...input, intakeMode: "direct" });
    await channel.processQueued();

    const reminder = await ledger.createReminder({
      companyId: "company-phone",
      instruction: "follow up",
      scheduledFor: new Date(Date.now() + 50).toISOString(),
      displayTimezone: "America/Los_Angeles",
      channel: "phone",
      conversationKey: input.conversationKey
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await channel.processQueued();
    assert.equal(result.processed, 1);
    assert.equal(result.failed, 0);
    assert.equal((await ledger.getReminder(reminder.id))?.status, "delivered");
    assert.match(replyGenerator.input?.prompt ?? "", /follow up/);

    const conversation = await ledger.getConversation("phone", input.conversationKey);
    assert.equal(conversation?.runs.at(-1)?.status, "done");
    assert.equal(conversation?.messages.filter((message) => message.metadata.reminderId === reminder.id).length, 1);
  } finally {
    channel.close();
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function phoneMessage(id: string, body: string, overrides: Partial<NormalizedPhoneMessage> = {}): NormalizedPhoneMessage {
  return {
    provider: "agentphone",
    id,
    numberId: "number-1",
    conversationId: "conv-compact",
    fromNumber: "+14155550123",
    toNumber: AGENTPHONE_FROM_NUMBER,
    direction: "inbound",
    channel: "sms",
    body,
    mediaUrls: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    receivedAt: "2026-01-01T00:00:00.000Z",
    raw: { id },
    ...overrides
  };
}

class CrashAfterAdmissionTransportStore extends SQLitePhoneTransportStore {
  private crashNextCheckpoint = true;

  override completePollMessage(provider: string, ownerId: string, providerEventId: string): void {
    if (this.crashNextCheckpoint) {
      this.crashNextCheckpoint = false;
      throw new Error("simulated process interruption after engine admission");
    }
    super.completePollMessage(provider, ownerId, providerEventId);
  }
}

function phonePollingConfig(dir: string, pollLimit: number, pollCalls = false) {
  return defaultPhoneChannelConfig({
    HOME: dir,
    PHONE_TASK_LEDGER_PATH: path.join(dir, "tasks.sqlite"),
    PHONE_TRANSPORT_STORE_PATH: path.join(dir, "phone-transport.sqlite"),
    PHONE_CHANNEL_STATUS_PATH: path.join(dir, "status.json"),
    PHONE_OUTBOUND_MODE: "send",
    PHONE_PROCESSING_ENABLED: "1",
    PHONE_POLL_CALLS_ENABLED: pollCalls ? "1" : "0",
    PHONE_POLL_LIMIT: String(pollLimit)
  });
}

function phoneCall(callId: string, overrides: Partial<NormalizedPhoneCall> = {}): NormalizedPhoneCall {
  return {
    provider: "agentphone",
    callId,
    numberId: "number-1",
    conversationId: `call-conv-${callId.replace(/^call-/, "")}`,
    fromNumber: "+14155550123",
    toNumber: AGENTPHONE_FROM_NUMBER,
    direction: "inbound",
    status: "completed",
    summary: null,
    transcript: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    raw: {
      id: callId,
      number_id: "number-1",
      conversation_id: `call-conv-${callId.replace(/^call-/, "")}`,
      from_number: "+14155550123",
      to_number: AGENTPHONE_FROM_NUMBER,
      direction: "inbound",
      status: "completed",
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: "2026-01-01T00:01:00.000Z"
    },
    ...overrides
  };
}

function deliveryInterruptedError(): Error {
  const error = new Error("provider accepted delivery before runtime confirmation");
  error.name = "DeliveryInterruptedError";
  return error;
}
