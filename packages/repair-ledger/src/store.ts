import { DatabaseSync } from "node:sqlite";
import { LedgerDb, requireNonEmptyText, runtimeRecordArray } from "@fluffles/storage";
import { cloneRepairTask, optionalRepairTaskRowFromSql, repairTaskFromRow, repairTaskRowFromSql } from "./rows";
import { RepairLedger, RepairTask, UpdateRepairTaskInput, UpsertRepairTaskInput, isTerminalRepairTaskStatus } from "./types";

/**
 * Repair tasks: durable state for tool diagnosis and repair work.
 */
export class RepairStore implements RepairLedger {
  constructor(private readonly db: LedgerDb) {}


  async upsertRepairTask(input: UpsertRepairTaskInput): Promise<RepairTask> {
    return this.db.mutate<RepairTask>((db) => {
      const toolId = requireNonEmptyText(input.toolId, "repair task tool id");
      const existing = this.activeRepairTaskForToolInDb(db, toolId);
      if (existing) {
        const updated = this.updateRepairTaskInDb(db, existing, {
          progress: input.progress ?? existing.progress,
          nextAction: input.nextAction ?? existing.nextAction
        });
        return cloneRepairTask(updated);
      }
      const now = this.db.isoNow();
      const task: RepairTask = {
        id: this.db.newId(),
        toolId,
        objective: requireNonEmptyText(input.objective, "repair task objective"),
        status: "pending",
        progress: input.progress ?? null,
        nextAction: input.nextAction ?? null,
        result: null,
        createdAt: now,
        updatedAt: now
      };
      this.insertRepairTask(db, task);
      return cloneRepairTask(task);
    });
  }

  async startRepairTask(taskId: string): Promise<RepairTask> {
    return this.db.mutate<RepairTask>((db) => {
      const task = this.requireRepairTaskInDb(db, taskId);
      if (task.status === "in_progress") return cloneRepairTask(task);
      if (task.status !== "pending") throw terminalRepairTaskTransitionError(task, "in_progress");
      return cloneRepairTask(this.updateRepairTaskInDb(db, task, { status: "in_progress" }));
    });
  }

  async updateRepairTask(taskId: string, input: UpdateRepairTaskInput): Promise<RepairTask> {
    return this.db.mutate<RepairTask>((db) => {
      const task = this.requireRepairTaskInDb(db, taskId);
      if (isTerminalRepairTaskStatus(task.status)) throw terminalRepairTaskTransitionError(task, "update");
      return cloneRepairTask(this.updateRepairTaskInDb(db, task, {
        progress: Object.hasOwn(input, "progress") ? input.progress ?? null : task.progress,
        nextAction: Object.hasOwn(input, "nextAction") ? input.nextAction ?? null : task.nextAction
      }));
    });
  }

  async completeRepairTask(taskId: string, result: string): Promise<RepairTask> {
    return this.finishRepairTask(taskId, "completed", result);
  }

  async failRepairTask(taskId: string, result: string): Promise<RepairTask> {
    return this.finishRepairTask(taskId, "failed", result);
  }

  async activeRepairTaskForTool(toolId: string): Promise<RepairTask | null> {
    const task = this.activeRepairTaskForToolInDb(this.db.ensureDb(), toolId);
    return task ? cloneRepairTask(task) : null;
  }

  async unfinishedRepairTasks(): Promise<RepairTask[]> {
    const rows = runtimeRecordArray(this.db.ensureDb().prepare(`
      SELECT ${repairTaskColumns()} FROM repair_tasks
      WHERE status IN ('pending', 'in_progress')
      ORDER BY updated_at ASC, created_at ASC
    `).all(), "unfinished repair tasks");
    return rows.map((row) => repairTaskFromRow(repairTaskRowFromSql(row, "unfinished repair task"))).map(cloneRepairTask);
  }

  private activeRepairTaskForToolInDb(db: DatabaseSync, toolId: string): RepairTask | null {
    const row = optionalRepairTaskRowFromSql(db.prepare(`
      SELECT ${repairTaskColumns()} FROM repair_tasks
      WHERE tool_id = ? AND status IN ('pending', 'in_progress')
      ORDER BY created_at ASC LIMIT 1
    `).get(requireNonEmptyText(toolId, "repair task tool id")), `active repair task for ${toolId}`);
    return row ? repairTaskFromRow(row) : null;
  }

  private requireRepairTaskInDb(db: DatabaseSync, taskId: string): RepairTask {
    const row = optionalRepairTaskRowFromSql(db.prepare(`
      SELECT ${repairTaskColumns()} FROM repair_tasks WHERE id = ?
    `).get(taskId), `repair task ${taskId}`);
    if (!row) throw new Error(`Repair task disappeared from SQLite store: ${taskId}`);
    return repairTaskFromRow(row);
  }

  private insertRepairTask(db: DatabaseSync, task: RepairTask): void {
    db.prepare(`
      INSERT INTO repair_tasks (
        id, tool_id, objective, status, progress, next_action, result, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id, task.toolId, task.objective, task.status, task.progress,
      task.nextAction, task.result, task.createdAt, task.updatedAt
    );
  }

  private updateRepairTaskInDb(
    db: DatabaseSync,
    task: RepairTask,
    update: Partial<Pick<RepairTask, "status" | "progress" | "nextAction" | "result">>
  ): RepairTask {
    const updated: RepairTask = { ...task, ...update, updatedAt: this.db.isoNow() };
    db.prepare(`
      UPDATE repair_tasks
      SET status = ?, progress = ?, next_action = ?, result = ?, updated_at = ?
      WHERE id = ?
    `).run(updated.status, updated.progress, updated.nextAction, updated.result, updated.updatedAt, updated.id);
    return updated;
  }

  private async finishRepairTask(taskId: string, status: "completed" | "failed", result: string): Promise<RepairTask> {
    return this.db.mutate<RepairTask>((db) => {
      const task = this.requireRepairTaskInDb(db, taskId);
      if (task.status === status || isTerminalRepairTaskStatus(task.status)) return cloneRepairTask(task);
      return cloneRepairTask(this.updateRepairTaskInDb(db, task, {
        status,
        progress: status === "completed" ? "completed" : "failed",
        nextAction: null,
        result: requireNonEmptyText(result, "repair task result")
      }));
    });
  }
}

function repairTaskColumns(): string {
  return `
    id, tool_id AS toolId, objective, status, progress,
    next_action AS nextAction, result, created_at AS createdAt, updated_at AS updatedAt
  `;
}


function terminalRepairTaskTransitionError(task: RepairTask, requested: string): Error {
  return new Error(`Cannot transition terminal repair task ${task.id} from ${task.status} to ${requested}`);
}
