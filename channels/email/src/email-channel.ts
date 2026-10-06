import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConversationEngine,
  ConversationRuntime,
  CodexProcessRunner,
  ProviderDeliveryRejectedError,
  conversationSandbox,
  deploymentUpdateNotice,
  SQLiteTaskLedger,
  getChannelContextLimits,
  resolveContextLimitsPath,
  type ConversationEngineIngestInput,
  type ContextChannelLimits,
  type JsonObject,
  type TaskLedgerMessage,
  type TaskLedgerStartedRun,
  type ConversationRuntimeTransport
} from "@fluffles/tasks";
import { codexExecutor } from "../../../agent/executors/codex";
import {
  buildIncomingEmailLedgerInput,
  emailExternalMessageId,
  resolveEmailConversationKey,
  type EmailClassification,
  type NormalizedEmail
} from "./email-task-adapter";
import { classifyEmail, normalizeGmailMessage, normalizeInboundEmail, type GmailMessage, type RawInboundEmail } from "./email-normalize";
import { GwsClient, parseJsonFromText, type GwsAuthStatus } from "./gws-client";
import { SQLiteEmailTransportStore, type EmailInboundReceiptInput, type EmailTransportSnapshot } from "./email-transport-store";

export type EmailOutboundMode = "draft" | "send" | "disabled";

export interface EmailChannelConfig {
  home: string;
  stateRoot: string;
  taskLedgerPath: string;
  transportStorePath: string;
  statusPath: string;
  pollQuery: string;
  pollMaxResults: number;
  pollingEnabled: boolean;
  webhookEnabled: boolean;
  /** Stable authenticated/configured mailbox identity used in every email key. */
  mailboxId: string;
  mailboxAddresses: string[];
  gmailPubSubSubscription: string | null;
  outboundMode: EmailOutboundMode;
  fromAddress: string | null;
  codexPath: string;
  codexSchemaPath: string;
  codexTimeoutMs: number;
  codexModel: string;
  codexReasoningEffort: string;
  codexServiceTier: string;
  /** Minimum wait after an ambiguous Gmail send before the runtime may retry. */
  deliveryReconciliationDelayMs: number;
  contextLimitsPath: string;
  contextLimits: ContextChannelLimits;
}

export interface EmailReplyDecision {
  shouldReply: boolean;
  reason: string;
  subject: string | null;
  body: string;
}

export interface EmailReplyGenerator {
  generate(input: EmailReplyGeneratorInput): Promise<EmailReplyDecision>;
}

export interface EmailGwsClient {
  authStatus(): Promise<GwsAuthStatus>;
  listMessages(query: string, maxResults: number): Promise<{ id: string; threadId: string | null }[]>;
  getProfile?(): Promise<{ historyId: string }>;
  listMessagesPage?(query: string, maxResults: number, pageToken?: string | null): Promise<{ messages: { id: string; threadId: string | null }[]; nextPageToken: string | null }>;
  listHistory?(startHistoryId: string, maxResults: number, pageToken?: string | null): Promise<{ messages: { id: string; threadId: string | null }[]; nextPageToken: string | null; historyId: string | null }>;
  getMessage(id: string): Promise<GmailMessage>;
  reply(input: { messageId: string; body: string; from?: string | null; draft: boolean; idempotencyKey?: string }): Promise<{ ok: boolean; mode: "draft" | "send"; response: unknown; providerMessageId?: string | null; providerDraftId?: string | null; providerThreadId?: string | null }>;
  findDelivery(messageId: string, idempotencyKey: string): Promise<JsonObject | null>;
}

export interface EmailReplyGeneratorInput {
  conversationKey: string;
  /** Built and budgeted by ConversationRuntime. Required for live execution. */
  prompt?: string;
  runKey?: string;
}

export interface EmailChannelStatus {
  ok: boolean;
  service: "fluffles-channel-email";
  startedAt: string;
  gwsTokenValid: boolean | null;
  gwsLastError: string | null;
  pollingEnabled: boolean;
  webhookEnabled: boolean;
  pollQuery: string;
  pollMaxResults: number;
  contextLimitsPath: string;
  contextLimits: ContextChannelLimits;
  outboundMode: EmailOutboundMode;
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
  lastGmailPushAt: string | null;
  lastGmailPushEmail: string | null;
  lastGmailPushHistoryId: string | null;
  lastRunAt: string | null;
  lastRunError: string | null;
  lastRunConversationKey: string | null;
  lastRunStatus: string | null;
  lastOutboundAction: string | null;
  recoveredRuns: number;
  taskLedgerPath: string;
  emailTransportStorePath: string;
  transport: EmailTransportSnapshot | null;
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

export class EmailChannel {
  private readonly config: EmailChannelConfig;
  private readonly engine: ConversationEngine;
  private readonly runtime: ConversationRuntime;
  private readonly ledger: SQLiteTaskLedger;
  private readonly ownedLedger: boolean;
  private readonly gws: EmailGwsClient;
  private readonly transportStore: SQLiteEmailTransportStore;
  private readonly replyGenerator: EmailReplyGenerator;
  private readonly status: EmailChannelStatus;

  constructor(options: {
    config: EmailChannelConfig;
    engine?: ConversationEngine;
    ledger?: SQLiteTaskLedger;
    gws?: EmailGwsClient;
    transportStore?: SQLiteEmailTransportStore;
    replyGenerator?: EmailReplyGenerator;
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
      workerInstanceId: `email:${os.hostname()}`,
      updateNotice: deploymentUpdateNotice,
      model: this.config.codexModel,
      acceptanceUnknownRetryDelayMs: this.config.deliveryReconciliationDelayMs,
      deliveryErrorsMayBeAmbiguous: true
    });
    this.gws = options.gws || new GwsClient({ binPath: path.join(options.config.home, "bin", "gws") });
    this.transportStore = options.transportStore || new SQLiteEmailTransportStore({ filePath: options.config.transportStorePath });
    this.replyGenerator = options.replyGenerator || new CodexEmailReplyGenerator(options.config, this.runtime);
    this.status = {
      ok: true,
      service: "fluffles-channel-email",
      startedAt: new Date().toISOString(),
      gwsTokenValid: null,
      gwsLastError: null,
      pollingEnabled: options.config.pollingEnabled,
      webhookEnabled: options.config.webhookEnabled,
      pollQuery: options.config.pollQuery,
      pollMaxResults: options.config.pollMaxResults,
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
      lastGmailPushAt: null,
      lastGmailPushEmail: null,
      lastGmailPushHistoryId: null,
      lastRunAt: null,
      lastRunError: null,
      lastRunConversationKey: null,
      lastRunStatus: null,
      lastOutboundAction: null,
      recoveredRuns: 0,
      taskLedgerPath: options.config.taskLedgerPath,
      emailTransportStorePath: options.config.transportStorePath,
      transport: null
    };
  }

  async recoverInterruptedRuns(options: { reclaimOwnLeases?: boolean } = {}): Promise<string[]> {
    const recovery = await this.runtime.recover("email", options);
    this.status.recoveredRuns += recovery.recoveredKeys.length;
    await this.writeStatus();
    return recovery.recoveredKeys;
  }

  async pollOnce(): Promise<PollResult> {
    const result: PollResult = { accepted: 0, skipped: 0, duplicates: 0, errors: 0 };
    this.status.lastPollAt = new Date().toISOString();
    this.status.lastPollError = null;
    await this.ingestDurableGmailPoll(result, (message) => { this.status.lastPollError = message; });
    this.recordPollResult(result);
    await this.writeStatus();
    return result;
  }

  async ingestWebhook(input: unknown): Promise<WebhookResult> {
    const result: WebhookResult = { accepted: 0, skipped: 0, duplicates: 0, errors: 0 };
    this.status.lastWebhookAt = new Date().toISOString();
    this.status.lastWebhookError = null;

    try {
      const push = gmailPushNotificationFromWebhook(input, this.config.gmailPubSubSubscription);
      if (push) {
        this.status.lastGmailPushAt = this.status.lastWebhookAt;
        this.status.lastGmailPushEmail = push.emailAddress;
        this.status.lastGmailPushHistoryId = push.historyId;
        await this.ingestGmailPush(push, result, (message) => { this.status.lastWebhookError = message; });
      } else {
        const email = normalizeInboundEmail(rawInboundEmailFromWebhook(input));
        await this.ingestNormalizedEmail(email, result);
      }
    } catch (error) {
      result.errors += 1;
      this.status.lastWebhookError = errorMessage(error);
      this.transportStore.recordInboundReceipt({
        provider: "webhook",
        providerMessageId: `error:${Date.now()}:${Math.random().toString(36).slice(2)}`,
        threadId: null,
        subject: "",
        from: "",
        classification: {},
        action: "error",
        error: errorMessage(error)
      });
    }

    this.recordWebhookResult(result);
    await this.writeStatus();
    return result;
  }

  async processQueued(limit = 5): Promise<ProcessResult> {
    await this.ledger.admitDueReminders({ channel: "email" });
    const runs = await this.runtime.processTransport(this.emailTransport(), limit);
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

  async snapshotStatus(): Promise<EmailChannelStatus> {
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

  private async ingestGmailQuery(result: PollResult, recordError: (message: string) => void): Promise<void> {
    const auth = await this.gws.authStatus();
    this.recordAuthStatus(auth);
    if (auth.token_valid !== true) {
      result.errors += 1;
      recordError(auth.token_error || auth.error || "gws auth invalid");
      return;
    }

    try {
      let pageToken: string | null = null;
      const summaries: Array<{ id: string; threadId: string | null }> = [];
      do {
        const page: { messages: { id: string; threadId: string | null }[]; nextPageToken: string | null } = this.gws.listMessagesPage
          ? await this.gws.listMessagesPage(durablePollingQuery(this.config.pollQuery), this.config.pollMaxResults, pageToken)
          : { messages: await this.gws.listMessages(durablePollingQuery(this.config.pollQuery), this.config.pollMaxResults), nextPageToken: null };
        summaries.push(...page.messages);
        pageToken = page.nextPageToken;
      } while (pageToken);
      await this.ingestGmailSummaries(summaries, result);
    } catch (error) {
      result.errors += 1;
      recordError(errorMessage(error));
    }
  }

  /**
   * Gmail unread state is not durable input: another client may mark a
   * message read while this worker is down. A mailbox history cursor is the
   * durable at-least-once source; full inbox scans are used only to establish
   * or repair that cursor.
   */
  private async ingestDurableGmailPoll(result: PollResult, recordError: (message: string) => void): Promise<void> {
    const auth = await this.gws.authStatus();
    this.recordAuthStatus(auth);
    if (auth.token_valid !== true) {
      result.errors += 1;
      recordError(auth.token_error || auth.error || "gws auth invalid");
      return;
    }
    const cursor = this.transportStore.gmailHistoryCursor(this.config.mailboxId);
    if (cursor && this.gws.listHistory) {
      await this.ingestGmailHistory(cursor.historyId, null, result, recordError);
      return;
    }
    // Capture the baseline before scanning. Messages arriving during the scan
    // appear in the next history pass from this cursor.
    try {
      const baseline = this.gws.getProfile ? await this.gws.getProfile() : null;
      await this.ingestGmailQuery(result, recordError);
      if (result.errors === 0 && baseline?.historyId) {
        this.transportStore.setGmailHistoryCursor(this.config.mailboxId, baseline.historyId);
      }
    } catch (error) {
      result.errors += 1;
      recordError(errorMessage(error));
    }
  }

  private async ingestGmailPush(
    push: GmailPushNotification,
    result: PollResult,
    recordError: (message: string) => void
  ): Promise<void> {
    const cursor = this.transportStore.gmailHistoryCursor(this.config.mailboxId);
    if (cursor && this.gws.listHistory) {
      await this.ingestGmailHistory(cursor.historyId, push.historyId, result, recordError);
      return;
    }
    await this.ingestDurableGmailPoll(result, recordError);
    // Legacy GWS implementations may not expose getProfile yet. A Pub/Sub
    // history id is still a durable baseline after a successful full scan.
    if (result.errors === 0 && push.historyId && !this.transportStore.gmailHistoryCursor(this.config.mailboxId)) {
      this.transportStore.setGmailHistoryCursor(this.config.mailboxId, push.historyId);
    }
  }

  private async ingestGmailHistory(
    startHistoryId: string,
    notificationHistoryId: string | null,
    result: PollResult,
    recordError: (message: string) => void
  ): Promise<void> {
    if (!this.gws.listHistory) {
      await this.ingestDurableGmailPoll(result, recordError);
      return;
    }
    let historyCursorExpired = false;
    try {
      let pageToken: string | null = null;
      let observedHistoryId: string | null = null;
      const summaries: Array<{ id: string; threadId: string | null }> = [];
      do {
        let page: Awaited<ReturnType<NonNullable<EmailGwsClient["listHistory"]>>>;
        try {
          page = await this.gws.listHistory(startHistoryId, this.config.pollMaxResults, pageToken);
        } catch (error) {
          // Gmail uses this specific history.list failure to signal that the
          // cursor can no longer be replayed. A 404 from getMessage is not
          // equivalent and must retain the existing history range.
          historyCursorExpired = isGmailHistoryCursorExpired(error);
          throw error;
        }
        summaries.push(...page.messages);
        pageToken = page.nextPageToken;
        observedHistoryId = page.historyId ?? observedHistoryId;
      } while (pageToken);
      await this.ingestGmailSummaries(summaries, result);
      // Advance only after every message was persisted/admitted. Replays are
      // harmless because receipt and engine idempotency are durable.
      this.transportStore.setGmailHistoryCursor(this.config.mailboxId, observedHistoryId ?? notificationHistoryId ?? startHistoryId);
    } catch (error) {
      // A normal history read, message fetch, normalization, or admission
      // failure must leave the cursor untouched. Replaying this exact range is
      // the at-least-once boundary; rebuilding from an inbox scan here could
      // skip a message another client archived after the transient failure.
      if (!historyCursorExpired) {
        result.errors += 1;
        recordError(errorMessage(error));
        return;
      }
      // Gmail explicitly says this history id is no longer retained. Only
      // that provider-guaranteed condition permits a full baseline rebuild.
      const baseline = this.gws.getProfile ? await this.gws.getProfile().catch(() => null) : null;
      await this.ingestGmailQuery(result, recordError);
      if (result.errors === 0 && baseline?.historyId) this.transportStore.setGmailHistoryCursor(this.config.mailboxId, baseline.historyId);
      if (result.errors > 0) recordError(errorMessage(error));
    }
  }

  private async ingestGmailSummaries(
    summaries: Array<{ id: string; threadId: string | null }>,
    result: PollResult
  ): Promise<void> {
    const emails: NormalizedEmail[] = [];
    for (const summary of summaries) {
      if (this.transportStore.hasInboundReceipt("gmail", summary.id)) {
        result.duplicates += 1;
        continue;
      }
      const message = await this.gws.getMessage(summary.id);
      emails.push(normalizeGmailMessage(message));
    }
    emails.sort(compareGmailEmailOrder);
    for (const email of emails) await this.ingestNormalizedEmail(email, result);
  }

  private emailTransport(): ConversationRuntimeTransport<{ provider: string; providerMessageId: string }, EmailReplyDecision> {
    return {
      channel: "email",
      provider: "gmail",
      maxContextTokens: contextTokenLimit(this.config.contextLimits),
      summaryMaxChars: this.config.contextLimits.summaryMaxChars,
      providerInstructions: emailProviderInstructions(),
      prepare: async (started) => {
        this.status.lastRunAt = new Date().toISOString();
        this.status.lastRunConversationKey = started.conversation.conversationKey;
        this.status.lastRunError = null;
        this.status.lastRunStatus = "running";
        const target = replyTargetFromMessages([...started.messages, ...started.conversation.messages]);
        if (!target.providerMessageId) throw new Error("email run has no Gmail provider message id to reply to");
        return { provider: target.provider, providerMessageId: target.providerMessageId };
      },
      createSummary: (previousSummary, messages, prompt) => executeEmailCompaction(this.config, this.runtime, previousSummary, messages, prompt),
      generate: async ({ started, prompt }) => {
        if (this.config.outboundMode === "disabled") return { shouldReply: false, reason: "outbound-disabled", subject: null, body: "" };
        if (prompt === null) throw new Error("ConversationRuntime did not construct an email execution prompt");
        return this.replyGenerator.generate({ conversationKey: started.conversation.conversationKey, prompt, runKey: executionRunKey("email", started.conversation.conversationKey) });
      },
      shouldDeliver: (decision) => decision.shouldReply && Boolean(decision.body.trim()),
      assistantMessage: (decision, target, started) => ({
        channel: "email", conversationKey: started.conversation.conversationKey, text: decision.body,
        runId: started.run.id, authorId: this.config.fromAddress || "fluffles@puffle.ai",
        metadata: { provider: target.provider, providerMessageId: target.providerMessageId, subject: decision.subject, mode: this.config.outboundMode }
      }),
      deliveryPayload: (decision, target) => ({
        provider: target.provider,
        providerMessageId: target.providerMessageId,
        body: decision.body,
        subject: decision.subject,
        mode: this.config.outboundMode,
        fromAddress: this.config.fromAddress
      }),
      reconcileDelivery: async (delivery) => {
        const payload = emailDeliveryPayload(delivery.payload, delivery.id);
        return this.gws.findDelivery(payload.providerMessageId, delivery.idempotencyKey);
      },
      deliver: async (delivery, started) => {
        const payload = emailDeliveryPayload(delivery.payload, delivery.id);
        const auth = await this.gws.authStatus();
        this.recordAuthStatus(auth);
        if (auth.token_valid !== true) {
          throw new ProviderDeliveryRejectedError(`gws-auth-invalid: ${auth.token_error || auth.error || "unknown"}`);
        }
        const sendResult = await this.gws.reply({ messageId: payload.providerMessageId, body: payload.body, from: payload.fromAddress, draft: payload.mode === "draft", idempotencyKey: delivery.idempotencyKey });
        const action = sendResult.mode === "draft" ? "drafted" : "sent";
        const receipt = {
          providerMessageId: sendResult.providerMessageId ?? payload.providerMessageId,
          providerDraftId: sendResult.providerDraftId ?? null,
          providerThreadId: sendResult.providerThreadId ?? null,
          action,
          mode: sendResult.mode,
          response: jsonObjectOrWrapped(sendResult.response)
        };
        try {
          this.transportStore.recordOutboundReceipt({ conversationKey: started.conversation.conversationKey, runId: started.run.id, provider: payload.provider, providerMessageId: receipt.providerMessageId, action, mode: payload.mode, response: jsonObjectOrWrapped(sendResult.response) });
        } catch (error) {
          console.warn("Email delivery receipt record failed", errorMessage(error));
        }
        this.status.lastRunStatus = "done";
        this.status.lastOutboundAction = action;
        return receipt;
      },
      skipped: async (decision, target, started) => {
        const disabled = this.config.outboundMode === "disabled";
        this.transportStore.recordOutboundReceipt({ conversationKey: started.conversation.conversationKey, runId: started.run.id, provider: target.provider, providerMessageId: target.providerMessageId, action: "skipped", mode: this.config.outboundMode, ...(disabled ? {} : { response: { reason: decision.reason } }) });
        this.status.lastRunStatus = "done";
        this.status.lastOutboundAction = "skipped";
      },
      failed: async (error, target, started) => {
        const message = errorMessage(error);
        this.status.lastRunError = message;
        this.status.lastRunStatus = "failed";
        this.status.lastOutboundAction = "failed";
        if (target) this.transportStore.recordOutboundReceipt({ conversationKey: started.conversation.conversationKey, runId: started.run.id, provider: target.provider, providerMessageId: target.providerMessageId, action: "failed", mode: this.config.outboundMode, error: message });
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

  private async ingestNormalizedEmail(email: NormalizedEmail, result: PollResult): Promise<void> {
    const id = providerMessageId(email);
    if (this.transportStore.hasInboundReceipt(email.provider, id)) {
      result.duplicates += 1;
      return;
    }

    const classification = classifyEmail(email, { mailboxAddresses: this.config.mailboxAddresses });
    const ingestInput: ConversationEngineIngestInput = {
      ...buildIncomingEmailLedgerInput(email, classification, this.config.mailboxId),
      intakeMode: "direct"
    };
    ingestInput.conversationKey = await resolveEmailConversationKey(this.engine, email, this.config.mailboxId);
    const engineResult = await this.engine.admit(ingestInput, {
      actionable: classification.shouldReply,
      reason: classification.reason ?? null,
      controlText: email.text
    });
    if (engineResult.conversation.status === "stopped") {
      this.runtime.cancelCodexRun(executionRunKey("email", engineResult.conversation.conversationKey));
    }
    if (!classification.shouldReply || engineResult.action.type === "none") {
      const isDuplicate = engineResult.action.type === "none" && engineResult.action.reason === "duplicate";
      const receipt: EmailInboundReceiptInput = {
        provider: email.provider,
        providerMessageId: id,
        threadId: email.threadId,
        subject: email.subject,
        from: email.from,
        classification: classificationJson(classification),
        action: isDuplicate ? "duplicate" : "skipped",
        taskConversationKey: engineResult.conversation.conversationKey,
        taskDisposition: engineResult.action.type
      };
      this.transportStore.recordInboundReceipt(email.date ? { ...receipt, receivedAt: email.date } : receipt);
      if (isDuplicate) result.duplicates += 1;
      else result.skipped += 1;
      return;
    }

    const receipt: EmailInboundReceiptInput = {
      provider: email.provider,
      providerMessageId: id,
      threadId: email.threadId,
      subject: email.subject,
      from: email.from,
      classification: classificationJson(classification),
      action: "accepted",
      taskConversationKey: engineResult.conversation.conversationKey,
      taskDisposition: engineResult.action.type
    };
    this.transportStore.recordInboundReceipt(email.date ? { ...receipt, receivedAt: email.date } : receipt);
    result.accepted += 1;
  }

  private recordAuthStatus(auth: GwsAuthStatus): void {
    this.status.gwsTokenValid = auth.token_valid === true;
    this.status.gwsLastError = auth.token_valid === true ? null : auth.token_error || auth.error || "unknown";
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

export class CodexEmailReplyGenerator implements EmailReplyGenerator {
  private readonly config: EmailChannelConfig;
  private readonly codexExecutor: CodexProcessRunner | ConversationRuntime;

  constructor(config: EmailChannelConfig, codexExecutor: CodexProcessRunner | ConversationRuntime = new CodexProcessRunner()) {
    this.config = config;
    this.codexExecutor = codexExecutor;
  }

  async generate(input: EmailReplyGeneratorInput): Promise<EmailReplyDecision> {
    if (process.env.EMAIL_CHANNEL_GENERATE_WITH_CODEX === "0") {
      return { shouldReply: false, reason: "reply-generation-disabled", subject: null, body: "" };
    }
    if (!input.prompt) throw new Error("Email model execution requires a ConversationRuntime-built prompt");
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
    const result = await runConversationCodex(this.codexExecutor, "email", input.conversationKey, request);
    return replyDecisionFromUnknown(parseJsonFromText(result.output));
  }
}

export function defaultEmailChannelConfig(env: NodeJS.ProcessEnv = process.env): EmailChannelConfig {
  const home = env.HOME || os.homedir();
  const stateRoot = path.join(home, "state");
  const contextLimitsPath = resolveContextLimitsPath(env);
  const contextLimits = getChannelContextLimits("email", env);
  return {
    home,
    stateRoot,
    taskLedgerPath: env.EMAIL_TASK_LEDGER_PATH || path.join(stateRoot, "tasks", "tasks.sqlite"),
    transportStorePath: env.EMAIL_TRANSPORT_STORE_PATH || path.join(stateRoot, "channels", "email", "email-transport.sqlite"),
    statusPath: env.EMAIL_CHANNEL_STATUS_PATH || path.join(stateRoot, "channels", "email", "status.json"),
    pollQuery: env.EMAIL_POLL_QUERY || "in:inbox",
    pollMaxResults: numberEnv(env.EMAIL_POLL_MAX_RESULTS, 100, 1, 500),
    pollingEnabled: booleanEnv(env.EMAIL_POLLING_ENABLED, true),
    webhookEnabled: booleanEnv(env.EMAIL_WEBHOOK_ENABLED, true),
    mailboxId: nonEmpty(env.EMAIL_MAILBOX_ID) || nonEmpty(env.EMAIL_FROM_ADDRESS) || "gmail:me",
    mailboxAddresses: emailAddressList(env.EMAIL_MAILBOX_ADDRESSES || env.EMAIL_FROM_ADDRESS || env.EMAIL_MAILBOX_ID || ""),
    gmailPubSubSubscription: nonEmpty(env.EMAIL_GMAIL_PUBSUB_SUBSCRIPTION),
    outboundMode: outboundModeEnv(env.EMAIL_OUTBOUND_MODE || "draft"),
    fromAddress: nonEmpty(env.EMAIL_FROM_ADDRESS) || null,
    codexPath: env.CODEX_BIN || path.join(home, "bin", "codex"),
    codexSchemaPath: env.EMAIL_REPLY_SCHEMA_PATH || path.join(home, "channels", "email", "reply-schema.json"),
    codexTimeoutMs: numberEnv(env.EMAIL_CHANNEL_CODEX_TIMEOUT_MS, 180000, 1000, 10 * 60 * 1000),
    codexModel: env[codexExecutor.modelEnv] || codexExecutor.defaultModel,
    codexReasoningEffort: env[codexExecutor.reasoningEffortEnv] || codexExecutor.defaultReasoningEffort,
    codexServiceTier: env[codexExecutor.serviceTierEnv] || codexExecutor.defaultServiceTier,
    deliveryReconciliationDelayMs: numberEnv(env.EMAIL_DELIVERY_RECONCILIATION_DELAY_MS, 120000, 1000, 60 * 60 * 1000),
    contextLimitsPath,
    contextLimits
  };
}

interface GmailPushNotification {
  emailAddress: string | null;
  historyId: string | null;
  messageId: string | null;
}

function rawInboundEmailFromWebhook(input: unknown): RawInboundEmail {
  const candidate = unwrapInboundPayload(input);
  if (!isRuntimeRecord(candidate)) throw new Error("email webhook payload must contain an inbound object");
  const raw: Record<string, unknown> = { ...candidate };
  if (raw.provider == null) raw.provider = "gmail";
  if (raw.providerMessageId == null) raw.providerMessageId = raw.gmailMessageId ?? raw.id;
  if (raw.externalMessageId == null) raw.externalMessageId = raw.rfcMessageId ?? raw.messageId;
  if (raw.text == null) raw.text = raw.body ?? raw.plainText;
  return raw as RawInboundEmail;
}

function gmailPushNotificationFromWebhook(input: unknown, expectedSubscription: string | null): GmailPushNotification | null {
  const envelope = pubSubEnvelopeFromWebhook(input, 0);
  return envelope ? gmailPushNotificationFromPubSub(envelope, expectedSubscription) : null;
}

function pubSubEnvelopeFromWebhook(input: unknown, depth: number): unknown | null {
  if (depth > 5 || !isRuntimeRecord(input)) return null;
  const message = input.message;
  if (isRuntimeRecord(message) && typeof message.data === "string" && ("subscription" in input || "pubsub" in input)) {
    return input;
  }
  for (const key of ["pubsub", "inbound", "email", "payload", "body"]) {
    const nested = pubSubEnvelopeFromWebhook(input[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

function gmailPushNotificationFromPubSub(input: unknown, expectedSubscription: string | null): GmailPushNotification {
  if (!isRuntimeRecord(input)) throw new Error("gmail pubsub payload must be an object");
  const message = input.message;
  if (!isRuntimeRecord(message)) throw new Error("gmail pubsub payload must contain message");
  if (expectedSubscription && stringField(input.subscription) !== expectedSubscription) {
    throw new Error("gmail pubsub subscription mismatch");
  }
  const data = stringField(message.data);
  if (!data) throw new Error("gmail pubsub message.data is required");

  const decoded = decodePubSubData(data);
  const emailAddress = stringField(decoded.emailAddress);
  const historyId = stringField(decoded.historyId);
  if (!emailAddress && !historyId) {
    throw new Error("gmail pubsub data must contain emailAddress or historyId");
  }
  return {
    emailAddress,
    historyId,
    messageId: stringField(message.messageId) || stringField(message.message_id)
  };
}

function decodePubSubData(data: string): Record<string, unknown> {
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const text = Buffer.from(padded, "base64").toString("utf8").trim();
  if (!text) throw new Error("gmail pubsub message.data decoded empty");
  const parsed = JSON.parse(text) as unknown;
  if (!isRuntimeRecord(parsed)) throw new Error("gmail pubsub message.data must decode to an object");
  return parsed;
}

function unwrapInboundPayload(input: unknown): unknown {
  if (!isRuntimeRecord(input)) return input;
  if (isRuntimeRecord(input.inbound)) return input.inbound;
  if (isRuntimeRecord(input.email)) return input.email;
  if (isRuntimeRecord(input.payload)) return unwrapInboundPayload(input.payload);
  return input;
}

function providerMessageId(email: NormalizedEmail): string {
  return email.id || emailExternalMessageId(email);
}

function compareGmailEmailOrder(left: NormalizedEmail, right: NormalizedEmail): number {
  const leftTime = Number(left.internalDate) || Date.parse(left.date);
  const rightTime = Number(right.internalDate) || Date.parse(right.date);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return leftTime - rightTime;
  return providerMessageId(left).localeCompare(providerMessageId(right));
}

function classificationJson(classification: EmailClassification): JsonObject {
  return {
    shouldReply: classification.shouldReply,
    confidence: classification.confidence || null,
    reason: classification.reason || null,
    sender: classification.sender || null,
    subject: classification.subject || null
  };
}

/** Never let legacy unread filtering turn a transient poll failure into loss. */
function durablePollingQuery(query: string): string {
  const durable = query.replace(/\bis:unread\b/ig, "").replace(/\s+/g, " ").trim();
  return durable || "in:inbox";
}

/** Gmail history.list returns 404 when the requested history id has expired. */
function isGmailHistoryCursorExpired(error: unknown): boolean {
  const status = typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : null;
  if (status === 404) return true;
  const text = errorMessage(error).toLowerCase();
  return /(?:history\s*id|historyid|starthistoryid).*(?:not found|expired|too old|invalid)/.test(text)
    || /(?:not found|expired|too old).*(?:history\s*id|historyid|starthistoryid)/.test(text);
}

function contextTokenLimit(limits: ContextChannelLimits): number {
  return limits.maxContextTokens ?? limits.maxContextChars;
}

/** The runtime owns compaction prompt construction and checkpoint policy. */
async function executeEmailCompaction(
  config: EmailChannelConfig,
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
      env: process.env,
      input: prompt,
      timeoutMs: Math.min(config.codexTimeoutMs, 120000)
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

function formatEmailLedgerMessageLine(message: TaskLedgerMessage): string {
  const author = message.role === "assistant" ? "assistant" : message.authorId || message.role;
  return `- seq ${message.seq} ${author}: ${message.text.trim() || "[empty]"}`;
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 20))}\n[truncated]`;
}

function replyTargetFromMessages(messages: TaskLedgerMessage[]): { provider: string; providerMessageId: string | null } {
  for (const message of [...messages].reverse()) {
    const metadata = message.metadata;
    const provider = stringField(metadata.provider) || "gmail";
    const providerMessage = stringField(metadata.providerMessageId) || stringField(metadata.id);
    if (providerMessage) return { provider, providerMessageId: providerMessage };
  }
  return { provider: "gmail", providerMessageId: null };
}

function emailDeliveryPayload(payload: JsonObject, deliveryId: string): {
  provider: string;
  providerMessageId: string;
  body: string;
  subject: string | null;
  mode: EmailOutboundMode;
  fromAddress: string | null;
} {
  const provider = stringField(payload.provider) || "gmail";
  const providerMessageId = stringField(payload.providerMessageId);
  const body = typeof payload.body === "string" ? payload.body : null;
  const mode = payload.mode === "draft" || payload.mode === "send" || payload.mode === "disabled" ? payload.mode : null;
  if (!providerMessageId || body == null || !mode) throw new Error(`invalid email delivery payload ${deliveryId}`);
  return {
    provider,
    providerMessageId,
    body,
    subject: stringField(payload.subject),
    mode,
    fromAddress: stringField(payload.fromAddress)
  };
}

function stringField(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function jsonObjectOrWrapped(value: unknown): JsonObject {
  return isJsonObject(value) ? value : { value: JSON.stringify(value) };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function replyDecisionFromUnknown(value: unknown): EmailReplyDecision {
  if (!isRuntimeRecord(value)) throw new Error("reply decision must be an object");
  return {
    shouldReply: value.should_reply === true || value.shouldReply === true,
    reason: stringField(value.reason) || "",
    subject: stringField(value.subject),
    body: stringField(value.body) || ""
  };
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

function outboundModeEnv(value: string): EmailOutboundMode {
  if (value === "send" || value === "draft" || value === "disabled") return value;
  return "draft";
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed : null;
}

function emailProviderInstructions(): string[] {
  // The harness home is the account this channel runs as, so the dev harness
  // never tells the model to drive production's task ledger.
  const home = process.env.HOME ?? os.homedir();
  return [
    "you are Fluffles replying from fluffles@puffle.ai.",
    "decide whether this email conversation should receive a concise response.",
    "skip newsletters, sales, spam, automated mail, vague FYI mail, and anything that would require facts you do not have.",
    "if it should be answered, write a short email reply in plain text.",
    "do not invent commitments, prices, legal claims, deadlines, or product details.",
    `when the user asks for a one-time reminder, create it with ${home}/bin/task-control reminder-create using the conversationKey below, an explicit future UTC scheduled-for timestamp, and an IANA display timezone before replying.`,
    `for meaningful multi-step work, keep the durable task registry current: run ${home}/bin/task-control task-list --channel email --conversation-key <conversationKey below> first and resume any unfinished task from its next_action; otherwise create one with task-create --objective <objective>, update it at checkpoints with task-update --id <task-id> --progress/--next-action, and finish it with task-update --id <task-id> --status completed --result <result> (or --status failed --result <reason>).`,
    "return only json matching the schema."
  ];
}

function emailAddressList(value: string): string[] {
  return value.split(",").map((address) => address.trim().toLowerCase()).filter(Boolean);
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
  channel: "email",
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

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
