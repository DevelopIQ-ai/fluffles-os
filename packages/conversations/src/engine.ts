import type {
  ConversationContext,
  ConversationEngineLedger,
  TaskChannel,
  TaskLedgerAssistantMessageInput,
  TaskLedgerConversation,
  TaskLedgerFinishRunResult,
  TaskLedgerMessage,
  TaskLedgerMessageInput,
  TaskLedgerAdmission,
  TaskLedgerRecoveryResult,
  TaskLedgerSnapshot,
  TaskLedgerStartedRun,
  CommunicationChannel,
  CreateOutboundDeliveryInput,
  CreateControlOutboundDeliveryInput,
  ConfirmOutboundDeliveryInput,
  ConfirmOutboundDeliveryResult,
  JsonObject,
  OutboundDelivery,
  TaskMessageDisposition,
  TaskRunStatus,
  CodexSession,
  DeploymentAdmission,
  LifecycleEvent,
  ConversationRunLease,
  ConversationRunLeaseInput,
} from "./types";

/** Whether a message arrived through a direct request channel (DM, @mention, thread reply)
 *  or an ambient channel where all messages are treated as potential requests. */
export type IntakeMode = "direct" | "ambient";

/**
 * What the engine determined should happen after a message was recorded.
 *
 * - start_run:  conversation is idle; caller should begin a run.
 * - steer:      an active run is in progress; the new message is queued and
 *               will be consumed at the next safe run boundary.
 * - restart:    the previous run was failed, stopped, or interrupted;
 *               the engine has re-queued the conversation.
 * - none:       no further action (duplicate, or filtered by the channel).
 */
export type ConversationAction =
  | { type: "start_run" }
  | { type: "steer" }
  | { type: "restart"; previousRunStatus: TaskRunStatus }
  | { type: "none"; reason: "duplicate" | "filtered" };

export interface ConversationEngineIngestInput extends TaskLedgerMessageInput {
  intakeMode: IntakeMode;
}

/** Provider facts supplied before admission. The engine owns their lifecycle effect. */
export interface ConversationAdmission {
  actionable: boolean;
  reason?: string | null;
  /** Provider-normalized user content used only for shared control commands. */
  controlText?: string | null;
}

export interface ConversationEngineIngestResult {
  conversation: TaskLedgerConversation;
  message: TaskLedgerMessage;
  disposition: TaskMessageDisposition;
  action: ConversationAction;
}

export interface ConversationEngineOptions<L extends ConversationEngineLedger = ConversationEngineLedger> {
  ledger: L;
}

/**
 * Serializes the irreversible provider-call boundary with a terminal stop in
 * this bridge process. SQLite remains the cross-worker durable authority.
 */
class KeyedAsyncGate {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

const deliveryDispatchGate = new KeyedAsyncGate();

export class ConversationEngine<L extends ConversationEngineLedger = ConversationEngineLedger> {
  protected readonly ledger: L;

  constructor(options: ConversationEngineOptions<L>) {
    this.ledger = options.ledger;
  }

  /** Record an incoming message and decide what should happen next. */
  async ingest(input: ConversationEngineIngestInput): Promise<ConversationEngineIngestResult> {
    const { intakeMode, ...ledgerInput } = input;
    const result = await this.ledger.recordMessage({
      ...ledgerInput,
      metadata: { ...(ledgerInput.metadata ?? {}), intakeMode }
    });
    const action = computeAction(result.disposition, result.conversation);
    return { conversation: result.conversation, message: result.message, disposition: result.disposition, action };
  }

  /** Persist assistant output into the conversation history. */
  async recordAssistantMessage(input: TaskLedgerAssistantMessageInput): Promise<TaskLedgerMessage | null> {
    return this.ledger.recordAssistantMessage(input);
  }

  async createOutboundDelivery(input: CreateOutboundDeliveryInput): Promise<OutboundDelivery> {
    return this.ledger.createOutboundDelivery(input);
  }

  async createControlOutboundDelivery(input: CreateControlOutboundDeliveryInput): Promise<OutboundDelivery> {
    return this.ledger.createControlOutboundDelivery(input);
  }

  async pendingOutboundDelivery(channel: CommunicationChannel, conversationKey: string): Promise<OutboundDelivery | null> {
    return this.ledger.pendingOutboundDelivery(channel, conversationKey);
  }

  async recoverableOutboundDelivery(channel: CommunicationChannel, conversationKey: string): Promise<OutboundDelivery | null> {
    return this.ledger.recoverableOutboundDelivery(channel, conversationKey);
  }

  async outboundDeliveries(channel: CommunicationChannel, conversationKey: string): Promise<OutboundDelivery[]> {
    return this.ledger.outboundDeliveries(channel, conversationKey);
  }

  async recoverableControlOutboundDeliveries(channel: CommunicationChannel): Promise<OutboundDelivery[]> {
    return this.ledger.recoverableControlOutboundDeliveries(channel);
  }

  async startOutboundDeliveryAttempt(deliveryId: string): Promise<OutboundDelivery> {
    return this.ledger.startOutboundDeliveryAttempt(deliveryId);
  }

  /**
   * Atomically persist an inbound message with its runnable disposition. Stop
   * commands are interpreted here so no channel can race admission against a
   * later lifecycle mutation.
   */
  async admit(input: ConversationEngineIngestInput, facts: ConversationAdmission): Promise<ConversationEngineIngestResult> {
    const { intakeMode, ...ledgerInput } = input;
    const stop = facts.actionable && isStopCommand(facts.controlText ?? ledgerInput.text);
    const admit = () => this.ledger.admitMessage({
      ...ledgerInput,
      metadata: { ...(ledgerInput.metadata ?? {}), intakeMode }
    }, {
      actionable: facts.actionable && !stop,
      reason: stop ? "user_stop" : facts.reason ?? null,
      stop
    });
    const result = stop && isCommunicationChannel(ledgerInput.channel)
      ? await this.withDeliveryDispatchGate(ledgerInput.channel, ledgerInput.conversationKey, admit)
      : await admit();
    const action: ConversationAction = result.disposition === "duplicate" || !facts.actionable || stop
      ? { type: "none", reason: result.disposition === "duplicate" ? "duplicate" : "filtered" }
      : computeAction(result.disposition, result.conversation);
    return { conversation: result.conversation, message: result.message, disposition: result.disposition, action };
  }

  async beginOutboundDeliveryDispatch(deliveryId: string, runId: string, lease?: ConversationRunLease): Promise<OutboundDelivery> {
    return this.ledger.beginOutboundDeliveryDispatch(deliveryId, runId, lease);
  }

  async assertOutboundDeliveryDispatchable(deliveryId: string, runId: string, lease?: ConversationRunLease): Promise<OutboundDelivery> {
    return this.ledger.assertOutboundDeliveryDispatchable(deliveryId, runId, lease);
  }

  async markOutboundDeliveryProviderAccepted(
    deliveryId: string,
    runId: string,
    providerReceipt: JsonObject,
    lease?: ConversationRunLease
  ): Promise<OutboundDelivery> {
    return this.ledger.markOutboundDeliveryProviderAccepted(deliveryId, runId, providerReceipt, lease);
  }

  /** Persist an ambiguous provider outcome before reconciliation or retry policy runs. */
  async markOutboundDeliveryAcceptanceUnknown(deliveryId: string, error: string): Promise<OutboundDelivery> {
    return this.ledger.markOutboundDeliveryAcceptanceUnknown(deliveryId, error);
  }

  /** Fence a provider send with the terminal stop transition for this conversation. */
  async withDeliveryDispatchGate<T>(
    channel: CommunicationChannel,
    conversationKey: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return deliveryDispatchGate.run(`${channel}:${conversationKey}`, operation);
  }

  async releaseOutboundDeliveryDispatch(deliveryId: string): Promise<OutboundDelivery> {
    return this.ledger.releaseOutboundDeliveryDispatch(deliveryId);
  }

  async confirmOutboundDelivery(input: ConfirmOutboundDeliveryInput): Promise<ConfirmOutboundDeliveryResult> {
    return this.ledger.confirmOutboundDelivery(input);
  }

  async failOutboundDelivery(deliveryId: string, error: string): Promise<OutboundDelivery> {
    return this.ledger.failOutboundDelivery(deliveryId, error);
  }

  /** Mark messages so they remain in history but cannot start or steer a run. */
  async markMessagesNonActionable(
    channel: TaskChannel,
    conversationKey: string,
    messageIds: string[]
  ): Promise<TaskLedgerConversation | null> {
    return this.ledger.markMessagesNonActionable(channel, conversationKey, messageIds);
  }

  /** Claim the next batch of pending messages and open a run.
   *  Returns null when there is nothing to process. */
  async startRun(
    channel: TaskChannel,
    conversationKey: string,
    lease?: ConversationRunLeaseInput
  ): Promise<TaskLedgerStartedRun | null> {
    return this.ledger.startRun(channel, conversationKey, lease);
  }

  async heartbeatRunLease(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    lease: ConversationRunLease,
    leaseDurationMs: number
  ): Promise<ConversationRunLease | null> {
    return this.ledger.heartbeatRunLease(channel, conversationKey, runId, lease, leaseDurationMs);
  }

  async assertRunLease(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    lease: ConversationRunLease
  ): Promise<ConversationRunLease> {
    return this.ledger.assertRunLease(channel, conversationKey, runId, lease);
  }

  /** Claim pending user messages into the active run at a channel-defined safe boundary. */
  async claimSteeringMessages(
    channel: TaskChannel,
    conversationKey: string,
    runId: string
  ): Promise<TaskLedgerMessage[]> {
    return this.ledger.claimSteeringMessages(channel, conversationKey, runId);
  }

  /** Record a run outcome and advance the conversation's state. */
  async finishRun(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    status: Exclude<TaskRunStatus, "running">,
    error?: string | null
  ): Promise<TaskLedgerFinishRunResult | null> {
    return this.ledger.finishRun(channel, conversationKey, runId, status, error);
  }

  /** Mark any in-flight runs as interrupted and re-queue their conversations.
   *  Called at bridge startup and periodically afterwards. A run leased by
   *  `workerInstanceId` (this worker) is always reclaimable: the caller cannot
   *  be running that work, so a restart inside the lease window recovers it
   *  immediately instead of stranding it until the lease expires. */
  async recover(channel: TaskChannel, workerInstanceId?: string): Promise<TaskLedgerRecoveryResult> {
    return this.ledger.recoverInterruptedRuns(channel, workerInstanceId);
  }

  /** Durable deployment admission state shared with the embedder's deployer. */
  async deploymentLifecycle(): Promise<DeploymentAdmission> {
    return this.ledger.deploymentLifecycle();
  }

  /** Checkpoint the active run at a safe turn boundary so it resumes after a deployment. */
  async checkpointRun(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    reason?: string
  ): Promise<TaskLedgerConversation | null> {
    return this.ledger.checkpointRun(channel, conversationKey, runId, reason);
  }

  /** Cancel active and pending work. The conversation and its history are preserved. */
  async stop(
    channel: TaskChannel,
    conversationKey: string,
    reason?: string
  ): Promise<TaskLedgerConversation | null> {
    if (!isCommunicationChannel(channel)) return this.ledger.stopConversation(channel, conversationKey, reason ?? null);
    return this.withDeliveryDispatchGate(channel, conversationKey, () => this.ledger.stopConversation(channel, conversationKey, reason ?? null));
  }

  /** Conversations with pending messages and no active run. */
  async runnableConversations(channel: TaskChannel): Promise<TaskLedgerConversation[]> {
    return this.ledger.runnableConversations(channel);
  }

  async getConversation(channel: TaskChannel, conversationKey: string): Promise<TaskLedgerConversation | null> {
    return this.ledger.getConversation(channel, conversationKey);
  }

  async conversations(channel: TaskChannel): Promise<TaskLedgerConversation[]> {
    return this.ledger.conversations(channel);
  }

  /** Move a non-running legacy conversation into its canonical key without rewriting its history. */
  async migrateConversationKey(
    channel: TaskChannel,
    legacyKey: string,
    canonicalKey: string
  ): Promise<TaskLedgerConversation | null> {
    return this.ledger.migrateConversationKey(channel, legacyKey, canonicalKey);
  }

  /** Durable Codex-thread ownership for every supported conversation channel. */
  async getCodexSession(channel: CommunicationChannel, conversationKey: string): Promise<CodexSession | null> {
    return this.ledger.getCodexSession(channel, conversationKey);
  }

  async saveCodexSession(
    channel: CommunicationChannel,
    conversationKey: string,
    codexSessionId: string
  ): Promise<CodexSession> {
    return this.ledger.saveCodexSession(channel, conversationKey, codexSessionId);
  }

  async clearCodexSession(channel: CommunicationChannel, conversationKey: string): Promise<void> {
    return this.ledger.clearCodexSession(channel, conversationKey);
  }

  /** Advance the context checkpoint. Throws if upToSeq exceeds the last completed run's lastConsumedSeq. */
  async compact(
    channel: TaskChannel,
    conversationKey: string,
    summary: string,
    upToSeq: number
  ): Promise<TaskLedgerConversation | null> {
    return this.ledger.compact(channel, conversationKey, summary, upToSeq);
  }

  /** Return checkpoint context, retained recent user messages, and messages after it, ordered by seq. */
  async buildContext(channel: TaskChannel, conversationKey: string): Promise<ConversationContext | null> {
    return this.ledger.buildContext(channel, conversationKey);
  }

  async lifecycleEvents(channel: TaskChannel, conversationKey: string): Promise<LifecycleEvent[]> {
    return this.ledger.lifecycleEvents(channel, conversationKey);
  }

  async snapshot(channel?: TaskChannel): Promise<TaskLedgerSnapshot> {
    return this.ledger.snapshot(channel);
  }
}

function computeAction(
  disposition: TaskMessageDisposition,
  conversation: TaskLedgerConversation
): ConversationAction {
  switch (disposition) {
    case "new_conversation":
      return { type: "start_run" };
    case "running_update":
      return { type: "steer" };
    case "duplicate":
      return { type: "none", reason: "duplicate" };
    case "queued_update": {
      const lastRun = conversation.runs.at(-1) ?? null;
      if (lastRun !== null && isUnhealthyRunStatus(lastRun.status)) {
        return { type: "restart", previousRunStatus: lastRun.status };
      }
      return { type: "start_run" };
    }
  }
}

function isUnhealthyRunStatus(status: TaskRunStatus): boolean {
  return status === "failed" || status === "stopped" || status === "interrupted";
}

function isCommunicationChannel(channel: TaskChannel): channel is CommunicationChannel {
  return channel === "slack" || channel === "email" || channel === "phone";
}

/** One shared terminal control policy for every direct conversation channel. */
function isStopCommand(text: string): boolean {
  return /^(stop|cancel|abort)\s*$/i.test(text.trim());
}
