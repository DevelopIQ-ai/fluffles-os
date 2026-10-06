import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const REPLAY_WINDOW_SECONDS = 300;

export interface AgentPhoneWebhookHeaders {
  signature: string;
  timestamp: string;
  webhookId?: string | null;
  event?: string | null;
}

export const AGENTPHONE_REPLAY_WINDOW_MS = REPLAY_WINDOW_SECONDS * 1000;

export type AgentPhoneWebhookCheck =
  | { ok: true; replayKey: string }
  | { ok: false; error: "stale_agentphone_signature" | "invalid_agentphone_signature" };

/**
 * Checks an AgentPhone `HMAC-SHA256(timestamp.body)` signature, reporting a
 * clock-skew rejection separately from a signature mismatch so operators can
 * tell a late delivery from a forged one.
 */
export function checkAgentPhoneWebhook(
  rawBody: string,
  headers: AgentPhoneWebhookHeaders,
  secret: string,
  now = Date.now()
): AgentPhoneWebhookCheck {
  try {
    const tsNum = Number.parseInt(headers.timestamp, 10);
    if (!Number.isFinite(tsNum)) return { ok: false, error: "invalid_agentphone_signature" };
    if (Math.abs(now / 1000 - tsNum) > REPLAY_WINDOW_SECONDS) {
      return { ok: false, error: "stale_agentphone_signature" };
    }
    const expectedHex = createHmac("sha256", secret)
      .update(`${headers.timestamp}.${rawBody}`)
      .digest("hex");
    const a = Buffer.from(headers.signature);
    const b = Buffer.from(`sha256=${expectedHex}`);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { ok: false, error: "invalid_agentphone_signature" };
    }
    return { ok: true, replayKey: agentPhoneReplayKey(headers) };
  } catch {
    return { ok: false, error: "invalid_agentphone_signature" };
  }
}

export function verifyAgentPhoneWebhook(rawBody: string, headers: AgentPhoneWebhookHeaders, secret: string, now = Date.now()): boolean {
  return checkAgentPhoneWebhook(rawBody, headers, secret, now).ok;
}

/**
 * Prefers AgentPhone's own delivery id so a retried delivery of the same body
 * is still one event; falls back to the signature, which is body plus
 * timestamp, when the provider omits the id.
 */
function agentPhoneReplayKey(headers: AgentPhoneWebhookHeaders): string {
  return headers.webhookId ? `id:${headers.webhookId}` : `sig:${headers.signature}`;
}

export function agentPhoneWebhookHeadersFromRequest(request: IncomingMessage): AgentPhoneWebhookHeaders {
  return {
    signature: headerString(request.headers["x-webhook-signature"]),
    timestamp: headerString(request.headers["x-webhook-timestamp"]),
    webhookId: headerString(request.headers["x-webhook-id"]),
    event: headerString(request.headers["x-webhook-event"])
  };
}

function headerString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}
