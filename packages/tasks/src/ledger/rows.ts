export {
  optionalPersistentTaskRowFromSql,
  persistentTaskFromRow,
  type PersistentTaskRow
} from "@fluffles/task-registry";
export {
  cloneRepairTask,
  optionalRepairTaskRowFromSql,
  repairTaskFromRow,
  repairTaskRowFromSql,
  type RepairTaskRow
} from "@fluffles/repair-ledger";

export function isTerminalPersistentTaskStatus(status: PersistentTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
import type { PersistentTaskStatus } from "@fluffles/task-registry";
import { cloneJsonObject, isJsonObject, jsonString, nullableNumberField, nullableStringField, parseJson, parseJsonObject, parseJsonObjectOrNull, requireNonEmptyText, requireNonNegativeSafeInteger, requirePositiveSafeInteger, requireRuntimeRecord, requiredEnumField, requiredNumberField, requiredStringField, runtimeRecordArray, type RuntimeRecord } from "@fluffles/storage";
export { cloneJsonObject, isJsonObject, jsonString, nullableNumberField, nullableStringField, parseJson, parseJsonObject, parseJsonObjectOrNull, requireNonEmptyText, requireNonNegativeSafeInteger, requirePositiveSafeInteger, requireRuntimeRecord, requiredEnumField, requiredNumberField, requiredStringField, runtimeRecordArray };
export { cloneConversation, cloneLifecycleEvent, cloneMessage, cloneOutboundDelivery, cloneRun, communicationChannelValues, conversationRowFromSql, conversationStopRequested, isCommunicationChannel, isControlOutboundDelivery, lifecycleEventFromRow, lifecycleEventRowFromSql, mergeMigratedConversationMetadata, messageFromRow, messageRowFromSql, optionalConversationRowFromSql, optionalCountRowFromSql, optionalMessageRowFromSql, optionalOutboundDeliveryRowFromSql, optionalRunRowFromSql, outboundDeliveryAssistantMessageFromJson, outboundDeliveryAssistantMessageJson, outboundDeliveryFromRow, outboundDeliveryRowFromSql, requireCommunicationChannel, runFromRow, runRowFromSql, stopRequestedReason, withStopRequested, type ConversationRow } from "@fluffles/conversations";
import { communicationChannelValues, taskChannelValues, taskConversationStatusValues } from "@fluffles/conversations";
import { CodexSession, CommunicationChannel, DeploymentLifecycleState, JsonObject, JsonValue, LifecycleEvent, LifecycleEventKind, MessageRole, OutboundDelivery, OutboundDeliveryAssistantMessage, OutboundDeliveryStatus, TaskChannel, TaskConversationStatus, TaskLedgerConversation, TaskLedgerMessage, TaskLedgerRun, TaskRunStatus } from "./types";


interface CodexSessionRow {
  channel: CommunicationChannel;
  conversationKey: string;
  codexSessionId: string;
  createdAt: string;
  updatedAt: string;
}


interface SnapshotRow { status: TaskConversationStatus; count: number; }
interface ChannelSnapshotRow { channel: TaskChannel; count: number; }
interface OldestQueuedRow { oldestQueuedAt: string | null; }
export interface DeploymentLifecycleRow { state: DeploymentLifecycleState; updatedAt: string; }
export interface ActiveSubagentRunRow { id: string; name: string; startedAt: string; leaseExpiresAt: string; }

export const deploymentLifecycleStates: readonly DeploymentLifecycleState[] = ["normal", "draining", "deploying", "restarting"];

export function optionalCodexSessionRowFromSql(value: unknown, context: string): CodexSessionRow | null {
  if (value == null) return null;
  return codexSessionRowFromSql(value, context);
}
function codexSessionRowFromSql(value: unknown, context: string): CodexSessionRow {
  const row = requireRuntimeRecord(value, context);
  return {
    channel: requiredEnumField(row, "channel", communicationChannelValues, context),
    conversationKey: requiredStringField(row, "conversationKey", context),
    codexSessionId: requiredStringField(row, "codexSessionId", context),
    createdAt: requiredStringField(row, "createdAt", context),
    updatedAt: requiredStringField(row, "updatedAt", context)
  };
}
export function snapshotRowFromSql(value: unknown, context: string): SnapshotRow {
  const row = requireRuntimeRecord(value, context);
  return { status: requiredEnumField(row, "status", taskConversationStatusValues, context), count: requiredNumberField(row, "count", context) };
}
export function channelSnapshotRowFromSql(value: unknown, context: string): ChannelSnapshotRow {
  const row = requireRuntimeRecord(value, context);
  return { channel: requiredEnumField(row, "channel", taskChannelValues, context), count: requiredNumberField(row, "count", context) };
}
export function oldestQueuedRowFromSql(value: unknown, context: string): OldestQueuedRow | undefined {
  if (value == null) return undefined;
  const row = requireRuntimeRecord(value, context);
  return { oldestQueuedAt: nullableStringField(row, "oldestQueuedAt", context) };
}
export function codexSessionFromRow(row: CodexSessionRow): CodexSession {
  return { ...row };
}
export function cloneCodexSession(session: CodexSession): CodexSession {
  return { ...session };
}
