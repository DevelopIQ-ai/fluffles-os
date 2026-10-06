import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { AddressInfo } from "node:net";

const root = path.resolve(__dirname, "..");
const relay = path.join(root, "tools", "automations-relay", "bin", "automations-relay.ts");
const secret = "relay-test-secret";

type Delivery = { headers: http.IncomingHttpHeaders; body: string };

async function withDaemon(
  status: number,
  run: (url: string, deliveries: Delivery[]) => Promise<void>
): Promise<Delivery[]> {
  const deliveries: Delivery[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      deliveries.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: status < 400 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await run(`http://127.0.0.1:${port}/events/inbound`, deliveries);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return deliveries;
}

async function post(
  url: string,
  stdin: string,
  environment: Record<string, string> = {},
  args: readonly string[] = []
): Promise<{ status: number | null; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", relay, ...args], {
    env: {
      ...process.env,
      AUTOMATIONS_EVENT_SECRET: secret,
      AUTOMATIONS_RELAY_URL: url,
      ...environment
    }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end(stdin);
  const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { status, stderr };
}

test("the relay signs the event it forwards and carries the delivery id", async () => {
  const deliveries = await withDaemon(202, async (url) => {
    const result = await post(
      url,
      JSON.stringify({ source: "email", event: "inbound", deliveryId: "d-1", payload: { subject: "hi" } })
    );
    assert.equal(result.status, 0, result.stderr);
  });
  assert.equal(deliveries.length, 1);
  const [delivery] = deliveries;
  assert.ok(delivery);
  assert.equal(delivery.headers["x-delivery-id"], "d-1");
  assert.equal(
    delivery.headers["x-webhook-signature"],
    `sha256=${createHmac("sha256", secret).update(Buffer.from(delivery.body, "utf8")).digest("hex")}`
  );
  assert.deepEqual(JSON.parse(delivery.body), {
    source: "email",
    event: "inbound",
    payload: { subject: "hi" }
  });
});

test("the relay fails rather than forwarding an event it cannot sign", async () => {
  const deliveries = await withDaemon(202, async (url) => {
    const result = await post(url, JSON.stringify({ source: "email", event: "inbound" }), {
      AUTOMATIONS_EVENT_SECRET: ""
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /AUTOMATIONS_EVENT_SECRET is not in the environment/);
  });
  assert.equal(deliveries.length, 0);
});

test("a daemon that rejects the delivery leaves the relay free to redeliver", async () => {
  // The provider decides to retry on a non-zero exit, so a rejected delivery
  // must not look like a success.
  await withDaemon(500, async (url) => {
    const result = await post(url, JSON.stringify({ source: "email", event: "inbound", deliveryId: "d-2" }));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /daemon answered 500/);
  });
});

test("the health probe answers without delivering an event", async () => {
  const deliveries = await withDaemon(200, async (url) => {
    const result = await post(url, "", {}, ["--health"]);
    assert.equal(result.status, 0, result.stderr);
  });
  assert.equal(deliveries.length, 1);
  const [probe] = deliveries;
  assert.ok(probe);
  assert.equal(probe.body, "", "a health probe must not deliver an event");
});

test("the relay wrapper takes its secret from the scoped Infisical path", () => {
  const wrapper = fs.readFileSync(path.join(root, "bin", "automations-relay"), "utf8");
  assert.match(wrapper, /\$\{home\}\/packages\/auth\/bin\/infisical-run" --path \/services\/automations /);
  assert.match(wrapper, /tools\/automations-relay\/bin\/automations-relay\.ts/);
  assert.ok((fs.statSync(path.join(root, "bin", "automations-relay")).mode & 0o111) !== 0);
});
