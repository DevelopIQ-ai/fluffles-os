import { existsSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type ChatChannel = "slack" | "email" | "phone" | "web";
export type ConversationStatus = "queued" | "running" | "done" | "failed" | "stopped";

export interface ChatStoreOptions {
  ledgerPath: string;
}

export interface ConversationFilters {
  channels?: ChatChannel[];
  status?: ConversationStatus | "all";
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ConversationSummary {
  id: string;
  channel: ChatChannel;
  conversationKey: string;
  title: string | null;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  messageCount: number;
  runCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastAuthorId: string | null;
}

export interface ChatMessage {
  id: string;
  direction: "inbound" | "outbound" | "system";
  kind: string;
  externalMessageId: string | null;
  authorId: string | null;
  text: string;
  receivedAt: string;
  runId: string | null;
  taskMessageId: string | null;
  metadata: JsonObject;
}

export interface ChatRun {
  id: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  messageIds: string[];
}

export interface ChatConversation extends ConversationSummary {
  replyTarget: JsonObject | null;
  metadata: JsonObject;
  messages: ChatMessage[];
  runs: ChatRun[];
}

export interface ChannelSnapshot {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  stopped: number;
}

export interface ChatSnapshot {
  ledgerPath: string;
  ledgerExists: boolean;
  total: number;
  byChannel: Record<ChatChannel, ChannelSnapshot>;
  byStatus: Record<ConversationStatus, number>;
  lastUpdatedAt: string | null;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type RuntimeRecord = Record<string, unknown>;

const chatChannels: readonly ChatChannel[] = ["slack", "email", "phone", "web"];
const chatChannelSql = chatChannels.map((channel) => `'${channel}'`).join(", ");
const conversationStatuses: readonly ConversationStatus[] = ["queued", "running", "done", "failed", "stopped"];
const maxLimit = 500;

export class LedgerChatStore {
  private readonly ledgerPath: string;
  private db: DatabaseSync | null = null;

  constructor(options: ChatStoreOptions) {
    this.ledgerPath = options.ledgerPath;
  }

  snapshot(): ChatSnapshot {
    const snapshot = emptySnapshot(this.ledgerPath, existsSync(this.ledgerPath));
    if (!snapshot.ledgerExists) return snapshot;
    const db = this.ensureDb();
    const rows = recordArray(db.prepare(`
      SELECT channel, status, COUNT(*) AS count
      FROM conversations
      WHERE channel IN (${chatChannelSql})
      GROUP BY channel, status
    `).all(), "snapshot rows");
    for (const row of rows) {
      const channel = chatChannel(requiredString(row, "channel", "snapshot row"));
      const status = conversationStatus(requiredString(row, "status", "snapshot row"));
      const count = numberField(row, "count", "snapshot row");
      snapshot.byChannel[channel][status] = count;
      snapshot.byChannel[channel].total += count;
      snapshot.byStatus[status] += count;
      snapshot.total += count;
    }
    const lastRow = optionalRecord(db.prepare(`
      SELECT MAX(updated_at) AS lastUpdatedAt
      FROM conversations
      WHERE channel IN (${chatChannelSql})
    `).get());
    snapshot.lastUpdatedAt = lastRow ? nullableString(lastRow, "lastUpdatedAt", "snapshot lastUpdatedAt") : null;
    return snapshot;
  }

  listConversations(filters: ConversationFilters = {}): ConversationSummary[] {
    if (!existsSync(this.ledgerPath)) return [];
    const db = this.ensureDb();
    const channels = normalizedChannels(filters.channels);
    const limit = clampInteger(filters.limit ?? 200, 1, maxLimit);
    const offset = clampInteger(filters.offset ?? 0, 0, Number.MAX_SAFE_INTEGER);
    const clauses: string[] = [`c.channel IN (${channels.map(() => "?").join(", ")})`];
    const params: SQLInputValue[] = [...channels];

    if (filters.status && filters.status !== "all") {
      clauses.push("c.status = ?");
      params.push(conversationStatus(filters.status));
    }

    const search = filters.search?.trim();
    if (search) {
      const like = `%${search}%`;
      clauses.push(`(
        c.conversation_key LIKE ?
        OR c.title LIKE ?
        OR EXISTS (
          SELECT 1 FROM messages sm
          WHERE sm.channel = c.channel
            AND sm.conversation_key = c.conversation_key
            AND sm.text LIKE ?
        )
      )`);
      params.push(like, like, like);
    }

    params.push(limit, offset);
    const rows = recordArray(db.prepare(`
      SELECT
        c.id,
        c.channel,
        c.conversation_key AS conversationKey,
        c.title,
        c.status,
        c.created_at AS createdAt,
        c.updated_at AS updatedAt,
        c.last_error AS lastError,
        COUNT(e.id) AS messageCount,
        (
          SELECT COUNT(*)
          FROM runs r
          WHERE r.channel = c.channel
            AND r.conversation_key = c.conversation_key
        ) AS runCount,
        MAX(e.received_at) AS lastMessageAt,
        (
          SELECT lm.text
          FROM messages lm
          WHERE lm.channel = c.channel
            AND lm.conversation_key = c.conversation_key
          ORDER BY lm.seq DESC, lm.id DESC
          LIMIT 1
        ) AS lastMessageText,
        (
          SELECT lm.author_id
          FROM messages lm
          WHERE lm.channel = c.channel
            AND lm.conversation_key = c.conversation_key
          ORDER BY lm.seq DESC, lm.id DESC
          LIMIT 1
        ) AS lastAuthorId
      FROM conversations c
      LEFT JOIN messages e
        ON e.channel = c.channel
       AND e.conversation_key = c.conversation_key
      WHERE ${clauses.join(" AND ")}
      GROUP BY c.channel, c.conversation_key
      ORDER BY COALESCE(MAX(e.received_at), c.updated_at) DESC, c.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params), "conversation summary rows");
    return rows.map(conversationSummaryFromRow);
  }

  getConversation(channel: ChatChannel, conversationKey: string): ChatConversation | null {
    if (!existsSync(this.ledgerPath)) return null;
    const db = this.ensureDb();
    const row = optionalRecord(db.prepare(`
      SELECT
        c.id,
        c.channel,
        c.conversation_key AS conversationKey,
        c.title,
        c.status,
        c.created_at AS createdAt,
        c.updated_at AS updatedAt,
        c.last_error AS lastError,
        c.reply_target_json AS replyTargetJson,
        c.metadata_json AS metadataJson,
        (
          SELECT COUNT(*)
          FROM messages m
          WHERE m.channel = c.channel
            AND m.conversation_key = c.conversation_key
        ) AS messageCount,
        (
          SELECT COUNT(*)
          FROM runs r
          WHERE r.channel = c.channel
            AND r.conversation_key = c.conversation_key
        ) AS runCount,
        (
          SELECT MAX(m.received_at)
          FROM messages m
          WHERE m.channel = c.channel
            AND m.conversation_key = c.conversation_key
        ) AS lastMessageAt,
        (
          SELECT lm.text
          FROM messages lm
          WHERE lm.channel = c.channel
            AND lm.conversation_key = c.conversation_key
          ORDER BY lm.seq DESC, lm.id DESC
          LIMIT 1
        ) AS lastMessageText,
        (
          SELECT lm.author_id
          FROM messages lm
          WHERE lm.channel = c.channel
            AND lm.conversation_key = c.conversation_key
          ORDER BY lm.seq DESC, lm.id DESC
          LIMIT 1
        ) AS lastAuthorId
      FROM conversations c
      WHERE c.channel = ? AND c.conversation_key = ?
    `).get(chatChannel(channel), conversationKey));
    if (!row) return null;

    const messages = recordArray(db.prepare(`
      SELECT
        id,
        role,
        external_message_id AS externalMessageId,
        author_id AS authorId,
        text,
        received_at AS receivedAt,
        run_id AS runId,
        metadata_json AS metadataJson
      FROM messages
      WHERE channel = ? AND conversation_key = ?
      ORDER BY seq ASC, id ASC
    `).all(channel, conversationKey), "conversation messages").map(messageFromRow);

    const runs = recordArray(db.prepare(`
      SELECT id, status, started_at AS startedAt, finished_at AS finishedAt, error
      FROM runs
      WHERE channel = ? AND conversation_key = ?
      ORDER BY started_at ASC, id ASC
    `).all(channel, conversationKey), "conversation runs").map((run) => runFromRow(run, messages));

    return {
      ...conversationSummaryFromRow(row),
      replyTarget: parseJsonObjectOrNull(requiredString(row, "replyTargetJson", "conversation row"), "reply target"),
      metadata: parseJsonObject(requiredString(row, "metadataJson", "conversation row"), "conversation metadata"),
      messages,
      runs
    };
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private ensureDb(): DatabaseSync {
    if (this.db) return this.db;
    const db = new DatabaseSync(this.ledgerPath);
    db.exec("PRAGMA query_only = ON;");
    this.db = db;
    return db;
  }
}

function emptySnapshot(ledgerPath: string, ledgerExists: boolean): ChatSnapshot {
  return {
    ledgerPath,
    ledgerExists,
    total: 0,
    byChannel: {
      slack: emptyChannelSnapshot(),
      email: emptyChannelSnapshot(),
      phone: emptyChannelSnapshot(),
      web: emptyChannelSnapshot()
    },
    byStatus: {
      queued: 0,
      running: 0,
      done: 0,
      failed: 0,
      stopped: 0
    },
    lastUpdatedAt: null
  };
}

function emptyChannelSnapshot(): ChannelSnapshot {
  return {
    total: 0,
    queued: 0,
    running: 0,
    done: 0,
    failed: 0,
    stopped: 0
  };
}

function normalizedChannels(channels: ChatChannel[] | undefined): ChatChannel[] {
  if (!channels || channels.length === 0) return [...chatChannels];
  return [...new Set(channels.map(chatChannel))];
}

function conversationSummaryFromRow(row: RuntimeRecord): ConversationSummary {
  return {
    id: requiredString(row, "id", "conversation row"),
    channel: chatChannel(requiredString(row, "channel", "conversation row")),
    conversationKey: requiredString(row, "conversationKey", "conversation row"),
    title: nullableString(row, "title", "conversation row"),
    status: conversationStatus(requiredString(row, "status", "conversation row")),
    createdAt: requiredString(row, "createdAt", "conversation row"),
    updatedAt: requiredString(row, "updatedAt", "conversation row"),
    lastError: nullableString(row, "lastError", "conversation row"),
    messageCount: numberField(row, "messageCount", "conversation row"),
    runCount: numberField(row, "runCount", "conversation row"),
    lastMessageAt: nullableString(row, "lastMessageAt", "conversation row"),
    lastMessagePreview: preview(nullableString(row, "lastMessageText", "conversation row")),
    lastAuthorId: nullableString(row, "lastAuthorId", "conversation row")
  };
}

function messageFromRow(row: RuntimeRecord): ChatMessage {
  const id = requiredString(row, "id", "message row");
  return {
    id,
    direction: directionFromRole(requiredString(row, "role", "message row")),
    kind: "message",
    externalMessageId: nullableString(row, "externalMessageId", "message row"),
    authorId: nullableString(row, "authorId", "message row"),
    text: requiredString(row, "text", "message row"),
    receivedAt: requiredString(row, "receivedAt", "message row"),
    runId: nullableString(row, "runId", "message row"),
    taskMessageId: id,
    metadata: parseJsonObject(requiredString(row, "metadataJson", "message row"), "message metadata")
  };
}

function runFromRow(row: RuntimeRecord, messages: ChatMessage[]): ChatRun {
  const id = requiredString(row, "id", "run row");
  return {
    id,
    status: requiredString(row, "status", "run row"),
    startedAt: requiredString(row, "startedAt", "run row"),
    finishedAt: nullableString(row, "finishedAt", "run row"),
    error: nullableString(row, "error", "run row"),
    messageIds: messages.filter((message) => message.runId === id).map((message) => message.taskMessageId || message.id)
  };
}

function chatChannel(value: string): ChatChannel {
  if ((chatChannels as readonly string[]).includes(value)) return value as ChatChannel;
  throw new Error(`invalid chat channel: ${value}`);
}

function conversationStatus(value: string): ConversationStatus {
  if ((conversationStatuses as readonly string[]).includes(value)) return value as ConversationStatus;
  throw new Error(`invalid conversation status: ${value}`);
}

function directionFromRole(role: string): ChatMessage["direction"] {
  if (role === "user") return "inbound";
  if (role === "assistant") return "outbound";
  return "system";
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function preview(text: string | null): string | null {
  const normalized = text?.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function parseJsonObject(text: string, context: string): JsonObject {
  const value = JSON.parse(text) as unknown;
  if (isJsonObject(value)) return value;
  throw new Error(`${context} must be a JSON object`);
}

function parseJsonObjectOrNull(text: string, context: string): JsonObject | null {
  const value = JSON.parse(text) as unknown;
  if (value === null) return null;
  if (isJsonObject(value)) return value;
  throw new Error(`${context} must be a JSON object or null`);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") return true;
  if (valueType === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === "object" && value !== null) return Object.values(value).every(isJsonValue);
  return false;
}

function recordArray(value: unknown[], context: string): RuntimeRecord[] {
  return value.map((item, index) => requireRecord(item, `${context}[${index}]`));
}

function optionalRecord(value: unknown): RuntimeRecord | null {
  if (value == null) return null;
  return requireRecord(value, "optional record");
}

function requireRecord(value: unknown, context: string): RuntimeRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${context} must be an object`);
  return value as RuntimeRecord;
}

function requiredString(record: RuntimeRecord, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${context}.${key} must be a string`);
  return value;
}

function nullableString(record: RuntimeRecord, key: string, context: string): string | null {
  const value = record[key];
  if (value == null) return null;
  if (typeof value !== "string") throw new Error(`${context}.${key} must be a string or null`);
  return value;
}

function numberField(record: RuntimeRecord, key: string, context: string): number {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`${context}.${key} must be a number`);
}
