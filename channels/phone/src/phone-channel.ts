import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  ConversationEngine,
  ConversationRuntime,
  CodexProcessRunner,
  conversationSandbox,
  deploymentUpdateNotice,
  SQLiteTaskLedger,
  getChannelContextLimits,
  resolveContextLimitsPath,
  type ConversationEngineIngestInput,
  type ContextChannelLimits,
  type JsonObject,
  type JsonValue,
  type TaskLedgerMessage,
  type TaskLedgerStartedRun,
  type ConversationRuntimeTransport
} from "@fluffles/tasks";
import { codexExecutor } from "../../../agent/executors/codex";
import { AGENTPHONE_FROM_NUMBER, ExecutorAgentPhoneClient, findAgentPhoneOutboundDelivery, type PhoneAgentPhoneClient } from "./agentphone-client";
import { parseJsonFromText } from "./executor-mcp-client";
import { normalizePhoneCall, normalizePhoneMessage, phoneCallExternalId, phoneMessageExternalId, phoneWebhookEventFromUnknown, shouldAcceptPhoneCall, shouldAcceptPhoneMessage, type NormalizedPhoneCall, type NormalizedPhoneMessage } from "./phone-normalize";
import { buildPhoneCallLedgerInput, buildPhoneMessageLedgerInput, resolvePhoneCallConversationKey, resolvePhoneConversationKey } from "./phone-task-adapter";
import { SQLitePhoneTransportStore, type PhoneInboundReceiptInput, type PhoneTransportSnapshot } from "./phone-transport-store";

export type PhoneOutboundMode = "send" | "disabled";

export interface PhoneChannelConfig {
  home: string;
  stateRoot: string;
  taskLedgerPath: string;
  transportStorePath: string;
  statusPath: string;
  pollLimit: number;
  pollCallsEnabled: boolean;
  pollingEnabled: boolean;
  webhookEnabled: boolean;
  outboundMode: PhoneOutboundMode;
  fromNumber: string;
  codexPath: string;
  codexSchemaPath: string;
  codexTimeoutMs: number;
  codexModel: string;
  codexReasoningEffort: string;
  codexServiceTier: string;
  /** Minimum wait after an ambiguous AgentPhone send before retry is permitted. */
  deliveryReconciliationDelayMs: number;
  contextLimitsPath: string;
  contextLimits: ContextChannelLimits;
}

export interface PhoneReplyDecision {
  shouldReply: boolean;
  reason: string;
  body: string;
}

export interface PhoneReplyGeneratorInput {
  conversationKey: string;
  /** Built and budgeted by ConversationRuntime. Required for live execution. */
  prompt?: string;
  runKey?: string;
}

export interface PhonePromptMessage {
  receivedAt: string;
  text: string;
  metadata: JsonObject;
}

export interface PhoneReplyGenerator {
  generate(input: PhoneReplyGeneratorInput): Promise<PhoneReplyDecision>;
}

export interface PhoneChannelStatus {
  ok: boolean;
  service: "fluffles-channel-phone";
  startedAt: string;
  phoneNumber: string;
  pollingEnabled: boolean;
  webhookEnabled: boolean;
  pollCallsEnabled: boolean;
  pollLimit: number;
  contextLimitsPath: string;
  contextLimits: ContextChannelLimits;
  outboundMode: PhoneOutboundMode;
  lastPollAt: string | null;
  lastPollError: string | null;
  lastPollAccepted: number;
  lastPollSkipped: number;
  lastPollDuplicates: number;
  lastPollErrors: number;
  lastWebhookAt: string | null;
  lastWebhookError: string | null;
  lastWebhookAccepted: number;
  lastWebhookSkipped: number;
  lastWebhookDuplicates: number;
  lastWebhookErrors: number;
  lastRunAt: string | null;
  lastRunError: string | null;
  lastRunConversationKey: string | null;
  lastRunStatus: string | null;
  lastOutboundAction: string | null;
  recoveredRuns: number;
  taskLedgerPath: string;
  phoneTransportStorePath: string;
  transport: PhoneTransportSnapshot | null;
}

export interface PollResult {
  accepted: number;
  skipped: number;
  duplicates: number;
  errors: number;
}

export interface ProcessResult {
  processed: number;
  failed: number;
}

export interface WebhookResult extends PollResult {}

export class PhoneChannel {
  private readonly pollOwnerId = randomUUID();
  private readonly config: PhoneChannelConfig;
  private readonly engine: ConversationEngine;
  private readonly runtime: ConversationRuntime;
  private readonly ledger: SQLiteTaskLedger;
  private readonly ownedLedger: boolean;
  private readonly agentPhone: PhoneAgentPhoneClient;
  private readonly transportStore: SQLitePhoneTransportStore;
  private readonly replyGenerator: PhoneReplyGenerator;
  private readonly status: PhoneChannelStatus;

  constructor(options: {
    config: PhoneChannelConfig;
    engine?: ConversationEngine;
    ledger?: SQLiteTaskLedger;
    agentPhone?: PhoneAgentPhoneClient;
    transportStore?: SQLitePhoneTransportStore;
    replyGenerator?: PhoneReplyGenerator;
    codexRunner?: CodexProcessRunner;
  }) {
    this.config = options.config;
    if (options.engine && options.ledger) {
      this.engine = options.engine;
      this.ledger = options.ledger;
      this.ownedLedger = false;
    } else {
      const ledger = new SQLiteTaskLedger({ filePath: options.config.taskLedgerPath });
      this.ledger = ledger;
      this.engine = new ConversationEngine({ ledger });
      this.ownedLedger = true;
    }
    this.runtime = new ConversationRuntime(this.engine, options.codexRunner, {
      // Stable identity so a restarted process reclaims its own crashed runs
      // immediately during startup recovery.
      workerInstanceId: `phone:${os.hostname()}`,
      updateNotice: deploymentUpdateNotice,
      model: this.config.codexModel,
      acceptanceUnknownRetryDelayMs: this.config.deliveryReconciliationDelayMs,
      deliveryErrorsMayBeAmbiguous: true
    });
    this.agentPhone = options.agentPhone || new ExecutorAgentPhoneClient();
    this.transportStore = options.transportStore || new SQLitePhoneTransportStore({ filePath: options.config.transportStorePath });
    this.replyGenerator = options.replyGenerator || new CodexPhoneReplyGenerator(options.config, this.runtime);
    this.status = {
      ok: true,
      service: "fluffles-channel-phone",
      startedAt: new Date().toISOString(),
      phoneNumber: options.config.fromNumber,
      pollingEnabled: options.config.pollingEnabled,
      webhookEnabled: options.config.webhookEnabled,
      pollCallsEnabled: options.config.pollCallsEnabled,
      pollLimit: options.config.pollLimit,
      contextLimitsPath: options.config.contextLimitsPath,
      contextLimits: options.config.contextLimits,
      outboundMode: options.config.outboundMode,
      lastPollAt: null,
      lastPollError: null,
      lastPollAccepted: 0,
      lastPollSkipped: 0,
      lastPollDuplicates: 0,
      lastPollErrors: 0,
      lastWebhookAt: null,
      lastWebhookError: null,
      lastWebhookAccepted: 0,
      lastWebhookSkipped: 0,
      lastWebhookDuplicates: 0,
      lastWebhookErrors: 0,
      lastRunAt: null,
      lastRunError: null,
      lastRunConversationKey: null,
      lastRunStatus: null,
      lastOutboundAction: null,
      recoveredRuns: 0,
      taskLedgerPath: options.config.taskLedgerPath,
      phoneTransportStorePath: options.config.transportStorePath,
      transport: null
    };
  }

  async recoverInterruptedRuns(options: { reclaimOwnLeases?: boolean } = {}): Promise<string[]> {
    const recovery = await this.runtime.recover("phone", options);
    this.status.recoveredRuns += recovery.recoveredKeys.length;
    await this.writeStatus();
    return recovery.recoveredKeys;
  }

  async pollOnce(): Promise<PollResult> {
    const result: PollResult = { accepted: 0, skipped: 0, duplicates: 0, errors: 0 };
    this.status.lastPollAt = new Date().toISOString();
    this.status.lastPollError = null;
    try {
      await this.retryPendingCallTranscripts(result);
      await this.pollMessagesLosslessly(result);
      if (this.config.pollCallsEnabled) await this.pollCallsLosslessly(result);
    } catch (error) {
      result.errors += 1;
      this.status.lastPollError = errorMessage(error);
    }
    this.recordPollResult(result);
    await this.writeStatus();
    return result;
  }

  async ingestWebhook(input: unknown): Promise<WebhookResult> {
    const result: WebhookResult = { accepted: 0, skipped: 0, duplicates: 0, errors: 0 };
    this.status.lastWebhookAt = new Date().toISOString();
    this.status.lastWebhookError = null;
    try {
      const event = phoneWebhookEventFromUnknown(input);
      if (event.kind === "message") await this.ingestMessage(event.message, result, "webhook");
      else if (event.kind === "call") await this.ingestCall(event.call, result, "webhook");
      else {
        result.skipped += 1;
        this.status.lastWebhookError = event.reason;
      }
    } catch (error) {
      result.errors += 1;
      this.status.lastWebhookError = errorMessage(error);
      this.transportStore.recordInboundReceipt({
        provider: "agentphone-webhook",
        providerEventId: `error:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        conversationId: null,
        sender: "",
        kind: "message",
        action: "error",
        error: errorMessage(error)
      });
    }
    this.recordWebhookResult(result);
    await this.writeStatus();
    return result;
  }

  async processQueued(limit = 5): Promise<ProcessResult> {
    await this.ledger.admitDueReminders({ channel: "phone" });
    const transcriptResult: PollResult = { accepted: 0, skipped: 0, duplicates: 0, errors: 0 };
    await this.retryPendingCallTranscripts(transcriptResult);
    const runs = await this.runtime.processTransport(this.phoneTransport(), limit);
    const result: ProcessResult = { processed: runs.length, failed: runs.filter((processed) => !processed).length };
    await this.writeStatus();
    return result;
  }

  async runOnce(): Promise<{ poll: PollResult; process: ProcessResult }> {
    await this.recoverInterruptedRuns();
    const poll = await this.pollOnce();
    const process = await this.processQueued();
    return { poll, process };
  }

  async snapshotStatus(): Promise<PhoneChannelStatus> {
    this.status.transport = this.transportStore.snapshot();
    return { ...this.status };
  }

  async writeStatus(): Promise<void> {
    const current = await this.snapshotStatus();
    await fs.mkdir(path.dirname(this.config.statusPath), { recursive: true });
    await fs.writeFile(this.config.statusPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  }

  close(): void {
    this.transportStore.close();
    if (this.ownedLedger) this.ledger.close();
  }

  private async ingestMessage(message: NormalizedPhoneMessage, result: PollResult, source: "poll" | "webhook"): Promise<void> {
    const id = phoneMessageExternalId(message);
    const provider = source === "webhook" ? "agentphone-webhook-message" : "agentphone-message";
    if (this.transportStore.hasInboundReceipt(provider, id)) {
      result.duplicates += 1;
      return;
    }

    let conversationKey: string;
    try {
      conversationKey = await resolvePhoneConversationKey(this.engine, message);
    } catch (error) {
      this.transportStore.recordInboundReceipt(
        inboundMessageReceipt(provider, id, message, "error", errorMessage(error))
      );
      result.errors += 1;
      return;
    }

    const ingestInput: ConversationEngineIngestInput = {
      ...buildPhoneMessageLedgerInput(message),
      intakeMode: "direct"
    };
    ingestInput.conversationKey = conversationKey;
    const acceptance = shouldAcceptPhoneMessage(message, this.config.fromNumber);
    const engineResult = await this.engine.admit(ingestInput, {
      actionable: acceptance.shouldReply,
      reason: acceptance.reason,
      controlText: message.body
    });
    if (engineResult.conversation.status === "stopped") {
      // The engine made the terminal transition atomically; this only interrupts
      // the local provider process that is now known to be obsolete.
      this.runtime.cancelCodexRun(executionRunKey("phone", engineResult.conversation.conversationKey));
    }
    if (!acceptance.shouldReply || engineResult.action.type === "none") {
      this.transportStore.recordInboundReceipt({
        ...inboundMessageReceipt(provider, id, message, "skipped", acceptance.reason),
        taskConversationKey: engineResult.conversation.conversationKey,
        taskDisposition: engineResult.action.type
      });
      if (engineResult.action.type === "none" && engineResult.action.reason === "duplicate") result.duplicates += 1;
      else result.skipped += 1;
      return;
    }

    this.transportStore.recordInboundReceipt({
      ...inboundMessageReceipt(provider, id, message, "accepted", null),
      taskConversationKey: engineResult.conversation.conversationKey,
      taskDisposition: engineResult.action.type
    });
    result.accepted += 1;
  }

  /**
   * Stage every page before advancing its cursor, then admit staged messages
   * from oldest to newest. A process crash can only leave a durable replay,
   * never a gap between AgentPhone and ConversationEngine.
   */
  private async pollMessagesLosslessly(result: PollResult): Promise<void> {
    const provider = "agentphone-message";
    let checkpoint = this.transportStore.claimPollOwnership(provider, this.pollOwnerId);
    if (!checkpoint) return;
    try {
      const seenCursors = new Set<string>();
      while (checkpoint.activeScanId != null) {
        const activeCheckpoint = checkpoint;
        const scanId = activeCheckpoint.activeScanId;
        if (scanId == null) break;
        const before = activeCheckpoint.providerCursor ?? undefined;
        if (before && seenCursors.has(before)) {
          throw new Error("AgentPhone polling cursor repeated before reaching the durable checkpoint");
        }
        if (before) seenCursors.add(before);
        const page = await this.agentPhone.listMessages({
          limit: this.config.pollLimit,
          ...(before ? { before } : {})
        });
        const checkpointIndex = activeCheckpoint.lastProcessedId == null
          ? -1
          : page.findIndex((message) => phoneMessageExternalId(message) === activeCheckpoint.lastProcessedId);
        if (checkpointIndex !== -1) {
          result.duplicates += 1;
        }
        const stagedMessages = checkpointIndex === -1 ? page : page.slice(0, checkpointIndex);
        const oldestProviderId = page.at(-1)?.id;
        const complete = checkpointIndex !== -1 || page.length < this.config.pollLimit;
        if (!complete && !oldestProviderId) {
          throw new Error("AgentPhone returned a full message page without a provider cursor id");
        }
        checkpoint = this.transportStore.stagePollPage({
          provider,
          ownerId: this.pollOwnerId,
          scanId,
          pageIndex: activeCheckpoint.nextPageIndex,
          messages: stagedMessages.map((message) => ({
            providerEventId: phoneMessageExternalId(message),
            message: message as unknown as Record<string, unknown>
          })),
          nextCursor: oldestProviderId ?? null,
          complete
        });
      }

      for (const pending of this.transportStore.pendingPollMessages(provider, this.pollOwnerId)) {
        const message = normalizePhoneMessage(pending.message);
        if (!message) {
          this.transportStore.recordInboundReceipt({
            provider,
            providerEventId: pending.providerEventId,
            conversationId: null,
            sender: "",
            kind: "message",
            action: "error",
            error: "durable AgentPhone poll payload could not be normalized"
          });
          result.errors += 1;
        } else {
          await this.ingestMessage(message, result, "poll");
        }
        // Engine admission (or a terminal persisted rejection) completed
        // before this transaction moves the provider checkpoint.
        this.transportStore.completePollMessage(provider, this.pollOwnerId, pending.providerEventId);
      }
    } finally {
      this.transportStore.releasePollOwnership(provider, this.pollOwnerId);
    }
  }

  /**
   * Completed calls have an offset-based AgentPhone API rather than the
   * message API's `before` cursor. The durable high-water call id gives the
   * same at-least-once boundary: every page is staged first, and a later scan
   * stops only once it reaches the newest call handled by the preceding scan.
   *
   * Offset pagination can repeat rows while newer calls arrive. That is safe:
   * staged rows and engine admission are idempotent, and the scan continues
   * until it reaches the durable high-water id rather than trusting an offset
   * to be stable.
   */
  private async pollCallsLosslessly(result: PollResult): Promise<void> {
    const provider = "agentphone-call";
    let checkpoint = this.transportStore.claimPollOwnership(provider, this.pollOwnerId);
    if (!checkpoint) return;
    try {
      const seenOffsets = new Set<number>();
      while (checkpoint.activeScanId != null) {
        const activeCheckpoint = checkpoint;
        const scanId = activeCheckpoint.activeScanId;
        if (scanId == null) break;
        const offset = phoneCallPollOffset(activeCheckpoint.providerCursor);
        if (seenOffsets.has(offset)) {
          throw new Error("AgentPhone call polling offset repeated before reaching the durable checkpoint");
        }
        seenOffsets.add(offset);

        const page = await this.agentPhone.listCalls({ limit: this.config.pollLimit, offset });
        const checkpointIndex = activeCheckpoint.lastProcessedId == null
          ? -1
          : page.findIndex((call) => phoneCallExternalId(call) === activeCheckpoint.lastProcessedId);
        if (checkpointIndex !== -1) result.duplicates += 1;
        const stagedCalls = checkpointIndex === -1 ? page : page.slice(0, checkpointIndex);
        const complete = checkpointIndex !== -1 || page.length < this.config.pollLimit;
        checkpoint = this.transportStore.stagePollPage({
          provider,
          ownerId: this.pollOwnerId,
          scanId,
          pageIndex: activeCheckpoint.nextPageIndex,
          messages: stagedCalls.map((call) => ({
            providerEventId: phoneCallExternalId(call),
            message: call as unknown as Record<string, unknown>
          })),
          nextCursor: String(offset + page.length),
          complete
        });
      }

      for (const pending of this.transportStore.pendingPollMessages(provider, this.pollOwnerId)) {
        const call = normalizePhoneCall(pending.message);
        if (!call) {
          this.transportStore.recordInboundReceipt({
            provider,
            providerEventId: pending.providerEventId,
            conversationId: null,
            sender: "",
            kind: "call",
            action: "error",
            error: "durable AgentPhone call poll payload could not be normalized"
          });
          result.errors += 1;
        } else {
          await this.ingestCall(call, result, "poll");
        }
        // A call with a delayed transcript is transferred to the durable
        // transcript queue by ingestCall before this staged record advances.
        this.transportStore.completePollMessage(provider, this.pollOwnerId, pending.providerEventId);
      }
    } finally {
      this.transportStore.releasePollOwnership(provider, this.pollOwnerId);
    }
  }

  private async ingestCall(call: NormalizedPhoneCall, result: PollResult, source: "poll" | "webhook"): Promise<void> {
    const id = phoneCallExternalId(call);
    const provider = source === "webhook" ? "agentphone-webhook-call" : "agentphone-call";
    if (this.transportStore.hasInboundReceipt(provider, id)) {
      result.duplicates += 1;
      return;
    }

    let conversationKey: string;
    try {
      conversationKey = await resolvePhoneCallConversationKey(this.engine, call);
    } catch (error) {
      this.transportStore.recordInboundReceipt(
        inboundCallReceipt(provider, id, call, "error", errorMessage(error))
      );
      result.errors += 1;
      return;
    }

    const transcriptReady = await this.resolveCallTranscript(call);
    if (!transcriptReady) {
      this.transportStore.deferCallTranscript({ provider, providerEventId: id, source, call: call.raw }, "call transcript not available yet");
      result.skipped += 1;
      return;
    }
    call = transcriptReady;
    const ingestInput: ConversationEngineIngestInput = {
      ...buildPhoneCallLedgerInput(call),
      conversationKey,
      intakeMode: "direct"
    };
    const acceptance = shouldAcceptPhoneCall(call, this.config.fromNumber);
    const engineResult = await this.engine.admit(ingestInput, {
      actionable: acceptance.shouldReply,
      reason: acceptance.reason
    });
    if (!acceptance.shouldReply || engineResult.action.type === "none") {
      this.transportStore.recordInboundReceipt({
        ...inboundCallReceipt(provider, id, call, "skipped", acceptance.reason),
        taskConversationKey: engineResult.conversation.conversationKey,
        taskDisposition: engineResult.action.type
      });
      if (engineResult.action.type === "none" && engineResult.action.reason === "duplicate") result.duplicates += 1;
      else result.skipped += 1;
      return;
    }

    this.transportStore.recordInboundReceipt({
      ...inboundCallReceipt(provider, id, call, "accepted", null),
      taskConversationKey: engineResult.conversation.conversationKey,
      taskDisposition: engineResult.action.type
    });
    result.accepted += 1;
  }

  private async retryPendingCallTranscripts(result: PollResult): Promise<void> {
    for (const pending of this.transportStore.claimPendingCallTranscripts(this.config.pollLimit)) {
      const call = normalizePhoneCall(pending.call);
      if (!call) {
        result.errors += 1;
        continue;
      }
      try {
        await this.ingestCall(call, result, pending.source);
      } catch (error) {
        this.transportStore.deferCallTranscript({
          provider: pending.provider,
          providerEventId: pending.providerEventId,
          source: pending.source,
          call: pending.call
        }, errorMessage(error));
        result.errors += 1;
      }
    }
  }

  private async resolveCallTranscript(call: NormalizedPhoneCall): Promise<NormalizedPhoneCall | null> {
    if (call.summary || call.transcript) return call;
    if (!call.callId) return null;
    try {
      const transcript = await this.agentPhone.getCallTranscript(call.callId);
      const text = transcriptTextFromProvider(transcript);
      return text ? { ...call, transcript: text } : null;
    } catch {
      return null;
    }
  }

  private phoneTransport(): ConversationRuntimeTransport<{ toNumber: string; providerMessageId: string | null }, PhoneReplyDecision> {
    return {
      channel: "phone",
      provider: "agentphone",
      maxContextTokens: contextTokenLimit(this.config.contextLimits),
      summaryMaxChars: this.config.contextLimits.summaryMaxChars,
      providerInstructions: phoneProviderInstructions(this.config.fromNumber),
      prepare: async (started) => {
        this.status.lastRunAt = new Date().toISOString();
        this.status.lastRunConversationKey = started.conversation.conversationKey;
        this.status.lastRunError = null;
        this.status.lastRunStatus = "running";
        const target = replyTargetFromMessages([...started.messages, ...started.conversation.messages]);
        if (!target.toNumber) throw new Error("phone run has no destination number to reply to");
        return { toNumber: target.toNumber, providerMessageId: target.providerMessageId };
      },
      createSummary: (previousSummary, messages, prompt) => executePhoneCompaction(this.config, this.runtime, previousSummary, messages, prompt),
      generate: async ({ started, prompt }) => {
        if (this.config.outboundMode === "disabled") return { shouldReply: false, reason: "outbound-disabled", body: "" };
        if (prompt === null) throw new Error("ConversationRuntime did not construct a phone execution prompt");
        return this.replyGenerator.generate({ conversationKey: started.conversation.conversationKey, prompt, runKey: executionRunKey("phone", started.conversation.conversationKey) });
      },
      shouldDeliver: (decision) => decision.shouldReply && Boolean(decision.body.trim()),
      assistantMessage: (decision, target, started) => ({ channel: "phone", conversationKey: started.conversation.conversationKey, text: decision.body, runId: started.run.id, authorId: this.config.fromNumber, metadata: { provider: "agentphone", destination: target.toNumber, mode: this.config.outboundMode } }),
      deliveryPayload: (decision, target) => ({
        toNumber: target.toNumber,
        providerMessageId: target.providerMessageId,
        body: decision.body,
        mode: this.config.outboundMode
      }),
      reconcileDelivery: async (delivery) => {
        const message = this.agentPhone.findOutboundDelivery
          ? await this.agentPhone.findOutboundDelivery(delivery.idempotencyKey)
          : await findAgentPhoneOutboundDelivery(this.agentPhone, delivery.idempotencyKey);
        return message ? { providerMessageId: message.id || null, reconciled: true } : null;
      },
      deliver: async (delivery, started) => {
        const payload = phoneDeliveryPayload(delivery.payload, delivery.id);
        const sendResult = await this.agentPhone.sendMessage({ toNumber: payload.toNumber, body: payload.body, idempotencyKey: delivery.idempotencyKey });
        const receipt = { providerMessageId: sendResult.providerMessageId, response: jsonObjectOrWrapped(sendResult.response) };
        try {
          this.transportStore.recordOutboundReceipt({ conversationKey: started.conversation.conversationKey, runId: started.run.id, provider: "agentphone", destination: payload.toNumber, providerMessageId: sendResult.providerMessageId, action: "sent", mode: payload.mode, response: jsonObjectOrWrapped(sendResult.response) });
        } catch (error) {
          console.warn("Phone delivery receipt record failed", errorMessage(error));
        }
        this.status.lastRunStatus = "done";
        this.status.lastOutboundAction = "sent";
        return receipt;
      },
      skipped: async (decision, target, started) => {
        const disabled = this.config.outboundMode === "disabled";
        this.transportStore.recordOutboundReceipt({ conversationKey: started.conversation.conversationKey, runId: started.run.id, provider: "agentphone", destination: target.toNumber, providerMessageId: target.providerMessageId || (disabled ? "disabled" : "skipped"), action: "skipped", mode: this.config.outboundMode, ...(disabled ? {} : { response: { reason: decision.reason } }) });
        this.status.lastRunStatus = "done";
        this.status.lastOutboundAction = "skipped";
      },
      failed: async (error, target, started) => {
        const message = errorMessage(error);
        this.status.lastRunError = message;
        this.status.lastRunStatus = "failed";
        this.status.lastOutboundAction = "failed";
        this.transportStore.recordOutboundReceipt({ conversationKey: started.conversation.conversationKey, runId: started.run.id, provider: "agentphone", destination: target?.toNumber || "", providerMessageId: target?.providerMessageId || "failed", action: "failed", mode: this.config.outboundMode, error: message });
      },
      stopped: (error) => {
        if (!isRunStoppedError(error)) return false;
        this.status.lastRunError = null;
        this.status.lastRunStatus = "stopped";
        this.status.lastOutboundAction = "stopped";
        return true;
      }
    };
  }

  private recordPollResult(result: PollResult): void {
    this.status.lastPollAccepted = result.accepted;
    this.status.lastPollSkipped = result.skipped;
    this.status.lastPollDuplicates = result.duplicates;
    this.status.lastPollErrors = result.errors;
  }

  private recordWebhookResult(result: WebhookResult): void {
    this.status.lastWebhookAccepted = result.accepted;
    this.status.lastWebhookSkipped = result.skipped;
    this.status.lastWebhookDuplicates = result.duplicates;
    this.status.lastWebhookErrors = result.errors;
  }

}

export class CodexPhoneReplyGenerator implements PhoneReplyGenerator {
  private readonly config: PhoneChannelConfig;
  private readonly codexExecutor: CodexProcessRunner | ConversationRuntime;

  constructor(config: PhoneChannelConfig, codexExecutor: CodexProcessRunner | ConversationRuntime = new CodexProcessRunner()) {
    this.config = config;
    this.codexExecutor = codexExecutor;
  }

  async generate(input: PhoneReplyGeneratorInput): Promise<PhoneReplyDecision> {
    if (process.env.PHONE_CHANNEL_GENERATE_WITH_CODEX === "0") {
      return { shouldReply: false, reason: "reply-generation-disabled", body: "" };
    }
    if (!input.prompt) throw new Error("Phone model execution requires a ConversationRuntime-built prompt");
    const sandbox = conversationSandbox(this.config.home);
    const request = {
      command: this.config.codexPath,
      args: [
        "exec",
        "--skip-git-repo-check",
        ...sandbox.args,
        "--model",
        this.config.codexModel,
        "-c",
        `model_reasoning_effort=${JSON.stringify(this.config.codexReasoningEffort)}`,
        "-c",
        `service_tier=${JSON.stringify(this.config.codexServiceTier)}`,
        "--output-schema",
        this.config.codexSchemaPath,
        "-"
      ],
      cwd: sandbox.cwd,
      input: input.prompt,
      timeoutMs: this.config.codexTimeoutMs,
      ...(input.runKey ? { runKey: input.runKey } : {}),
      env: process.env
    };
    const result = await runConversationCodex(this.codexExecutor, "phone", input.conversationKey, request);
    return replyDecisionFromUnknown(parseJsonFromText(result.output));
  }
}

export function defaultPhoneChannelConfig(env: NodeJS.ProcessEnv = process.env): PhoneChannelConfig {
  const home = env.HOME || os.homedir();
  const stateRoot = path.join(home, "state");
  const contextLimitsPath = resolveContextLimitsPath(env);
  const contextLimits = getChannelContextLimits("phone", env);
  return {
    home,
    stateRoot,
    taskLedgerPath: env.PHONE_TASK_LEDGER_PATH || path.join(stateRoot, "tasks", "tasks.sqlite"),
    transportStorePath: env.PHONE_TRANSPORT_STORE_PATH || path.join(stateRoot, "channels", "phone", "phone-transport.sqlite"),
    statusPath: env.PHONE_CHANNEL_STATUS_PATH || path.join(stateRoot, "channels", "phone", "status.json"),
    pollLimit: numberEnv(env.PHONE_POLL_LIMIT, 25, 1, 100),
    pollCallsEnabled: booleanEnv(env.PHONE_POLL_CALLS_ENABLED, true),
    pollingEnabled: booleanEnv(env.PHONE_POLLING_ENABLED, true),
    webhookEnabled: booleanEnv(env.PHONE_WEBHOOK_ENABLED, true),
    outboundMode: outboundModeEnv(env.PHONE_OUTBOUND_MODE || "send"),
    fromNumber: env.PHONE_FROM_NUMBER || AGENTPHONE_FROM_NUMBER,
    codexPath: env.CODEX_BIN || path.join(home, "bin", "codex"),
    codexSchemaPath: env.PHONE_REPLY_SCHEMA_PATH || path.join(home, "channels", "phone", "reply-schema.json"),
    codexTimeoutMs: numberEnv(env.PHONE_CHANNEL_CODEX_TIMEOUT_MS, 180000, 1000, 10 * 60 * 1000),
    codexModel: env[codexExecutor.modelEnv] || codexExecutor.defaultModel,
    codexReasoningEffort: env[codexExecutor.reasoningEffortEnv] || codexExecutor.defaultReasoningEffort,
    codexServiceTier: env[codexExecutor.serviceTierEnv] || codexExecutor.defaultServiceTier,
    deliveryReconciliationDelayMs: numberEnv(
      env.PHONE_DELIVERY_RECONCILIATION_DELAY_MS,
      120000,
      1000,
      60 * 60 * 1000
    ),
    contextLimitsPath,
    contextLimits
  };
}


function inboundMessageReceipt(provider: string, id: string, message: NormalizedPhoneMessage, action: PhoneInboundReceiptInput["action"], reason: string | null): PhoneInboundReceiptInput {
  const receipt: PhoneInboundReceiptInput = {
    provider,
    providerEventId: id,
    conversationId: message.conversationId,
    sender: message.fromNumber || "",
    kind: "message",
    action,
    error: action === "skipped" || action === "error" ? reason : null
  };
  const receivedAt = message.receivedAt || message.createdAt;
  if (receivedAt) receipt.receivedAt = receivedAt;
  return receipt;
}

function inboundCallReceipt(provider: string, id: string, call: NormalizedPhoneCall, action: PhoneInboundReceiptInput["action"], reason: string | null): PhoneInboundReceiptInput {
  const receipt: PhoneInboundReceiptInput = {
    provider,
    providerEventId: id,
    conversationId: call.conversationId || null,
    sender: call.fromNumber || "",
    kind: "call",
    action,
    error: action === "skipped" || action === "error" ? reason : null
  };
  const receivedAt = call.endedAt || call.startedAt;
  if (receivedAt) receipt.receivedAt = receivedAt;
  return receipt;
}

function contextTokenLimit(limits: ContextChannelLimits): number {
  return limits.maxContextTokens ?? limits.maxContextChars;
}

/** The runtime owns compaction prompt construction and checkpoint policy. */
async function executePhoneCompaction(
  config: PhoneChannelConfig,
  codexExecutor: CodexProcessRunner | ConversationRuntime,
  previousSummary: string | null,
  messages: TaskLedgerMessage[],
  prompt: string
): Promise<string> {
  try {
    const result = await runCodex(codexExecutor, {
      command: config.codexPath,
      args: [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--model",
        config.codexModel,
        "-c",
        `model_reasoning_effort=${JSON.stringify(config.codexReasoningEffort)}`,
        "-c",
        `service_tier=${JSON.stringify(config.codexServiceTier)}`,
        "-"
      ],
      cwd: config.home,
      input: prompt,
      timeoutMs: Math.min(config.codexTimeoutMs, 120000),
      env: process.env,
    });
    const summary = result.stdout.trim();
    if (summary) return summary;
  } catch {
    // Fall back to a bounded mechanical summary so compaction can continue.
  }

  return [
    previousSummary ? `Prior: ${previousSummary}` : null,
    `Compacted ${messages.length} messages through seq ${messages[messages.length - 1]?.seq ?? "?"}.`,
    messages.slice(-5).map((message) => `${message.role}: ${truncateText(message.text, 200)}`).join(" | ")
  ].filter(Boolean).join(" ");
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20))}\n[truncated]`;
}

interface PhoneReplyTarget {
  toNumber: string | null;
  providerMessageId: string | null;
}

function replyTargetFromMessages(messages: TaskLedgerMessage[]): PhoneReplyTarget {
  for (const message of [...messages].reverse()) {
    const target = message.metadata;
    const toNumber = stringField(target.fromNumber) || stringField(target.callerNumber);
    if (toNumber) return {
      toNumber,
      providerMessageId: stringField(target.providerMessageId) || stringField(target.id) || stringField(target.callId)
    };
  }
  return { toNumber: null, providerMessageId: null };
}


function phoneDeliveryPayload(payload: JsonObject, deliveryId: string): { toNumber: string; body: string; mode: PhoneOutboundMode } {
  const toNumber = stringField(payload.toNumber);
  const body = typeof payload.body === "string" ? payload.body : null;
  const mode = payload.mode === "send" || payload.mode === "disabled" ? payload.mode : null;
  if (!toNumber || body == null || !mode) throw new Error(`invalid phone delivery payload ${deliveryId}`);
  return { toNumber, body, mode };
}

function replyDecisionFromUnknown(value: unknown): PhoneReplyDecision {
  if (!isRecord(value)) throw new Error("reply decision must be an object");
  return {
    shouldReply: value.shouldReply === true,
    reason: typeof value.reason === "string" ? value.reason : "no reason provided",
    body: typeof value.body === "string" ? value.body : ""
  };
}

function jsonObjectOrWrapped(value: unknown): JsonObject {
  const converted = jsonValueOrNull(value);
  if (converted && typeof converted === "object" && !Array.isArray(converted)) return converted as JsonObject;
  return { value: converted };
}

function jsonValueOrNull(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(jsonValueOrNull);
  if (isRecord(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) out[key] = jsonValueOrNull(item);
    return out;
  }
  return null;
}

function outboundModeEnv(value: string): PhoneOutboundMode {
  if (value === "send" || value === "disabled") return value;
  throw new Error(`invalid PHONE_OUTBOUND_MODE: ${value}`);
}

function numberEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function booleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  return fallback;
}

function truncatePhoneText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 15) return text.slice(-maxChars);
  return `...[truncated]\n${text.slice(-(maxChars - 15))}`;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRunStoppedError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "RUN_STOPPED";
}

function runCodex(
  executor: CodexProcessRunner | ConversationRuntime,
  request: Parameters<CodexProcessRunner["run"]>[0]
) {
  return executor instanceof ConversationRuntime ? executor.runCodex(request) : executor.run(request);
}

async function runConversationCodex(
  executor: CodexProcessRunner | ConversationRuntime,
  channel: "phone",
  conversationKey: string,
  request: Parameters<CodexProcessRunner["run"]>[0]
): Promise<{ output: string }> {
  if (executor instanceof ConversationRuntime) {
    return executor.runCodexConversation({ channel, conversationKey, request });
  }
  const result = await executor.run(request);
  return { output: result.stdout };
}

function executionRunKey(channel: "email" | "phone", conversationKey: string): string {
  return `${channel}:${conversationKey}`;
}

function transcriptTextFromProvider(value: Record<string, unknown>): string | null {
  const direct = stringField(value.transcript) || stringField(value.summary) || stringField(value.text);
  if (direct) return direct;
  for (const key of ["messages", "segments", "data", "items"]) {
    const candidate = value[key];
    if (!Array.isArray(candidate)) continue;
    const lines = candidate.flatMap((item) => {
      if (!isRecord(item)) return [];
      const speaker = stringField(item.speaker) || stringField(item.role) || "speaker";
      const text = stringField(item.text) || stringField(item.message) || stringField(item.transcript);
      return text ? [`${speaker}: ${text}`] : [];
    });
    if (lines.length > 0) return lines.join("\n");
  }
  return null;
}

function phoneCallPollOffset(cursor: string | null): number {
  if (cursor == null) return 0;
  const parsed = Number(cursor);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`invalid durable AgentPhone call polling cursor: ${cursor}`);
  }
  return parsed;
}

function phoneProviderInstructions(fromNumber: string): string[] {
  // The harness home is the account this channel runs as, so the dev harness
  // never tells the model to drive production's task ledger.
  const home = process.env.HOME ?? os.homedir();
  return [
    `you are Fluffles replying by text message from ${fromNumber}.`,
    "decide whether this phone conversation should receive a concise response.",
    "skip spam, automated messages, vague FYI messages, and anything that requires facts you do not have.",
    "if it should be answered, write a short plain-text sms/imessage reply.",
    "use lowercase for casual chat unless a proper noun, path, or code identifier needs casing.",
    "do not invent commitments, prices, legal claims, deadlines, product details, or private information.",
    "do not use em dashes.",
    `when the user asks for a one-time reminder, create it with ${home}/bin/task-control reminder-create using the conversationKey below, an explicit future UTC scheduled-for timestamp, and an IANA display timezone before replying.`,
    `for meaningful multi-step work, keep the durable task registry current: run ${home}/bin/task-control task-list --channel phone --conversation-key <conversationKey below> first and resume any unfinished task from its next_action; otherwise create one with task-create --objective <objective>, update it at checkpoints with task-update --id <task-id> --progress/--next-action, and finish it with task-update --id <task-id> --status completed --result <result> (or --status failed --result <reason>).`,
    "return only json matching the schema."
  ];
}
