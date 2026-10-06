import type { JsonObject } from "@fluffles/storage";
export type { JsonObject, JsonValue } from "@fluffles/storage";

export type TaskChannel = "slack" | "email" | "phone" | "web" | "manual" | "cron" | "watchdog" | "subagent";
export type ContextLimitChannel = "slack" | "email" | "phone" | "web";
export type CommunicationChannel = "slack" | "email" | "phone" | "web";
export type TaskConversationStatus = "queued" | "running" | "done" | "failed" | "stopped";
export type TaskRunStatus = "running" | "done" | "failed" | "stopped" | "interrupted";
/**
 * `dispatching` is only local admission to make a provider call.  It is still
 * cancellable. `acceptance_unknown` records a provider call whose external
 * effect cannot yet be disproved. `provider_accepted` is written immediately
 * after a known provider response, before local history/run confirmation.
 */
export type OutboundDeliveryStatus = "pending" | "dispatching" | "acceptance_unknown" | "provider_accepted" | "delivered" | "failed" | "cancelled";
export type TaskMessageDisposition = "new_conversation" | "queued_update" | "running_update" | "duplicate";
export type MessageRole = "user" | "assistant" | "system";
export type LifecycleEventKind =
  | "admitted"
  | "duplicate"
  | "steering_received"
  | "run_started"
  | "steering_claimed"
  | "compacted"
  | "checkpointed"
  | "stopped"
  | "cancelled"
  | "completed"
  | "failed"
  | "recovered"
  | "delivery_intended"
  | "delivery_dispatched"
  | "delivery_acceptance_unknown"
  | "provider_accepted"
  | "delivery_confirmed"
  | "delivery_failed";

// Each channel maps external threads to a canonical key string:
//   Slack:  slack:<teamId>:<channelId>:<rootTs>
//   Email:  email:<accountId>:<threadId>
//   Phone:  phone:<providerConversationId>
//   Web:    web:<chatId>
export type ConversationKeyParts =
  | { channel: "slack"; teamId: string; channelId: string; rootTs: string }
  | { channel: "email"; accountId: string; threadId: string }
  | { channel: "phone"; conversationId: string }
  | { channel: "web"; chatId: string };

export const ConversationKey = {
  forSlack(teamId: string, channelId: string, rootTs: string): string {
    return `slack:${teamId}:${channelId}:${rootTs}`;
  },
  forEmail(accountId: string, threadId: string): string {
    return `email:${accountId}:${threadId}`;
  },
  forPhone(conversationId: string): string {
    if (!conversationId.trim()) throw new Error("phone conversation id is required");
    return `phone:${conversationId}`;
  },
  forWeb(chatId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(chatId)) throw new Error("web chat id must be 1-64 url-safe characters");
    return `web:${chatId}`;
  },
  parse(key: string): ConversationKeyParts | null {
    if (key.startsWith("slack:")) {
      const body = key.slice(6);
      const p1 = body.indexOf(":");
      if (p1 <= 0) return null;
      const p2 = body.indexOf(":", p1 + 1);
      if (p2 <= p1 + 1) return null;
      const rootTs = body.slice(p2 + 1);
      if (!rootTs) return null;
      return { channel: "slack", teamId: body.slice(0, p1), channelId: body.slice(p1 + 1, p2), rootTs };
    }
    if (key.startsWith("email:")) {
      const body = key.slice(6);
      const p1 = body.indexOf(":");
      if (p1 <= 0) return null;
      const threadId = body.slice(p1 + 1);
      if (!threadId) return null;
      return { channel: "email", accountId: body.slice(0, p1), threadId };
    }
    if (key.startsWith("phone:")) {
      const conversationId = key.slice(6);
      if (!conversationId) return null;
      return { channel: "phone", conversationId };
    }
    if (key.startsWith("web:")) {
      const chatId = key.slice(4);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(chatId)) return null;
      return { channel: "web", chatId };
    }
    return null;
  }
};

export interface ContextChannelLimits {
  recentMessagesLimit: number;
  maxContextChars: number;
  /** Compaction threshold for model-visible context. Runtime enforces the final model budget. */
  maxContextTokens?: number;
  recentUserMessageTokenLimit: number;
  summaryMaxChars: number;
  openLoopsMaxChars: number;
}

export interface ContextLimitsConfig {
  path: string;
  channels: Record<ContextLimitChannel, ContextChannelLimits>;
}

export interface TaskLedgerMessageInput {
  channel: TaskChannel;
  conversationKey: string;
  externalMessageId: string | null;
  authorId: string | null;
  text: string;
  receivedAt?: string;
  title?: string;
  role?: MessageRole;
  replyTarget?: JsonObject;
  metadata?: JsonObject;
}

export interface TaskLedgerMessage {
  id: string;
  seq: number;
  role: MessageRole;
  externalMessageId: string | null;
  authorId: string | null;
  text: string;
  receivedAt: string;
  runId: string | null;
  metadata: JsonObject;
}

export interface TaskLedgerRun {
  id: string;
  status: TaskRunStatus;
  startedAt: string;
  finishedAt: string | null;
  messageIds: string[];
  error: string | null;
  lastConsumedSeq: number | null;
  /** Durable worker identity that owns the active run lease. */
  workerInstanceId?: string | null;
  /** ISO timestamp after which recovery may reclaim the run. */
  leaseExpiresAt?: string | null;
}

/**
 * The SQLite-coordinated ownership capability for one active conversation run.
 * One owner and one expiry: a run is owned while its lease is unexpired, and
 * renewing the lease is the heartbeat.
 */
export interface ConversationRunLease {
  workerInstanceId: string;
  leaseExpiresAt: string;
}

/** Input used when ConversationRuntime atomically opens a run with a lease. */
export interface ConversationRunLeaseInput {
  workerInstanceId: string;
  leaseDurationMs: number;
}

export interface TaskLedgerConversation {
  id: string;
  channel: TaskChannel;
  conversationKey: string;
  title: string | null;
  status: TaskConversationStatus;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  replyTarget: JsonObject | null;
  metadata: JsonObject;
  activeRunId: string | null;
  compactionSeq: number | null;
  compactionSummary: string | null;
  messages: TaskLedgerMessage[];
  runs: TaskLedgerRun[];
}

export interface TaskLedgerRecordMessageResult {
  conversation: TaskLedgerConversation;
  message: TaskLedgerMessage;
  disposition: TaskMessageDisposition;
}

export interface TaskLedgerStartedRun {
  conversation: TaskLedgerConversation;
  run: TaskLedgerRun;
  messages: TaskLedgerMessage[];
}

export interface TaskLedgerFinishRunResult {
  conversation: TaskLedgerConversation;
  hasPendingMessages: boolean;
}

export interface TaskLedgerRecoveryResult {
  recoveredKeys: string[];
  runnableKeys: string[];
}

export interface TaskLedgerSnapshot {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  stopped: number;
  byChannel: Partial<Record<TaskChannel, number>>;
  oldestQueuedAt: string | null;
}

export interface ConversationContext {
  summary: string | null;
  recentUserMessages: TaskLedgerMessage[];
  messages: TaskLedgerMessage[];
}

/** Engine-owned admission decision persisted with an inbound message. */
export interface TaskLedgerAdmission {
  actionable: boolean;
  reason?: string | null;
  stop?: boolean;
}

/** A deterministic, model-safe subset of the durable conversation history. */
export interface BoundedConversationContext extends ConversationContext {
  maxTokens: number;
  /** Tokens reserved by the runtime for task, resume, and deployment inputs. */
  reservedTokens: number;
  tokenCount: number;
  truncated: boolean;
}

/** Raised before model execution when the current request alone exceeds its safe context allocation. */
export class ContextBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextBudgetExceededError";
  }
}

export interface LifecycleEvent {
  id: string;
  channel: TaskChannel;
  conversationKey: string;
  runId: string | null;
  kind: LifecycleEventKind;
  reason: string | null;
  metadata: JsonObject;
  occurredAt: string;
}

export interface TaskLedgerAssistantMessageInput {
  channel: TaskChannel;
  conversationKey: string;
  text: string;
  runId?: string | null;
  externalMessageId?: string | null;
  authorId?: string | null;
  receivedAt?: string;
  metadata?: JsonObject;
}

/** A generated assistant reply that remains outside model-visible history until delivery confirms. */
export interface OutboundDeliveryAssistantMessage {
  text: string;
  externalMessageId?: string | null;
  authorId?: string | null;
  receivedAt?: string;
  metadata?: JsonObject;
}

export interface OutboundDelivery {
  id: string;
  channel: CommunicationChannel;
  conversationKey: string;
  runId: string;
  provider: string;
  idempotencyKey: string;
  status: OutboundDeliveryStatus;
  payload: JsonObject;
  assistantMessage: OutboundDeliveryAssistantMessage;
  providerReceipt: JsonObject | null;
  error: string | null;
  attemptCount: number;
  attemptedAt: string;
  acceptanceUnknownAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateOutboundDeliveryInput {
  channel: CommunicationChannel;
  conversationKey: string;
  runId: string;
  provider: string;
  idempotencyKey: string;
  payload: JsonObject;
  assistantMessage: OutboundDeliveryAssistantMessage;
}

export interface ConfirmOutboundDeliveryInput {
  deliveryId: string;
  runId: string;
  providerReceipt: JsonObject;
}

export interface ConfirmOutboundDeliveryResult {
  delivery: OutboundDelivery;
  assistantMessage: TaskLedgerMessage;
  finish: TaskLedgerFinishRunResult;
}

/** A durable, conversation-visible system reply, such as a stop acknowledgement. */
export interface CreateControlOutboundDeliveryInput {
  channel: CommunicationChannel;
  conversationKey: string;
  provider: string;
  idempotencyKey: string;
  payload: JsonObject;
  assistantMessage: OutboundDeliveryAssistantMessage;
}

/** Durable, channel-agnostic Codex session ownership for a conversation. */
export interface CodexSession {
  channel: CommunicationChannel;
  conversationKey: string;
  codexSessionId: string;
  createdAt: string;
  updatedAt: string;
}

/** Executor session continuity: the persisted model session per conversation. */
export interface ExecutorSessionLedger {
  getCodexSession(channel: CommunicationChannel, conversationKey: string): Promise<CodexSession | null>;
  saveCodexSession(channel: CommunicationChannel, conversationKey: string, codexSessionId: string): Promise<CodexSession>;
  clearCodexSession(channel: CommunicationChannel, conversationKey: string): Promise<void>;
}

/** Bridge core: chats, messages, runs, leases/recovery, and outbound deliveries. */
export interface BridgeLedger {
  recordMessage(input: TaskLedgerMessageInput): Promise<TaskLedgerRecordMessageResult>;
  /** Atomically record an inbound message with its runnable/stop disposition. */
  admitMessage(input: TaskLedgerMessageInput, admission: TaskLedgerAdmission): Promise<TaskLedgerRecordMessageResult>;
  recordAssistantMessage(input: TaskLedgerAssistantMessageInput): Promise<TaskLedgerMessage | null>;
  createOutboundDelivery(input: CreateOutboundDeliveryInput): Promise<OutboundDelivery>;
  createControlOutboundDelivery(input: CreateControlOutboundDeliveryInput): Promise<OutboundDelivery>;
  pendingOutboundDelivery(channel: CommunicationChannel, conversationKey: string): Promise<OutboundDelivery | null>;
  recoverableOutboundDelivery(channel: CommunicationChannel, conversationKey: string): Promise<OutboundDelivery | null>;
  outboundDeliveries(channel: CommunicationChannel, conversationKey: string): Promise<OutboundDelivery[]>;
  recoverableControlOutboundDeliveries(channel: CommunicationChannel): Promise<OutboundDelivery[]>;
  startOutboundDeliveryAttempt(deliveryId: string): Promise<OutboundDelivery>;
  beginOutboundDeliveryDispatch(deliveryId: string, runId: string, lease?: ConversationRunLease): Promise<OutboundDelivery>;
  assertOutboundDeliveryDispatchable(deliveryId: string, runId: string, lease?: ConversationRunLease): Promise<OutboundDelivery>;
  markOutboundDeliveryProviderAccepted(deliveryId: string, runId: string, providerReceipt: JsonObject, lease?: ConversationRunLease): Promise<OutboundDelivery>;
  markOutboundDeliveryAcceptanceUnknown(deliveryId: string, error: string): Promise<OutboundDelivery>;
  releaseOutboundDeliveryDispatch(deliveryId: string): Promise<OutboundDelivery>;
  confirmOutboundDelivery(input: ConfirmOutboundDeliveryInput): Promise<ConfirmOutboundDeliveryResult>;
  failOutboundDelivery(deliveryId: string, error: string, providerReceipt?: JsonObject | null): Promise<OutboundDelivery>;
  lifecycleEvents(channel: TaskChannel, conversationKey: string): Promise<LifecycleEvent[]>;
  startRun(channel: TaskChannel, conversationKey: string, lease?: ConversationRunLeaseInput): Promise<TaskLedgerStartedRun | null>;
  heartbeatRunLease(channel: TaskChannel, conversationKey: string, runId: string, lease: ConversationRunLease, leaseDurationMs: number): Promise<ConversationRunLease | null>;
  assertRunLease(channel: TaskChannel, conversationKey: string, runId: string, lease: ConversationRunLease): Promise<ConversationRunLease>;
  claimSteeringMessages(channel: TaskChannel, conversationKey: string, runId: string): Promise<TaskLedgerMessage[]>;
  finishRun(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    status: Exclude<TaskRunStatus, "running">,
    error?: string | null
  ): Promise<TaskLedgerFinishRunResult | null>;
  recoverInterruptedRuns(channel: TaskChannel, workerInstanceId?: string): Promise<TaskLedgerRecoveryResult>;
  checkpointRun(
    channel: TaskChannel,
    conversationKey: string,
    runId: string,
    reason?: string
  ): Promise<TaskLedgerConversation | null>;
  runnableConversations(channel: TaskChannel): Promise<TaskLedgerConversation[]>;
  /** Engine-owned terminal stop transition. */
  stopConversation(
    channel: TaskChannel,
    conversationKey: string,
    reason?: string | null
  ): Promise<TaskLedgerConversation | null>;
  /** @deprecated Compatibility stop entrypoint. Only the `stopped` transition is accepted. */
  setConversationStatus(
    channel: TaskChannel,
    conversationKey: string,
    status: TaskConversationStatus,
    error?: string | null
  ): Promise<TaskLedgerConversation | null>;
  markMessagesNonActionable(
    channel: TaskChannel,
    conversationKey: string,
    messageIds: string[]
  ): Promise<TaskLedgerConversation | null>;
  migrateConversationKey(
    channel: TaskChannel,
    legacyKey: string,
    canonicalKey: string
  ): Promise<TaskLedgerConversation | null>;
  getConversation(channel: TaskChannel, conversationKey: string): Promise<TaskLedgerConversation | null>;
  conversations(channel: TaskChannel): Promise<TaskLedgerConversation[]>;
  compact(channel: TaskChannel, conversationKey: string, summary: string, upToSeq: number): Promise<TaskLedgerConversation | null>;
  buildContext(channel: TaskChannel, conversationKey: string): Promise<ConversationContext | null>;
}

/**
 * Deployment admission state shared with the embedder's deployer. Any state
 * other than "normal" checkpoints active runs at the next safe turn boundary.
 */
export interface DeploymentAdmission {
  state: string;
}

/**
 * Everything the ConversationEngine requires of its ledger: the bridge core,
 * executor session continuity, the conversation snapshot aggregate, and the
 * deployment admission gate.
 */
export interface ConversationEngineLedger extends BridgeLedger, ExecutorSessionLedger {
  snapshot(channel?: TaskChannel): Promise<TaskLedgerSnapshot>;
  deploymentLifecycle(): Promise<DeploymentAdmission>;
}
