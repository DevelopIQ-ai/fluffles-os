import type { CommunicationChannel } from "@fluffles/conversations";

export type ReminderStatus = "scheduled" | "delivered" | "cancelled";
export type ReminderTaskStatus = "pending" | "in_progress" | "completed" | "failed" | "cancelled";

/**
 * The scheduler's own durable task record: one row per reminder recording its
 * objective/status/progress so restarts can account for scheduled work. It is
 * shaped identically to the embedder's persistent tasks so both can share one
 * table, but the scheduler only ever touches rows it created.
 */
export interface ReminderTask {
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

/**
 * Durable one-time reminder state. A reminder only ever schedules a message:
 * once admitted, the conversation owns the work like any other inbound turn.
 * companyId is nullable because the repository has no tenancy model yet.
 */
export interface ScheduledReminder {
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

export interface CreateScheduledReminderInput {
  companyId?: string | null;
  instruction: string;
  scheduledFor: string;
  displayTimezone: string;
  channel: CommunicationChannel;
  conversationKey: string;
}

export interface ReminderListOptions {
  channel?: CommunicationChannel;
  conversationKey?: string;
  statuses?: ReminderStatus[];
}

export interface AdmitDueRemindersOptions {
  channel?: CommunicationChannel;
  now?: string;
  limit?: number;
}

/**
 * `duplicate` means the instruction was already in the conversation, which is
 * how a crash between admitting and marking delivered stays exactly-once.
 */
export interface ReminderAdmission {
  reminder: ScheduledReminder;
  disposition: "admitted" | "duplicate";
}

/** Scheduler: durable reminders, and admitting them when they come due. */
export interface SchedulerLedger {
  createReminder(input: CreateScheduledReminderInput): Promise<ScheduledReminder>;
  getReminder(reminderId: string): Promise<ScheduledReminder | null>;
  listReminders(options?: ReminderListOptions): Promise<ScheduledReminder[]>;
  cancelReminder(reminderId: string): Promise<ScheduledReminder | null>;
  rescheduleReminder(reminderId: string, scheduledFor: string, displayTimezone?: string): Promise<ScheduledReminder | null>;
  admitDueReminders(options?: AdmitDueRemindersOptions): Promise<ReminderAdmission[]>;
}
