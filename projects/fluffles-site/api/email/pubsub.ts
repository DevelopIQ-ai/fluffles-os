import { createHmac, timingSafeEqual } from "node:crypto";

type VercelRequest = {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
};

type VercelResponse = {
  status(code: number): VercelResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
};

type PubSubEnvelope = {
  message?: {
    data?: unknown;
    messageId?: unknown;
    message_id?: unknown;
    publishTime?: unknown;
    publish_time?: unknown;
    attributes?: unknown;
  };
  subscription?: unknown;
};

type GmailPushData = {
  emailAddress?: unknown;
  historyId?: unknown;
};

const MAX_ERROR_PREVIEW = 500;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  res.setHeader("cache-control", "no-store");
  try {
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "method_not_allowed" });
      return;
    }

    const expectedToken = requiredEnv("EMAIL_PUBSUB_PUSH_TOKEN");
    const suppliedToken = first(req.query?.token);
    if (!secretEqual(suppliedToken, expectedToken)) {
      res.status(401).json({ ok: false, error: "invalid_push_token" });
      return;
    }

    const amalgmEventsUrl = requiredEnv("AMALGM_EVENTS_URL");
    const amalgmSecret = requiredEnv("AMALGM_EMAIL_INBOUND_SECRET");
    const envelope = parsePubSubEnvelope(req.body);
    const gmail = decodeGmailPushData(envelope);

    const eventPayload = {
      source: "email",
      event: "inbound",
      adapter: "fluffles-site.email.pubsub",
      receivedAt: new Date().toISOString(),
      gmail,
      pubsub: envelope
    };
    const raw = JSON.stringify(eventPayload);
    const signature = `sha256=${createHmac("sha256", amalgmSecret).update(raw).digest("hex")}`;
    const response = await fetch(amalgmEventsUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-webhook-signature": signature
      },
      body: raw
    });
    const text = await response.text();
    if (!response.ok) {
      res.status(502).json({
        ok: false,
        error: "amalgm_forward_failed",
        status: response.status,
        body: text.slice(0, MAX_ERROR_PREVIEW)
      });
      return;
    }

    res.status(202).json({
      ok: true,
      status: response.status,
      messageId: stringField(envelope.message?.messageId) || stringField(envelope.message?.message_id),
      emailAddress: gmail.emailAddress,
      historyId: gmail.historyId
    });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    res.status(status).json({
      ok: false,
      error: error instanceof Error ? error.message : "internal_error"
    });
  }
}

function parsePubSubEnvelope(input: unknown): PubSubEnvelope {
  const value = typeof input === "string" ? JSON.parse(input) as unknown : input;
  if (!isRecord(value)) throw new HttpError(400, "pubsub_body_must_be_object");
  const message = value.message;
  if (!isRecord(message)) throw new HttpError(400, "pubsub_message_required");
  if (typeof message.data !== "string") throw new HttpError(400, "pubsub_message_data_required");
  return value as PubSubEnvelope;
}

function decodeGmailPushData(envelope: PubSubEnvelope): { emailAddress: string | null; historyId: string | null } {
  const data = stringField(envelope.message?.data);
  if (!data) throw new HttpError(400, "pubsub_message_data_required");
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const text = Buffer.from(padded, "base64").toString("utf8").trim();
  if (!text) throw new HttpError(400, "gmail_push_data_empty");
  const parsed = JSON.parse(text) as GmailPushData;
  if (!isRecord(parsed)) throw new HttpError(400, "gmail_push_data_must_be_object");
  const emailAddress = stringField(parsed.emailAddress);
  const historyId = stringField(parsed.historyId);
  if (!emailAddress && !historyId) throw new HttpError(400, "gmail_push_data_missing_fields");
  return { emailAddress, historyId };
}

function first(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new HttpError(500, `${name}_not_configured`);
  return value;
}

function secretEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function stringField(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
