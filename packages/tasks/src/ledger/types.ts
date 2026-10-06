export type { JsonObject, JsonValue } from "@fluffles/storage";
import type { JsonObject } from "@fluffles/storage";
export {
  ContextBudgetExceededError,
  ConversationKey,
  type BoundedConversationContext,
  type BridgeLedger,
  type CodexSession,
  type CommunicationChannel,
  type ConfirmOutboundDeliveryInput,
  type ConfirmOutboundDeliveryResult,
  type ContextChannelLimits,
  type ContextLimitChannel,
  type ContextLimitsConfig,
  type ConversationContext,
  type ConversationKeyParts,
  type ConversationRunLease,
  type ConversationRunLeaseInput,
  type CreateControlOutboundDeliveryInput,
  type CreateOutboundDeliveryInput,
  type ExecutorSessionLedger,
  type LifecycleEvent,
  type LifecycleEventKind,
  type MessageRole,
  type OutboundDelivery,
  type OutboundDeliveryAssistantMessage,
  type OutboundDeliveryStatus,
  type TaskChannel,
  type TaskConversationStatus,
  type TaskLedgerAdmission,
  type TaskLedgerAssistantMessageInput,
  type TaskLedgerConversation,
  type TaskLedgerFinishRunResult,
  type TaskLedgerMessage,
  type TaskLedgerMessageInput,
  type TaskLedgerRecordMessageResult,
  type TaskLedgerRecoveryResult,
  type TaskLedgerRun,
  type TaskLedgerSnapshot,
  type TaskLedgerStartedRun,
  type TaskMessageDisposition,
  type TaskRunStatus
} from "@fluffles/conversations";
export {
  type AdmitDueRemindersOptions,
  type CreateScheduledReminderInput,
  type ReminderAdmission,
  type ReminderListOptions,
  type ReminderStatus,
  type ScheduledReminder,
  type SchedulerLedger
} from "@fluffles/scheduler";
export {
  type CreateConversationTaskInput,
  type PersistentTask,
  type PersistentTaskStatus,
  type TaskRegistryLedger,
  type UpdateConversationTaskInput,
  type UpdatePersistentTaskInput
} from "@fluffles/task-registry";
export {
  type RepairLedger,
  type RepairTask,
  type UpsertRepairTaskInput
} from "@fluffles/repair-ledger";
import type { TaskRegistryLedger } from "@fluffles/task-registry";
import type { RepairLedger } from "@fluffles/repair-ledger";
import type { SchedulerLedger } from "@fluffles/scheduler";
import type {
  BridgeLedger,
  CodexSession,
  CommunicationChannel,
  ConversationRunLease,
  ExecutorSessionLedger,
  TaskChannel,
  TaskLedgerConversation,
  TaskLedgerRun,
  TaskLedgerSnapshot
} from "@fluffles/conversations";


/**
 * `tasks.sqlite` is the authoritative record for run state and provider
 * acceptance. It must use WAL for concurrent readers and FULL synchronous
 * commits for crash durability. Channel transport receipt databases are not
 * authoritative and intentionally retain their own NORMAL durability policy.
 */
export { AUTHORITATIVE_LEDGER_DURABILITY } from "@fluffles/storage";
export type DeploymentLifecycleState = "normal" | "draining" | "deploying" | "restarting";





















export interface DeploymentLifecycle {
  state: DeploymentLifecycleState;
  updatedAt: string;
}

export interface ActiveSubagentRun {
  id: string;
  name: string;
  startedAt: string;
  leaseExpiresAt: string;
}







/** Control plane: snapshots, deployment admission gate, and subagent leases. */
export interface ControlLedger {
  snapshot(channel?: TaskChannel): Promise<TaskLedgerSnapshot>;
  deploymentLifecycle(): Promise<DeploymentLifecycle>;
  setDeploymentLifecycle(state: DeploymentLifecycleState): Promise<DeploymentLifecycle>;
  startSubagentRun(id: string, name: string, ownerPid?: number, ownerStartedAt?: string): Promise<ActiveSubagentRun | null>;
  heartbeatSubagentRun(id: string): Promise<boolean>;
  finishSubagentRun(id: string): Promise<void>;
  activeSubagentRuns(): Promise<ActiveSubagentRun[]>;
}

export interface TaskLedger extends BridgeLedger, SchedulerLedger, ExecutorSessionLedger, TaskRegistryLedger, RepairLedger, ControlLedger {
  close(): void;
}

export interface SQLiteTaskLedgerOptions {
  filePath: string;
  now?: () => Date;
  idFactory?: () => string;
  subagentLeaseMs?: number;
  subagentProcessStartedAt?: (pid: number) => string | null;
  subagentProcessExists?: (pid: number) => boolean;
  isLegacySubagentProcessAlive?: (name: string) => boolean;
  runOwnerId?: string;
  runOwnerPid?: number;
  runOwnerStartedAt?: string | null;
  runProcessStartedAt?: (pid: number) => string | null;
  runProcessExists?: (pid: number) => boolean;
  /** Default only for direct ledger callers. ConversationRuntime supplies its own identity. */
  runWorkerInstanceId?: string;
  runLeaseDurationMs?: number;
}
