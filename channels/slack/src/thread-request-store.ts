import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ConversationAction,
  ConversationEngine,
  ConversationAdmission,
  ConversationRuntime,
  ConversationEngineIngestInput,
  ConversationEngineIngestResult,
  IntakeMode,
  JsonObject,
  TaskLedgerConversation,
  TaskLedgerMessage,
  TaskLedgerRun,
  TaskLedgerSnapshot,
  TRANSPORT_INBOUND_SCHEMA,
  claimInboundReceiptInDb,
} from "@fluffles/tasks";
import {
  nullableStringField,
  optionalEnumField,
  requiredEnumField,
  requiredStringField,
  requireRuntimeRecord
} from "./runtime-validators";
import { slackProviderMessageIdentity } from "./slack-message-identity";

export type SlackSurface = "ambient" | "mention" | "thread" | "dm" | "message";

export type ThreadRequestStatus = "queued" | "running" | "done" | "failed" | "stopped";

export type ThreadRunStatus = "running" | "done" | "failed" | "stopped" | "interrupted";

export type IntakeDisposition =
  | "new_request"
  | "thread_update"
  | "queued_update"
  | "running_update"
  | "filtered"
  | "duplicate";

export interface SlackEventForRequest {
  teamId: string;
  eventId: string | null;
  channel: string;
  channelType: string | null;
  user: string | null;
  ts: string;
  threadTs: string | null;
}

export interface RecordMessageInput {
  key: string;
  surface: SlackSurface;
  text: string;
  event: SlackEventForRequest;
  receivedAt?: string;
  /** Provider facts are supplied before persistence; the engine owns their lifecycle effect. */
  admission?: ConversationAdmission;
}

export interface ThreadRequestMessage {
  id: string;
  eventId: string | null;
  channel: string;
  channelType: string | null;
  user: string | null;
  ts: string;
  threadTs: string | null;
  text: string;
  receivedAt: string;
  runId: string | null;
}

export interface ThreadRun {
  id: string;
  status: ThreadRunStatus;
  startedAt: string;
  finishedAt: string | null;
  messageIds: string[];
  error: string | null;
}

export interface ThreadRequest {
  id: string;
  key: string;
  surface: SlackSurface;
  channel: string;
  channelType: string | null;
  rootTs: string;
  threadTs: string | null;
  user: string | null;
  status: ThreadRequestStatus;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
  messages: ThreadRequestMessage[];
  runs: ThreadRun[];
}

export interface ThreadRequestStoreData {
  version: 1;
  requests: Record<string, ThreadRequest>;
}

export interface RecordMessageResult {
  request: ThreadRequest;
  message: ThreadRequestMessage;
  disposition: IntakeDisposition;
}

export interface StartedRun {
  request: ThreadRequest;
  run: ThreadRun;
  messages: ThreadRequestMessage[];
  promptText: string;
}

export interface FinishRunResult {
  request: ThreadRequest;
  hasPendingMessages: boolean;
}

export interface RecoveryResult {
  recoveredKeys: string[];
  runnableKeys: string[];
}

export interface ThreadRequestSnapshot {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  stopped: number;
  oldestQueuedAt: string | null;
}

export type SlackRunStatus = "idle" | "running" | "retrying" | "stopped" | "error";

export interface SlackSessionRecord {
  key: string;
  sessionId: string;
  createdAt: string;
  channel: string;
  threadTs: string | null;
  surface: SlackSurface;
  user: string | null;
  codexSessionId: string | null;
  codexSessionCreatedAt: string | null;
  cwd: string | null;
  lastUsedAt: string | null;
  runStatus: SlackRunStatus | null;
  lastError: string | null;
  lastRunFinishedAt: string | null;
}

/** Provider-owned ingestion position. This is deliberately not runtime state. */
export interface SlackIngressCheckpoint {
  channel: string;
  lastEventTs: string;
  updatedAt: string;
}

export interface GetOrCreateSessionInput {
  key: string;
  channel: string;
  threadTs: string | null;
  surface: SlackSurface;
  user: string | null;
}

interface SQLiteThreadRequestStoreOptions {
  filePath: string;
  now?: () => Date;
  idFactory?: () => string;
  engine: ConversationEngine;
  runtime?: ConversationRuntime;
}

interface SessionRow {
  key: string;
  sessionId: string;
  createdAt: string;
  channel: string;
  threadTs: string | null;
  surface: SlackSurface;
  user: string | null;
  codexSessionId: string | null;
  codexSessionCreatedAt: string | null;
  cwd: string | null;
  lastUsedAt: string | null;
  runStatus: SlackRunStatus | null;
  lastError: string | null;
  lastRunFinishedAt: string | null;
}

type SlackConversationMetadata = {
  surface: SlackSurface;
  channel: string;
  channelType: string | null;
  rootTs: string;
  threadTs: string | null;
  user: string | null;
};

type SlackMessageMetadata = {
  eventId: string | null;
  channel: string;
  channelType: string | null;
  user: string | null;
  ts: string;
  threadTs: string | null;
  rootTs: string;
  surface: SlackSurface;
};

const slackSurfaceValues: readonly SlackSurface[] = ["ambient", "mention", "thread", "dm", "message"];
const slackRunStatusValues: readonly SlackRunStatus[] = ["idle", "running", "retrying", "stopped", "error"];

export class SQLiteThreadRequestStore {
  private readonly filePath: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly engine: ConversationEngine;
  private readonly runtime: ConversationRuntime;
  private db: DatabaseSync | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: SQLiteThreadRequestStoreOptions) {
    this.filePath = options.filePath;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? (() => randomUUID());
    this.engine = options.engine;
    this.runtime = options.runtime ?? new ConversationRuntime(options.engine);
  }

  async recordMessage(input: RecordMessageInput): Promise<RecordMessageResult> {
    const receivedAt = input.receivedAt ?? this.isoNow();
    const engineResult = await this.engine.admit(
      this.ingestInput(input, receivedAt),
      input.admission ?? { actionable: true, controlText: input.text }
    );
    await this.recordTransportReceipt(input, engineResult, receivedAt);
    return this.recordMessageResultFromEngine(engineResult);
  }

  async startRun(key: string): Promise<StartedRun | null> {
    const started = await this.runtime.startRun("slack", key);
    if (!started) return null;
    const request = this.threadRequestFromConversation(started.conversation);
    const messages = started.messages.map((message) => this.threadMessageFromLedger(message, request));
    return {
      request,
      run: this.threadRunFromLedger(started.run),
      messages,
      promptText: formatMessagesForPrompt(messages)
    };
  }

  async claimSteeringMessages(key: string, runId: string): Promise<ThreadRequestMessage[]> {
    const claimed = await this.runtime.claimSteeringMessages("slack", key, runId);
    const conversation = await this.runtime.getConversation("slack", key);
    if (!conversation) return [];
    const request = this.threadRequestFromConversation(conversation);
    return claimed.map((message) => this.threadMessageFromLedger(message, request));
  }

  async finishRun(key: string, runId: string, status: Exclude<ThreadRunStatus, "running">, error?: string): Promise<FinishRunResult | null> {
    const finished = await this.runtime.finishRun("slack", key, runId, status, error ?? null);
    if (!finished) return null;
    return {
      request: this.threadRequestFromConversation(finished.conversation),
      hasPendingMessages: finished.hasPendingMessages
    };
  }

  async markStopped(key: string, reason = "stopped"): Promise<ThreadRequest | null> {
    const stopped = await this.runtime.stop("slack", key, reason);
    return stopped ? this.threadRequestFromConversation(stopped) : null;
  }

  async getRequest(key: string): Promise<ThreadRequest | null> {
    const conversation = await this.runtime.getConversation("slack", key);
    return conversation ? this.threadRequestFromConversation(conversation) : null;
  }

  async migrateConversationKey(legacyKey: string, canonicalKey: string): Promise<boolean> {
    const legacyConversation = await this.runtime.getConversation("slack", legacyKey);
    const canonicalConversation = await this.runtime.getConversation("slack", canonicalKey);
    if (
      legacyConversation?.status === "running"
      || legacyConversation?.activeRunId
      || canonicalConversation?.status === "running"
      || canonicalConversation?.activeRunId
    ) return false;
    if (legacyConversation) {
      await this.runtime.migrateConversationKey("slack", legacyKey, canonicalKey);
    }

    return this.mutate<boolean>((db) => {
      const legacySession = this.getSessionInDb(db, legacyKey);
      const canonicalSession = this.getSessionInDb(db, canonicalKey);
      if (!legacyConversation && !legacySession) return false;

      if (legacySession && !canonicalSession) {
        db.prepare("UPDATE sessions SET key = ? WHERE key = ?").run(canonicalKey, legacyKey);
      } else if (legacySession) {
        db.prepare("DELETE FROM sessions WHERE key = ?").run(legacyKey);
      }
      db.prepare("UPDATE inbound_receipts SET task_conversation_key = ? WHERE task_conversation_key = ?")
        .run(canonicalKey, legacyKey);
      return true;
    });
  }

  async getOrCreateSession(input: GetOrCreateSessionInput): Promise<SlackSessionRecord> {
    return this.mutate<SlackSessionRecord>((db) => {
      const existing = this.getSessionInDb(db, input.key);
      if (existing) return cloneSession(existing);

      const session: SlackSessionRecord = {
        key: input.key,
        sessionId: this.idFactory(),
        createdAt: this.isoNow(),
        channel: input.channel,
        threadTs: input.threadTs,
        surface: input.surface,
        user: input.user,
        codexSessionId: null,
        codexSessionCreatedAt: null,
        cwd: null,
        lastUsedAt: null,
        runStatus: null,
        lastError: null,
        lastRunFinishedAt: null
      };
      this.upsertSession(db, session);
      return cloneSession(session);
    });
  }

  async getSession(key: string): Promise<SlackSessionRecord | null> {
    const session = this.getSessionInDb(this.ensureDb(), key);
    return session ? cloneSession(session) : null;
  }

  async saveSession(session: SlackSessionRecord): Promise<void> {
    await this.mutate<void>((db) => {
      this.upsertSession(db, session);
    });
  }

  async ingressCheckpoint(channel: string): Promise<SlackIngressCheckpoint | null> {
    const row = this.ensureDb().prepare(`
      SELECT channel, last_event_ts AS lastEventTs, updated_at AS updatedAt
      FROM ingress_checkpoints
      WHERE channel = ?
    `).get(channel) as { channel?: unknown; lastEventTs?: unknown; updatedAt?: unknown } | undefined;
    if (!row) return null;
    if (typeof row.channel !== "string" || typeof row.lastEventTs !== "string" || typeof row.updatedAt !== "string") {
      throw new Error("Invalid Slack ingress checkpoint row");
    }
    return { channel: row.channel, lastEventTs: row.lastEventTs, updatedAt: row.updatedAt };
  }

  /**
   * Advance a provider cursor monotonically. Concurrent pollers can replay an
   * event, but neither can move this durable checkpoint backwards.
   */
  async advanceIngressCheckpoint(channel: string, eventTs: string): Promise<SlackIngressCheckpoint> {
    return this.mutate<SlackIngressCheckpoint>((db) => {
      const existing = db.prepare(`
        SELECT last_event_ts AS lastEventTs FROM ingress_checkpoints WHERE channel = ?
      `).get(channel) as { lastEventTs?: unknown } | undefined;
      const lastEventTs = typeof existing?.lastEventTs === "string" && compareSlackTimestamps(existing.lastEventTs, eventTs) >= 0
        ? existing.lastEventTs
        : eventTs;
      const updatedAt = this.isoNow();
      db.prepare(`
        INSERT INTO ingress_checkpoints (channel, last_event_ts, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(channel) DO UPDATE SET
          last_event_ts = excluded.last_event_ts,
          updated_at = excluded.updated_at
      `).run(channel, lastEventTs, updatedAt);
      return { channel, lastEventTs, updatedAt };
    });
  }

  async recoverInterruptedRuns(options: { reclaimOwnLeases?: boolean } = {}): Promise<RecoveryResult> {
    return this.runtime.recover("slack", options);
  }

  async runnableRequests(): Promise<ThreadRequest[]> {
    const conversations = await this.runtime.runnableConversations("slack");
    return conversations.map((conversation) => this.threadRequestFromConversation(conversation));
  }

  async snapshot(): Promise<ThreadRequestSnapshot> {
    return threadSnapshotFromLedger(await this.runtime.snapshot("slack"));
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private ingestInput(input: RecordMessageInput, receivedAt: string): ConversationEngineIngestInput {
    const rootTs = input.event.threadTs ?? input.event.ts;
    const externalMessageId = slackProviderMessageIdentity(
      input.event.teamId,
      input.event.channel,
      input.event.ts
    );
    const intakeMode: IntakeMode = input.surface === "ambient" ? "ambient" : "direct";
    const messageMetadata: SlackMessageMetadata = {
      eventId: input.event.eventId,
      channel: input.event.channel,
      channelType: input.event.channelType,
      user: input.event.user,
      ts: input.event.ts,
      threadTs: input.event.threadTs,
      rootTs,
      surface: input.surface
    };
    const conversationMetadata: SlackConversationMetadata = {
      surface: input.surface,
      channel: input.event.channel,
      channelType: input.event.channelType,
      rootTs,
      threadTs: input.event.threadTs,
      user: input.event.user
    };
    const ingestInput: ConversationEngineIngestInput = {
      channel: "slack",
      conversationKey: input.key,
      externalMessageId,
      authorId: input.event.user,
      text: input.text,
      receivedAt,
      intakeMode,
      replyTarget: {
        type: "slack_thread",
        channel: input.event.channel,
        threadTs: rootTs
      },
      metadata: {
        ...conversationMetadata,
        latestMessage: messageMetadata
      }
    };
    const title = titleFromSlackText(input.text);
    if (title) ingestInput.title = title;
    return ingestInput;
  }

  private async recordTransportReceipt(
    input: RecordMessageInput,
    engineResult: ConversationEngineIngestResult,
    receivedAt: string
  ): Promise<void> {
    await this.mutate<void>((db) => {
      claimInboundReceiptInDb(db, {
        provider: "slack",
        providerEventId: eventDedupeKey(input.event),
        action: "accepted",
        taskConversationKey: input.key,
        receivedAt,
        details: {
          messageId: engineResult.message.id,
          eventId: input.event.eventId,
          channel: input.event.channel,
          channelType: input.event.channelType,
          user: input.event.user,
          ts: input.event.ts,
          threadTs: input.event.threadTs,
          surface: input.surface,
          text: input.text
        }
      }, receivedAt);
    });
  }

  private recordMessageResultFromEngine(result: ConversationEngineIngestResult): RecordMessageResult {
    const request = this.threadRequestFromConversation(result.conversation);
    return {
      request,
      message: this.threadMessageFromLedger(result.message, request),
      disposition: dispositionFromAction(result.action)
    };
  }

  private threadRequestFromConversation(conversation: TaskLedgerConversation): ThreadRequest {
    const metadata = slackConversationMetadataFromConversation(conversation);
    const messages = conversation.messages.map((message) => this.threadMessageFromLedger(message, metadata));
    return {
      id: conversation.id,
      key: conversation.conversationKey,
      surface: metadata.surface,
      channel: metadata.channel,
      channelType: metadata.channelType,
      rootTs: metadata.rootTs,
      threadTs: metadata.threadTs,
      user: metadata.user,
      status: conversation.status,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      lastError: conversation.lastError,
      messages,
      runs: conversation.runs.map((run) => this.threadRunFromLedger(run))
    };
  }

  private threadMessageFromLedger(message: TaskLedgerMessage, requestOrMetadata: ThreadRequest | SlackConversationMetadata): ThreadRequestMessage {
    const metadata = slackMessageMetadataFromMessage(message, requestOrMetadata);
    return {
      id: message.id,
      eventId: metadata.eventId,
      channel: metadata.channel,
      channelType: metadata.channelType,
      user: metadata.user,
      ts: metadata.ts,
      threadTs: metadata.threadTs,
      text: message.text,
      receivedAt: message.receivedAt,
      runId: message.runId
    };
  }

  private threadRunFromLedger(run: TaskLedgerRun): ThreadRun {
    return {
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      messageIds: [...run.messageIds],
      error: run.error
    };
  }

  private async mutate<T>(operation: (db: DatabaseSync) => T): Promise<T> {
    const run = this.writeChain.then(() => this.withTransaction(operation));
    this.writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private withTransaction<T>(operation: (db: DatabaseSync) => T): T {
    const db = this.ensureDb();
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation(db);
      db.exec("COMMIT");
      return value;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureDb(): DatabaseSync {
    if (this.db) return this.db;
    if (this.filePath !== ":memory:") mkdirSync(path.dirname(this.filePath), { recursive: true });
    const db = new DatabaseSync(this.filePath);
    this.db = db;
    this.initializeDb(db);
    return db;
  }

  private initializeDb(db: DatabaseSync): void {
    db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread_ts TEXT,
        surface TEXT NOT NULL,
        user TEXT,
        codex_session_id TEXT,
        codex_session_created_at TEXT,
        cwd TEXT,
        last_used_at TEXT,
        run_status TEXT,
        last_error TEXT,
        last_run_finished_at TEXT
      );


      CREATE TABLE IF NOT EXISTS ingress_checkpoints (
        channel TEXT PRIMARY KEY,
        last_event_ts TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      ${TRANSPORT_INBOUND_SCHEMA}
    `);
    migrateSlackEventReceipts(db);
  }

  private getSessionInDb(db: DatabaseSync, key: string): SlackSessionRecord | null {
    const row = sessionRowFromSql(db.prepare(`
      SELECT
        key,
        session_id AS sessionId,
        created_at AS createdAt,
        channel,
        thread_ts AS threadTs,
        surface,
        user,
        codex_session_id AS codexSessionId,
        codex_session_created_at AS codexSessionCreatedAt,
        cwd,
        last_used_at AS lastUsedAt,
        run_status AS runStatus,
        last_error AS lastError,
        last_run_finished_at AS lastRunFinishedAt
      FROM sessions
      WHERE key = ?
    `).get(key), "session row");
    return row ? sessionFromRow(row) : null;
  }

  private upsertSession(db: DatabaseSync, session: SlackSessionRecord): void {
    db.prepare(`
      INSERT INTO sessions (
        key,
        session_id,
        created_at,
        channel,
        thread_ts,
        surface,
        user,
        codex_session_id,
        codex_session_created_at,
        cwd,
        last_used_at,
        run_status,
        last_error,
        last_run_finished_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        session_id = excluded.session_id,
        created_at = excluded.created_at,
        channel = excluded.channel,
        thread_ts = excluded.thread_ts,
        surface = excluded.surface,
        user = excluded.user,
        codex_session_id = excluded.codex_session_id,
        codex_session_created_at = excluded.codex_session_created_at,
        cwd = excluded.cwd,
        last_used_at = excluded.last_used_at,
        run_status = excluded.run_status,
        last_error = excluded.last_error,
        last_run_finished_at = excluded.last_run_finished_at
    `).run(
      session.key,
      session.sessionId,
      session.createdAt,
      session.channel,
      session.threadTs,
      session.surface,
      session.user,
      session.codexSessionId,
      session.codexSessionCreatedAt,
      session.cwd,
      session.lastUsedAt,
      session.runStatus,
      session.lastError,
      session.lastRunFinishedAt
    );
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

function compareSlackTimestamps(left: string, right: string): number {
  const [leftSeconds, leftFraction = "0"] = left.split(".");
  const [rightSeconds, rightFraction = "0"] = right.split(".");
  const seconds = Number(leftSeconds) - Number(rightSeconds);
  if (seconds !== 0) return seconds;
  return Number(leftFraction) - Number(rightFraction);
}

export const FileThreadRequestStore = SQLiteThreadRequestStore;

export function formatMessagesForPrompt(messages: ThreadRequestMessage[]): string {
  if (messages.length === 1) {
    return messages[0]?.text.trim() || "[No visible Slack text]";
  }

  const formatted = messages.map((message) => {
    const author = message.user ? `<@${message.user}>` : "unknown";
    const text = message.text.trim() || "[No visible Slack text]";
    return `- ${message.ts} ${author}: ${text}`;
  });

  return [
    "The user added these messages to the same Slack request thread.",
    "Treat them as one updated instruction timeline. Later messages override earlier ones when they conflict.",
    "",
    ...formatted
  ].join("\n");
}

function threadSnapshotFromLedger(snapshot: TaskLedgerSnapshot): ThreadRequestSnapshot {
  return {
    total: snapshot.total,
    queued: snapshot.queued,
    running: snapshot.running,
    done: snapshot.done,
    failed: snapshot.failed,
    stopped: snapshot.stopped,
    oldestQueuedAt: snapshot.oldestQueuedAt
  };
}

function dispositionFromAction(action: ConversationAction): IntakeDisposition {
  switch (action.type) {
    case "start_run":
    case "restart":
      return "new_request";
    case "steer":
      return "running_update";
    case "none":
      return action.reason === "filtered" ? "filtered" : "duplicate";
  }
}

/**
 * Folds a deployed `event_receipts` table into the shared inbound receipts.
 *
 * Slack's dedupe key becomes the provider event id and its Slack-shaped
 * columns become `details_json`, so an existing database keeps every receipt
 * and stays deduplicated across the change.
 */
function migrateSlackEventReceipts(db: DatabaseSync): void {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_receipts'").get();
  if (!exists) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    copySlackEventReceipts(db);
    db.exec("DROP TABLE event_receipts");
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* transaction was not opened */ }
    throw error;
  }
}

function copySlackEventReceipts(db: DatabaseSync): void {
  const rows = db.prepare("SELECT * FROM event_receipts").all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    claimInboundReceiptInDb(db, {
      provider: "slack",
      providerEventId: String(row.dedupe_key ?? ""),
      action: "accepted",
      taskConversationKey: legacyText(row.conversation_key),
      receivedAt: typeof row.received_at === "string" ? row.received_at : undefined,
      details: {
        messageId: legacyText(row.message_id),
        eventId: legacyText(row.event_id),
        channel: legacyText(row.channel),
        channelType: legacyText(row.channel_type),
        user: legacyText(row.user),
        ts: legacyText(row.ts),
        threadTs: legacyText(row.thread_ts),
        surface: legacyText(row.surface),
        text: legacyText(row.text)
      }
    }, typeof row.received_at === "string" ? row.received_at : new Date().toISOString());
  }
}

function legacyText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function eventDedupeKey(event: SlackEventForRequest): string {
  return slackProviderMessageIdentity(event.teamId, event.channel, event.ts);
}

function titleFromSlackText(text: string): string | null {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized) return null;
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function slackConversationMetadataFromConversation(conversation: TaskLedgerConversation): SlackConversationMetadata {
  const metadata = conversation.metadata;
  const latest = jsonObjectValue(metadata.latestMessage);
  const replyTarget = conversation.replyTarget ?? {};
  const channel = stringValue(metadata.channel) ?? stringValue(replyTarget.channel) ?? stringValue(latest?.channel) ?? "";
  const rootTs = stringValue(metadata.rootTs) ?? stringValue(replyTarget.threadTs) ?? stringValue(latest?.rootTs) ?? "";
  const surface = enumValue(metadata.surface, slackSurfaceValues) ?? enumValue(latest?.surface, slackSurfaceValues) ?? "message";
  return {
    surface,
    channel,
    channelType: stringOrNull(metadata.channelType) ?? stringOrNull(latest?.channelType),
    rootTs,
    threadTs: stringOrNull(metadata.threadTs),
    user: stringOrNull(metadata.user)
  };
}

function slackMessageMetadataFromMessage(
  message: TaskLedgerMessage,
  requestOrMetadata: ThreadRequest | SlackConversationMetadata
): SlackMessageMetadata {
  const metadata = message.metadata;
  const fallbackChannel = requestOrMetadata.channel;
  const fallbackRootTs = requestOrMetadata.rootTs;
  const fallbackThreadTs = requestOrMetadata.threadTs;
  const fallbackSurface = requestOrMetadata.surface;
  const fallbackChannelType = requestOrMetadata.channelType;
  const fallbackUser = requestOrMetadata.user;
  return {
    eventId: stringOrNull(metadata.eventId),
    channel: stringValue(metadata.channel) ?? fallbackChannel,
    channelType: stringOrNull(metadata.channelType) ?? fallbackChannelType,
    user: stringOrNull(metadata.user) ?? message.authorId ?? fallbackUser,
    ts: stringValue(metadata.ts) ?? message.externalMessageId ?? message.id,
    threadTs: stringOrNull(metadata.threadTs) ?? fallbackThreadTs,
    rootTs: stringValue(metadata.rootTs) ?? fallbackRootTs,
    surface: enumValue(metadata.surface, slackSurfaceValues) ?? fallbackSurface
  };
}

function sessionFromRow(row: SessionRow): SlackSessionRecord {
  return {
    key: row.key,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    channel: row.channel,
    threadTs: row.threadTs,
    surface: row.surface,
    user: row.user,
    codexSessionId: row.codexSessionId,
    codexSessionCreatedAt: row.codexSessionCreatedAt,
    cwd: row.cwd,
    lastUsedAt: row.lastUsedAt,
    runStatus: row.runStatus,
    lastError: row.lastError,
    lastRunFinishedAt: row.lastRunFinishedAt
  };
}

function sessionRowFromSql(value: unknown, context: string): SessionRow | null {
  if (value == null) return null;
  const row = requireRuntimeRecord(value, context);
  return {
    key: requiredStringField(row, "key", context),
    sessionId: requiredStringField(row, "sessionId", context),
    createdAt: requiredStringField(row, "createdAt", context),
    channel: requiredStringField(row, "channel", context),
    threadTs: nullableStringField(row, "threadTs", context),
    surface: requiredEnumField(row, "surface", slackSurfaceValues, context),
    user: nullableStringField(row, "user", context),
    codexSessionId: nullableStringField(row, "codexSessionId", context),
    codexSessionCreatedAt: nullableStringField(row, "codexSessionCreatedAt", context),
    cwd: nullableStringField(row, "cwd", context),
    lastUsedAt: nullableStringField(row, "lastUsedAt", context),
    runStatus: optionalEnumField(row, "runStatus", slackRunStatusValues, context) ?? null,
    lastError: nullableStringField(row, "lastError", context),
    lastRunFinishedAt: nullableStringField(row, "lastRunFinishedAt", context)
  };
}

function cloneSession(session: SlackSessionRecord): SlackSessionRecord {
  return { ...session };
}

function jsonObjectValue(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return value == null || typeof value === "string" ? value ?? null : null;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : null;
}
