import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReplayWindow } from "../src/channel";
import {
  booleanEnv,
  loadChannelEnv,
  loadEnvFileInto,
  numberEnv,
  parseBooleanEnv,
  parseCsvSet,
  parseNullableStringEnv,
  parseNumberEnv,
  parseStringEnv
} from "../src/channel-env";
import {
  defineChannelService,
  verifySignedWebhook,
  type ChannelService,
  type ChannelServiceAdapter,
  type ChannelServiceOptions,
  type ChannelWebhookIngestResult
} from "../src/channel-service";

interface StubIngest extends ChannelWebhookIngestResult {
  accepted: number;
  errors: number;
}

class StubAdapter implements ChannelServiceAdapter<StubIngest> {
  polls = 0;
  processed: number[] = [];
  ranOnce = 0;
  recoveries: Array<{ reclaimOwnLeases?: boolean } | undefined> = [];
  statusWrites = 0;
  closed = 0;
  ingested: unknown[] = [];
  ingestResult: StubIngest = { accepted: 1, errors: 0 };
  pollError: Error | null = null;
  pollGate: Promise<void> | null = null;

  async pollOnce(): Promise<unknown> {
    this.polls += 1;
    if (this.pollGate) await this.pollGate;
    if (this.pollError) throw this.pollError;
    return { accepted: 0, errors: 0 };
  }

  async processQueued(limit: number): Promise<unknown> {
    this.processed.push(limit);
    return { processed: 0, failed: 0 };
  }

  async runOnce(): Promise<unknown> {
    this.ranOnce += 1;
    return { ok: true };
  }

  async ingestWebhook(payload: unknown): Promise<StubIngest> {
    this.ingested.push(payload);
    return this.ingestResult;
  }

  async snapshotStatus(): Promise<unknown> {
    return { ok: true, source: "snapshot" };
  }

  async writeStatus(): Promise<void> {
    this.statusWrites += 1;
  }

  async recoverInterruptedRuns(options?: { reclaimOwnLeases?: boolean }): Promise<unknown> {
    this.recoveries.push(options);
    return [];
  }

  close(): void {
    this.closed += 1;
  }
}

function serviceOptions(
  adapter: StubAdapter,
  overrides: Partial<ChannelServiceOptions<StubIngest>> = {}
): ChannelServiceOptions<StubIngest> {
  return {
    service: "fluffles-channel-stub",
    host: "127.0.0.1",
    port: 0,
    adapter,
    statusPath: path.join(os.tmpdir(), "fluffles-stub-status-does-not-exist.json"),
    pollIntervalMs: 60_000,
    processIntervalMs: 60_000,
    recoveryIntervalMs: 60_000,
    processLimit: 5,
    pollingEnabled: false,
    processingEnabled: true,
    webhookEnabled: true,
    webhookPaths: ["/webhook/stub", "/stub/inbound"],
    webhookMaxBodyBytes: 1024,
    webhookRateLimitPerMinute: 2,
    verifyWebhook: () => ({ ok: true }),
    internalSecretHeader: "x-stub-internal-secret",
    internalApiSecret: "",
    log: { log: () => {}, error: () => {} },
    ...overrides
  };
}

interface RunningService {
  service: ChannelService;
  origin: string;
  stop(): Promise<void>;
}

async function startService(options: ChannelServiceOptions<StubIngest>): Promise<RunningService> {
  const service = defineChannelService(options);
  await service.start([]);
  const server = service.server;
  assert.ok(server);
  await new Promise<void>((resolve) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once("listening", () => { resolve(); });
  });
  const address = server.address() as AddressInfo;
  return {
    service,
    origin: `http://127.0.0.1:${address.port}`,
    stop: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => { resolve(); });
    })
  };
}

test("health is public and internal routes are loopback-open", async () => {
  const adapter = new StubAdapter();
  const running = await startService(serviceOptions(adapter, { processingEnabled: false }));
  try {
    const health = await fetch(`${running.origin}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const status = await fetch(`${running.origin}/status`);
    assert.equal(status.status, 200);
    assert.deepEqual(await status.json(), { ok: true, source: "snapshot" });

    const poll = await fetch(`${running.origin}/poll`, { method: "POST" });
    assert.equal(poll.status, 200);
    assert.deepEqual(await poll.json(), { ok: true, result: { accepted: 0, errors: 0 } });
    assert.equal(adapter.polls, 1);

    const run = await fetch(`${running.origin}/run`, { method: "POST" });
    assert.equal(run.status, 200);
    assert.deepEqual(adapter.processed, [5]);
  } finally {
    await running.stop();
  }
});

test("unknown paths are 404 and unsupported methods on internal routes are 405", async () => {
  const running = await startService(serviceOptions(new StubAdapter()));
  try {
    const missing = await fetch(`${running.origin}/nope`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { ok: false, error: "not_found" });

    const wrongMethod = await fetch(`${running.origin}/status`, { method: "DELETE" });
    assert.equal(wrongMethod.status, 405);
    assert.deepEqual(await wrongMethod.json(), { ok: false, error: "method_not_allowed" });
  } finally {
    await running.stop();
  }
});

test("boot recovers leases once, then writes status", async () => {
  const adapter = new StubAdapter();
  const running = await startService(serviceOptions(adapter));
  try {
    assert.deepEqual(adapter.recoveries, [{ reclaimOwnLeases: true }]);
    assert.equal(adapter.statusWrites, 1);
  } finally {
    await running.stop();
  }
});

test("a failing poll reports the error without throwing out of the route", async () => {
  const adapter = new StubAdapter();
  adapter.pollError = new Error("gmail_unreachable");
  const running = await startService(serviceOptions(adapter));
  try {
    const response = await fetch(`${running.origin}/poll`, { method: "POST" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: false, error: "gmail_unreachable" });
  } finally {
    await running.stop();
  }
});

test("channel-supplied success predicates decide tick ok", async () => {
  const adapter = new StubAdapter();
  const running = await startService(serviceOptions(adapter, {
    pollSucceeded: (result) => (result as { errors: number }).errors === 0,
    processSucceeded: () => false
  }));
  try {
    const poll = await (await fetch(`${running.origin}/poll`, { method: "POST" })).json();
    assert.deepEqual(poll, { ok: true, result: { accepted: 0, errors: 0 } });
    const run = await (await fetch(`${running.origin}/run`, { method: "POST" })).json();
    assert.deepEqual(run, { ok: false, result: { processed: 0, failed: 0 } });
  } finally {
    await running.stop();
  }
});

test("overlapping ticks are skipped rather than run twice", async () => {
  const adapter = new StubAdapter();
  let release = () => {};
  adapter.pollGate = new Promise<void>((resolve) => { release = resolve; });
  const running = await startService(serviceOptions(adapter));
  try {
    const first = fetch(`${running.origin}/poll`, { method: "POST" });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    const second = await fetch(`${running.origin}/poll`, { method: "POST" });
    assert.deepEqual(await second.json(), { ok: true, skipped: "poll_already_running" });
    release();
    await first;
    assert.equal(adapter.polls, 1);
  } finally {
    await running.stop();
  }
});

test("non-loopback internal calls need the secret", async () => {
  const adapter = new StubAdapter();
  const unset = await startService(serviceOptions(adapter, { host: "0.0.0.0" }));
  const localAddress = `http://${nonLoopbackHost()}:${(unset.service.server?.address() as AddressInfo).port}`;
  try {
    const response = await fetch(`${localAddress}/status`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: "internal_api_secret_not_configured" });
  } finally {
    await unset.stop();
  }

  const guarded = await startService(serviceOptions(adapter, { host: "0.0.0.0", internalApiSecret: "s3cret" }));
  const guardedAddress = `http://${nonLoopbackHost()}:${(guarded.service.server?.address() as AddressInfo).port}`;
  try {
    const rejected = await fetch(`${guardedAddress}/status`);
    assert.equal(rejected.status, 401);
    assert.deepEqual(await rejected.json(), { ok: false, error: "invalid_internal_api_secret" });

    const headerAuthorized = await fetch(`${guardedAddress}/status`, { headers: { "x-stub-internal-secret": "s3cret" } });
    assert.equal(headerAuthorized.status, 200);

    const bearerAuthorized = await fetch(`${guardedAddress}/status`, { headers: { authorization: "Bearer s3cret" } });
    assert.equal(bearerAuthorized.status, 200);
  } finally {
    await guarded.stop();
  }
});

test("webhook accepts, reports errors, and honors the disabled switch", async () => {
  const adapter = new StubAdapter();
  const running = await startService(serviceOptions(adapter));
  try {
    for (const webhookPath of ["/webhook/stub", "/stub/inbound"]) {
      const accepted = await fetch(`${running.origin}${webhookPath}`, {
        method: "POST",
        body: JSON.stringify({ id: webhookPath })
      });
      assert.equal(accepted.status, 202);
      assert.deepEqual(await accepted.json(), {
        ok: true,
        result: { accepted: 1, errors: 0 },
        processing: "queued"
      });
    }
    assert.deepEqual(adapter.ingested, [{ id: "/webhook/stub" }, { id: "/stub/inbound" }]);

    const getRequest = await fetch(`${running.origin}/webhook/stub`);
    assert.equal(getRequest.status, 405);
  } finally {
    await running.stop();
  }

  const failing = new StubAdapter();
  failing.ingestResult = { accepted: 0, errors: 2 };
  const errored = await startService(serviceOptions(failing));
  try {
    const response = await fetch(`${errored.origin}/webhook/stub`, { method: "POST", body: "{}" });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), {
      ok: false,
      result: { accepted: 0, errors: 2 },
      processing: "idle"
    });
  } finally {
    await errored.stop();
  }

  const disabled = await startService(serviceOptions(new StubAdapter(), { webhookEnabled: false }));
  try {
    const response = await fetch(`${disabled.origin}/webhook/stub`, { method: "POST", body: "{}" });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: "webhook_disabled" });
  } finally {
    await disabled.stop();
  }
});

test("webhook rejection, oversized bodies, invalid json, and rate limits never reach the adapter", async () => {
  const adapter = new StubAdapter();
  const rejecting = await startService(serviceOptions(adapter, {
    verifyWebhook: () => ({ ok: false, statusCode: 401, error: "invalid_signature" })
  }));
  try {
    const response = await fetch(`${rejecting.origin}/webhook/stub`, { method: "POST", body: "{}" });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: "invalid_signature" });
    assert.deepEqual(adapter.ingested, []);
  } finally {
    await rejecting.stop();
  }

  const running = await startService(serviceOptions(adapter, { webhookRateLimitPerMinute: 10_000 }));
  try {
    const oversized = await fetch(`${running.origin}/webhook/stub`, { method: "POST", body: "x".repeat(2048) });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { ok: false, error: "body_too_large" });

    const invalid = await fetch(`${running.origin}/webhook/stub`, { method: "POST", body: "not json" });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { ok: false, error: "invalid_json" });
  } finally {
    await running.stop();
  }

  // The limiter allows two requests per minute per caller.
  const limitedService = await startService(serviceOptions(new StubAdapter(), { webhookRateLimitPerMinute: 2 }));
  try {
    assert.equal((await fetch(`${limitedService.origin}/webhook/stub`, { method: "POST", body: "{}" })).status, 202);
    assert.equal((await fetch(`${limitedService.origin}/webhook/stub`, { method: "POST", body: "{}" })).status, 202);
    const limited = await fetch(`${limitedService.origin}/webhook/stub`, { method: "POST", body: "{}" });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.deepEqual(await limited.json(), { ok: false, error: "webhook_rate_limited" });
  } finally {
    await limitedService.stop();
  }
});

test("processing disabled leaves accepted work idle", async () => {
  const adapter = new StubAdapter();
  const running = await startService(serviceOptions(adapter, { processingEnabled: false }));
  try {
    const response = await fetch(`${running.origin}/webhook/stub`, { method: "POST", body: "{}" });
    assert.deepEqual(await response.json(), {
      ok: true,
      result: { accepted: 1, errors: 0 },
      processing: "idle"
    });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    assert.deepEqual(adapter.processed, []);
  } finally {
    await running.stop();
  }
});

test("one-shot CLI flags run without serving and close the adapter", async () => {
  for (const [flag, check] of [
    ["--poll-once", (adapter: StubAdapter) => assert.equal(adapter.polls, 1)],
    ["--process-once", (adapter: StubAdapter) => assert.deepEqual(adapter.processed, [5])],
    ["--once", (adapter: StubAdapter) => assert.equal(adapter.ranOnce, 1)]
  ] as const) {
    const adapter = new StubAdapter();
    const service = defineChannelService(serviceOptions(adapter));
    assert.equal(await service.start([flag]), "command");
    assert.equal(service.server, null);
    check(adapter);
    assert.equal(adapter.closed, 1);
  }
});

test("--status prefers the host status file and falls back to a live snapshot", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fluffles-status-"));
  const statusPath = path.join(dir, "status.json");
  writeFileSync(statusPath, JSON.stringify({ ok: true, source: "file" }), "utf8");
  const lines: string[] = [];
  const log = { log: (value: string) => { lines.push(value); }, error: () => {} };

  const withFile = defineChannelService(serviceOptions(new StubAdapter(), { statusPath, log }));
  assert.equal(await withFile.start(["--status"]), "command");
  assert.deepEqual(JSON.parse(lines[0] as string), { ok: true, source: "file" });

  const withoutFile = defineChannelService(serviceOptions(new StubAdapter(), {
    statusPath: path.join(dir, "missing.json"),
    log
  }));
  assert.equal(await withoutFile.start(["--status"]), "command");
  assert.deepEqual(JSON.parse(lines[1] as string), { ok: true, source: "snapshot" });
});

test("verifySignedWebhook enforces secret, freshness, signature, and replay", () => {
  const secret = "shhh";
  const rawBody = JSON.stringify({ hello: "world" });
  const now = 1_700_000_000_000;
  const seconds = String(Math.floor(now / 1000));
  const sign = (timestamp: string) => createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");

  assert.deepEqual(
    verifySignedWebhook({ rawBody, signature: sign(seconds), timestamp: seconds, secret: "", maxAgeMs: 60_000, now }),
    { ok: false, statusCode: 503, error: "webhook_secret_not_configured" }
  );
  assert.deepEqual(
    verifySignedWebhook({ rawBody, signature: sign(seconds), timestamp: undefined, secret, maxAgeMs: 60_000, now }),
    { ok: false, statusCode: 401, error: "missing_webhook_signature" }
  );
  const stale = String(Math.floor(now / 1000) - 600);
  assert.deepEqual(
    verifySignedWebhook({ rawBody, signature: sign(stale), timestamp: stale, secret, maxAgeMs: 60_000, now }),
    { ok: false, statusCode: 401, error: "stale_webhook_signature" }
  );
  assert.deepEqual(
    verifySignedWebhook({ rawBody, signature: "v1=deadbeef", timestamp: seconds, secret, maxAgeMs: 60_000, now }),
    { ok: false, statusCode: 401, error: "invalid_webhook_signature" }
  );
  assert.deepEqual(
    verifySignedWebhook({ rawBody, signature: `v1=${sign(seconds)}`, timestamp: seconds, secret, maxAgeMs: 60_000, now }),
    { ok: true }
  );
  // Millisecond timestamps are accepted too.
  const millis = String(now);
  assert.deepEqual(
    verifySignedWebhook({ rawBody, signature: sign(millis), timestamp: millis, secret, maxAgeMs: 60_000, now }),
    { ok: true }
  );

  const replay = new ReplayWindow();
  const signature = sign(seconds);
  assert.deepEqual(
    verifySignedWebhook({ rawBody, signature, timestamp: seconds, secret, maxAgeMs: 60_000, replay, now }),
    { ok: true }
  );
  assert.deepEqual(
    verifySignedWebhook({ rawBody, signature, timestamp: seconds, secret, maxAgeMs: 60_000, replay, now }),
    { ok: false, statusCode: 409, error: "replayed_webhook" }
  );
});

test("channel env files load in order without overriding or importing secrets", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "fluffles-home-"));
  mkdirSync(path.join(home, "channels", "stub"), { recursive: true });
  mkdirSync(path.join(home, "state", "channels", "stub"), { recursive: true });
  writeFileSync(path.join(home, "channels", "stub", "channel.env"), [
    "# comment",
    "STUB_MODE=\"deployed\"",
    "STUB_PORT=3005",
    "STUB_SECRET=from-file",
    "STUB_INJECTED=file-loses"
  ].join("\n"), "utf8");
  writeFileSync(path.join(home, "state", "channels", "stub", "runtime.env"), "STUB_MODE=runtime-loses\nSTUB_HOST='127.0.0.1'\n", "utf8");
  writeFileSync(path.join(home, "channels", "stub", ".env"), "STUB_LOCAL=dev\n", "utf8");

  const env: NodeJS.ProcessEnv = { STUB_INJECTED: "infisical-wins" };
  loadChannelEnv("stub", { home, env, localSecretKeys: ["STUB_SECRET"] });

  assert.deepEqual(env, {
    STUB_INJECTED: "infisical-wins",
    STUB_MODE: "deployed",
    STUB_PORT: "3005",
    STUB_HOST: "127.0.0.1",
    STUB_LOCAL: "dev"
  });
});

test("lines that are not plain KEY=value are ignored", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fluffles-env-"));
  const filePath = path.join(dir, "channel.env");
  writeFileSync(filePath, [
    "export STUB_SECRET=sneaky",
    "9STUB=leading-digit",
    "STUB WITH SPACE=nope",
    "novalue",
    "STUB_OK=yes"
  ].join("\n"), "utf8");

  const env: NodeJS.ProcessEnv = {};
  loadEnvFileInto(filePath, { env, localSecretKeys: ["STUB_SECRET"] });
  assert.deepEqual(env, { STUB_OK: "yes" });
});

test("a missing env file is not an error", () => {
  const env: NodeJS.ProcessEnv = {};
  loadEnvFileInto(path.join(os.tmpdir(), "fluffles-absent.env"), { env });
  assert.deepEqual(env, {});
});

test("numeric and boolean env parsing clamps and defaults", () => {
  assert.equal(numberEnv(undefined, 10, 1, 100), 10);
  assert.equal(numberEnv("not-a-number", 10, 1, 100), 10);
  assert.equal(numberEnv("500", 10, 1, 100), 100);
  assert.equal(numberEnv("0", 10, 1, 100), 1);
  assert.equal(numberEnv("42.9", 10, 1, 100), 42);

  assert.equal(booleanEnv(undefined, true), true);
  assert.equal(booleanEnv("", false), false);
  assert.equal(booleanEnv("TRUE", false), true);
  assert.equal(booleanEnv("1", false), true);
  assert.equal(booleanEnv("false", true), false);
  assert.equal(booleanEnv("0", true), false);
  assert.equal(booleanEnv("maybe", true), true);
});

test("strict env parsing fails a misconfigured value instead of clamping it", () => {
  assert.equal(parseBooleanEnv("FLAG", undefined, true), true);
  assert.equal(parseBooleanEnv("FLAG", "YES", false), true);
  assert.equal(parseBooleanEnv("FLAG", "off", true), false);
  assert.throws(() => parseBooleanEnv("FLAG", "sometimes", false), /Invalid boolean env FLAG/);

  assert.equal(parseNumberEnv("PORT", undefined, 3000, { integer: true, min: 1 }), 3000);
  assert.equal(parseNumberEnv("PORT", " 3001 ", 3000, { integer: true, min: 1, max: 65535 }), 3001);
  assert.throws(() => parseNumberEnv("PORT", "3.14", 3000, { integer: true }), /Invalid integer env PORT/);
  assert.throws(() => parseNumberEnv("PORT", "0", 3000, { min: 1 }), /must be >= 1/);
  assert.throws(() => parseNumberEnv("PORT", "99999", 3000, { max: 65535 }), /must be <= 65535/);
  assert.throws(() => parseNumberEnv("PORT", "nope", 3000), /Invalid number env PORT/);

  assert.equal(parseStringEnv("  value  ", "fallback"), "value");
  assert.equal(parseStringEnv("   ", "fallback"), "fallback");
  assert.equal(parseNullableStringEnv("   "), null);
  assert.deepEqual([...parseCsvSet("A, B,,C")], ["A", "B", "C"]);
});

function nonLoopbackHost(): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "127.0.0.1";
}
