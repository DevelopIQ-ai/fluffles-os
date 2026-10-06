import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  ConversationEngine,
  ConversationKey,
  SQLiteTaskLedger,
  type JsonObject,
  type TaskLedgerConversation,
  type TaskLedgerMessageInput,
  type TaskLedgerRecordMessageResult
} from "@fluffles/tasks";

export interface NormalizedEmail {
  provider: string;
  id: string | null;
  threadId: string | null;
  from: string;
  to: string;
  subject: string;
  date: string;
  internalDate?: string | null;
  messageId: string | null;
  references: string[];
  inReplyTo: string | null;
  headers: Record<string, string>;
  text: string;
  labels: string[];
}

export interface EmailClassification {
  shouldReply: boolean;
  confidence?: string;
  reason?: string;
  sender?: string;
  subject?: string;
}

export interface RecordEmailTaskOptions {
  ledgerPath?: string;
  now?: () => Date;
  idFactory?: () => string;
}

export interface RecordEmailTaskResult extends TaskLedgerRecordMessageResult {
  ledgerPath: string;
}

export const DEFAULT_TASK_LEDGER_PATH =
  process.env.EMAIL_TASK_LEDGER_PATH || path.join(process.env.HOME ?? os.homedir(), "state", "tasks", "tasks.sqlite");

export function emailConversationKey(email: NormalizedEmail, mailboxIdentity?: string): string {
  const threadId = nonEmpty(email.threadId);
  const accountId = emailAccountId(email, mailboxIdentity);
  if (threadId) return ConversationKey.forEmail(accountId, threadId);

  const referencedRoot = email.references.find((reference) => nonEmpty(reference)) || nonEmpty(email.inReplyTo);
  if (referencedRoot) return ConversationKey.forEmail(accountId, referencedRoot);

  return ConversationKey.forEmail(accountId, emailExternalMessageId(email));
}

/** Pre-Step-1 keys emitted by the email adapter before canonical email:<account>:<thread> keys. */
export function legacyEmailConversationKeys(email: NormalizedEmail): string[] {
  const provider = legacyProviderKeySegment(email.provider);
  const threadId = nonEmpty(email.threadId);
  if (threadId) return [`${provider}-thread:${threadId}`];

  const referencedRoot = email.references.find((reference) => nonEmpty(reference)) || nonEmpty(email.inReplyTo);
  if (referencedRoot) return [`${provider}-thread:${referencedRoot}`];

  return [`${provider}-message:${emailExternalMessageId(email)}`];
}

export interface EmailConversationKeyMigrationStore {
  getConversation(channel: "email", conversationKey: string): Promise<TaskLedgerConversation | null>;
  migrateConversationKey(channel: "email", legacyKey: string, canonicalKey: string): Promise<TaskLedgerConversation | null>;
}

/** Resolve an email key without moving active work out from under the current run. */
export async function resolveEmailConversationKey(
  store: EmailConversationKeyMigrationStore,
  email: NormalizedEmail,
  mailboxIdentity?: string
): Promise<string> {
  const canonicalKey = emailConversationKey(email, mailboxIdentity);
  if (await store.getConversation("email", canonicalKey)) return canonicalKey;

  for (const legacyKey of legacyEmailConversationKeys(email)) {
    const legacy = await store.getConversation("email", legacyKey);
    if (!legacy) continue;
    if (legacy.status === "running" || legacy.activeRunId) return legacyKey;
    await store.migrateConversationKey("email", legacyKey, canonicalKey);
    return canonicalKey;
  }

  return canonicalKey;
}

export function emailExternalMessageId(email: NormalizedEmail): string {
  return nonEmpty(email.messageId) || nonEmpty(email.id) || stableMessageFingerprint(email);
}

export function buildEmailLedgerInput(
  email: NormalizedEmail,
  classification: EmailClassification
): TaskLedgerMessageInput {
  if (!classification.shouldReply) {
    throw new Error("Refusing to enqueue email that classifier did not accept.");
  }

  return buildIncomingEmailLedgerInput(email, classification);
}

export function buildIncomingEmailLedgerInput(
  email: NormalizedEmail,
  classification: EmailClassification | null = null,
  mailboxIdentity?: string
): TaskLedgerMessageInput {
  const input: TaskLedgerMessageInput = {
    channel: "email",
    conversationKey: emailConversationKey(email, mailboxIdentity),
    externalMessageId: emailExternalMessageId(email),
    authorId: classification?.sender || senderAddress(email.from),
    text: emailLedgerText(email),
    title: email.subject || "email request",
    replyTarget: {
      type: "email_thread",
      provider: email.provider,
      providerMessageId: email.id,
      threadId: email.threadId,
      messageId: email.messageId,
      references: email.references,
      inReplyTo: email.inReplyTo,
      from: email.from,
      to: email.to,
      subject: email.subject
    },
    metadata: emailMetadata(email, classification)
  };
  const receivedAt = receivedAtIso(email.date);
  if (receivedAt) input.receivedAt = receivedAt;
  return input;
}

export async function recordEmailTask(
  email: NormalizedEmail,
  classification: EmailClassification,
  options: RecordEmailTaskOptions = {}
): Promise<RecordEmailTaskResult> {
  const ledgerPath = options.ledgerPath || DEFAULT_TASK_LEDGER_PATH;
    const ledger = new SQLiteTaskLedger({
    filePath: ledgerPath,
    ...(options.now ? { now: options.now } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {})
  });
  try {
    const engine = new ConversationEngine({ ledger });
    const input = buildEmailLedgerInput(email, classification);
    input.conversationKey = await resolveEmailConversationKey(engine, email);
    const result = await engine.admit({ ...input, intakeMode: "direct" }, {
      actionable: classification.shouldReply,
      reason: classification.reason ?? null,
      controlText: email.text
    });
    return { conversation: result.conversation, message: result.message, disposition: result.disposition, ledgerPath };
  } finally {
    ledger.close();
  }
}

function emailLedgerText(email: NormalizedEmail): string {
  const body = email.text.trim();
  return [
    `From: ${email.from || "(unknown)"}`,
    `To: ${email.to || "(unknown)"}`,
    `Subject: ${email.subject || "(no subject)"}`,
    "",
    body
  ].join("\n").trim();
}

function emailMetadata(email: NormalizedEmail, classification: EmailClassification | null): JsonObject {
  return {
    provider: email.provider,
    id: email.id,
    providerMessageId: email.id,
    threadId: email.threadId,
    messageId: email.messageId,
    from: email.from,
    to: email.to,
    subject: email.subject,
    date: email.date,
    internalDate: email.internalDate ?? null,
    labels: email.labels,
    classification: {
      shouldReply: classification?.shouldReply ?? null,
      confidence: classification?.confidence || null,
      reason: classification?.reason || null,
      sender: classification?.sender || null,
      subject: classification?.subject || null
    },
    headers: selectedHeaders(email.headers)
  };
}

function selectedHeaders(headers: Record<string, string>): JsonObject {
  const keep = [
    "message-id",
    "in-reply-to",
    "references",
    "list-id",
    "list-unsubscribe",
    "auto-submitted",
    "precedence"
  ];
  const out: JsonObject = {};
  for (const key of keep) {
    const value = headers[key];
    if (value) out[key] = value;
  }
  return out;
}

function senderAddress(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const match = text.match(/<([^>]+)>/);
  const address = (match?.[1] || text).trim().toLowerCase();
  return address.includes("@") ? address : null;
}

function emailAccountId(email: NormalizedEmail, mailboxIdentity?: string): string {
  const configuredIdentity = nonEmpty(mailboxIdentity);
  if (configuredIdentity) return configuredIdentity.toLowerCase();
  return senderAddress(email.to) || nonEmpty(email.to) || nonEmpty(email.provider) || "email";
}

function receivedAtIso(value: string): string | null {
  if (!value.trim()) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function stableMessageFingerprint(email: NormalizedEmail): string {
  const hash = createHash("sha256");
  hash.update(email.provider);
  hash.update("\0");
  hash.update(email.from);
  hash.update("\0");
  hash.update(email.to);
  hash.update("\0");
  hash.update(email.subject);
  hash.update("\0");
  hash.update(email.date);
  hash.update("\0");
  hash.update(email.text.slice(0, 4096));
  return `sha256:${hash.digest("hex").slice(0, 32)}`;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed : null;
}

function legacyProviderKeySegment(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "email";
}
