import { nullableStringField, requireRuntimeRecord, requiredEnumField, requiredStringField } from "@fluffles/storage";
import { PersistentTask, PersistentTaskStatus } from "./types";

export interface PersistentTaskRow {
  id: string;
  conversationId: string;
  objective: string;
  status: PersistentTaskStatus;
  progress: string | null;
  nextAction: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

export const persistentTaskStatusValues: readonly PersistentTaskStatus[] = ["pending", "in_progress", "completed", "failed", "cancelled"];

export function optionalPersistentTaskRowFromSql(value: unknown, context: string): PersistentTaskRow | null {
  if (value == null) return null;
  return persistentTaskRowFromSql(value, context);
}

export function persistentTaskRowFromSql(value: unknown, context: string): PersistentTaskRow {
  const row = requireRuntimeRecord(value, context);
  return {
    id: requiredStringField(row, "id", context),
    conversationId: requiredStringField(row, "conversationId", context),
    objective: requiredStringField(row, "objective", context),
    status: requiredEnumField(row, "status", persistentTaskStatusValues, context),
    progress: nullableStringField(row, "progress", context),
    nextAction: nullableStringField(row, "nextAction", context),
    result: nullableStringField(row, "result", context),
    createdAt: requiredStringField(row, "createdAt", context),
    updatedAt: requiredStringField(row, "updatedAt", context)
  };
}

export function persistentTaskFromRow(row: PersistentTaskRow): PersistentTask {
  return { ...row };
}
