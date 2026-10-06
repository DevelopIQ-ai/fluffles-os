import type { IncomingMessage, ServerResponse } from "node:http";
import { createChannelRouter, type ChannelRouteHandler } from "@fluffles/tasks";
import { parseSlackEventsPayload, type SlackEvent, type SlackEventsPayload } from "./slack-api-response";
import {
  readSlackRequestBody,
  SlackRequestBodyLimitError,
  timingSafeEqual,
  verifySlackRequest
} from "./slack-http-security";

/**
 * Slack's HTTP ingress. Routing, the bounded body read and the constant-time
 * compare come from the shared channel HTTP kit; what stays here is the part
 * only Slack has: the health body, the signing-secret internal auth rule, and
 * the Events API contract (url_verification handshake, event_callback,
 * synchronous processing) which no other channel shares.
 */

/** The status fields the HTTP layer reads or stamps. */
export interface SlackHttpStatus {
  lastWebhookAt: string | null;
  lastWebhookError: string | null;
  lastEventAt: string | null;
  lastError: string | null;
}

export interface SlackHttpDependencies {
  status: SlackHttpStatus;
  healthBody(): unknown;
  publicStatus(): unknown;
  writeStatus(): Promise<void>;
  processSlackEvent(event: SlackEvent): Promise<void>;
  allowWebhookRequest(remoteAddress: string | undefined): boolean;
  signingSecret: string;
  maxBodyBytes: number;
  formatError(error: unknown): string;
  log?: Pick<Console, "error">;
}

export function createSlackHttpHandler(deps: SlackHttpDependencies): ChannelRouteHandler {
  return createChannelRouter({
    routes: [
      { method: "GET", path: "/healthz", handle: (_req, res) => { sendDocument(res, 200, deps.healthBody()); } },
      { method: "GET", path: "/", handle: (req, res) => { handleStatus(deps, req, res); } },
      { method: "POST", path: "/slack/events", handle: (req, res) => handleEvents(deps, req, res) }
    ],
    notFound: (_req, res) => { sendJson(res, 404, { ok: false, error: "not_found" }); }
  });
}

/** The internal status route is unlisted rather than 401, so it answers 404. */
export function isInternalRequestAuthorized(req: IncomingMessage, signingSecret: string): boolean {
  if (!signingSecret) return false;
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const supplied = String(req.headers["x-fluffles-internal-token"] || bearer || "");
  return timingSafeEqual(supplied, signingSecret);
}

function handleStatus(deps: SlackHttpDependencies, req: IncomingMessage, res: ServerResponse): void {
  if (!isInternalRequestAuthorized(req, deps.signingSecret)) {
    sendJson(res, 404, { ok: false, error: "not_found" });
    return;
  }
  sendDocument(res, 200, deps.publicStatus(), 2);
}

async function handleEvents(
  deps: SlackHttpDependencies,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const { status } = deps;
  if (!deps.allowWebhookRequest(req.socket.remoteAddress)) {
    res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
    res.end(JSON.stringify({ ok: false, error: "rate_limited" }));
    return;
  }

  let rawBody: Buffer;
  try {
    rawBody = await readSlackRequestBody(req, deps.maxBodyBytes);
  } catch (error) {
    const tooLarge = error instanceof SlackRequestBodyLimitError;
    status.lastWebhookError = tooLarge ? "payload_too_large" : "body_read_failed";
    await deps.writeStatus();
    sendJson(res, tooLarge ? 413 : 400, { ok: false, error: status.lastWebhookError });
    return;
  }
  const textBody = rawBody.toString("utf8");

  if (!verifySlackRequest(req, textBody, deps.signingSecret)) {
    status.lastWebhookError = deps.signingSecret ? "invalid_signature" : "missing_signing_secret";
    await deps.writeStatus();
    sendJson(res, deps.signingSecret ? 401 : 503, { ok: false, error: status.lastWebhookError });
    return;
  }

  let payload: SlackEventsPayload;
  try {
    payload = parseSlackEventsPayload(JSON.parse(textBody));
  } catch (_error) {
    status.lastWebhookError = "invalid_json";
    await deps.writeStatus();
    sendJson(res, 400, { ok: false, error: "invalid_json" });
    return;
  }

  status.lastWebhookAt = new Date().toISOString();
  status.lastWebhookError = null;

  if (payload.type === "url_verification" && payload.challenge) {
    await deps.writeStatus();
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(String(payload.challenge));
    return;
  }

  if (payload.type !== "event_callback" || !payload.event) {
    await deps.writeStatus();
    sendJson(res, 200, { ok: true, ignored: true });
    return;
  }

  const event: SlackEvent = {
    ...payload.event,
    channel: payload.event.channel,
    ts: payload.event.ts,
    event_id: payload.event_id || payload.event.event_id || null,
    event_ts: payload.event_time ? String(payload.event_time) : payload.event.event_ts || payload.event.ts || null
  };

  status.lastEventAt = new Date().toISOString();
  await deps.writeStatus();
  try {
    await deps.processSlackEvent(event);
  } catch (error) {
    status.lastWebhookError = deps.formatError(error);
    status.lastError = deps.formatError(error);
    await deps.writeStatus();
    (deps.log || console).error("Slack webhook event failed", error);
    sendJson(res, 500, { ok: false, error: "event_processing_failed" });
    return;
  }

  sendJson(res, 200, { ok: true });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Health and status bodies are newline terminated so `curl` output reads well. */
function sendDocument(res: ServerResponse, statusCode: number, body: unknown, indent?: number): void {
  res.writeHead(statusCode, { "content-type": "application/json" });
  res.end(`${JSON.stringify(body, null, indent)}\n`);
}
