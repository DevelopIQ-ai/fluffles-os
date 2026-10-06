import { BridgeStore } from "./bridge-store";
import { CodexSessionStore } from "./codex-sessions";
import { ControlStore } from "./control-store";
import { deploymentLifecycleInDb } from "./deployment-lifecycle";
import { cancelOpenConversationTasksInDb } from "./task-registry";
import { LedgerDb } from "./db";
import { RepairStore } from "./repair-store";
import { SchedulerStore } from "./scheduler-store";
import { TaskRegistryStore } from "./task-registry-store";
import { SQLiteTaskLedgerOptions, TaskLedger } from "./types";

/**
 * The authoritative SQLite task ledger, composed from domain stores that
 * share one durable connection and write chain:
 *
 * - bridge: chats/messages/runs/deliveries, admission, leases, recovery
 * - scheduler: reminders, admitted into their conversation when they come due
 * - codexSessions: executor session continuity across turns/restarts
 * - taskRegistry: passive Step 2 task state the agent updates while working
 * - repairs: repair-ledger repair tasks
 * - control: snapshots, deployment lifecycle, subagent leases
 *
 * Every TaskLedger method delegates to exactly one store.
 */
export class SQLiteTaskLedger implements TaskLedger {
  private readonly db: LedgerDb;
  readonly bridge: BridgeStore;
  readonly scheduler: SchedulerStore;
  readonly codexSessions: CodexSessionStore;
  readonly taskRegistry: TaskRegistryStore;
  readonly repairs: RepairStore;
  readonly control: ControlStore;

  constructor(options: SQLiteTaskLedgerOptions) {
    this.db = new LedgerDb(options);
    try {
      this.bridge = new BridgeStore(this.db, options, {
        admitNewRuns: (db) => deploymentLifecycleInDb(db).state === "normal",
        onConversationStopped: (db, conversationId, reason, stoppedAt) =>
          cancelOpenConversationTasksInDb(db, conversationId, reason, stoppedAt),
        onConversationKeyMigrated: (db, migration) => {
          if (migration.canonicalConversationId) {
            db.prepare("UPDATE tasks SET conversation_id = ? WHERE conversation_id = ?")
              .run(migration.canonicalConversationId, migration.legacyConversationId);
          }
          db.prepare(`
            DELETE FROM codex_sessions
            WHERE channel = ? AND conversation_key = ?
              AND EXISTS (SELECT 1 FROM codex_sessions WHERE channel = ? AND conversation_key = ?)
          `).run(migration.channel, migration.legacyKey, migration.channel, migration.canonicalKey);
          db.prepare("UPDATE codex_sessions SET conversation_key = ? WHERE channel = ? AND conversation_key = ?")
            .run(migration.canonicalKey, migration.channel, migration.legacyKey);
          db.prepare("UPDATE scheduled_reminders SET conversation_key = ? WHERE channel = ? AND conversation_key = ?")
            .run(migration.canonicalKey, migration.channel, migration.legacyKey);
        }
      });
      this.scheduler = new SchedulerStore(this.db, this.bridge);
      this.codexSessions = new CodexSessionStore(this.db, this.bridge);
      this.taskRegistry = new TaskRegistryStore(this.db, this.bridge);
      this.repairs = new RepairStore(this.db);
      this.control = new ControlStore(this.db, options);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  /** Throws if the authoritative SQLite connection has lost its WAL + FULL contract. */
  assertAuthoritativeDurability(): void { this.db.assertAuthoritativeDurability(); }

  // bridge
  recordMessage: TaskLedger["recordMessage"] = (...args) => this.bridge.recordMessage(...args);
  admitMessage: TaskLedger["admitMessage"] = (...args) => this.bridge.admitMessage(...args);
  recordAssistantMessage: TaskLedger["recordAssistantMessage"] = (...args) => this.bridge.recordAssistantMessage(...args);
  lifecycleEvents: TaskLedger["lifecycleEvents"] = (...args) => this.bridge.lifecycleEvents(...args);
  createOutboundDelivery: TaskLedger["createOutboundDelivery"] = (...args) => this.bridge.createOutboundDelivery(...args);
  createControlOutboundDelivery: TaskLedger["createControlOutboundDelivery"] = (...args) => this.bridge.createControlOutboundDelivery(...args);
  pendingOutboundDelivery: TaskLedger["pendingOutboundDelivery"] = (...args) => this.bridge.pendingOutboundDelivery(...args);
  recoverableOutboundDelivery: TaskLedger["recoverableOutboundDelivery"] = (...args) => this.bridge.recoverableOutboundDelivery(...args);
  outboundDeliveries: TaskLedger["outboundDeliveries"] = (...args) => this.bridge.outboundDeliveries(...args);
  recoverableControlOutboundDeliveries: TaskLedger["recoverableControlOutboundDeliveries"] = (...args) => this.bridge.recoverableControlOutboundDeliveries(...args);
  startOutboundDeliveryAttempt: TaskLedger["startOutboundDeliveryAttempt"] = (...args) => this.bridge.startOutboundDeliveryAttempt(...args);
  beginOutboundDeliveryDispatch: TaskLedger["beginOutboundDeliveryDispatch"] = (...args) => this.bridge.beginOutboundDeliveryDispatch(...args);
  assertOutboundDeliveryDispatchable: TaskLedger["assertOutboundDeliveryDispatchable"] = (...args) => this.bridge.assertOutboundDeliveryDispatchable(...args);
  markOutboundDeliveryProviderAccepted: TaskLedger["markOutboundDeliveryProviderAccepted"] = (...args) => this.bridge.markOutboundDeliveryProviderAccepted(...args);
  markOutboundDeliveryAcceptanceUnknown: TaskLedger["markOutboundDeliveryAcceptanceUnknown"] = (...args) => this.bridge.markOutboundDeliveryAcceptanceUnknown(...args);
  releaseOutboundDeliveryDispatch: TaskLedger["releaseOutboundDeliveryDispatch"] = (...args) => this.bridge.releaseOutboundDeliveryDispatch(...args);
  confirmOutboundDelivery: TaskLedger["confirmOutboundDelivery"] = (...args) => this.bridge.confirmOutboundDelivery(...args);
  failOutboundDelivery: TaskLedger["failOutboundDelivery"] = (...args) => this.bridge.failOutboundDelivery(...args);
  startRun: TaskLedger["startRun"] = (...args) => this.bridge.startRun(...args);
  heartbeatRunLease: TaskLedger["heartbeatRunLease"] = (...args) => this.bridge.heartbeatRunLease(...args);
  assertRunLease: TaskLedger["assertRunLease"] = (...args) => this.bridge.assertRunLease(...args);
  claimSteeringMessages: TaskLedger["claimSteeringMessages"] = (...args) => this.bridge.claimSteeringMessages(...args);
  finishRun: TaskLedger["finishRun"] = (...args) => this.bridge.finishRun(...args);
  stopConversation: TaskLedger["stopConversation"] = (...args) => this.bridge.stopConversation(...args);
  setConversationStatus: TaskLedger["setConversationStatus"] = (...args) => this.bridge.setConversationStatus(...args);
  markMessagesNonActionable: TaskLedger["markMessagesNonActionable"] = (...args) => this.bridge.markMessagesNonActionable(...args);
  checkpointRun: TaskLedger["checkpointRun"] = (...args) => this.bridge.checkpointRun(...args);
  recoverInterruptedRuns: TaskLedger["recoverInterruptedRuns"] = (...args) => this.bridge.recoverInterruptedRuns(...args);
  runnableConversations: TaskLedger["runnableConversations"] = (...args) => this.bridge.runnableConversations(...args);
  getConversation: TaskLedger["getConversation"] = (...args) => this.bridge.getConversation(...args);
  conversations: TaskLedger["conversations"] = (...args) => this.bridge.conversations(...args);
  migrateConversationKey: TaskLedger["migrateConversationKey"] = (...args) => this.bridge.migrateConversationKey(...args);
  compact: TaskLedger["compact"] = (...args) => this.bridge.compact(...args);
  buildContext: TaskLedger["buildContext"] = (...args) => this.bridge.buildContext(...args);

  // scheduler
  createReminder: TaskLedger["createReminder"] = (...args) => this.scheduler.createReminder(...args);
  getReminder: TaskLedger["getReminder"] = (...args) => this.scheduler.getReminder(...args);
  listReminders: TaskLedger["listReminders"] = (...args) => this.scheduler.listReminders(...args);
  cancelReminder: TaskLedger["cancelReminder"] = (...args) => this.scheduler.cancelReminder(...args);
  rescheduleReminder: TaskLedger["rescheduleReminder"] = (...args) => this.scheduler.rescheduleReminder(...args);
  admitDueReminders: TaskLedger["admitDueReminders"] = (...args) => this.scheduler.admitDueReminders(...args);

  // codex sessions
  getCodexSession: TaskLedger["getCodexSession"] = (...args) => this.codexSessions.getCodexSession(...args);
  saveCodexSession: TaskLedger["saveCodexSession"] = (...args) => this.codexSessions.saveCodexSession(...args);
  clearCodexSession: TaskLedger["clearCodexSession"] = (...args) => this.codexSessions.clearCodexSession(...args);

  // task registry
  createConversationTask: TaskLedger["createConversationTask"] = (...args) => this.taskRegistry.createConversationTask(...args);
  updateConversationTask: TaskLedger["updateConversationTask"] = (...args) => this.taskRegistry.updateConversationTask(...args);
  conversationTasks: TaskLedger["conversationTasks"] = (...args) => this.taskRegistry.conversationTasks(...args);
  unfinishedConversationTask: TaskLedger["unfinishedConversationTask"] = (...args) => this.taskRegistry.unfinishedConversationTask(...args);

  // repairs
  upsertRepairTask: TaskLedger["upsertRepairTask"] = (...args) => this.repairs.upsertRepairTask(...args);
  startRepairTask: TaskLedger["startRepairTask"] = (...args) => this.repairs.startRepairTask(...args);
  updateRepairTask: TaskLedger["updateRepairTask"] = (...args) => this.repairs.updateRepairTask(...args);
  completeRepairTask: TaskLedger["completeRepairTask"] = (...args) => this.repairs.completeRepairTask(...args);
  failRepairTask: TaskLedger["failRepairTask"] = (...args) => this.repairs.failRepairTask(...args);
  activeRepairTaskForTool: TaskLedger["activeRepairTaskForTool"] = (...args) => this.repairs.activeRepairTaskForTool(...args);
  unfinishedRepairTasks: TaskLedger["unfinishedRepairTasks"] = (...args) => this.repairs.unfinishedRepairTasks(...args);

  // control
  snapshot: TaskLedger["snapshot"] = (...args) => this.control.snapshot(...args);
  deploymentLifecycle: TaskLedger["deploymentLifecycle"] = (...args) => this.control.deploymentLifecycle(...args);
  setDeploymentLifecycle: TaskLedger["setDeploymentLifecycle"] = (...args) => this.control.setDeploymentLifecycle(...args);
  startSubagentRun: TaskLedger["startSubagentRun"] = (...args) => this.control.startSubagentRun(...args);
  heartbeatSubagentRun: TaskLedger["heartbeatSubagentRun"] = (...args) => this.control.heartbeatSubagentRun(...args);
  finishSubagentRun: TaskLedger["finishSubagentRun"] = (...args) => this.control.finishSubagentRun(...args);
  activeSubagentRuns: TaskLedger["activeSubagentRuns"] = (...args) => this.control.activeSubagentRuns(...args);
}
