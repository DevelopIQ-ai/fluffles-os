import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// The deploy gate lives or dies on this contract: smoke's slack-health check
// reads fields from GET /healthz, and if the Slack server stops serving one
// of them every deploy fails smoke and rolls itself back forever.

const root = path.join(__dirname, "..");
const smokeSource = fs.readFileSync(path.join(root, "tools", "smoke", "bin", "smoke.ts"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "channels", "slack", "src", "server.ts"), "utf8");

function slackHealthCheckBody(): string {
  const start = smokeSource.indexOf("async function checkSlackHealth(");
  assert.ok(start >= 0, "smoke must define checkSlackHealth");
  const end = smokeSource.indexOf("async function", start + 1);
  return smokeSource.slice(start, end === -1 ? undefined : end);
}

function healthzResponseBody(): string {
  // The Slack server hands its /healthz body to the shared HTTP handler.
  const start = serverSource.indexOf("healthBody: () => ({");
  assert.ok(start >= 0, "slack server must supply a /healthz body");
  const end = serverSource.indexOf("})", start);
  assert.ok(end > start, "the /healthz body must be a literal the contract can read");
  return serverSource.slice(start, end);
}

test("every field smoke's slack-health check reads is served by the Slack /healthz endpoint", () => {
  const check = slackHealthCheckBody();
  const healthz = healthzResponseBody();
  const fields = new Set<string>();
  for (const match of check.matchAll(/health\.([A-Za-z0-9_]+)/g)) {
    fields.add(match[1]);
  }
  assert.ok(fields.size >= 5, "the smoke check should inspect a meaningful health surface");
  for (const field of fields) {
    assert.ok(
      new RegExp(`\\b${field}\\s*:`).test(healthz),
      `smoke reads health.${field} but the Slack /healthz response does not serve it; deploys would fail smoke and roll back`
    );
  }
});

test("smoke accepts every activeTransport value the Slack server can report", () => {
  const check = slackHealthCheckBody();
  const typeMatch = serverSource.match(/activeTransport:\s*([^;]+);/);
  assert.ok(typeMatch, "slack server must declare the activeTransport union type");
  const transports = [...typeMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(transports.length >= 2, "the transport union should enumerate every mode the server can run in");
  for (const transport of transports) {
    assert.ok(
      check.includes(`"${transport}"`),
      `the Slack server can report activeTransport "${transport}" but smoke's check rejects it; deploys would fail smoke and roll back`
    );
  }
});
