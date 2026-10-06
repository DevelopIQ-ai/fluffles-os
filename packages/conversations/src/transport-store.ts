import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JsonObject } from "./types";

/**
 * The receipt half of a channel's transport database.
 *
 * Every channel needs the same two things at its edge: a durable record that a
 * provider event was seen, so a retry is not admitted twice, and a durable
 * record of what was sent back. Only the surrounding metadata differs per
 * channel, so it lives in `details_json` rather than in bespoke columns, and
 * the tables, the dedupe key, and the counters are shared.
 *
 * Channel-specific tables (Gmail cursors, AgentPhone poll checkpoints) stay
 * with the channel via `channelSchema`, in the same file, so a channel keeps a
 * single transactional database.
 */

export type TransportInboundAction = "accepted" | "skipped" | "duplicate" | "error";

export interface TransportInboundReceipt {
  provider: string;
  providerEventId: string;
  action: TransportInboundAction;
  details: JsonObject;
  taskConversationKey?: string | null | undefined;
  taskDisposition?: string | null | undefined;
  error?: string | null | undefined;
  receivedAt?: string | undefined;
}

export interface TransportOutboundReceipt {
  conversationKey: string;
  runId: string;
  provider: string;
  providerMessageId: string;
  action: string;
  mode: string;
  destination?: string | null | undefined;
  response?: JsonObject | null | undefined;
  error?: string | null | undefined;
}

export interface TransportReceiptCounts {
  inboundTotal: number;
  inboundAccepted: number;
  inboundSkipped: number;
  inboundErrors: number;
  outboundTotal: number;
}

const INBOUND_RECEIPTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS inbound_receipts (
    provider TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    action TEXT NOT NULL,
    details_json TEXT NOT NULL,
    task_conversation_key TEXT,
    task_disposition TEXT,
    error TEXT,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(provider, provider_event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_transport_inbound_updated ON inbound_receipts(updated_at);
  CREATE INDEX IF NOT EXISTS idx_transport_inbound_conversation ON inbound_receipts(task_conversation_key, received_at);
`;

export const TRANSPORT_RECEIPTS_SCHEMA = `
  ${INBOUND_RECEIPTS_SCHEMA}
  CREATE TABLE IF NOT EXISTS outbound_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_key TEXT NOT NULL,
    run_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    destination TEXT,
    provider_message_id TEXT NOT NULL,
    action TEXT NOT NULL,
    mode TEXT NOT NULL,
    response_json TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_transport_outbound_conversation ON outbound_receipts(conversation_key, run_id);
`;

/** Inbound receipts only, for a channel whose outbound history lives in the ledger. */
export const TRANSPORT_INBOUND_SCHEMA = INBOUND_RECEIPTS_SCHEMA;

export function hasInboundReceiptInDb(db: DatabaseSync, provider: string, providerEventId: string): boolean {
  const row = optionalCountRow(db.prepare(`
    SELECT COUNT(*) AS count FROM inbound_receipts WHERE provider = ? AND provider_event_id = ?
  `).get(provider, providerEventId));
  return (row?.count ?? 0) > 0;
}

export function recordInboundReceiptInDb(db: DatabaseSync, input: TransportInboundReceipt, now: string): void {
  db.prepare(`
    INSERT INTO inbound_receipts (
      provider, provider_event_id, action, details_json,
      task_conversation_key, task_disposition, error, received_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, provider_event_id) DO UPDATE SET
      action = excluded.action,
      details_json = excluded.details_json,
      task_conversation_key = excluded.task_conversation_key,
      task_disposition = excluded.task_disposition,
      error = excluded.error,
      updated_at = excluded.updated_at
  `).run(
    input.provider,
    input.providerEventId,
    input.action,
    JSON.stringify(input.details),
    input.taskConversationKey ?? null,
    input.taskDisposition ?? null,
    input.error ?? null,
    input.receivedAt ?? now,
    now
  );
}

/** Insert only if this provider event has never been seen. Returns false on a duplicate. */
export function claimInboundReceiptInDb(db: DatabaseSync, input: TransportInboundReceipt, now: string): boolean {
  if (hasInboundReceiptInDb(db, input.provider, input.providerEventId)) return false;
  recordInboundReceiptInDb(db, input, now);
  return true;
}

export abstract class SQLiteTransportStore {
  protected readonly filePath: string;
  protected readonly now: () => Date;
  private db: DatabaseSync | null = null;

  constructor(options: { filePath: string; now?: () => Date }) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date());
  }

  /** Extra `CREATE TABLE`/`CREATE INDEX` statements this channel needs. */
  protected abstract channelSchema(): string;

  hasInboundReceipt(provider: string, providerEventId: string): boolean {
    return hasInboundReceiptInDb(this.ensureDb(), provider, providerEventId);
  }

  protected writeInboundReceipt(input: TransportInboundReceipt): void {
    recordInboundReceiptInDb(this.ensureDb(), input, this.isoNow());
  }

  protected writeOutboundReceipt(input: TransportOutboundReceipt): void {
    this.ensureDb().prepare(`
      INSERT INTO outbound_receipts (
        conversation_key, run_id, provider, destination, provider_message_id,
        action, mode, response_json, error, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.conversationKey,
      input.runId,
      input.provider,
      input.destination ?? null,
      input.providerMessageId,
      input.action,
      input.mode,
      JSON.stringify(input.response ?? null),
      input.error ?? null,
      this.isoNow()
    );
  }

  /** Counts every channel reports; per-action outbound counts stay channel-side. */
  protected receiptCounts(): TransportReceiptCounts {
    const db = this.ensureDb();
    return {
      inboundTotal: countRows(db, "SELECT COUNT(*) AS count FROM inbound_receipts"),
      inboundAccepted: countRows(db, "SELECT COUNT(*) AS count FROM inbound_receipts WHERE action = 'accepted'"),
      inboundSkipped: countRows(db, "SELECT COUNT(*) AS count FROM inbound_receipts WHERE action = 'skipped'"),
      inboundErrors: countRows(db, "SELECT COUNT(*) AS count FROM inbound_receipts WHERE action = 'error'"),
      outboundTotal: countRows(db, "SELECT COUNT(*) AS count FROM outbound_receipts")
    };
  }

  protected countOutboundByAction(action: string): number {
    const row = optionalCountRow(this.ensureDb()
      .prepare("SELECT COUNT(*) AS count FROM outbound_receipts WHERE action = ?")
      .get(action));
    return row?.count ?? 0;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  protected ensureDb(): DatabaseSync {
    if (this.db) return this.db;
    if (this.filePath !== ":memory:") mkdirSync(path.dirname(this.filePath), { recursive: true });
    const db = new DatabaseSync(this.filePath);
    this.db = db;
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
    `);
    migrateLegacyTransportReceipts(db);
    db.exec(`
      ${TRANSPORT_RECEIPTS_SCHEMA}
      ${this.channelSchema()}
    `);
    return db;
  }

  protected isoNow(): string {
    return this.now().toISOString();
  }
}

const CANONICAL_INBOUND_COLUMNS = [
  "provider",
  "provider_event_id",
  "action",
  "details_json",
  "task_conversation_key",
  "task_disposition",
  "error",
  "received_at",
  "updated_at"
];

/**
 * Rewrites a pre-unification receipt table in place.
 *
 * The old per-channel columns (email's `subject`/`sender`/`classification_json`
 * keyed on `provider_message_id`, phone's `conversation_id`/`sender`/`kind`)
 * become `details_json` under their original names, so a deployed database
 * keeps every row and every dedupe key it had.
 *
 * The whole rewrite is one transaction, because the alternative loses receipts
 * silently: the "already migrated?" question is answered by the shape of
 * `inbound_receipts`, so a crash partway through the copy would leave a table
 * that looks migrated but is missing rows, and every missing row is a provider
 * event that would be admitted a second time. A database left half migrated by
 * an earlier build is finished on the next open rather than abandoned.
 */
export function migrateLegacyTransportReceipts(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    resumeInterruptedInboundMigration(db);

    const inbound = tableColumns(db, "inbound_receipts");
    if (inbound.length && !inbound.includes("details_json")) {
      db.exec("ALTER TABLE inbound_receipts RENAME TO inbound_receipts_legacy");
      createCanonicalInboundReceipts(db);
      copyLegacyInboundReceipts(db);
      db.exec("DROP TABLE inbound_receipts_legacy");
    }

    // Email's outbound table predates AgentPhone's destination column.
    const outbound = tableColumns(db, "outbound_receipts");
    if (outbound.length && !outbound.includes("destination")) {
      db.exec("ALTER TABLE outbound_receipts ADD COLUMN destination TEXT");
    }
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction was not opened */ }
    throw error;
  }
}

/** Finishes a rewrite abandoned by a build that did not migrate atomically. */
function resumeInterruptedInboundMigration(db: DatabaseSync): void {
  if (!tableColumns(db, "inbound_receipts_legacy").length) return;
  if (!tableColumns(db, "inbound_receipts").length) createCanonicalInboundReceipts(db);
  copyLegacyInboundReceipts(db);
  db.exec("DROP TABLE inbound_receipts_legacy");
}

function createCanonicalInboundReceipts(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE inbound_receipts (
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      action TEXT NOT NULL,
      details_json TEXT NOT NULL,
      task_conversation_key TEXT,
      task_disposition TEXT,
      error TEXT,
      received_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(provider, provider_event_id)
    )
  `);
}

/** Copies `inbound_receipts_legacy` forward, keeping any row already migrated. */
function copyLegacyInboundReceipts(db: DatabaseSync): void {
  const columns = tableColumns(db, "inbound_receipts_legacy");
  const idColumn = columns.includes("provider_event_id") ? "provider_event_id" : "provider_message_id";
  const detailColumns = columns.filter((column) => column !== idColumn && !CANONICAL_INBOUND_COLUMNS.includes(column));
  const insert = db.prepare(`
    INSERT INTO inbound_receipts (
      provider, provider_event_id, action, details_json,
      task_conversation_key, task_disposition, error, received_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(provider, provider_event_id) DO NOTHING
  `);
  for (const row of db.prepare("SELECT * FROM inbound_receipts_legacy").all() as Array<Record<string, unknown>>) {
    const details: Record<string, unknown> = {};
    for (const column of detailColumns) {
      details[camelCase(column)] = column === "classification_json"
        ? parseJson(row[column])
        : row[column] ?? null;
    }
    insert.run(
      String(row.provider ?? ""),
      String(row[idColumn] ?? ""),
      String(row.action ?? "error"),
      JSON.stringify(details),
      nullableString(row.task_conversation_key),
      nullableString(row.task_disposition),
      nullableString(row.error),
      String(row.received_at ?? row.updated_at ?? ""),
      String(row.updated_at ?? row.received_at ?? "")
    );
  }
}

function tableColumns(db: DatabaseSync, table: string): string[] {
  const rows = db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<Record<string, unknown>>;
  return rows.map((row) => String(row.name));
}

function camelCase(column: string): string {
  return column.replace(/_json$/, "").replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function countRows(db: DatabaseSync, sql: string): number {
  return optionalCountRow(db.prepare(sql).get())?.count ?? 0;
}

function optionalCountRow(value: unknown): { count: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = (value as Record<string, unknown>).count;
  if (typeof raw === "number" && Number.isFinite(raw)) return { count: raw };
  if (typeof raw === "bigint") return { count: Number(raw) };
  return null;
}
