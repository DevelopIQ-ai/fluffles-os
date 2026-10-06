import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FixedWindowRateLimiter,
  ReplayWindow,
  SingleFlightTask,
  channelErrorStatusCode,
  channelRequestPathname,
  defineChannel,
  isLoopbackAddress,
  parseChannelJsonBody,
  readChannelRequestBody,
  sendChannelJson,
  type ChannelCliCommand,
  type DefinedChannel
} from "./channel";
import { channelErrorMessage } from "./channel-env";

/**
 * The shared shape of a polling channel service: health, internal status and
 * tick routes, one signed webhook route, single-flight poll/process ticks,
 * periodic lease recovery, and the one-shot CLI flags. A channel supplies its
 * platform behavior through ChannelServiceAdapter and its own webhook
 * verification; the transport-neutral service is this one implementation.
 */

export type WebhookVerification = { ok: true } | { ok: false; statusCode: number; error: string };

export interface ChannelWebhookIngestResult {
  accepted: number;
  errors: number;
}

export interface ChannelServiceAdapter<TIngest extends ChannelWebhookIngestResult> {
  pollOnce(): Promise<unknown>;
  processQueued(limit: number): Promise<unknown>;
  runOnce(): Promise<unknown>;
  ingestWebhook(payload: unknown): Promise<TIngest>;
  snapshotStatus(): Promise<unknown>;
  writeStatus(): Promise<void>;
  recoverInterruptedRuns(options?: { reclaimOwnLeases?: boolean }): Promise<unknown>;
  close(): void;
}

export interface ChannelServiceOptions<TIngest extends ChannelWebhookIngestResult> {
  service: string;
  host: string;
  port: number;
  adapter: ChannelServiceAdapter<TIngest>;
  /** Absolute path to the status file the host writes; read by `--status`. */
  statusPath: string;
  pollIntervalMs: number;
  processIntervalMs: number;
  recoveryIntervalMs: number;
  processLimit: number;
  pollingEnabled: boolean;
  processingEnabled: boolean;
  webhookEnabled: boolean;
  webhookPaths: readonly string[];
  webhookMaxBodyBytes: number;
  webhookRateLimitPerMinute: number;
  verifyWebhook(request: IncomingMessage, rawBody: string): WebhookVerification | Promise<WebhookVerification>;
  /** Header carrying the internal API secret for non-loopback callers. */
  internalSecretHeader: string;
  internalApiSecret: string;
  /** Extra fields logged once the HTTP server is listening. */
  describe?(): Record<string, unknown>;
  /** Channel-specific reading of a tick result as success. Defaults to true. */
  pollSucceeded?(result: unknown): boolean;
  processSucceeded?(result: unknown): boolean;
  log?: Pick<Console, "log" | "error">;
}

export interface ChannelService extends DefinedChannel {
  /** Exposed for tests and for channels that add routes of their own. */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  pollTick(): Promise<unknown>;
  processTick(): Promise<unknown>;
}

export function defineChannelService<TIngest extends ChannelWebhookIngestResult>(
  options: ChannelServiceOptions<TIngest>
): ChannelService {
  const log = options.log || console;
  const adapter = options.adapter;
  const pollTask = new SingleFlightTask();
  const processTask = new SingleFlightTask();
  const webhookRateLimiter = new FixedWindowRateLimiter(options.webhookRateLimitPerMinute);
  const webhookPaths = new Set(options.webhookPaths);
  const pollSucceeded = options.pollSucceeded || (() => true);
  const processSucceeded = options.processSucceeded || (() => true);

  async function pollTick(): Promise<unknown> {
    return pollTask.run<unknown>(async () => {
      try {
        const result = await adapter.pollOnce();
        return { ok: pollSucceeded(result), result };
      } catch (error) {
        log.error(channelErrorMessage(error));
        return { ok: false, error: channelErrorMessage(error) };
      }
    }, () => ({ ok: true, skipped: "poll_already_running" }));
  }

  async function processTick(): Promise<unknown> {
    return processTask.run<unknown>(async () => {
      try {
        const result = await adapter.processQueued(options.processLimit);
        return { ok: processSucceeded(result), result };
      } catch (error) {
        log.error(channelErrorMessage(error));
        return { ok: false, error: channelErrorMessage(error) };
      }
    }, () => ({ ok: true, skipped: "process_already_running" }));
  }

  function requireInternalRequest(request: IncomingMessage): void {
    if (request.method !== "GET" && request.method !== "POST") {
      throw Object.assign(new Error("method_not_allowed"), { status: 405 });
    }
    if (isLoopbackAddress(request.socket.remoteAddress)) return;
    if (!options.internalApiSecret) {
      throw Object.assign(new Error("internal_api_secret_not_configured"), { status: 503 });
    }
    const value = headerValue(request, options.internalSecretHeader) || headerValue(request, "authorization");
    if (value === options.internalApiSecret || value === `Bearer ${options.internalApiSecret}`) return;
    throw Object.assign(new Error("invalid_internal_api_secret"), { status: 401 });
  }

  async function handleWebhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST") {
      sendChannelJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    if (!options.webhookEnabled) {
      sendChannelJson(response, 503, { ok: false, error: "webhook_disabled" });
      return;
    }
    const rawBody = await readChannelRequestBody(request, options.webhookMaxBodyBytes);
    const auth = await options.verifyWebhook(request, rawBody);
    if (!auth.ok) {
      sendChannelJson(response, auth.statusCode, { ok: false, error: auth.error });
      return;
    }
    if (!webhookRateLimiter.allow(request.socket.remoteAddress)) {
      response.setHeader("retry-after", "60");
      sendChannelJson(response, 429, { ok: false, error: "webhook_rate_limited" });
      return;
    }

    const result = await adapter.ingestWebhook(parseChannelJsonBody(rawBody));
    const queued = options.processingEnabled && result.accepted > 0;
    if (queued) setImmediate(() => { void processTick(); });
    sendChannelJson(response, result.errors > 0 ? 422 : 202, {
      ok: result.errors === 0,
      result,
      processing: queued ? "queued" : "idle"
    });
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const pathname = channelRequestPathname(request);
      if (pathname === "/healthz") {
        sendChannelJson(response, 200, { ok: true });
        return;
      }
      if (pathname === "/" || pathname === "/status") {
        requireInternalRequest(request);
        sendChannelJson(response, 200, await adapter.snapshotStatus());
        return;
      }
      if (pathname === "/poll") {
        requireInternalRequest(request);
        sendChannelJson(response, 200, await pollTick());
        return;
      }
      if (pathname === "/run") {
        requireInternalRequest(request);
        sendChannelJson(response, 200, await processTick());
        return;
      }
      if (webhookPaths.has(pathname)) {
        await handleWebhook(request, response);
        return;
      }
      sendChannelJson(response, 404, { ok: false, error: "not_found" });
    } catch (error) {
      sendChannelJson(response, channelErrorStatusCode(error), { ok: false, error: channelErrorMessage(error) });
    }
  }

  async function readStatus(): Promise<unknown> {
    try {
      return JSON.parse(await fs.readFile(options.statusPath, "utf8")) as unknown;
    } catch {
      return adapter.snapshotStatus();
    }
  }

  const commands: ChannelCliCommand[] = [
    { flag: "--status", run: async () => { log.log(JSON.stringify(await readStatus(), null, 2)); } },
    { flag: "--poll-once", run: async () => { log.log(JSON.stringify(await adapter.pollOnce(), null, 2)); adapter.close(); } },
    {
      flag: "--process-once",
      run: async () => { log.log(JSON.stringify(await adapter.processQueued(options.processLimit), null, 2)); adapter.close(); }
    },
    { flag: "--once", run: async () => { log.log(JSON.stringify(await adapter.runOnce(), null, 2)); adapter.close(); } }
  ];

  const channel = defineChannel({
    service: options.service,
    signals: "always",
    http: {
      host: options.host,
      port: options.port,
      handle,
      onListen: () => {
        log.log(JSON.stringify({
          ok: true,
          service: options.service,
          listening: `http://${options.host}:${options.port}`,
          pollIntervalMs: options.pollIntervalMs,
          processIntervalMs: options.processIntervalMs,
          pollingEnabled: options.pollingEnabled,
          webhookEnabled: options.webhookEnabled,
          processingEnabled: options.processingEnabled,
          ...options.describe?.()
        }));
      }
    },
    // Recovery must repeat so a run whose lease expires after a crash is
    // eventually reclaimed even if this process never restarts again.
    recovery: {
      intervalMs: options.recoveryIntervalMs,
      recover: (recoveryOptions) => adapter.recoverInterruptedRuns(recoveryOptions)
    },
    connect: async () => { await adapter.writeStatus(); },
    afterStart: () => {
      if (options.pollingEnabled) void pollTick();
      if (options.processingEnabled) void processTick();
      // The listening socket owns process lifetime; ticks must not keep a
      // closed service alive on their own.
      setInterval(() => { if (options.pollingEnabled) void pollTick(); }, options.pollIntervalMs).unref();
      setInterval(() => { if (options.processingEnabled) void processTick(); }, options.processIntervalMs).unref();
    },
    shutdown: () => { adapter.close(); },
    commands
  });

  return {
    get server() {
      return channel.server;
    },
    start: (argv?: readonly string[]) => channel.start(argv),
    handle,
    pollTick,
    processTick
  };
}

/**
 * Starts a channel service and exits non-zero when startup fails, which is the
 * signal launchd uses to restart the job.
 */
export function startChannelService<TIngest extends ChannelWebhookIngestResult>(
  service: ChannelService,
  options: { adapter: ChannelServiceAdapter<TIngest>; closeOnFailure?: boolean; log?: Pick<Console, "error"> }
): void {
  const log = options.log || console;
  service.start().catch((error: unknown) => {
    log.error(error instanceof Error ? error.stack || error.message : String(error));
    if (options.closeOnFailure !== false) options.adapter.close();
    process.exit(1);
  });
}

export interface SignedWebhookInput {
  rawBody: string;
  signature: string | undefined;
  timestamp: string | undefined;
  secret: string;
  maxAgeMs: number;
  replay?: ReplayWindow;
  now?: number;
  missingError?: string;
  invalidError?: string;
}

/**
 * Verifies an `HMAC-SHA256(timestamp.body)` signature with a bounded clock skew
 * and optional replay rejection. Seconds and milliseconds timestamps are both
 * accepted because providers disagree.
 */
export function verifySignedWebhook(input: SignedWebhookInput): WebhookVerification {
  const missingError = input.missingError || "missing_webhook_signature";
  const invalidError = input.invalidError || "invalid_webhook_signature";
  if (!input.secret) return { ok: false, statusCode: 503, error: "webhook_secret_not_configured" };
  if (!input.signature || !input.timestamp) return { ok: false, statusCode: 401, error: missingError };
  const now = input.now ?? Date.now();
  const timestampMs = Number(input.timestamp) * (input.timestamp.length <= 10 ? 1000 : 1);
  if (!Number.isFinite(timestampMs) || Math.abs(now - timestampMs) > input.maxAgeMs) {
    return { ok: false, statusCode: 401, error: "stale_webhook_signature" };
  }
  const expected = createHmac("sha256", input.secret).update(`${input.timestamp}.${input.rawBody}`).digest("hex");
  if (!timingSafeStringEqual(input.signature.replace(/^v1=/, ""), expected)) {
    return { ok: false, statusCode: 401, error: invalidError };
  }
  if (input.replay) {
    if (input.replay.isReplay(input.signature, now)) return { ok: false, statusCode: 409, error: "replayed_webhook" };
    input.replay.remember(input.signature, input.maxAgeMs, now);
  }
  return { ok: true };
}

export function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function headerValue(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers[name];
  return Array.isArray(header) ? header[0] : header;
}
