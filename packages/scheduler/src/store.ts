import { DatabaseSync } from "node:sqlite";
import { BridgeStore, requireCommunicationChannel } from "@fluffles/conversations";
import { LedgerDb, requireNonEmptyText, requirePositiveSafeInteger, runtimeRecordArray } from "@fluffles/storage";
import { cloneScheduledReminder, optionalReminderTaskRowFromSql, optionalScheduledReminderRowFromSql, reminderTaskFromRow, requireReminderStatus, scheduledReminderFromRow, scheduledReminderRowFromSql } from "./rows";
import { normalizeReminderUtc, validateReminderTimezone } from "./time";
import { AdmitDueRemindersOptions, CreateScheduledReminderInput, ReminderAdmission, ReminderListOptions, ReminderStatus, ReminderTask, ScheduledReminder, SchedulerLedger } from "./types";

/**
 * Durable one-time reminders. A reminder is only a scheduled message: when it
 * comes due the instruction is admitted into its conversation and the ordinary
 * inbound path runs it, so there is exactly one execution lifecycle to get
 * right. Admission is keyed by the reminder id, which is what makes a crash
 * between admitting and recording delivery harmless.
 */
export class SchedulerStore implements SchedulerLedger {
  constructor(private readonly db: LedgerDb, private readonly bridge: BridgeStore) {}

  async createReminder(input: CreateScheduledReminderInput): Promise<ScheduledReminder> {
    return this.db.mutate<ScheduledReminder>((db) => {
      const companyId = input.companyId == null ? null : requireNonEmptyText(input.companyId, "reminder company id");
      const scheduledFor = normalizeReminderUtc(input.scheduledFor);
      if (scheduledFor <= this.db.isoNow()) throw new Error("reminder scheduled_for must be in the future");
      const displayTimezone = validateReminderTimezone(input.displayTimezone);
      const channel = requireCommunicationChannel(input.channel, "reminder channel");
      const conversationKey = requireNonEmptyText(input.conversationKey, "reminder conversation key");
      const conversation = this.bridge.getConversationInDb(db, channel, conversationKey);
      if (!conversation) throw new Error(`Unknown reminder conversation: ${channel}:${conversationKey}`);
      const now = this.db.isoNow();
      const task: ReminderTask = {
        id: this.db.newId(),
        conversationId: conversation.id,
        objective: requireNonEmptyText(input.instruction, "reminder instruction"),
        status: "pending",
        progress: "scheduled",
        nextAction: null,
        result: null,
        createdAt: now,
        updatedAt: now
      };
      this.insertTask(db, task, "reminder");
      const reminder: ScheduledReminder = {
        id: task.id,
        companyId,
        instruction: task.objective,
        scheduledFor,
        displayTimezone,
        channel,
        conversationKey,
        status: "scheduled",
        createdAt: now,
        deliveredAt: null,
        cancelledAt: null
      };
      this.insertReminder(db, reminder);
      return cloneScheduledReminder(reminder);
    });
  }

  async getReminder(reminderId: string): Promise<ScheduledReminder | null> {
    const reminder = this.reminderInDb(this.db.ensureDb(), reminderId);
    return reminder ? cloneScheduledReminder(reminder) : null;
  }

  async listReminders(options: ReminderListOptions = {}): Promise<ScheduledReminder[]> {
    const db = this.db.ensureDb();
    const filters: string[] = [];
    const values: Array<string> = [];
    if (options.channel !== undefined) {
      filters.push("channel = ?");
      values.push(requireCommunicationChannel(options.channel, "reminder channel"));
    }
    if (options.conversationKey !== undefined) {
      filters.push("conversation_key = ?");
      values.push(requireNonEmptyText(options.conversationKey, "reminder conversation key"));
    }
    if (options.statuses !== undefined) {
      if (options.statuses.length === 0) return [];
      for (const status of options.statuses) requireReminderStatus(status, "reminder status filter");
      filters.push(`status IN (${options.statuses.map(() => "?").join(", ")})`);
      values.push(...options.statuses);
    }
    const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
    const rows = runtimeRecordArray(db.prepare(`
      SELECT ${scheduledReminderColumns()} FROM scheduled_reminders
      ${where}
      ORDER BY scheduled_for ASC, created_at ASC, id ASC
    `).all(...values), "scheduled reminder rows");
    return rows.map((row) => scheduledReminderFromRow(scheduledReminderRowFromSql(row, "scheduled reminder row")))
      .map(cloneScheduledReminder);
  }

  async cancelReminder(reminderId: string): Promise<ScheduledReminder | null> {
    return this.db.mutate<ScheduledReminder | null>((db) => {
      const reminder = this.reminderInDb(db, reminderId);
      if (!reminder) return null;
      this.requireReminderTransition(reminder, ["scheduled"], "cancel");
      const updated = { ...reminder, status: "cancelled" as const, cancelledAt: this.db.isoNow() };
      this.updateReminder(db, updated);
      this.updateTaskInDb(db, this.requireTaskInDb(db, reminder.id), {
        status: "cancelled",
        progress: "cancelled",
        nextAction: null,
        result: "cancelled"
      });
      return cloneScheduledReminder(updated);
    });
  }

  async rescheduleReminder(reminderId: string, scheduledForInput: string, displayTimezone?: string): Promise<ScheduledReminder | null> {
    return this.db.mutate<ScheduledReminder | null>((db) => {
      const reminder = this.reminderInDb(db, reminderId);
      if (!reminder) return null;
      this.requireReminderTransition(reminder, ["scheduled"], "reschedule");
      const scheduledFor = normalizeReminderUtc(scheduledForInput);
      if (scheduledFor <= this.db.isoNow()) throw new Error("reminder scheduled_for must be in the future");
      const updated: ScheduledReminder = {
        ...reminder,
        scheduledFor,
        displayTimezone: displayTimezone === undefined ? reminder.displayTimezone : validateReminderTimezone(displayTimezone)
      };
      this.updateReminder(db, updated);
      return cloneScheduledReminder(updated);
    });
  }

  /**
   * Hands every due reminder to its conversation as an ordinary inbound
   * message. Admission is idempotent on `reminder:<id>`, so an interrupted
   * pass re-admits nothing and simply records the delivery it already made.
   */
  async admitDueReminders(options: AdmitDueRemindersOptions = {}): Promise<ReminderAdmission[]> {
    const now = options.now === undefined ? this.db.isoNow() : normalizeReminderUtc(options.now, "reminder admission time");
    const limit = options.limit === undefined ? 25 : requirePositiveSafeInteger(options.limit, "reminder admission limit");
    const channel = options.channel === undefined ? null : requireCommunicationChannel(options.channel, "reminder channel");
    const rows = runtimeRecordArray(this.db.ensureDb().prepare(`
      SELECT ${scheduledReminderColumns()} FROM scheduled_reminders
      WHERE status = 'scheduled' AND scheduled_for <= ?${channel ? " AND channel = ?" : ""}
      ORDER BY scheduled_for ASC, created_at ASC, id ASC
      LIMIT ?
    `).all(...(channel ? [now, channel, limit] : [now, limit])), "due scheduled reminders");

    const admissions: ReminderAdmission[] = [];
    for (const row of rows) {
      const reminder = scheduledReminderFromRow(scheduledReminderRowFromSql(row, "due scheduled reminder"));
      const result = await this.bridge.admitMessage({
        channel: reminder.channel,
        conversationKey: reminder.conversationKey,
        externalMessageId: `reminder:${reminder.id}`,
        authorId: "reminder",
        text: reminder.instruction,
        metadata: { reminderId: reminder.id, reminderInstruction: true }
      }, { actionable: true });
      admissions.push({ reminder: await this.markDelivered(reminder), disposition: result.disposition === "duplicate" ? "duplicate" : "admitted" });
    }
    return admissions;
  }

  private async markDelivered(reminder: ScheduledReminder): Promise<ScheduledReminder> {
    return this.db.mutate<ScheduledReminder>((db) => {
      const delivered: ScheduledReminder = { ...reminder, status: "delivered", deliveredAt: this.db.isoNow() };
      this.updateReminder(db, delivered);
      this.updateTaskInDb(db, this.requireTaskInDb(db, reminder.id), {
        status: "completed",
        progress: "delivered",
        nextAction: null,
        result: "delivered to the conversation"
      });
      return cloneScheduledReminder(delivered);
    });
  }

  private reminderInDb(db: DatabaseSync, reminderId: string): ScheduledReminder | null {
    const row = optionalScheduledReminderRowFromSql(db.prepare(`
      SELECT ${scheduledReminderColumns()} FROM scheduled_reminders WHERE id = ?
    `).get(requireNonEmptyText(reminderId, "reminder id")), `scheduled reminder ${reminderId}`);
    return row ? scheduledReminderFromRow(row) : null;
  }

  private insertReminder(db: DatabaseSync, reminder: ScheduledReminder): void {
    db.prepare(`
      INSERT INTO scheduled_reminders (
        id, company_id, instruction, scheduled_for, display_timezone, channel, conversation_key,
        status, created_at, delivered_at, cancelled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reminder.id,
      reminder.companyId,
      reminder.instruction,
      reminder.scheduledFor,
      reminder.displayTimezone,
      reminder.channel,
      reminder.conversationKey,
      reminder.status,
      reminder.createdAt,
      reminder.deliveredAt,
      reminder.cancelledAt
    );
  }

  private updateReminder(db: DatabaseSync, reminder: ScheduledReminder): void {
    db.prepare(`
      UPDATE scheduled_reminders
      SET scheduled_for = ?, display_timezone = ?, status = ?, delivered_at = ?, cancelled_at = ?
      WHERE id = ?
    `).run(
      reminder.scheduledFor,
      reminder.displayTimezone,
      reminder.status,
      reminder.deliveredAt,
      reminder.cancelledAt,
      reminder.id
    );
  }

  private requireReminderTransition(reminder: ScheduledReminder, allowedFrom: readonly ReminderStatus[], action: string): void {
    if (!allowedFrom.includes(reminder.status)) {
      throw new Error(`Cannot ${action} scheduled reminder ${reminder.id} from ${reminder.status}`);
    }
  }

  private requireTaskInDb(db: DatabaseSync, taskId: string): ReminderTask {
    const row = optionalReminderTaskRowFromSql(db.prepare(`
      SELECT id, conversation_id AS conversationId, objective, status, progress,
        next_action AS nextAction, result, created_at AS createdAt, updated_at AS updatedAt
      FROM tasks WHERE id = ?
    `).get(taskId), `task ${taskId}`);
    if (!row) throw new Error(`Persistent task disappeared from SQLite store: ${taskId}`);
    return reminderTaskFromRow(row);
  }

  private insertTask(db: DatabaseSync, task: ReminderTask, kind: "reminder"): void {
    db.prepare(`
      INSERT INTO tasks (
        id, conversation_id, objective, status, progress, next_action, result, created_at, updated_at, task_kind
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.conversationId,
      task.objective,
      task.status,
      task.progress,
      task.nextAction,
      task.result,
      task.createdAt,
      task.updatedAt,
      kind
    );
  }

  private updateTaskInDb(
    db: DatabaseSync,
    task: ReminderTask,
    update: Partial<Pick<ReminderTask, "status" | "progress" | "nextAction" | "result">>
  ): ReminderTask {
    const updated: ReminderTask = { ...task, ...update, updatedAt: this.db.isoNow() };
    db.prepare(`
      UPDATE tasks
      SET status = ?, progress = ?, next_action = ?, result = ?, updated_at = ?
      WHERE id = ?
    `).run(updated.status, updated.progress, updated.nextAction, updated.result, updated.updatedAt, updated.id);
    return updated;
  }
}

function scheduledReminderColumns(): string {
  return `
    id,
    company_id AS companyId,
    instruction,
    scheduled_for AS scheduledFor,
    display_timezone AS displayTimezone,
    channel,
    conversation_key AS conversationKey,
    status,
    created_at AS createdAt,
    delivered_at AS deliveredAt,
    cancelled_at AS cancelledAt
  `;
}
