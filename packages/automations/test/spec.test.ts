import assert from "node:assert/strict";
import test from "node:test";
import { parseAutomationSpec } from "../src/spec";
import { renderTemplate, expandPlaceholders } from "../src/template";

const validDocument = {
  name: "Capability health",
  triggers: [
    { kind: "schedule", cron: "*/5 * * * *", tz: "America/Los_Angeles" },
    { kind: "event", source: "email", event: "inbound" },
    { kind: "manual" }
  ],
  steps: [{ kind: "command", name: "probe", argv: ["/bin/echo", "ok"] }]
};

test("accepts a spec with several trigger kinds", () => {
  const parsed = parseAutomationSpec(validDocument, "capability-health");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.spec.id, "capability-health");
  assert.equal(parsed.spec.enabled, true);
  assert.equal(parsed.spec.triggers.length, 3);
  assert.equal(parsed.spec.limits.maxConcurrentRuns, 1);
});

test("collects every issue rather than failing at the first", () => {
  const parsed = parseAutomationSpec({ triggers: [{ kind: "schedule", cron: "nope" }], steps: [] }, "broken");
  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  const paths = parsed.issues.map((issue) => issue.path);
  assert.ok(paths.includes("name"));
  assert.ok(paths.includes("triggers[0].cron"));
  assert.ok(paths.includes("steps"));
});

test("rejects unknown trigger kinds and time zones", () => {
  const unknownKind = parseAutomationSpec({ ...validDocument, triggers: [{ kind: "webhook" }] }, "x");
  assert.equal(unknownKind.ok, false);
  const badZone = parseAutomationSpec(
    { ...validDocument, triggers: [{ kind: "schedule", cron: "* * * * *", tz: "Mars/Olympus" }] },
    "x"
  );
  assert.equal(badZone.ok, false);
});

test("requires http triggers to declare a rooted path", () => {
  const parsed = parseAutomationSpec({ ...validDocument, triggers: [{ kind: "http", path: "github" }] }, "x");
  assert.equal(parsed.ok, false);
});

test("a whole-string reference keeps the referenced value's type", () => {
  const context = { event: { payload: { inbound: { from: "kush" } } } };
  assert.deepEqual(renderTemplate("{{event.payload.inbound}}", context), { from: "kush" });
  assert.equal(renderTemplate("from {{event.payload.inbound.from}}", context), "from kush");
});

test("alternatives resolve to the first defined path", () => {
  const withInbound = { event: { payload: { inbound: { id: 1 } } } };
  const withoutInbound = { event: { payload: { id: 2 } } };
  assert.deepEqual(renderTemplate("{{event.payload.inbound|event.payload}}", withInbound), { id: 1 });
  assert.deepEqual(renderTemplate("{{event.payload.inbound|event.payload}}", withoutInbound), { id: 2 });
});

test("placeholders expand before parsing", () => {
  const expanded = expandPlaceholders('{"cwd":"{{ROOT}}"}', { ROOT: "/Users/ai" });
  assert.equal(expanded, '{"cwd":"/Users/ai"}');
});
