import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { type AddressInfo } from "node:net";

const root = path.resolve(__dirname, "..");

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function requestJson(port: number, method: string, requestPath: string, body?: unknown): Promise<Record<string, unknown>> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: requestPath,
      method,      headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : undefined
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const parsed = JSON.parse(text || "{}");
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`${method} ${requestPath} returned ${res.statusCode}: ${text}`));
          return;
        }
        resolve(parsed as Record<string, unknown>);
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("request-timeout")));
    if (payload) req.write(payload);
    req.end();
  });
}

test("webhook HTTP service handles local test and generic events", { timeout: 30000 }, async () => {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "webhooks-service-test-"));
  process.env.WEBHOOK_STATE_DIR = stateDir;
  process.env.WEBHOOK_HOST = "127.0.0.1";
  process.env.WEBHOOK_PORT = "8787";
  delete process.env.HARNESS_WEBHOOK_SECRET;
  delete process.env.GITHUB_WEBHOOK_SECRET;

  const { handle } = await import(path.join(root, "src", "server")) as { handle: Handler };
  const server = http.createServer((req, res) => { void handle(req, res); });
  const port = await listen(server);
  try {
    const health = await requestJson(port, "GET", "/healthz");
    assert.equal(health.ok, true);
    assert.equal(health.service, "webhooks");

    const testReceipt = await requestJson(port, "POST", "/events/test", { smoke: true, source: "test-suite" });
    assert.equal(testReceipt.ok, true);
    assert.equal(testReceipt.routeId, "test");
    assert.equal(testReceipt.trusted, true);

    const genericReceipt = await requestJson(port, "POST", "/events/generic", { hello: "world" });
    assert.equal(genericReceipt.ok, true);
    assert.equal(genericReceipt.routeId, "generic");
    assert.equal(genericReceipt.trusted, true);

    const latest = await requestJson(port, "GET", "/events/latest");
    const event = latest.event as Record<string, unknown>;
    assert.equal(event.id, genericReceipt.id);
    assert.equal(event.source, "generic");
  } finally {
    await close(server);
    await fsp.rm(stateDir, { recursive: true, force: true });  }
});
