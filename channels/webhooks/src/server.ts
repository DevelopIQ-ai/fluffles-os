#!/usr/bin/env node
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import fsp from "node:fs/promises";
import { loadConfig, publicConfig } from "./config";
import { appendEvent, ensureState, readLatestEvent, readLatestEventSync, type StoredWebhookEvent, type StoredWebhookEventInput } from "./event-store";
import { verifyGitHubSignature, verifySharedSecret, type VerificationResult } from "./signatures";

const config = loadConfig();
const startedAt = new Date();

type Route = { method: string; path: string; id: string; description: string };
type HttpError = Error & { status?: number };

const routes: Route[] = [
  { method: "GET", path: "/", id: "status", description: "service status" },
  { method: "GET", path: "/healthz", id: "health", description: "compact health check" },
  { method: "GET", path: "/routes", id: "routes", description: "route inventory" },
  { method: "GET", path: "/events/latest", id: "latest-event", description: "latest event receipt" },
  { method: "POST", path: "/events/test", id: "test", description: "local smoke event" },
  { method: "POST", path: "/events/generic", id: "generic", description: "generic machine event" },
  { method: "POST", path: "/github/events", id: "github", description: "GitHub event endpoint" }
];

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function notFound(res: ServerResponse): void { json(res, 404, { ok: false, error: "not-found" }); }
function methodNotAllowed(res: ServerResponse): void { json(res, 405, { ok: false, error: "method-not-allowed" }); }

function isLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url || "/", `http://${req.headers.host || `${config.host}:${config.port}`}`);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > config.maxBodyBytes) throw Object.assign(new Error("body-too-large"), { status: 413 });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseBody(rawBody: Buffer, headers: IncomingMessage["headers"]): unknown {
  const contentType = String(headers["content-type"] || "");
  if (rawBody.length === 0) return null;
  if (contentType.includes("application/json")) return JSON.parse(rawBody.toString("utf8"));
  return rawBody.toString("utf8");
}

function healthPayload(): Record<string, unknown> {
  const latestEvent = readLatestEventSync(config);
  return {
    ok: true,
    service: config.serviceName,
    version: config.version,
    pid: process.pid,
    uptimeSeconds: Math.round(process.uptime()),
    startedAt: startedAt.toISOString(),
    routeCount: routes.length,
    routes: routes.map((route) => `${route.method} ${route.path}`),
    latestEvent: latestEvent ? { id: latestEvent.id, routeId: latestEvent.routeId, source: latestEvent.source, trusted: latestEvent.trusted, receivedAt: latestEvent.receivedAt } : null,
    config: publicConfig(config)
  };
}

async function writeRuntimeState(): Promise<void> {
  await ensureState(config);
  await fsp.writeFile(config.pidFile, `${process.pid}\n`, "utf8");
  await fsp.writeFile(config.stateFile, `${JSON.stringify({ service: config.serviceName, pid: process.pid, startedAt: startedAt.toISOString(), healthUrl: `http://127.0.0.1:${config.port}/healthz`, routesUrl: `http://127.0.0.1:${config.port}/routes`, stateDir: config.stateDir }, null, 2)}\n`, "utf8");
}

function receiptResponse(record: StoredWebhookEvent): Record<string, unknown> {
  return { ok: true, id: record.id, routeId: record.routeId, source: record.source, trusted: record.trusted, receivedAt: record.receivedAt, rawSha256: record.rawSha256 };
}

async function persistRequest(req: IncomingMessage, routeId: string, source: string, verification: VerificationResult, bodyOverride?: unknown): Promise<StoredWebhookEvent> {
  const rawBody = await readBody(req);
  const parsed = bodyOverride === undefined ? parseBody(rawBody, req.headers) : bodyOverride;
  const idHeader = req.headers["x-github-delivery"] || req.headers["x-request-id"];
  const id = Array.isArray(idHeader) ? idHeader[0] : idHeader;
  const input: StoredWebhookEventInput = { routeId, source, trusted: Boolean(verification.trusted), verification, headers: req.headers, rawBody, body: parsed };
  if (id) input.id = id;
  if (req.socket.remoteAddress) input.remoteAddress = req.socket.remoteAddress;
  return appendEvent(config, input);
}

async function handleTest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res);
  const record = await persistRequest(req, "test", "local-smoke", { ok: true, trusted: true, reason: "local-smoke" });
  return json(res, 202, receiptResponse(record));
}

async function handleGeneric(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res);
  let verification: VerificationResult;
  if (config.genericSecret) {
    verification = verifySharedSecret(req.headers["x-harness-webhook-secret"] || req.headers.authorization, config.genericSecret);
    if (!verification.ok) return json(res, 401, { ok: false, error: verification.reason });
  } else if (isLoopback(req.socket.remoteAddress)) {
    verification = { ok: true, trusted: true, reason: "loopback-without-shared-secret" };
  } else {
    return json(res, 503, { ok: false, error: "generic-secret-not-configured" });
  }
  const record = await persistRequest(req, "generic", "generic", verification);
  return json(res, 202, receiptResponse(record));
}

async function handleGitHub(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "POST") return methodNotAllowed(res);
  const rawBody = await readBody(req);
  const verification = verifyGitHubSignature(rawBody, req.headers["x-hub-signature-256"], config.githubSecret);
  if (!verification.ok) return json(res, 401, { ok: false, error: verification.reason });
  const body = parseBody(rawBody, req.headers);
  const deliveryHeader = req.headers["x-github-delivery"];
  const eventHeader = req.headers["x-github-event"];
  const input: StoredWebhookEventInput = { routeId: "github", source: `github:${Array.isArray(eventHeader) ? eventHeader[0] : eventHeader || "event"}`, trusted: true, verification, headers: req.headers, rawBody, body };
  const deliveryId = Array.isArray(deliveryHeader) ? deliveryHeader[0] : deliveryHeader;
  if (deliveryId) input.id = deliveryId;
  if (req.socket.remoteAddress) input.remoteAddress = req.socket.remoteAddress;
  const record = await appendEvent(config, input);
  return json(res, 202, receiptResponse(record));
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = requestUrl(req);
  if (req.method === "GET" && url.pathname === "/") return json(res, 200, healthPayload());
  if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, healthPayload());
  if (req.method === "GET" && url.pathname === "/routes") return json(res, 200, { ok: true, routes });
  if (req.method === "GET" && url.pathname === "/events/latest") return json(res, 200, { ok: true, event: await readLatestEvent(config) });
  if (url.pathname === "/events/test") return handleTest(req, res);
  if (url.pathname === "/events/generic") return handleGeneric(req, res);
  if (url.pathname === "/github/events") return handleGitHub(req, res);
  return notFound(res);
}

async function main(): Promise<void> {
  await writeRuntimeState();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: HttpError) => json(res, error.status || 500, { ok: false, error: error.message || "internal-error" }));
  });
  const shutdown = async (): Promise<void> => {
    server.close(() => undefined);
    await fsp.rm(config.pidFile, { force: true }).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => { void shutdown(); });
  process.on("SIGINT", () => { void shutdown(); });
  server.listen(config.port, config.host, () => console.log(`${config.serviceName} listening on http://${config.host}:${config.port}`));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}

export { handle, healthPayload };
