import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { WebhookConfig } from "./config";
import { sha256Hex } from "./signatures";

const HEADER_ALLOWLIST = new Set([
  "content-type",
  "user-agent",
  "x-github-delivery",
  "x-github-event",
  "x-request-id",
  "x-webhooks-event-type"
]);

export type StoredWebhookEventInput = {
  id?: string;
  routeId: string;
  source: string;
  trusted: boolean;
  verification: unknown;
  remoteAddress?: string | null;
  headers: IncomingHttpHeaders;
  rawBody?: Buffer;
  body?: unknown;
};

export type StoredWebhookEvent = {
  id: string;
  receivedAt: string;
  routeId: string;
  source: string;
  trusted: boolean;
  verification: unknown;
  remoteAddress: string | null;
  headers: Record<string, string | string[]>;
  rawSha256: string;
  rawPreview: string;
  body: unknown;
};

export async function ensureState(config: WebhookConfig): Promise<void> {
  await fsp.mkdir(config.eventDir, { recursive: true });
  await fsp.mkdir(config.logDir, { recursive: true });
}

function todayFile(config: WebhookConfig, date = new Date()): string {
  return path.join(config.eventDir, `${date.toISOString().slice(0, 10)}.jsonl`);
}

function safeHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (HEADER_ALLOWLIST.has(lower) && value !== undefined) output[lower] = Array.isArray(value) ? value : String(value);
  }
  return output;
}

function shortBody(rawBody: Buffer): string {
  const text = rawBody.toString("utf8");
  if (text.length <= 2000) return text;
  return `${text.slice(0, 2000)}...`;
}

export async function appendEvent(config: WebhookConfig, event: StoredWebhookEventInput): Promise<StoredWebhookEvent> {
  await ensureState(config);
  const now = new Date();
  const id = event.id || crypto.randomUUID();
  const rawBody = event.rawBody || Buffer.alloc(0);
  const record: StoredWebhookEvent = {
    id,
    receivedAt: now.toISOString(),
    routeId: event.routeId,
    source: event.source,
    trusted: Boolean(event.trusted),
    verification: event.verification || null,
    remoteAddress: event.remoteAddress || null,
    headers: safeHeaders(event.headers),
    rawSha256: sha256Hex(rawBody),
    rawPreview: event.rawBody ? shortBody(event.rawBody) : "",
    body: event.body === undefined ? null : event.body
  };
  const line = `${JSON.stringify(record)}\n`;
  await fsp.appendFile(todayFile(config, now), line, "utf8");
  await fsp.writeFile(config.latestEventFile, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

export async function readLatestEvent(config: WebhookConfig): Promise<StoredWebhookEvent | null> {
  try {
    return JSON.parse(await fsp.readFile(config.latestEventFile, "utf8")) as StoredWebhookEvent;
  } catch (_error) {
    return null;
  }
}

export function readLatestEventSync(config: WebhookConfig): StoredWebhookEvent | null {
  try {
    return JSON.parse(fs.readFileSync(config.latestEventFile, "utf8")) as StoredWebhookEvent;
  } catch (_error) {
    return null;
  }
}
