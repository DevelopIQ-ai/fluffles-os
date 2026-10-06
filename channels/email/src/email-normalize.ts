import type { NormalizedEmail, EmailClassification } from "./email-task-adapter";

export interface GmailMessageHeader {
  name?: unknown;
  value?: unknown;
}

export interface GmailMessagePartBody {
  data?: unknown;
}

export interface GmailMessagePart {
  mimeType?: unknown;
  body?: GmailMessagePartBody;
  parts?: unknown;
}

export interface GmailMessage {
  id?: unknown;
  threadId?: unknown;
  internalDate?: unknown;
  labelIds?: unknown;
  snippet?: unknown;
  payload?: {
    headers?: unknown;
    mimeType?: unknown;
    body?: GmailMessagePartBody;
    parts?: unknown;
  };
}

export interface RawInboundEmail {
  provider?: unknown;
  providerMessageId?: unknown;
  id?: unknown;
  gmailMessageId?: unknown;
  externalMessageId?: unknown;
  messageId?: unknown;
  rfcMessageId?: unknown;
  threadId?: unknown;
  from?: unknown;
  to?: unknown;
  subject?: unknown;
  date?: unknown;
  references?: unknown;
  inReplyTo?: unknown;
  headers?: unknown;
  text?: unknown;
  body?: unknown;
  plainText?: unknown;
  html?: unknown;
  labels?: unknown;
}

export function normalizeGmailMessage(gmail: GmailMessage): NormalizedEmail {
  const payload = gmail.payload || {};
  const headers = headerMap(payload.headers || []);
  return {
    provider: "gmail",
    id: optionalString(gmail.id),
    threadId: optionalString(gmail.threadId),
    from: headers.from || "",
    to: headers.to || "",
    subject: headers.subject || "",
    date: headers.date || "",
    internalDate: optionalString(gmail.internalDate) || null,
    messageId: headers["message-id"] || optionalString(gmail.id),
    references: headers.references ? headers.references.split(/\s+/).filter(Boolean) : [],
    inReplyTo: headers["in-reply-to"] || null,
    headers,
    text: extractTextPart(payload) || optionalString(gmail.snippet) || "",
    labels: stringArray(gmail.labelIds)
  };
}

export function normalizeInboundEmail(input: RawInboundEmail): NormalizedEmail {
  const headers = headerMap(input.headers || {});
  return {
    provider: optionalString(input.provider) || "gmail",
    id: optionalString(input.providerMessageId) || optionalString(input.gmailMessageId) || optionalString(input.id),
    threadId: optionalString(input.threadId),
    from: optionalString(input.from) || headers.from || "",
    to: optionalString(input.to) || headers.to || "",
    subject: optionalString(input.subject) || headers.subject || "",
    date: optionalString(input.date) || headers.date || "",
    internalDate: null,
    messageId: optionalString(input.externalMessageId) || optionalString(input.rfcMessageId) || optionalString(input.messageId) || headers["message-id"] || null,
    references: Array.isArray(input.references) ? stringArray(input.references) : [],
    inReplyTo: optionalString(input.inReplyTo) || headers["in-reply-to"] || null,
    headers,
    text: optionalString(input.text) || optionalString(input.body) || optionalString(input.plainText) || stripHtml(optionalString(input.html) || ""),
    labels: stringArray(input.labels)
  };
}

export function classifyEmail(
  email: NormalizedEmail,
  options: { mailboxAddresses?: readonly string[] } = {}
): EmailClassification {
  const from = parseAddress(email.from);
  const subject = email.subject || "";
  const text = email.text || "";
  const headers = email.headers || {};
  const labels = new Set(email.labels.map(String));
  const combined = `${subject}\n${text}`.toLowerCase();
  const reasons: string[] = [];

  if (!from.email) reasons.push("missing-sender");
  const mailboxAddresses = new Set((options.mailboxAddresses ?? []).map(canonicalMailboxAddress).filter(Boolean));
  if (mailboxAddresses.has(canonicalMailboxAddress(from.email))) reasons.push("outbound-echo");
  if (labels.has("SENT")) reasons.push("outbound-message");
  if (email.provider === "gmail" && labels.size > 0 && !labels.has("INBOX") && !labels.has("SENT")) {
    reasons.push("not-inbox");
  }
  if (mailboxAddresses.size > 0 && !recipientIncludesMailbox(email.to, mailboxAddresses)) {
    reasons.push("wrong-recipient");
  }
  if (/(^|[._-])(no-?reply|do-?not-?reply|mailer-daemon|bounce|notifications?|newsletter|updates?)@/i.test(from.email)) {
    reasons.push("automated-sender");
  }
  if (headers["list-unsubscribe"] || headers["list-id"]) reasons.push("mailing-list");
  if (/^(auto-replied|auto-generated|auto-notified)/i.test(headers["auto-submitted"] || "")) {
    reasons.push("auto-submitted");
  }
  if (/^(bulk|list|junk)/i.test(headers.precedence || "")) reasons.push("bulk-precedence");
  if ([...labels].some((label) => ["SPAM", "TRASH", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL"].includes(label))) {
    reasons.push("spam-or-promotions-label");
  }
  if (hasAny(combined, [
    /\bunsubscribe\b/,
    /\bnewsletter\b/,
    /\bwebinar\b/,
    /\bpromo\b/,
    /\bdiscount\b/,
    /\blimited time\b/,
    /\bsale\b/,
    /\bsponsored\b/,
    /\bmarketing\b/
  ])) {
    reasons.push("marketing-language");
  }

  const needsReply = hasAny(combined, [
    /\?/,
    /\bcan you\b/,
    /\bcould you\b/,
    /\bwould you\b/,
    /\bplease\b/,
    /\blet me know\b/,
    /\bthoughts\b/,
    /\bavailable\b/,
    /\bschedule\b/,
    /\bconfirm\b/,
    /\breply\b/,
    /\brespond\b/,
    /\bneed (your|a|an|to|help|input|feedback)\b/,
    /\breview\b/,
    /\bfollow up\b/
  ]);
  if (!needsReply) reasons.push("no-clear-ask");

  const skipReasons = reasons.filter((reason) => reason !== "no-clear-ask");
  const shouldReply = needsReply && skipReasons.length === 0;
  return {
    shouldReply,
    confidence: shouldReply ? "medium" : "high",
    reason: shouldReply ? "clear-human-ask" : reasons.join(", "),
    sender: from.email,
    subject
  };
}

export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function parseAddress(value: string): { raw: string; name: string; email: string } {
  const text = value.trim();
  const match = text.match(/<([^>]+)>/);
  const email = (match?.[1] ?? text).trim().toLowerCase();
  const name = text.replace(/<[^>]+>/g, "").replace(/^"|"$/g, "").trim();
  return { raw: text, name, email };
}

function extractTextPart(part: GmailMessagePart): string {
  const mimeType = optionalString(part.mimeType);
  if (mimeType === "text/plain" && typeof part.body?.data === "string") {
    return base64UrlDecode(part.body.data);
  }
  if (Array.isArray(part.parts)) {
    return part.parts.map((child) => extractTextPart(asMessagePart(child))).filter(Boolean).join("\n\n");
  }
  if (mimeType === "text/html" && typeof part.body?.data === "string") {
    return stripHtml(base64UrlDecode(part.body.data));
  }
  return "";
}

function headerMap(headers: unknown): Record<string, string> {
  if (!Array.isArray(headers)) {
    if (!isRecord(headers)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = String(value);
    return out;
  }
  const out: Record<string, string> = {};
  for (const header of headers) {
    if (!isRecord(header) || typeof header.name !== "string") continue;
    out[header.name.toLowerCase()] = optionalString(header.value) || "";
  }
  return out;
}

function base64UrlDecode(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function recipientIncludesMailbox(value: string, mailboxAddresses: ReadonlySet<string>): boolean {
  return value.split(",").some((recipient) => mailboxAddresses.has(canonicalMailboxAddress(parseAddress(recipient).email)));
}

function canonicalMailboxAddress(value: string): string {
  const email = parseAddress(value).email;
  const at = email.lastIndexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const plus = local.indexOf("+");
  return `${plus === -1 ? local : local.slice(0, plus)}${email.slice(at)}`;
}

function asMessagePart(value: unknown): GmailMessagePart {
  return isRecord(value) ? value : {};
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
