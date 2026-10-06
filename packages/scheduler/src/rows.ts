import { communicationChannelValues, type CommunicationChannel } from "@fluffles/conversations";
import { nullableStringField, requireRuntimeRecord, requiredEnumField, requiredStringField } from "@fluffles/storage";
import { normalizeReminderUtc, validateReminderTimezone } from "./time";
import { ReminderStatus, ReminderTask, ReminderTaskStatus, ScheduledReminder } from "./types";

interface ReminderTaskRow {
  id: string;
  conversationId: string;
  objective: string;
  status: ReminderTaskStatus;
  progress: string | null;
  nextAction: string | null;
  result: string | null;
  createdAt: string;
  updatedAt: string;
}

const reminderTaskStatusValues: readonly ReminderTaskStatus[] = ["pending", "in_progress", "completed", "failed", "cancelled"];

export function optionalReminderTaskRowFromSql(value: unknown, context: string): ReminderTaskRow | null {
  if (value == null) return null;
  const row = requireRuntimeRecord(value, context);
  return {
    id: requiredStringField(row, "id", context),
    conversationId: requiredStringField(row, "conversationId", context),
    objective: requiredStringField(row, "objective", context),
    status: requiredEnumField(row, "status", reminderTaskStatusValues, context),
    progress: nullableStringField(row, "progress", context),
    nextAction: nullableStringField(row, "nextAction", context),
    result: nullableStringField(row, "result", context),
    createdAt: requiredStringField(row, "createdAt", context),
    updatedAt: requiredStringField(row, "updatedAt", context)
  };
}

export function reminderTaskFromRow(row: ReminderTaskRow): ReminderTask {
  return { ...row };
}

interface ScheduledReminderRow {
  id: string;
  companyId: string | null;
  instruction: string;
  scheduledFor: string;
  displayTimezone: string;
  channel: CommunicationChannel;
  conversationKey: string;
  status: ReminderStatus;
  createdAt: string;
  deliveredAt: string | null;
  cancelledAt: string | null;
}

const reminderStatusValues: readonly ReminderStatus[] = ["scheduled", "delivered", "cancelled"];

export function requireReminderStatus(value: ReminderStatus, field: string): ReminderStatus {
  if (!(reminderStatusValues as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of: ${reminderStatusValues.join(", ")}`);
  }
  return value;
}

export function optionalScheduledReminderRowFromSql(value: unknown, context: string): ScheduledReminderRow | null {
  if (value == null) return null;
  return scheduledReminderRowFromSql(value, context);
}

export function scheduledReminderRowFromSql(value: unknown, context: string): ScheduledReminderRow {
  const row = requireRuntimeRecord(value, context);
  return {
    id: requiredStringField(row, "id", context),
    companyId: nullableStringField(row, "companyId", context),
    instruction: requiredStringField(row, "instruction", context),
    scheduledFor: normalizeReminderUtc(requiredStringField(row, "scheduledFor", context)),
    displayTimezone: validateReminderTimezone(requiredStringField(row, "displayTimezone", context)),
    channel: requiredEnumField(row, "channel", communicationChannelValues, context),
    conversationKey: requiredStringField(row, "conversationKey", context),
    status: requiredEnumField(row, "status", reminderStatusValues, context),
    createdAt: requiredStringField(row, "createdAt", context),
    deliveredAt: nullableStringField(row, "deliveredAt", context),
    cancelledAt: nullableStringField(row, "cancelledAt", context)
  };
}

export function scheduledReminderFromRow(row: ScheduledReminderRow): ScheduledReminder {
  return { ...row };
}

export function cloneScheduledReminder(reminder: ScheduledReminder): ScheduledReminder {
  return { ...reminder };
}
