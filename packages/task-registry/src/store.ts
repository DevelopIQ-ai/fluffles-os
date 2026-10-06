import { DatabaseSync } from "node:sqlite";
import { BridgeStore, type TaskChannel } from "@fluffles/conversations";
import { LedgerDb, requireNonEmptyText, runtimeRecordArray } from "@fluffles/storage";
import { optionalPersistentTaskRowFromSql, persistentTaskFromRow } from "./rows";
import {
  CreateConversationTaskInput,
  PersistentTask,
  TaskRegistryLedger,
  UpdateConversationTaskInput
} from "./types";

const conversationTaskColumns = `
  id, conversation_id AS conversationId, objective, status, progress,
  next_action AS nextAction, result, created_at AS createdAt, updated_at AS updatedAt
`;

/**
 * The Step 2 persistent task registry: passive durable state for meaningful
 * conversation work. The agent owns execution; this store only records the
 * latest objective/status/progress/next_action/result so unfinished work can
 * resume after a restart. Registry tasks use task_kind 'conversation'; the
 * scheduler's reminder tasks and repair-ledger's repair tasks live in their own
 * kinds and are never touched here.
 */
export class TaskRegistryStore implements TaskRegistryLedger {
  constructor(private readonly db: LedgerDb, private readonly bridge: BridgeStore) {}

  async createConversationTask(input: CreateConversationTaskInput): Promise<PersistentTask> {
    return this.db.mutate<PersistentTask>((db) => {
      const objective = requireNonEmptyText(input.objective, "task objective");
      const conversation = this.bridge.getConversationInDb(db, input.channel, input.conversationKey);
      if (!conversation) throw new Error(`Unknown task conversation: ${input.channel}:${input.conversationKey}`);
      const active = this.activeConversationTaskInDb(db, conversation.id);
      if (active) throw new Error(`Conversation already has an unfinished task ${active.id}; update or finish it first`);
      const now = this.db.isoNow();
      const task: PersistentTask = {
        id: this.db.newId(),
        conversationId: conversation.id,
        objective,
        status: input.status ?? "in_progress",
        progress: input.progress ?? null,
        nextAction: input.nextAction ?? null,
        result: null,
        createdAt: now,
        updatedAt: now
      };
      if (task.status !== "pending" && task.status !== "in_progress") {
        throw new Error("a new task must start as pending or in_progress");
      }
      db.prepare(`
        INSERT INTO tasks (
          id, conversation_id, objective, status, progress, next_action, result, created_at, updated_at, task_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'conversation')
      `).run(task.id, task.conversationId, task.objective, task.status, task.progress, task.nextAction, task.result, task.createdAt, task.updatedAt);
      return task;
    });
  }

  async updateConversationTask(taskId: string, input: UpdateConversationTaskInput): Promise<PersistentTask> {
    return this.db.mutate<PersistentTask>((db) => {
      const existing = this.conversationTaskInDb(db, taskId);
      if (!existing) throw new Error(`Unknown conversation task: ${taskId}`);
      if (existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") {
        throw new Error(`Task ${taskId} is already ${existing.status} and cannot be updated`);
      }
      const updated: PersistentTask = {
        ...existing,
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.progress !== undefined ? { progress: input.progress } : {}),
        ...(input.nextAction !== undefined ? { nextAction: input.nextAction } : {}),
        ...(input.result !== undefined ? { result: input.result } : {}),
        updatedAt: this.db.isoNow()
      };
      if ((updated.status === "completed" || updated.status === "failed") && !updated.result?.trim()) {
        throw new Error(`a ${updated.status} task must record a result`);
      }
      db.prepare(`
        UPDATE tasks
        SET status = ?, progress = ?, next_action = ?, result = ?, updated_at = ?
        WHERE id = ? AND task_kind = 'conversation'
      `).run(updated.status, updated.progress, updated.nextAction, updated.result, updated.updatedAt, updated.id);
      return updated;
    });
  }

  async conversationTasks(channel: TaskChannel, conversationKey: string): Promise<PersistentTask[]> {
    return this.db.mutate<PersistentTask[]>((db) => {
      const conversation = this.bridge.getConversationInDb(db, channel, conversationKey);
      if (!conversation) return [];
      return runtimeRecordArray(db.prepare(`
        SELECT ${conversationTaskColumns}
        FROM tasks
        WHERE conversation_id = ? AND task_kind = 'conversation'
        ORDER BY created_at ASC
      `).all(conversation.id), "conversation task rows")
        .map((row) => persistentTaskFromRow(persistentTaskRow(row)));
    });
  }

  async unfinishedConversationTask(channel: TaskChannel, conversationKey: string): Promise<PersistentTask | null> {
    return this.db.mutate<PersistentTask | null>((db) => {
      const conversation = this.bridge.getConversationInDb(db, channel, conversationKey);
      if (!conversation) return null;
      return this.activeConversationTaskInDb(db, conversation.id);
    });
  }

  private conversationTaskInDb(db: DatabaseSync, taskId: string): PersistentTask | null {
    const row = optionalPersistentTaskRowFromSql(db.prepare(`
      SELECT ${conversationTaskColumns}
      FROM tasks WHERE id = ? AND task_kind = 'conversation'
    `).get(taskId), `conversation task ${taskId}`);
    return row ? persistentTaskFromRow(row) : null;
  }

  private activeConversationTaskInDb(db: DatabaseSync, conversationId: string): PersistentTask | null {
    const row = optionalPersistentTaskRowFromSql(db.prepare(`
      SELECT ${conversationTaskColumns}
      FROM tasks
      WHERE conversation_id = ? AND task_kind = 'conversation' AND status IN ('pending', 'in_progress')
    `).get(conversationId), `active conversation task for ${conversationId}`);
    return row ? persistentTaskFromRow(row) : null;
  }
}

function persistentTaskRow(row: unknown) {
  const parsed = optionalPersistentTaskRowFromSql(row, "conversation task row");
  if (!parsed) throw new Error("conversation task row disappeared mid-read");
  return parsed;
}

export { cancelOpenConversationTasksInDb } from "./cancel";
