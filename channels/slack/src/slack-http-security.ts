import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  ChannelRequestBodyLimitError,
  readChannelRequestBuffer,
  timingSafeStringEqual
} from "@fluffles/tasks";

/**
 * Only Slack's own v0 signing scheme lives here; the bounded body reader and
 * the constant-time comparison are the shared channel HTTP primitives.
 */

export { ChannelRequestBodyLimitError as SlackRequestBodyLimitError };

export function readSlackRequestBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return readChannelRequestBuffer(req, maxBytes);
}

/** Verify Slack v0 HMAC and reject timestamps outside the replay window. */
export function verifySlackRequest(
  req: IncomingMessage,
  rawBody: string,
  signingSecret: string,
  now = Date.now(),
  replayWindowSeconds = 5 * 60
): boolean {
  if (!signingSecret) return false;
  const timestamp = String(req.headers["x-slack-request-timestamp"] || "");
  const signature = String(req.headers["x-slack-signature"] || "");
  if (!timestamp || !signature) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(now / 1000 - timestampSeconds) > replayWindowSeconds) return false;
  const expected = `v0=${crypto.createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  return timingSafeEqual(signature, expected);
}

export function timingSafeEqual(leftValue: unknown, rightValue: unknown): boolean {
  return timingSafeStringEqual(String(leftValue || ""), String(rightValue || ""));
}
