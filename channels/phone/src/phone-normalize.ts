import { createHash } from "node:crypto";

export interface NormalizedPhoneMessage {
  provider: "agentphone";
  id: string | null;
  numberId: string | null;
  conversationId: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  direction: "inbound" | "outbound" | null;
  channel: string | null;
  body: string;
  mediaUrls: string[];
  createdAt: string | null;
  receivedAt: string | null;
  raw: Record<string, unknown>;
}

export interface NormalizedPhoneCall {
  provider: "agentphone";
  callId: string | null;
  numberId: string | null;
  conversationId?: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  direction: "inbound" | "outbound" | null;
  status: string | null;
  summary: string | null;
  transcript: string | null;
  startedAt: string | null;
  endedAt: string | null;
  raw: Record<string, unknown>;
}

export type PhoneWebhookEvent =
  | { kind: "message"; message: NormalizedPhoneMessage }
  | { kind: "call"; call: NormalizedPhoneCall }
  | { kind: "ignored"; reason: string };

export function normalizedPhoneMessagesFromListResult(value: unknown): NormalizedPhoneMessage[] {
  return arrayFromData(value).map(normalizePhoneMessage).filter((item): item is NormalizedPhoneMessage => item !== null);
}

export function normalizedPhoneCallsFromListResult(value: unknown): NormalizedPhoneCall[] {
  return arrayFromData(value).map(normalizePhoneCall).filter((item): item is NormalizedPhoneCall => item !== null);
}

export function phoneWebhookEventFromUnknown(input: unknown): PhoneWebhookEvent {
  const record = requireRecord(input, "phone webhook payload");
  const event = stringField(record.event) || "";
  const channel = stringField(record.channel);
  const data = isRecord(record.data) ? record.data : record;
  if (event === "agent.message" || channel === "sms" || channel === "mms" || channel === "imessage") {
    return { kind: "message", message: normalizePhoneMessage({ ...data, event, channel, timestamp: record.timestamp }) || emptyMessage(data) };
  }
  if (event === "agent.call_ended" || channel === "voice") {
    return { kind: "call", call: normalizePhoneCall({ ...data, event, channel, timestamp: record.timestamp }) || emptyCall(data) };
  }
  return { kind: "ignored", reason: event ? `unsupported phone webhook event: ${event}` : "unsupported phone webhook payload" };
}

export function normalizePhoneMessage(value: unknown): NormalizedPhoneMessage | null {
  if (!isRecord(value)) return null;
  const mediaUrls = stringArray(value.media_urls) || stringArray(value.mediaUrls) || singleStringArray(value.media_url) || singleStringArray(value.mediaUrl) || [];
  const body = stringField(value.body) || stringField(value.message) || stringField(value.text) || "";
  return {
    provider: "agentphone",
    id: stringField(value.id) || stringField(value.message_id) || stringField(value.messageId),
    numberId: stringField(value.number_id) || stringField(value.numberId),
    conversationId: stringField(value.conversation_id) || stringField(value.conversationId),
    fromNumber: normalizeNumber(stringField(value.from_number) || stringField(value.fromNumber) || stringField(value.from)),
    toNumber: normalizeNumber(stringField(value.to_number) || stringField(value.toNumber) || stringField(value.to)),
    direction: directionField(value.direction),
    channel: stringField(value.channel),
    body,
    mediaUrls,
    createdAt: stringField(value.created_at) || stringField(value.createdAt) || stringField(value.timestamp),
    receivedAt: stringField(value.received_at) || stringField(value.receivedAt) || stringField(value.timestamp),
    raw: value
  };
}

export function normalizePhoneCall(value: unknown): NormalizedPhoneCall | null {
  if (!isRecord(value)) return null;
  return {
    provider: "agentphone",
    callId: stringField(value.id) || stringField(value.call_id) || stringField(value.callId),
    numberId: stringField(value.number_id) || stringField(value.numberId),
    conversationId: stringField(value.conversation_id) || stringField(value.conversationId),
    fromNumber: normalizeNumber(stringField(value.from_number) || stringField(value.fromNumber) || stringField(value.from)),
    toNumber: normalizeNumber(stringField(value.to_number) || stringField(value.toNumber) || stringField(value.to)),
    direction: directionField(value.direction),
    status: stringField(value.status),
    summary: stringField(value.summary),
    transcript: transcriptText(value.transcript),
    startedAt: stringField(value.started_at) || stringField(value.startedAt) || stringField(value.created_at) || stringField(value.createdAt) || stringField(value.timestamp),
    endedAt: stringField(value.ended_at) || stringField(value.endedAt) || stringField(value.completed_at) || stringField(value.completedAt),
    raw: value
  };
}

export function phoneMessageExternalId(message: NormalizedPhoneMessage): string {
  return message.id || stableFingerprint("message", [message.conversationId, message.fromNumber, message.toNumber, message.receivedAt, message.body, ...message.mediaUrls]);
}

export function phoneCallExternalId(call: NormalizedPhoneCall): string {
  return call.callId || stableFingerprint("call", [call.fromNumber, call.toNumber, call.startedAt, call.endedAt, call.summary, call.transcript]);
}

export function shouldAcceptPhoneMessage(message: NormalizedPhoneMessage, ownNumber: string): { shouldReply: boolean; reason: string } {
  if (message.direction === "outbound") return { shouldReply: false, reason: "outbound echo" };
  if (message.fromNumber && sameNumber(message.fromNumber, ownNumber)) return { shouldReply: false, reason: "own number echo" };
  if (message.toNumber && !sameNumber(message.toNumber, ownNumber)) return { shouldReply: false, reason: "different destination number" };
  if (!message.body.trim() && message.mediaUrls.length === 0) return { shouldReply: false, reason: "empty message" };
  return { shouldReply: true, reason: "inbound phone message" };
}

export function shouldAcceptPhoneCall(call: NormalizedPhoneCall, ownNumber: string): { shouldReply: boolean; reason: string } {
  if (call.direction === "outbound") return { shouldReply: false, reason: "outbound call" };
  if (call.fromNumber && sameNumber(call.fromNumber, ownNumber)) return { shouldReply: false, reason: "own number call echo" };
  if (call.toNumber && !sameNumber(call.toNumber, ownNumber)) return { shouldReply: false, reason: "different destination number" };
  if (!call.summary && !call.transcript) return { shouldReply: false, reason: "call has no summary or transcript" };
  return { shouldReply: true, reason: "inbound phone call" };
}

function arrayFromData(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  if (Array.isArray(value.data)) return value.data;
  if (Array.isArray(value.messages)) return value.messages;
  if (Array.isArray(value.calls)) return value.calls;
  if (Array.isArray(value.items)) return value.items;
  return [];
}

function emptyMessage(raw: Record<string, unknown>): NormalizedPhoneMessage {
  return normalizePhoneMessage(raw) || {
    provider: "agentphone",
    id: null,
    numberId: null,
    conversationId: null,
    fromNumber: null,
    toNumber: null,
    direction: null,
    channel: null,
    body: "",
    mediaUrls: [],
    createdAt: null,
    receivedAt: null,
    raw
  };
}

function emptyCall(raw: Record<string, unknown>): NormalizedPhoneCall {
  return normalizePhoneCall(raw) || {
    provider: "agentphone",
    callId: null,
    numberId: null,
    conversationId: null,
    fromNumber: null,
    toNumber: null,
    direction: null,
    status: null,
    summary: null,
    transcript: null,
    startedAt: null,
    endedAt: null,
    raw
  };
}

function transcriptText(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (!Array.isArray(value)) return null;
  const lines = value.map((item) => {
    if (!isRecord(item)) return null;
    const speaker = stringField(item.speaker) || stringField(item.role) || "speaker";
    const text = stringField(item.text) || stringField(item.message) || stringField(item.transcript);
    return text ? `${speaker}: ${text}` : null;
  }).filter((item): item is string => item !== null);
  return lines.length > 0 ? lines.join("\n") : null;
}

function stableFingerprint(prefix: string, parts: Array<string | null>): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part || "");
    hash.update("\0");
  }
  return `sha256:${prefix}:${hash.digest("hex").slice(0, 32)}`;
}

function sameNumber(a: string, b: string): boolean {
  return digits(a) === digits(b);
}

function digits(value: string): string {
  return value.replace(/\D+/g, "");
}

function normalizeNumber(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) return trimmed;
  const justDigits = digits(trimmed);
  return justDigits.length === 11 && justDigits.startsWith("1") ? `+${justDigits}` : trimmed;
}

function directionField(value: unknown): "inbound" | "outbound" | null {
  return value === "inbound" || value === "outbound" ? value : null;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function singleStringArray(value: unknown): string[] | null {
  return typeof value === "string" && value.trim() ? [value] : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
