import {
  cloneJsonObject,
  isJsonObject,
  nullableNumberField,
  nullableStringField,
  parseJsonObject,
  requireNonEmptyText,
  requireRuntimeRecord,
  requiredEnumField,
  requiredNumberField,
  requiredStringField,
  type JsonObject,
  type RuntimeRecord
} from "@fluffles/storage";
import {
  CommunicationChannel,
  LifecycleEvent,
  LifecycleEventKind,
  MessageRole,
  OutboundDelivery,
  OutboundDeliveryAssistantMessage,
  OutboundDeliveryStatus,
  TaskChannel,
  TaskConversationStatus,
  TaskLedgerConversation,
  TaskLedgerMessage,
  TaskLedgerRun,
  TaskRunStatus
} from "./types";

export interface ConversationRow {
  id: string;
  channel: TaskChannel;
  conversationKey: string;
  title: string | null;
  status: TaskConversationStatus;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  replyTargetJson: string;
  metadataJson: string;
  activeRunId: string | null;
  compactionSeq: number | null;
  compactionSummary: string | null;
}

export interface MessageRow {
  id: string;
  seq: number;
  role: MessageRole;
  externalMessageId: string | null;
  authorId: string | null;
  text: string;
  receivedAt: string;
  runId: string | null;
  metadataJson: string;
}

export interface RunRow {
  id: string;
  status: TaskRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  lastConsumedSeq: number | null;
  workerInstanceId: string | null;
  leaseExpiresAt: string | null;
}

export interface LifecycleEventRow {
  id: string;
  channel: TaskChannel;
  conversationKey: string;
  runId: string | null;
  kind: LifecycleEventKind;
  reason: string | null;
  metadataJson: string;
  occurredAt: string;
}

export interface OutboundDeliveryRow {
  id: string;
  channel: CommunicationChannel;
  conversationKey: string;
  runId: string;
  provider: string;
  idempotencyKey: string;
  status: OutboundDeliveryStatus;
  payloadJson: string;
  assistantMessageJson: string;
  providerReceiptJson: string | null;
  error: string | null;
  attemptCount: number;
  attemptedAt: string;
  acceptanceUnknownAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CountRow { count: number; }

export const taskChannelValues: readonly TaskChannel[] = ["slack", "email", "phone", "web", "manual", "cron", "watchdog", "subagent"];
export const communicationChannelValues: readonly CommunicationChannel[] = ["slack", "email", "phone", "web"];
export const taskConversationStatusValues: readonly TaskConversationStatus[] = ["queued", "running", "done", "failed", "stopped"];
const taskRunStatusValues: readonly TaskRunStatus[] = ["running", "done", "failed", "stopped", "interrupted"];
const outboundDeliveryStatusValues: readonly OutboundDeliveryStatus[] = ["pending", "dispatching", "acceptance_unknown", "provider_accepted", "delivered", "failed", "cancelled"];
const lifecycleEventKindValues: readonly LifecycleEventKind[] = [
  "admitted", "duplicate", "steering_received", "run_started", "steering_claimed", "compacted",
  "checkpointed", "stopped", "cancelled", "completed", "failed", "recovered",
  "delivery_intended", "delivery_dispatched", "delivery_acceptance_unknown", "provider_accepted", "delivery_confirmed", "delivery_failed"
];
const messageRoleValues: readonly MessageRole[] = ["user", "assistant", "system"];

export function outboundDeliveryAssistantMessageFromJson(
  text: string,
  deliveryId: string
): OutboundDeliveryAssistantMessage {
  const context = `assistant message for outbound delivery ${deliveryId}`;
  const value = parseJsonObject(text, context);
  const record = value as RuntimeRecord;
  const metadata = value.metadata;
  if (metadata !== undefined && !isJsonObject(metadata)) {
    throw new Error(`${context}.metadata must be a JSON object`);
  }
  return {
    text: requireNonEmptyText(requiredStringField(record, "text", context), `${context}.text`),
    ...(Object.hasOwn(value, "externalMessageId")
      ? { externalMessageId: nullableStringField(record, "externalMessageId", context) }
      : {}),
    ...(Object.hasOwn(value, "authorId")
      ? { authorId: nullableStringField(record, "authorId", context) }
      : {}),
    ...(Object.hasOwn(value, "receivedAt")
      ? { receivedAt: requiredStringField(record, "receivedAt", context) }
      : {}),
    ...(metadata !== undefined ? { metadata } : {})
  };
}
export function requireCommunicationChannel(value: CommunicationChannel, field: string): CommunicationChannel {
  if (!(communicationChannelValues as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of: ${communicationChannelValues.join(", ")}`);
  }
  return value;
}
export function optionalConversationRowFromSql(value: unknown, context: string): ConversationRow | null {
  if (value == null) return null;
  return conversationRowFromSql(value, context);
}
export function conversationRowFromSql(value: unknown, context: string): ConversationRow {
  const row = requireRuntimeRecord(value, context);
  return {
    id: requiredStringField(row, "id", context),
    channel: requiredEnumField(row, "channel", taskChannelValues, context),
    conversationKey: requiredStringField(row, "conversationKey", context),
    title: nullableStringField(row, "title", context),
    status: requiredEnumField(row, "status", taskConversationStatusValues, context),
    createdAt: requiredStringField(row, "createdAt", context),
    updatedAt: requiredStringField(row, "updatedAt", context),
    lastError: nullableStringField(row, "lastError", context),
    replyTargetJson: requiredStringField(row, "replyTargetJson", context),
    metadataJson: requiredStringField(row, "metadataJson", context),
    activeRunId: nullableStringField(row, "activeRunId", context),
    compactionSeq: nullableNumberField(row, "compactionSeq", context),
    compactionSummary: nullableStringField(row, "compactionSummary", context)
  };
}
export function optionalMessageRowFromSql(value: unknown, context: string): MessageRow | null {
  if (value == null) return null;
  return messageRowFromSql(value, context);
}
export function messageRowFromSql(value: unknown, context: string): MessageRow {
  const row = requireRuntimeRecord(value, context);
  return {
    id: requiredStringField(row, "id", context),
    seq: requiredNumberField(row, "seq", context),
    role: requiredEnumField(row, "role", messageRoleValues, context),
    externalMessageId: nullableStringField(row, "externalMessageId", context),
    authorId: nullableStringField(row, "authorId", context),
    text: requiredStringField(row, "text", context),
    receivedAt: requiredStringField(row, "receivedAt", context),
    runId: nullableStringField(row, "runId", context),
    metadataJson: requiredStringField(row, "metadataJson", context)
  };
}
export function runRowFromSql(value: unknown, context: string): RunRow {
  const row = requireRuntimeRecord(value, context);
  return {
    id: requiredStringField(row, "id", context),
    status: requiredEnumField(row, "status", taskRunStatusValues, context),
    startedAt: requiredStringField(row, "startedAt", context),
    finishedAt: nullableStringField(row, "finishedAt", context),
    error: nullableStringField(row, "error", context),
    lastConsumedSeq: nullableNumberField(row, "lastConsumedSeq", context),
    workerInstanceId: nullableStringField(row, "workerInstanceId", context),
    leaseExpiresAt: nullableStringField(row, "leaseExpiresAt", context)
  };
}
export function optionalRunRowFromSql(value: unknown, context: string): RunRow | null {
  if (value == null) return null;
  return runRowFromSql(value, context);
}
export function optionalOutboundDeliveryRowFromSql(value: unknown, context: string): OutboundDeliveryRow | null {
  if (value == null) return null;
  return outboundDeliveryRowFromSql(value, context);
}
export function outboundDeliveryRowFromSql(value: unknown, context: string): OutboundDeliveryRow {
  const row = requireRuntimeRecord(value, context);
  return {
    id: requiredStringField(row, "id", context),
    channel: requiredEnumField(row, "channel", communicationChannelValues, context),
    conversationKey: requiredStringField(row, "conversationKey", context),
    runId: requiredStringField(row, "runId", context),
    provider: requiredStringField(row, "provider", context),
    idempotencyKey: requiredStringField(row, "idempotencyKey", context),
    status: requiredEnumField(row, "status", outboundDeliveryStatusValues, context),
    payloadJson: requiredStringField(row, "payloadJson", context),
    assistantMessageJson: requiredStringField(row, "assistantMessageJson", context),
    providerReceiptJson: nullableStringField(row, "providerReceiptJson", context),
    error: nullableStringField(row, "error", context),
    attemptCount: requiredNumberField(row, "attemptCount", context),
    attemptedAt: requiredStringField(row, "attemptedAt", context),
    acceptanceUnknownAt: nullableStringField(row, "acceptanceUnknownAt", context),
    deliveredAt: nullableStringField(row, "deliveredAt", context),
    createdAt: requiredStringField(row, "createdAt", context),
    updatedAt: requiredStringField(row, "updatedAt", context)
  };
}
export function optionalCountRowFromSql(value: unknown, context: string): CountRow | undefined {
  if (value == null) return undefined;
  const row = requireRuntimeRecord(value, context);
  return { count: requiredNumberField(row, "count", context) };
}
export function lifecycleEventRowFromSql(value: unknown, context: string): LifecycleEventRow {
  const row = requireRuntimeRecord(value, context);
  return {
    id: requiredStringField(row, "id", context),
    channel: requiredEnumField(row, "channel", taskChannelValues, context),
    conversationKey: requiredStringField(row, "conversationKey", context),
    runId: nullableStringField(row, "runId", context),
    kind: requiredEnumField(row, "kind", lifecycleEventKindValues, context),
    reason: nullableStringField(row, "reason", context),
    metadataJson: requiredStringField(row, "metadataJson", context),
    occurredAt: requiredStringField(row, "occurredAt", context)
  };
}
export function messageFromRow(row: MessageRow): TaskLedgerMessage {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    externalMessageId: row.externalMessageId,
    authorId: row.authorId,
    text: row.text,
    receivedAt: row.receivedAt,
    runId: row.runId,
    metadata: parseJsonObject(row.metadataJson, `metadata for message ${row.id}`)
  };
}
export function runFromRow(row: RunRow, messages: MessageRow[]): TaskLedgerRun {
  return {
    id: row.id,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    error: row.error,
    lastConsumedSeq: row.lastConsumedSeq,
    workerInstanceId: row.workerInstanceId,
    leaseExpiresAt: row.leaseExpiresAt,
    messageIds: messages.filter((message) => message.runId === row.id).map((message) => message.id)
  };
}
export function outboundDeliveryFromRow(row: OutboundDeliveryRow): OutboundDelivery {
  return {
    id: row.id,
    channel: row.channel,
    conversationKey: row.conversationKey,
    runId: row.runId,
    provider: row.provider,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    payload: parseJsonObject(row.payloadJson, `payload for outbound delivery ${row.id}`),
    assistantMessage: outboundDeliveryAssistantMessageFromJson(row.assistantMessageJson, row.id),
    providerReceipt: row.providerReceiptJson
      ? parseJsonObject(row.providerReceiptJson, `provider receipt for outbound delivery ${row.id}`)
      : null,
    error: row.error,
    attemptCount: row.attemptCount,
    attemptedAt: row.attemptedAt,
    acceptanceUnknownAt: row.acceptanceUnknownAt,
    deliveredAt: row.deliveredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
export function isControlOutboundDelivery(delivery: OutboundDelivery): boolean {
  return delivery.payload.__runtimeControlDelivery === true;
}
export function lifecycleEventFromRow(row: LifecycleEventRow): LifecycleEvent {
  return {
    id: row.id,
    channel: row.channel,
    conversationKey: row.conversationKey,
    runId: row.runId,
    kind: row.kind,
    reason: row.reason,
    metadata: parseJsonObject(row.metadataJson, `metadata for lifecycle event ${row.id}`),
    occurredAt: row.occurredAt
  };
}
export function cloneConversation(conversation: TaskLedgerConversation): TaskLedgerConversation {
  return {
    ...conversation,
    replyTarget: conversation.replyTarget ? cloneJsonObject(conversation.replyTarget) : null,
    metadata: cloneJsonObject(conversation.metadata),
    messages: conversation.messages.map(cloneMessage),
    runs: conversation.runs.map(cloneRun)
  };
}
export function cloneMessage(message: TaskLedgerMessage): TaskLedgerMessage {
  return { ...message, metadata: cloneJsonObject(message.metadata) };
}
export function cloneRun(run: TaskLedgerRun): TaskLedgerRun {
  return { ...run, messageIds: [...run.messageIds] };
}
export function cloneOutboundDelivery(delivery: OutboundDelivery): OutboundDelivery {
  return {
    ...delivery,
    payload: cloneJsonObject(delivery.payload),
    assistantMessage: cloneOutboundDeliveryAssistantMessage(delivery.assistantMessage),
    providerReceipt: delivery.providerReceipt ? cloneJsonObject(delivery.providerReceipt) : null
  };
}
function cloneOutboundDeliveryAssistantMessage(
  assistantMessage: OutboundDeliveryAssistantMessage
): OutboundDeliveryAssistantMessage {
  const cloned: OutboundDeliveryAssistantMessage = { ...assistantMessage };
  if (assistantMessage.metadata !== undefined) cloned.metadata = cloneJsonObject(assistantMessage.metadata);
  return cloned;
}
export function outboundDeliveryAssistantMessageJson(
  assistantMessage: OutboundDeliveryAssistantMessage
): JsonObject {
  const value: JsonObject = { text: assistantMessage.text };
  if (assistantMessage.externalMessageId !== undefined) value.externalMessageId = assistantMessage.externalMessageId;
  if (assistantMessage.authorId !== undefined) value.authorId = assistantMessage.authorId;
  if (assistantMessage.receivedAt !== undefined) value.receivedAt = assistantMessage.receivedAt;
  if (assistantMessage.metadata !== undefined) value.metadata = cloneJsonObject(assistantMessage.metadata);
  return value;
}
export function cloneLifecycleEvent(event: LifecycleEvent): LifecycleEvent {
  return { ...event, metadata: cloneJsonObject(event.metadata) };
}
export function mergeMigratedConversationMetadata(
  canonicalMetadata: JsonObject,
  legacy: TaskLedgerConversation
): JsonObject {
  const checkpoints = Array.isArray(canonicalMetadata.migratedCheckpoints)
    ? [...canonicalMetadata.migratedCheckpoints]
    : [];
  if (legacy.compactionSummary != null) {
    checkpoints.push({
      conversationKey: legacy.conversationKey,
      seq: legacy.compactionSeq,
      summary: legacy.compactionSummary
    });
  }
  return checkpoints.length === 0
    ? canonicalMetadata
    : { ...canonicalMetadata, migratedCheckpoints: checkpoints };
}
export function isCommunicationChannel(channel: TaskChannel): channel is CommunicationChannel {
  return (communicationChannelValues as readonly string[]).includes(channel);
}

/** Internal durable cancellation intent used to fence cross-process dispatch. */
export function conversationStopRequested(conversation: Pick<TaskLedgerConversation, "metadata">): boolean {
  return conversation.metadata.__engineStopRequested === true;
}

export function stopRequestedReason(conversation: Pick<TaskLedgerConversation, "metadata">): string | null {
  const value = conversation.metadata.__engineStopReason;
  return typeof value === "string" && value.trim() ? value : null;
}

export function withStopRequested(metadata: JsonObject, reason: string, requestedAt: string): JsonObject {
  return {
    ...metadata,
    __engineStopRequested: true,
    __engineStopReason: reason,
    __engineStopRequestedAt: requestedAt
  };
}
