import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Automations } from "../src/service";
import type { AutomationEvent, CommandStep, HttpStep } from "../src/types";

type Harness = {
  automations: Automations;
  root: string;
  stateDir: string;
  commands: { argv: readonly string[]; event: AutomationEvent }[];
  posts: { url: string; event: AutomationEvent }[];
  setNow(iso: string): void;
  cleanup(): Promise<void>;
};

function writeSpec(root: string, id: string, document: Record<string, unknown>): void {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, "automation.json"), JSON.stringify(document, null, 2), "utf8");
}

function harness(specs: Record<string, Record<string, unknown>>, startIso = "2026-08-02T10:00:00.000Z"): Harness {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "automations-"));
  const root = path.join(base, "automations");
  for (const [id, document] of Object.entries(specs)) writeSpec(root, id, document);
  const commands: { argv: readonly string[]; event: AutomationEvent }[] = [];
  const posts: { url: string; event: AutomationEvent }[] = [];
  let current = new Date(startIso);
  const stateDir = path.join(base, "state");
  const automations = new Automations({
    root,
    stateDir,
    now: () => current,
    executors: {
      async command(step: CommandStep, event: AutomationEvent) {
        commands.push({ argv: step.argv, event });
        if (step.argv.includes("fail")) throw new Error("command failed");
        return "ok";
      },
      async http(step: HttpStep, event: AutomationEvent) {
        posts.push({ url: step.url, event });
        return "accepted";
      }
    }
  });
  return {
    automations,
    root,
    stateDir,
    commands,
    posts,
    setNow: (iso: string) => { current = new Date(iso); },
    cleanup: async () => {
      await automations.stop();
      fs.rmSync(base, { recursive: true, force: true });
    }
  };
}

const scheduleAndEvent = {
  name: "Inbound and hourly",
  triggers: [
    { kind: "schedule", cron: "0 * * * *", tz: "UTC" },
    { kind: "event", source: "email", event: "inbound" },
    { kind: "http", method: "POST", path: "/github/events", verify: { style: "hmac-sha256", header: "x-hub-signature-256", secretEnv: "TEST_WEBHOOK_SECRET" } }
  ],
  steps: [
    { kind: "command", name: "note", argv: ["/bin/echo", "{{event.source}}"] },
    { kind: "http", name: "forward", url: "http://127.0.0.1:3001/webhook/email", body: { inbound: "{{event.payload.inbound|event.payload}}" } }
  ]
};

test("one automation fires from a schedule, an event, and an http request", async (t) => {
  const context = harness({ "inbound-and-hourly": scheduleAndEvent });
  t.after(() => context.cleanup());

  await context.automations.sync();
  assert.deepEqual(await context.automations.tick(), []);

  context.setNow("2026-08-02T11:00:30.000Z");
  const scheduled = await context.automations.tick();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]?.status, "completed");
  assert.equal(scheduled[0]?.triggerKind, "schedule");

  const eventRuns = await context.automations.dispatchEvent({
    source: "email",
    event: "inbound",
    payload: { inbound: { from: "kush" } },
    headers: {},
    receivedAt: "2026-08-02T11:01:00.000Z"
  });
  assert.equal(eventRuns.length, 1);
  assert.equal(eventRuns[0]?.triggerKind, "event");
  assert.deepEqual(context.posts.at(-1)?.event.payload, { inbound: { from: "kush" } });

  process.env.TEST_WEBHOOK_SECRET = "shh";
  const rawBody = Buffer.from(JSON.stringify({ action: "opened" }), "utf8");
  const signature = `sha256=${createHmac("sha256", "shh").update(rawBody).digest("hex")}`;
  const accepted = await context.automations.handleRequest({
    method: "POST",
    path: "/github/events",
    headers: { "x-hub-signature-256": signature },
    rawBody
  });
  assert.equal(accepted.status, 202);

  const rejected = await context.automations.handleRequest({
    method: "POST",
    path: "/github/events",
    headers: { "x-hub-signature-256": "sha256=wrong" },
    rawBody
  });
  assert.equal(rejected.status, 401);

  const runs = await context.automations.recentRuns("inbound-and-hourly", 10);
  assert.equal(runs.length, 3);
  assert.deepEqual([...new Set(runs.map((run) => run.triggerKind))].sort(), ["event", "http", "schedule"]);
});

test("a schedule that came due while stopped fires once, not once per missed slot", async (t) => {
  const context = harness({ "every-minute": {
    name: "Every minute",
    triggers: [{ kind: "schedule", cron: "* * * * *", tz: "UTC" }],
    steps: [{ kind: "command", name: "tick", argv: ["/bin/echo", "tick"] }]
  } });
  t.after(() => context.cleanup());

  await context.automations.sync();
  context.setNow("2026-08-02T12:00:00.000Z");
  const runs = await context.automations.tick();
  assert.equal(runs.length, 1);
  assert.equal(context.commands.length, 1);
});

test("a failing step fails the run and stops later steps", async (t) => {
  const context = harness({ broken: {
    name: "Broken",
    triggers: [{ kind: "manual" }],
    steps: [
      { kind: "command", name: "boom", argv: ["/bin/echo", "fail"] },
      { kind: "http", name: "never", url: "http://127.0.0.1:9/never" }
    ]
  } });
  t.after(() => context.cleanup());

  const run = await context.automations.run("broken");
  assert.equal(run.status, "failed");
  assert.equal(run.steps.length, 1);
  assert.equal(context.posts.length, 0);
});

test("disabled automations never fire, and invalid specs fail validation", async (t) => {
  const context = harness({
    off: {
      name: "Off",
      enabled: false,
      triggers: [{ kind: "schedule", cron: "* * * * *", tz: "UTC" }, { kind: "event", source: "email", event: "inbound" }],
      steps: [{ kind: "command", name: "noop", argv: ["/bin/echo", "noop"] }]
    },
    bad: { name: "Bad", triggers: [{ kind: "schedule", cron: "nope", tz: "UTC" }], steps: [] }
  });
  t.after(() => context.cleanup());

  const report = context.automations.validate();
  assert.equal(report.ok, false);
  assert.deepEqual(report.automations.filter((entry) => !entry.ok).map((entry) => entry.id), ["bad"]);

  const runs = await context.automations.dispatchEvent({
    source: "email",
    event: "inbound",
    payload: {},
    headers: {},
    receivedAt: "2026-08-02T10:00:00.000Z"
  });
  assert.deepEqual(runs, []);
});

test("editing a schedule discards the stored next run", async (t) => {
  const context = harness({ movable: {
    name: "Movable",
    triggers: [{ kind: "schedule", cron: "0 3 * * *", tz: "UTC" }],
    steps: [{ kind: "command", name: "noop", argv: ["/bin/echo", "noop"] }]
  } });
  t.after(() => context.cleanup());

  await context.automations.sync();
  const before = await context.automations.summarize();
  assert.equal(before[0]?.nextRunAt, "2026-08-03T03:00:00.000Z");

  writeSpec(context.root, "movable", {
    name: "Movable",
    triggers: [{ kind: "schedule", cron: "0 4 * * *", tz: "UTC" }],
    steps: [{ kind: "command", name: "noop", argv: ["/bin/echo", "noop"] }]
  });
  await context.automations.sync();
  const after = await context.automations.summarize();
  assert.equal(after[0]?.nextRunAt, "2026-08-03T04:00:00.000Z");
});

test("removing a spec forgets its stored state", async (t) => {
  const context = harness({ temporary: {
    name: "Temporary",
    triggers: [{ kind: "schedule", cron: "0 * * * *", tz: "UTC" }],
    steps: [{ kind: "command", name: "noop", argv: ["/bin/echo", "noop"] }]
  } });
  t.after(() => context.cleanup());

  await context.automations.sync();
  fs.rmSync(path.join(context.root, "temporary"), { recursive: true, force: true });
  await context.automations.sync();
  assert.deepEqual(await context.automations.summarize(), []);
});

test("a spec added while the daemon runs is scheduled on the next tick", async (t) => {
  const context = harness({ existing: {
    name: "Existing",
    triggers: [{ kind: "schedule", cron: "0 * * * *", tz: "UTC" }],
    steps: [{ kind: "command", name: "noop", argv: ["/bin/echo", "noop"] }]
  } });
  t.after(() => context.cleanup());

  await context.automations.sync();
  writeSpec(context.root, "added", {
    name: "Added",
    triggers: [{ kind: "schedule", cron: "*/5 * * * *", tz: "UTC" }],
    steps: [{ kind: "command", name: "noop", argv: ["/bin/echo", "added"] }]
  });

  context.setNow("2026-08-02T10:06:00.000Z");
  assert.deepEqual(await context.automations.tick(), []);
  assert.equal((await context.automations.summarize()).find((entry) => entry.id === "added")?.nextRunAt, "2026-08-02T10:10:00.000Z");

  context.setNow("2026-08-02T10:10:00.000Z");
  const runs = await context.automations.tick();
  assert.deepEqual(runs.map((run) => run.automationId), ["added"]);
});

test("credential headers never reach the durable run history", async (t) => {
  const context = harness({ hooked: {
    name: "Hooked",
    triggers: [{ kind: "http", method: "POST", path: "/hook" }],
    steps: [{ kind: "command", name: "noop", argv: ["/bin/echo", "noop"] }]
  } });
  t.after(() => context.cleanup());

  const response = await context.automations.handleRequest({
    method: "POST",
    path: "/hook",
    headers: {
      authorization: "Bearer super-secret-token",
      cookie: "session=abc",
      "x-hub-signature-256": "sha256=deadbeef",
      "content-type": "application/json"
    },
    rawBody: Buffer.from("{}", "utf8")
  });
  assert.equal(response.status, 202);

  const [run] = await context.automations.recentRuns("hooked", 1);
  assert.deepEqual(run?.event.headers, {
    authorization: "[redacted]",
    cookie: "[redacted]",
    "x-hub-signature-256": "[redacted]",
    "content-type": "application/json"
  });
  const receipt = fs.readFileSync(path.join(context.stateDir, "automations", "hooked", "runs.jsonl"), "utf8");
  assert.doesNotMatch(receipt, /super-secret-token/);
});

test("a broken definition stops itself, not the daemon around it", async (t) => {
  const context = harness({ healthy: {
    name: "Healthy",
    triggers: [{ kind: "schedule", cron: "0 * * * *", tz: "UTC" }],
    steps: [{ kind: "command", name: "note", argv: ["/bin/echo", "ok"] }]
  } });
  t.after(() => context.cleanup());
  fs.mkdirSync(path.join(context.root, "broken"), { recursive: true });
  fs.writeFileSync(path.join(context.root, "broken", "automation.json"), "{ not json", "utf8");

  const skipped: string[] = [];
  const serving = new Automations({
    root: context.root,
    stateDir: context.stateDir,
    onInvalidSpec: (id) => skipped.push(id),
    executors: { async command() { return "ok"; }, async http() { return "ok"; } }
  });
  t.after(() => serving.stop());

  await serving.serve();
  assert.deepEqual(skipped, ["broken"]);
  assert.deepEqual((await serving.summarize()).map((summary) => summary.id), ["healthy"]);
  const health = await serving.doctor();
  assert.equal(health.ok, false, "doctor still reports the broken definition");
  assert.equal((await serving.run("healthy")).status, "completed");
});

test("a schedule missed while the daemon was down is not still overdue once it is up", async (t) => {
  const context = harness({ hourly: {
    name: "Hourly",
    triggers: [{ kind: "schedule", cron: "0 * * * *", tz: "UTC" }],
    steps: [{ kind: "command", name: "note", argv: ["/bin/echo", "ok"] }]
  } });
  t.after(() => context.cleanup());

  await context.automations.sync();
  await context.automations.stop();

  // Four hours of downtime: the stored next-run is now long past, which is
  // what the tool health probe would see if it ran before the first tick.
  const restarted = new Automations({
    root: context.root,
    stateDir: context.stateDir,
    now: () => new Date("2026-08-02T14:30:00.000Z"),
    executors: { async command() { return "ok"; }, async http() { return "ok"; } }
  });
  t.after(() => restarted.stop());
  const before = await restarted.doctor();
  assert.equal(before.ok, false, "an unstarted daemon should look overdue");

  await restarted.serve();
  const after = await restarted.doctor();
  assert.equal(after.ok, true, "serve catches the schedule up before it can be reported overdue");
  assert.deepEqual(after.overdue, []);
});

const inbound = {
  name: "Inbound",
  triggers: [{ kind: "event", source: "email", event: "inbound" }],
  steps: [{ kind: "http", name: "forward", url: "http://127.0.0.1:3001/webhook/email", body: { inbound: "{{event.payload}}" } }]
};

function delivery(body: unknown, headers: Record<string, string> = {}) {
  return { method: "POST" as const, path: "/events/inbound", headers, rawBody: Buffer.from(JSON.stringify(body), "utf8") };
}

const email = { source: "email", event: "inbound", payload: { from: "kush", subject: "hello" } };

test("a redelivered event is answered, not run a second time", async (t) => {
  const context = harness({ "email-inbound": inbound });
  t.after(() => context.cleanup());

  const first = await context.automations.handleRequest(delivery(email, { "x-delivery-id": "d-1" }));
  assert.equal(first.status, 202);
  assert.equal(context.posts.length, 1);

  const retry = await context.automations.handleRequest(delivery(email, { "x-delivery-id": "d-1" }));
  assert.equal(retry.status, 202);
  assert.equal((retry.body as Record<string, unknown>).duplicate, true);
  assert.equal(context.posts.length, 1, "the same delivery was forwarded twice");
  assert.equal((await context.automations.recentRuns("email-inbound", 10)).length, 1);
});

test("a relay with no delivery id is deduplicated on the bytes it sent", async (t) => {
  const context = harness({ "email-inbound": inbound });
  t.after(() => context.cleanup());

  await context.automations.handleRequest(delivery(email));
  await context.automations.handleRequest(delivery(email));
  assert.equal(context.posts.length, 1);

  const different = { ...email, payload: { from: "kush", subject: "a different one" } };
  await context.automations.handleRequest(delivery(different));
  assert.equal(context.posts.length, 2, "a distinct event was mistaken for a redelivery");
});

test("a delivery whose automation failed is retried rather than swallowed", async (t) => {
  const context = harness({ "email-inbound": {
    ...inbound,
    steps: [{ kind: "command", name: "forward", argv: ["/bin/echo", "fail"] }]
  } });
  t.after(() => context.cleanup());

  const failed = await context.automations.handleRequest(delivery(email, { "x-delivery-id": "d-2" }));
  assert.equal(failed.status, 500, "a failed run must not be acknowledged as accepted");

  const retry = await context.automations.handleRequest(delivery(email, { "x-delivery-id": "d-2" }));
  assert.equal(retry.status, 500);
  assert.equal(context.commands.length, 2, "the relay's retry of a failed delivery was suppressed");
});
