import { createHash } from "node:crypto";
import { ConversationKey, type JsonObject, type TaskLedgerConversation, type TaskLedgerMessageInput } from "@fluffles/tasks";
import { phoneCallExternalId, phoneMessageExternalId, type NormalizedPhoneCall, type NormalizedPhoneMessage } from "./phone-normalize";

export function phoneConversationKey(message: NormalizedPhoneMessage): string {
  return ConversationKey.forPhone(requiredProviderConversationId(message.conversationId));
}

export function phoneCallConversationKey(call: NormalizedPhoneCall): string {
  return ConversationKey.forPhone(requiredProviderConversationId(call.conversationId));
}

export interface PhoneConversationKeyMigrationStore {
  conversations(channel: "phone"): Promise<TaskLedgerConversation[]>;
  migrateConversationKey(channel: "phone", legacyKey: string, canonicalKey: string): Promise<TaskLedgerConversation | null>;
}

export async function resolvePhoneConversationKey(
  store: PhoneConversationKeyMigrationStore,
  message: NormalizedPhoneMessage
): Promise<string> {
  const conversationId = requiredProviderConversationId(message.conversationId);
  const canonicalKey = ConversationKey.forPhone(conversationId);
  await migrateProvenPhoneConversations(store, canonicalKey, conversationId);
  return canonicalKey;
}

export async function resolvePhoneCallConversationKey(
  _store: PhoneConversationKeyMigrationStore,
  call: NormalizedPhoneCall
): Promise<string> {
  return phoneCallConversationKey(call);
}

function requiredProviderConversationId(value: string | null | undefined): string {
  const conversationId = value?.trim();
  if (!conversationId) {
    throw new Error("phone event is missing provider conversation id");
  }
  return conversationId;
}

async function migrateProvenPhoneConversations(
  store: PhoneConversationKeyMigrationStore,
  canonicalKey: string,
  conversationId: string
): Promise<void> {
  const conversations = await store.conversations("phone");
  const canonical = conversations.find((conversation) => conversation.conversationKey === canonicalKey);
  const externalMessageIds = new Set(canonical ? messageExternalIds(canonical) : []);

  for (const conversation of conversations) {
    if (!isProvenPhoneMigrationCandidate(conversation, canonicalKey, conversationId, externalMessageIds)) continue;
    await store.migrateConversationKey("phone", conversation.conversationKey, canonicalKey);
    for (const externalMessageId of messageExternalIds(conversation)) externalMessageIds.add(externalMessageId);
  }
}

function isProvenPhoneMigrationCandidate(
  conversation: TaskLedgerConversation,
  canonicalKey: string,
  conversationId: string,
  existingExternalMessageIds: ReadonlySet<string>
): boolean {
  if (conversation.conversationKey === canonicalKey || conversation.status === "running" || conversation.activeRunId) return false;

  const inboundMessages = conversation.messages.filter((message) => message.role === "user");
  if (inboundMessages.length === 0 || inboundMessages.every((message) => message.metadata.kind === "call")) return false;
  if (!inboundMessages.every((message) => providerConversationIdFromMetadata(message.metadata) === conversationId)) return false;
  if (!conversationMetadataMatches(conversation.metadata, conversationId)) return false;
  if (conversation.replyTarget && !conversationMetadataMatches(conversation.replyTarget, conversationId)) return false;

  return messageExternalIds(conversation).every((externalMessageId) => !existingExternalMessageIds.has(externalMessageId));
}

function providerConversationIdFromMetadata(metadata: JsonObject): string | null {
  const value = metadata.conversationId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function conversationMetadataMatches(metadata: JsonObject, conversationId: string): boolean {
  const value = metadata.conversationId;
  return value == null || (typeof value === "string" && value.trim() === conversationId);
}

function messageExternalIds(conversation: TaskLedgerConversation): string[] {
  return conversation.messages.flatMap((message) => message.externalMessageId ? [message.externalMessageId] : []);
}

export function buildPhoneMessageLedgerInput(message: NormalizedPhoneMessage): TaskLedgerMessageInput {
  const input: TaskLedgerMessageInput = {
    channel: "phone",
    conversationKey: phoneConversationKey(message),
    externalMessageId: phoneMessageExternalId(message),
    authorId: message.fromNumber,
    text: phoneMessageLedgerText(message),
    title: `phone message from ${message.fromNumber || "unknown"}`,
    replyTarget: {
      type: "agentphone_conversation",
      provider: "agentphone",
      fromNumber: message.fromNumber,
      toNumber: message.toNumber,
      messageId: message.id,
      numberId: message.numberId,
      conversationId: message.conversationId
    },
    metadata: phoneMessageMetadata(message)
  };
  const receivedAt = receivedAtIso(message.receivedAt || message.createdAt);
  if (receivedAt) input.receivedAt = receivedAt;
  return input;
}

export function buildPhoneCallLedgerInput(call: NormalizedPhoneCall): TaskLedgerMessageInput {
  const input: TaskLedgerMessageInput = {
    channel: "phone",
    conversationKey: phoneCallConversationKey(call),
    externalMessageId: phoneCallExternalId(call),
    authorId: call.fromNumber,
    text: phoneCallLedgerText(call),
    title: `phone call from ${call.fromNumber || "unknown"}`,
    replyTarget: {
      type: "agentphone_call",
      provider: "agentphone",
      callerNumber: call.fromNumber,
      toNumber: call.toNumber,
      numberId: call.numberId,
      callId: call.callId,
      conversationId: call.conversationId || null
    },
    metadata: phoneCallMetadata(call)
  };
  const receivedAt = receivedAtIso(call.endedAt || call.startedAt);
  if (receivedAt) input.receivedAt = receivedAt;
  return input;
}

function phoneMessageLedgerText(message: NormalizedPhoneMessage): string {
  const media = message.mediaUrls.length > 0 ? [`Media: ${message.mediaUrls.join(", ")}`] : [];
  return [
    `From: ${message.fromNumber || "(unknown)"}`,
    `To: ${message.toNumber || "(unknown)"}`,
    `Channel: ${message.channel || "phone"}`,
    ...media,
    "",
    message.body.trim()
  ].join("\n").trim();
}

function phoneCallLedgerText(call: NormalizedPhoneCall): string {
  return [
    `From: ${call.fromNumber || "(unknown)"}`,
    `To: ${call.toNumber || "(unknown)"}`,
    `Status: ${call.status || "unknown"}`,
    call.summary ? `Summary: ${call.summary}` : null,
    "",
    call.transcript || "(no transcript)"
  ].filter((item): item is string => item !== null).join("\n").trim();
}

function phoneMessageMetadata(message: NormalizedPhoneMessage): JsonObject {
  return {
    provider: "agentphone",
    kind: "message",
    id: message.id,
    numberId: message.numberId,
    providerMessageId: phoneMessageExternalId(message),
    conversationId: message.conversationId,
    fromNumber: message.fromNumber,
    toNumber: message.toNumber,
    direction: message.direction,
    channel: message.channel,
    mediaUrls: message.mediaUrls,
    createdAt: message.createdAt,
    receivedAt: message.receivedAt,
    fingerprint: stableRawFingerprint(message.raw)
  };
}

function phoneCallMetadata(call: NormalizedPhoneCall): JsonObject {
  return {
    provider: "agentphone",
    kind: "call",
    callId: call.callId,
    numberId: call.numberId,
    providerCallId: phoneCallExternalId(call),
    conversationId: call.conversationId || null,
    fromNumber: call.fromNumber,
    toNumber: call.toNumber,
    direction: call.direction,
    status: call.status,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    fingerprint: stableRawFingerprint(call.raw)
  };
}

function receivedAtIso(value: string | null): string | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

function stableRawFingerprint(value: Record<string, unknown>): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(value, Object.keys(value).sort()).slice(0, 8192));
  return hash.digest("hex").slice(0, 32);
}
