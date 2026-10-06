import { SQLiteTransportStore, type JsonObject } from "@fluffles/tasks";

export type EmailInboundAction = "accepted" | "skipped" | "duplicate" | "error";
export type EmailOutboundAction = "drafted" | "sent" | "skipped" | "failed";

export interface EmailInboundReceiptInput {
  provider: string;
  providerMessageId: string;
  threadId: string | null;
  subject: string;
  from: string;
  classification: JsonObject;
  action: EmailInboundAction;
  taskConversationKey?: string | null;
  taskDisposition?: string | null;
  error?: string | null;
  receivedAt?: string;
}

export interface EmailOutboundReceiptInput {
  conversationKey: string;
  runId: string;
  provider: string;
  providerMessageId: string;
  action: EmailOutboundAction;
  mode: "draft" | "send" | "disabled";
  response?: JsonObject | null;
  error?: string | null;
}

export interface EmailTransportSnapshot {
  inboundTotal: number;
  inboundAccepted: number;
  inboundSkipped: number;
  inboundErrors: number;
  outboundTotal: number;
  outboundDrafted: number;
  outboundSent: number;
  outboundFailed: number;
}

export interface GmailHistoryCursor {
  mailboxId: string;
  historyId: string;
  updatedAt: string;
}

export class SQLiteEmailTransportStore extends SQLiteTransportStore {
  recordInboundReceipt(input: EmailInboundReceiptInput): void {
    this.writeInboundReceipt({
      provider: input.provider,
      providerEventId: input.providerMessageId,
      action: input.action,
      details: { threadId: input.threadId, subject: input.subject, sender: input.from, classification: input.classification },
      taskConversationKey: input.taskConversationKey,
      taskDisposition: input.taskDisposition,
      error: input.error,
      receivedAt: input.receivedAt
    });
  }

  recordOutboundReceipt(input: EmailOutboundReceiptInput): void {
    this.writeOutboundReceipt(input);
  }

  gmailHistoryCursor(mailboxId: string): GmailHistoryCursor | null {
    const row = this.ensureDb().prepare(`
      SELECT mailbox_id AS mailboxId, history_id AS historyId, updated_at AS updatedAt
      FROM gmail_history_cursors WHERE mailbox_id = ?
    `).get(mailboxId) as Record<string, unknown> | undefined;
    if (!row || typeof row.historyId !== "string" || !row.historyId) return null;
    return {
      mailboxId: typeof row.mailboxId === "string" ? row.mailboxId : mailboxId,
      historyId: row.historyId,
      updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : ""
    };
  }

  setGmailHistoryCursor(mailboxId: string, historyId: string): void {
    const normalized = historyId.trim();
    if (!normalized) return;
    this.ensureDb().prepare(`
      INSERT INTO gmail_history_cursors (mailbox_id, history_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(mailbox_id) DO UPDATE SET history_id = excluded.history_id, updated_at = excluded.updated_at
      WHERE CAST(excluded.history_id AS INTEGER) > CAST(gmail_history_cursors.history_id AS INTEGER)
    `).run(mailboxId, normalized, this.isoNow());
  }

  snapshot(): EmailTransportSnapshot {
    return {
      ...this.receiptCounts(),
      outboundDrafted: this.countOutboundByAction("drafted"),
      outboundSent: this.countOutboundByAction("sent"),
      outboundFailed: this.countOutboundByAction("failed")
    };
  }

  protected channelSchema(): string {
    return `
      CREATE TABLE IF NOT EXISTS gmail_history_cursors (
        mailbox_id TEXT PRIMARY KEY,
        history_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `;
  }
}
