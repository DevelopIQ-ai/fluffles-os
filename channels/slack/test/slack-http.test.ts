import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createSlackHttpHandler, type SlackHttpDependencies } from "../src/slack-http";

const signingSecret = "signing-secret";

interface Harness {
  server: Server;
  url: string;
  events: unknown[];
  status: SlackHttpDependencies["status"];
  statusWrites: number;
  close(): Promise<void>;
}

async function harness(overrides: Partial<SlackHttpDependencies> = {}): Promise<Harness> {
  const events: unknown[] = [];
  const status = { lastWebhookAt: null, lastWebhookError: null, lastEventAt: null, lastError: null };
  const state = { statusWrites: 0 };
  const handler = createSlackHttpHandler({
    status,
    healthBody: () => ({ ok: true, service: "fluffles-channel-slack" }),
    publicStatus: () => ({ ok: true, secretish: true }),
    writeStatus: async () => { state.statusWrites += 1; },
    processSlackEvent: async (event) => { events.push(event); },
    allowWebhookRequest: () => true,
    signingSecret,
    maxBodyBytes: 1024,
    formatError: (error) => (error instanceof Error ? error.message : String(error)),
    log: { error: () => {} },
    ...overrides
  });
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    events,
    status,
    get statusWrites() { return state.statusWrites; },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    })
  };
}

function signedHeaders(body: string, timestampSeconds = Math.floor(Date.now() / 1000)): Record<string, string> {
  const timestamp = String(timestampSeconds);
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": timestamp,
    "x-slack-signature": `v0=${crypto.createHmac("sha256", signingSecret).update(`v0:${timestamp}:${body}`).digest("hex")}`
  };
}

test("health is public and the status route is unlisted without the internal token", async () => {
  const app = await harness();
  try {
    const health = await fetch(`${app.url}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), '{"ok":true,"service":"fluffles-channel-slack"}\n');

    const anonymous = await fetch(`${app.url}/`);
    assert.equal(anonymous.status, 404);
    assert.deepEqual(await anonymous.json(), { ok: false, error: "not_found" });

    const wrongToken = await fetch(`${app.url}/`, { headers: { "x-fluffles-internal-token": "nope" } });
    assert.equal(wrongToken.status, 404);

    for (const headers of [
      { "x-fluffles-internal-token": signingSecret },
      { authorization: `Bearer ${signingSecret}` }
    ]) {
      const authorized = await fetch(`${app.url}/`, { headers });
      assert.equal(authorized.status, 200);
      assert.deepEqual(await authorized.json(), { ok: true, secretish: true });
    }

    const unknown = await fetch(`${app.url}/nope`);
    assert.equal(unknown.status, 404);
    const wrongMethod = await fetch(`${app.url}/healthz`, { method: "POST" });
    assert.equal(wrongMethod.status, 404);
  } finally {
    await app.close();
  }
});

test("the events route answers the url_verification handshake and dispatches event_callback", async () => {
  const app = await harness();
  try {
    const challengeBody = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const challenge = await fetch(`${app.url}/slack/events`, {
      method: "POST",
      headers: signedHeaders(challengeBody),
      body: challengeBody
    });
    assert.equal(challenge.status, 200);
    assert.equal(challenge.headers.get("content-type"), "text/plain");
    assert.equal(await challenge.text(), "abc123");

    const eventBody = JSON.stringify({
      type: "event_callback",
      event_id: "Ev1",
      event_time: 1700000000,
      event: { type: "message", channel: "C1", ts: "1.1", text: "hi" }
    });
    const accepted = await fetch(`${app.url}/slack/events`, {
      method: "POST",
      headers: signedHeaders(eventBody),
      body: eventBody
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true });
    assert.equal(app.events.length, 1);
    assert.equal((app.events[0] as { event_id: string }).event_id, "Ev1");
    assert.equal((app.events[0] as { event_ts: string }).event_ts, "1700000000");
    assert.ok(app.status.lastEventAt);

    const ignoredBody = JSON.stringify({ type: "something_else" });
    const ignored = await fetch(`${app.url}/slack/events`, {
      method: "POST",
      headers: signedHeaders(ignoredBody),
      body: ignoredBody
    });
    assert.equal(ignored.status, 200);
    assert.deepEqual(await ignored.json(), { ok: true, ignored: true });
    assert.equal(app.events.length, 1);
  } finally {
    await app.close();
  }
});

test("the events route rejects bad signatures, stale timestamps, oversized bodies, and bad json", async () => {
  const app = await harness({ maxBodyBytes: 128 });
  try {
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });

    const unsigned = await fetch(`${app.url}/slack/events`, { method: "POST", body });
    assert.equal(unsigned.status, 401);
    assert.deepEqual(await unsigned.json(), { ok: false, error: "invalid_signature" });

    const stale = await fetch(`${app.url}/slack/events`, {
      method: "POST",
      headers: signedHeaders(body, Math.floor(Date.now() / 1000) - 301),
      body
    });
    assert.equal(stale.status, 401);

    const large = "x".repeat(256);
    const oversized = await fetch(`${app.url}/slack/events`, {
      method: "POST",
      headers: signedHeaders(large),
      body: large
    });
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { ok: false, error: "payload_too_large" });

    const badJson = "not-json";
    const invalid = await fetch(`${app.url}/slack/events`, {
      method: "POST",
      headers: signedHeaders(badJson),
      body: badJson
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { ok: false, error: "invalid_json" });
    assert.equal(app.status.lastWebhookError, "invalid_json");
  } finally {
    await app.close();
  }
});

test("an unconfigured signing secret answers 503 and a rate limited caller answers 429", async () => {
  const unconfigured = await harness({ signingSecret: "" });
  try {
    const response = await fetch(`${unconfigured.url}/slack/events`, { method: "POST", body: "{}" });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: "missing_signing_secret" });
    // Without a signing secret the internal status route stays unlisted too.
    assert.equal((await fetch(`${unconfigured.url}/`)).status, 404);
  } finally {
    await unconfigured.close();
  }

  const limited = await harness({ allowWebhookRequest: () => false });
  try {
    const response = await fetch(`${limited.url}/slack/events`, { method: "POST", body: "{}" });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.deepEqual(await response.json(), { ok: false, error: "rate_limited" });
  } finally {
    await limited.close();
  }
});

test("a failing event handler reports event_processing_failed and records the error", async () => {
  const app = await harness({
    processSlackEvent: async () => { throw new Error("boom"); }
  });
  try {
    const body = JSON.stringify({
      type: "event_callback",
      event: { type: "message", channel: "C1", ts: "1.1", text: "hi" }
    });
    const response = await fetch(`${app.url}/slack/events`, {
      method: "POST",
      headers: signedHeaders(body),
      body
    });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { ok: false, error: "event_processing_failed" });
    assert.equal(app.status.lastWebhookError, "boom");
    assert.equal(app.status.lastError, "boom");
  } finally {
    await app.close();
  }
});
