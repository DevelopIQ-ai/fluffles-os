import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Shared channel scaffolding. A channel supplies only its platform-specific
 * surface (conversation key derivation, inbound normalization, outbound
 * delivery and reconciliation, health probes, prompt/config); the process
 * lifecycle here (boot order, health endpoint hosting, periodic recovery,
 * drain dispatch, graceful shutdown) is one shared
 * implementation composed through defineChannel.
 */

export function requiredCliArgument(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1]?.trim();
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

export function optionalCliArgument(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index === -1 ? undefined : argv[index + 1]?.trim();
  return value || undefined;
}

export function channelHttpError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

export function channelErrorStatusCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = Number((error as { status?: unknown }).status);
    if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  return 500;
}

export function sendChannelJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json");
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

export function channelRequestPathname(request: IncomingMessage): string {
  return new URL(request.url || "/", "http://127.0.0.1").pathname;
}

export async function readChannelRequestBody(request: IncomingMessage, maxBodyBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) throw channelHttpError("body_too_large", 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseChannelJsonBody(rawBody: string): unknown {
  if (!rawBody.trim()) return {};
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw channelHttpError("invalid_json", 400);
  }
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

/** Fixed one-minute ingress windows keyed by caller address. */
export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly limitPerMinute: number) {}

  allow(key: string | undefined, now = Date.now()): boolean {
    const windowKey = key || "unknown";
    const current = this.windows.get(windowKey);
    if (!current || current.resetAt <= now) {
      this.windows.set(windowKey, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    if (current.count >= this.limitPerMinute) return false;
    current.count += 1;
    return true;
  }
}

/** Bounded-lifetime replay detection for webhook signatures and provider message ids. */
export class ReplayWindow {
  private readonly seen = new Map<string, number>();

  isReplay(key: string, now = Date.now()): boolean {
    for (const [seenKey, expiresAt] of this.seen) {
      if (expiresAt <= now) this.seen.delete(seenKey);
    }
    return this.seen.has(key);
  }

  remember(key: string, ttlMs: number, now = Date.now()): void {
    this.seen.set(key, now + ttlMs);
  }
}

/** Serializes a periodic tick so overlapping timers never run the work twice. */
export class SingleFlightTask {
  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  async run<T>(task: () => Promise<T>, skipped: () => T): Promise<T> {
    if (this.running) return skipped();
    this.running = true;
    try {
      return await task();
    } finally {
      this.running = false;
    }
  }
}

export interface ConversationDrainHooks {
  onError(error: unknown): void | Promise<void>;
  onSettled?(): void;
}

/**
 * One in-flight drain per conversation key. A drain that reports more work
 * remaining is rescheduled on the next tick so a long backlog never starves
 * the event loop or overlaps itself.
 */
export class ConversationDrainQueue {
  private readonly queues = new Map<string, Promise<unknown>>();

  get size(): number {
    return this.queues.size;
  }

  has(key: string): boolean {
    return this.queues.has(key);
  }

  schedule(key: string, drain: () => Promise<boolean>, hooks: ConversationDrainHooks): void {
    if (this.queues.has(key)) return;
    let continueDrain = false;
    const next = Promise.resolve()
      .then(async () => {
        try {
          continueDrain = await drain();
        } catch (error) {
          await hooks.onError(error);
        }
      })
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
        hooks.onSettled?.();
        if (continueDrain) setImmediate(() => { this.schedule(key, drain, hooks); });
      });
    this.queues.set(key, next);
  }
}

export interface ChannelHttpDefinition {
  host: string;
  port: number;
  handle(request: IncomingMessage, response: ServerResponse): void | Promise<void>;
  onListen?(): void;
}

export interface ChannelRecoveryDefinition {
  intervalMs: number;
  recover(options?: { reclaimOwnLeases?: boolean }): Promise<unknown>;
  onError?(error: unknown): void;
}

export interface ChannelCliCommand {
  flag: string;
  run(): Promise<void>;
}

export interface ChannelDefinition {
  service: string;
  http: ChannelHttpDefinition;
  recovery: ChannelRecoveryDefinition;
  /** Platform boot (authentication, identity). Return false to serve health only. */
  boot?(): Promise<boolean | void>;
  /** Platform ingress start (sockets, polling) after recovery has run. */
  connect?(): Promise<void>;
  /** Started after the HTTP server is listening (processing ticks). */
  afterStart?(): void;
  shutdown(): void | Promise<void>;
  /** Exit the process once shutdown settles; channels that stage their own exit set false. */
  exitAfterShutdown?: boolean;
  /** When "always", signal handlers also cover one-shot CLI invocations. */
  signals?: "serving" | "always";
  commands?: ChannelCliCommand[];
}

export interface DefinedChannel {
  /** Resolves "command" for one-shot CLI invocations, "serving" once the runtime is up. */
  start(argv?: readonly string[]): Promise<"command" | "serving">;
  readonly server: Server | null;
}

export function defineChannel(definition: ChannelDefinition): DefinedChannel {
  let server: Server | null = null;
  let recoveryTimer: ReturnType<typeof setInterval> | null = null;

  function startPeriodicRecovery(): void {
    recoveryTimer = setInterval(() => {
      definition.recovery.recover().catch((error) => {
        definition.recovery.onError?.(error);
      });
    }, definition.recovery.intervalMs);
    recoveryTimer.unref();
  }

  function startHttpServer(): void {
    server = http.createServer((request, response) => {
      void definition.http.handle(request, response);
    });
    server.listen(definition.http.port, definition.http.host, () => {
      definition.http.onListen?.();
    });
  }

  function wireSignals(): void {
    const handle = () => {
      const settled = Promise.resolve(definition.shutdown());
      if (definition.exitAfterShutdown === false) {
        settled.catch(() => {});
        return;
      }
      void settled.finally(() => {
        server?.close();
        process.exit(0);
      });
    };
    process.on("SIGTERM", handle);
    process.on("SIGINT", handle);
  }

  return {
    get server() {
      return server;
    },
    async start(argv: readonly string[] = process.argv): Promise<"command" | "serving"> {
      if (definition.signals === "always") wireSignals();
      for (const command of definition.commands || []) {
        if (argv.includes(command.flag)) {
          await command.run();
          return "command";
        }
      }

      if (definition.signals !== "always") wireSignals();
      const ready = (await definition.boot?.()) !== false;
      if (ready) {
        await definition.recovery.recover({ reclaimOwnLeases: true });
        startPeriodicRecovery();
        await definition.connect?.();
      }
      startHttpServer();
      definition.afterStart?.();
      return "serving";
    }
  };
}
