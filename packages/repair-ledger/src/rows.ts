import { nullableStringField, requireRuntimeRecord, requiredEnumField, requiredStringField } from "@fluffles/storage";
import { RepairTask, RepairTaskStatus } from "./types";

export interface RepairTaskRow {
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

const repairTaskStatusValues: readonly RepairTaskStatus[] = ["pending", "in_progress", "completed", "failed", "cancelled"];

export function optionalRepairTaskRowFromSql(value: unknown, context: string): RepairTaskRow | null {
  if (value == null) return null;
  return repairTaskRowFromSql(value, context);
}

export function repairTaskRowFromSql(value: unknown, context: string): RepairTaskRow {
  const row = requireRuntimeRecord(value, context);
  return {
    id: requiredStringField(row, "id", context),
    toolId: requiredStringField(row, "toolId", context),
    objective: requiredStringField(row, "objective", context),
    status: requiredEnumField(row, "status", repairTaskStatusValues, context),
    progress: nullableStringField(row, "progress", context),
    nextAction: nullableStringField(row, "nextAction", context),
    result: nullableStringField(row, "result", context),
    createdAt: requiredStringField(row, "createdAt", context),
    updatedAt: requiredStringField(row, "updatedAt", context)
  };
}

export function repairTaskFromRow(row: RepairTaskRow): RepairTask {
  return { ...row };
}

export function cloneRepairTask(task: RepairTask): RepairTask {
  return { ...task };
}
