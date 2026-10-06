export type RepairTaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

/** Durable repair work keyed by the tool that needs attention. */
export interface RepairTask {
  id: string;
  toolId: string;
  objective: string;
  status: RepairTaskStatus;
  progress: string | null;
  nextAction: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertRepairTaskInput {
  toolId: string;
  objective: string;
  progress?: string | null;
  nextAction?: string | null;
}

export interface UpdateRepairTaskInput {
  progress?: string | null;
  nextAction?: string | null;
}

/** Repair ledger: durable diagnosis and repair task lifecycle. */
export interface RepairLedger {
  upsertRepairTask(input: UpsertRepairTaskInput): Promise<RepairTask>;
  startRepairTask(taskId: string): Promise<RepairTask>;
  updateRepairTask(taskId: string, input: UpdateRepairTaskInput): Promise<RepairTask>;
  completeRepairTask(taskId: string, result: string): Promise<RepairTask>;
  failRepairTask(taskId: string, result: string): Promise<RepairTask>;
  activeRepairTaskForTool(toolId: string): Promise<RepairTask | null>;
  unfinishedRepairTasks(): Promise<RepairTask[]>;
}

export function isTerminalRepairTaskStatus(status: RepairTaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
