import { DatabaseSync } from "node:sqlite";
import { SQLiteTransportStore, type JsonObject } from "@fluffles/tasks";

export type PhoneInboundAction = "accepted" | "skipped" | "duplicate" | "error";
export type PhoneOutboundAction = "sent" | "skipped" | "failed";

export interface PhoneInboundReceiptInput {
  provider: string;
  providerEventId: string;
  conversationId: string | null;
  sender: string;
  kind: "message" | "call";
  action: PhoneInboundAction;
  taskConversationKey?: string | null;
  taskDisposition?: string | null;
  error?: string | null;
  receivedAt?: string;
}

export interface PhoneOutboundReceiptInput {
  conversationKey: string;
  runId: string;
  provider: string;
  destination: string;
  providerMessageId: string;
  action: PhoneOutboundAction;
  mode: "send" | "disabled";
  response?: JsonObject | null;
  error?: string | null;
}

export interface PhoneTransportSnapshot {
  inboundTotal: number;
  inboundAccepted: number;
  inboundSkipped: number;
  inboundErrors: number;
  outboundTotal: number;
  outboundSent: number;
  outboundFailed: number;
}

export interface PendingPhoneCallTranscript {
  provider: string;
  providerEventId: string;
  source: "poll" | "webhook";
  call: Record<string, unknown>;
  attempts: number;
}

/** Durable progress for the newest-to-oldest AgentPhone message scan. */
export interface PhonePollCheckpoint {
  provider: string;
  providerCursor: string | null;
  lastProcessedId: string | null;
  checkpointTimestamp: string | null;
  activeScanId: number | null;
  nextPageIndex: number;
}

/** A provider message durably staged before it is admitted to the engine. */
export interface PendingPhonePollMessage {
  provider: string;
  providerEventId: string;
  message: Record<string, unknown>;
}

interface PollCheckpointRow extends PhonePollCheckpoint {
  lastScanId: number;
  ownerId: string | null;
  ownerLeaseExpiresAt: string | null;
}

interface CountRow { count: number; }

export class SQLitePhoneTransportStore extends SQLiteTransportStore {
  /** Persist a call that is complete but whose transcript is not ready yet. */
  deferCallTranscript(input: Omit<PendingPhoneCallTranscript, "attempts">, error: string | null = null): void {
    const db = this.ensureDb();
    const now = this.isoNow();
    const existing = db.prepare(`
      SELECT attempts FROM pending_call_transcripts
      WHERE provider = ? AND provider_event_id = ?
    `).get(input.provider, input.providerEventId) as Record<string, unknown> | undefined;
    const attempts = numberField(existing?.attempts) + 1;
    const nextAttemptAt = new Date(this.now().getTime() + transcriptRetryDelayMs(attempts)).toISOString();
    db.prepare(`
      INSERT INTO pending_call_transcripts (
        provider, provider_event_id, source, call_json, attempts, last_error, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, provider_event_id) DO UPDATE SET
        source = excluded.source,
        call_json = excluded.call_json,
        attempts = excluded.attempts,
        last_error = excluded.last_error,
        next_attempt_at = excluded.next_attempt_at,
        updated_at = excluded.updated_at
    `).run(input.provider, input.providerEventId, input.source, JSON.stringify(input.call), attempts, error, nextAttemptAt, now, now);
  }

  /** Claim due transcript work. Claimed rows are removed and must be completed or re-deferred by the caller. */
  claimPendingCallTranscripts(limit: number): PendingPhoneCallTranscript[] {
    const db = this.ensureDb();
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const now = this.isoNow();
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = db.prepare(`
        SELECT provider, provider_event_id, source, call_json, attempts
        FROM pending_call_transcripts
        WHERE next_attempt_at <= ?
        ORDER BY created_at ASC, provider ASC, provider_event_id ASC
        LIMIT ?
      `).all(now, boundedLimit) as Array<Record<string, unknown>>;
      const claimed: PendingPhoneCallTranscript[] = rows.flatMap((row): PendingPhoneCallTranscript[] => {
        const provider = stringField(row.provider);
        const providerEventId = stringField(row.provider_event_id);
        const source = row.source === "poll" || row.source === "webhook" ? row.source : null;
        const call = jsonObject(row.call_json);
        const attempts = numberField(row.attempts);
        return provider && providerEventId && source && call ? [{ provider, providerEventId, source: source as "poll" | "webhook", call, attempts }] : [];
      });
      const remove = db.prepare("DELETE FROM pending_call_transcripts WHERE provider = ? AND provider_event_id = ?");
      for (const row of rows) {
        const provider = stringField(row.provider);
        const providerEventId = stringField(row.provider_event_id);
        // A corrupt deferred record must not block the entire due queue forever.
        if (provider && providerEventId) remove.run(provider, providerEventId);
      }
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction was not opened */ }
      throw error;
    }
  }

  recordInboundReceipt(input: PhoneInboundReceiptInput): void {
    this.writeInboundReceipt({
      provider: input.provider,
      providerEventId: input.providerEventId,
      action: input.action,
      details: { conversationId: input.conversationId, sender: input.sender, kind: input.kind },
      taskConversationKey: input.taskConversationKey,
      taskDisposition: input.taskDisposition,
      error: input.error,
      receivedAt: input.receivedAt
    });
  }

  recordOutboundReceipt(input: PhoneOutboundReceiptInput): void {
    this.writeOutboundReceipt(input);
  }

  /** Claim the provider scan across processes. Staged rows make crashes replay-safe. */
  claimPollOwnership(provider: string, ownerId: string, leaseDurationMs = 60_000): PhonePollCheckpoint | null {
    const db = this.ensureDb();
    const now = this.isoNow();
    const leaseExpiresAt = new Date(this.now().getTime() + leaseDurationMs).toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.pollCheckpointRowInDb(db, provider);
      if (existing?.ownerId && existing.ownerLeaseExpiresAt && existing.ownerLeaseExpiresAt > now) {
        db.exec("COMMIT");
        return null;
      }
      const activeScanId = existing?.activeScanId ?? (existing ? existing.lastScanId + 1 : 1);
      const nextPageIndex = existing?.activeScanId == null ? 0 : existing.nextPageIndex;
      db.prepare(`
        INSERT INTO phone_poll_checkpoints (
          provider, provider_cursor, last_processed_id, checkpoint_timestamp, active_scan_id, last_scan_id, next_page_index,
          owner_id, owner_lease_expires_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider) DO UPDATE SET
          active_scan_id = excluded.active_scan_id,
          last_scan_id = excluded.last_scan_id,
          next_page_index = excluded.next_page_index,
          owner_id = excluded.owner_id,
          owner_lease_expires_at = excluded.owner_lease_expires_at,
          updated_at = excluded.updated_at
      `).run(
        provider,
        existing?.lastProcessedId ?? null,
        existing?.checkpointTimestamp ?? null,
        activeScanId,
        activeScanId,
        nextPageIndex,
        ownerId,
        leaseExpiresAt,
        now
      );
      const claimed = this.pollCheckpointInDb(db, provider);
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction was not opened */ }
      throw error;
    }
  }

  /** Persist a provider page before moving its pagination cursor. */
  stagePollPage(input: {
    provider: string;
    ownerId: string;
    scanId: number;
    pageIndex: number;
    messages: Array<{ providerEventId: string; message: Record<string, unknown> }>;
    nextCursor: string | null;
    complete: boolean;
  }): PhonePollCheckpoint {
    const db = this.ensureDb();
    const now = this.isoNow();
    db.exec("BEGIN IMMEDIATE");
    try {
      const checkpoint = this.requirePollOwnerInDb(db, input.provider, input.ownerId);
      if (checkpoint.activeScanId !== input.scanId || checkpoint.nextPageIndex !== input.pageIndex) {
        throw new Error(`AgentPhone poll scan changed while staging ${input.provider} page ${input.pageIndex}`);
      }
      const insert = db.prepare(`
        INSERT INTO phone_poll_messages (
          provider, provider_event_id, scan_id, page_index, page_position, message_json, staged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, provider_event_id) DO NOTHING
      `);
      for (const [pagePosition, message] of input.messages.entries()) {
        insert.run(input.provider, message.providerEventId, input.scanId, input.pageIndex, pagePosition, JSON.stringify(message.message), now);
      }
      db.prepare(`
        UPDATE phone_poll_checkpoints
        SET provider_cursor = ?, active_scan_id = ?, last_scan_id = ?, next_page_index = ?,
          owner_lease_expires_at = ?, updated_at = ?
        WHERE provider = ? AND owner_id = ?
      `).run(
        input.complete ? null : input.nextCursor,
        input.complete ? null : input.scanId,
        input.scanId,
        input.complete ? 0 : input.pageIndex + 1,
        new Date(this.now().getTime() + 60_000).toISOString(),
        now,
        input.provider,
        input.ownerId
      );
      const staged = this.pollCheckpointInDb(db, input.provider);
      db.exec("COMMIT");
      if (!staged) throw new Error(`AgentPhone poll checkpoint disappeared for ${input.provider}`);
      return staged;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction was not opened */ }
      throw error;
    }
  }

  pendingPollMessages(provider: string, ownerId: string): PendingPhonePollMessage[] {
    const db = this.ensureDb();
    this.requirePollOwnerInDb(db, provider, ownerId);
    const rows = db.prepare(`
      SELECT provider, provider_event_id, message_json
      FROM phone_poll_messages
      WHERE provider = ?
      ORDER BY scan_id ASC, page_index DESC, page_position DESC, provider_event_id ASC
    `).all(provider) as Array<Record<string, unknown>>;
    return rows.flatMap((row): PendingPhonePollMessage[] => {
      const providerEventId = stringField(row.provider_event_id);
      const message = jsonObject(row.message_json);
      return providerEventId && message ? [{ provider, providerEventId, message }] : [];
    });
  }

  /** Remove a durably handled staged event and advance its checkpoint together. */
  completePollMessage(provider: string, ownerId: string, providerEventId: string): void {
    const db = this.ensureDb();
    const now = this.isoNow();
    db.exec("BEGIN IMMEDIATE");
    try {
      this.requirePollOwnerInDb(db, provider, ownerId);
      db.prepare("DELETE FROM phone_poll_messages WHERE provider = ? AND provider_event_id = ?")
        .run(provider, providerEventId);
      db.prepare(`
        UPDATE phone_poll_checkpoints
        SET last_processed_id = ?, checkpoint_timestamp = ?, owner_lease_expires_at = ?, updated_at = ?
        WHERE provider = ? AND owner_id = ?
      `).run(providerEventId, now, new Date(this.now().getTime() + 60_000).toISOString(), now, provider, ownerId);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* transaction was not opened */ }
      throw error;
    }
  }

  releasePollOwnership(provider: string, ownerId: string): void {
    this.ensureDb().prepare(`
      UPDATE phone_poll_checkpoints
      SET owner_id = NULL, owner_lease_expires_at = NULL, updated_at = ?
      WHERE provider = ? AND owner_id = ?
    `).run(this.isoNow(), provider, ownerId);
  }

  pollCheckpoint(provider: string): PhonePollCheckpoint | null {
    return this.pollCheckpointInDb(this.ensureDb(), provider);
  }

  snapshot(): PhoneTransportSnapshot {
    return {
      ...this.receiptCounts(),
      outboundSent: this.countOutboundByAction("sent"),
      outboundFailed: this.countOutboundByAction("failed")
    };
  }

  protected channelSchema(): string {
    return `
      CREATE TABLE IF NOT EXISTS pending_call_transcripts (
        provider TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        source TEXT NOT NULL,
        call_json TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        last_error TEXT,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(provider, provider_event_id)
      );
      CREATE TABLE IF NOT EXISTS phone_poll_checkpoints (
        provider TEXT PRIMARY KEY,
        provider_cursor TEXT,
        last_processed_id TEXT,
        checkpoint_timestamp TEXT,
        active_scan_id INTEGER,
        last_scan_id INTEGER NOT NULL DEFAULT 0,
        next_page_index INTEGER NOT NULL DEFAULT 0,
        owner_id TEXT,
        owner_lease_expires_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS phone_poll_messages (
        provider TEXT NOT NULL,
        provider_event_id TEXT NOT NULL,
        scan_id INTEGER NOT NULL,
        page_index INTEGER NOT NULL,
        page_position INTEGER NOT NULL,
        message_json TEXT NOT NULL,
        staged_at TEXT NOT NULL,
        PRIMARY KEY(provider, provider_event_id)
      );
      CREATE INDEX IF NOT EXISTS idx_phone_pending_call_transcripts_due ON pending_call_transcripts(next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_phone_poll_messages_order ON phone_poll_messages(provider, scan_id, page_index, page_position);
    `;
  }

  private pollCheckpointInDb(db: DatabaseSync, provider: string): PhonePollCheckpoint | null {
    const row = this.pollCheckpointRowInDb(db, provider);
    return row ? {
      provider: row.provider,
      providerCursor: row.providerCursor,
      lastProcessedId: row.lastProcessedId,
      checkpointTimestamp: row.checkpointTimestamp,
      activeScanId: row.activeScanId,
      nextPageIndex: row.nextPageIndex
    } : null;
  }

  private pollCheckpointRowInDb(db: DatabaseSync, provider: string): PollCheckpointRow | null {
    const value = db.prepare(`
      SELECT provider, provider_cursor, last_processed_id, checkpoint_timestamp, active_scan_id, next_page_index,
        last_scan_id, owner_id, owner_lease_expires_at
      FROM phone_poll_checkpoints WHERE provider = ?
    `).get(provider);
    if (!isRecord(value)) return null;
    const savedProvider = stringField(value.provider);
    if (!savedProvider) return null;
    return {
      provider: savedProvider,
      providerCursor: nullableStringField(value.provider_cursor),
      lastProcessedId: nullableStringField(value.last_processed_id),
      checkpointTimestamp: nullableStringField(value.checkpoint_timestamp),
      activeScanId: nullableNumberField(value.active_scan_id),
      nextPageIndex: numberField(value.next_page_index),
      lastScanId: numberField(value.last_scan_id),
      ownerId: nullableStringField(value.owner_id),
      ownerLeaseExpiresAt: nullableStringField(value.owner_lease_expires_at)
    };
  }

  private requirePollOwnerInDb(db: DatabaseSync, provider: string, ownerId: string): PollCheckpointRow {
    const row = this.pollCheckpointRowInDb(db, provider);
    if (!row || row.ownerId !== ownerId || !row.ownerLeaseExpiresAt || row.ownerLeaseExpiresAt <= this.isoNow()) {
      throw new Error(`AgentPhone poll ownership was lost for ${provider}`);
    }
    return row;
  }
}

function count(db: DatabaseSync, sql: string): number {
  return optionalCountRow(db.prepare(sql).get())?.count ?? 0;
}

function optionalCountRow(value: unknown): CountRow | null {
  if (!isRecord(value)) return null;
  const raw = value.count;
  if (typeof raw === "number" && Number.isFinite(raw)) return { count: raw };
  if (typeof raw === "bigint") return { count: Number(raw) };
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableStringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nullableNumberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function transcriptRetryDelayMs(attempts: number): number {
  // Delayed provider transcription commonly settles within seconds. Bound retries
  // to five minutes so unavailable transcripts do not create a hot polling loop.
  return Math.min(5 * 60_000, 5_000 * 2 ** Math.max(0, attempts - 1));
}
