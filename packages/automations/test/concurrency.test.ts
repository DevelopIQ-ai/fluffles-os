import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Automations } from "../src/service";

test("a second run is rejected while the automation is at maxConcurrentRuns", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "automations-limits-"));
  const root = path.join(base, "automations");
  fs.mkdirSync(path.join(root, "slow"), { recursive: true });
  fs.writeFileSync(path.join(root, "slow", "automation.json"), JSON.stringify({
    name: "Slow",
    triggers: [{ kind: "manual" }],
    steps: [{ kind: "command", name: "wait", argv: ["/bin/sleep", "1"] }],
    limits: { maxConcurrentRuns: 1, queueLimit: 0 }
  }), "utf8");

  let release: (() => void) | null = null;
  const started = new Promise<void>((resolve) => { release = resolve; });
  const automations = new Automations({
    root,
    stateDir: path.join(base, "state"),
    executors: {
      async command() {
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "ok";
      },
      async http() { return "ok"; }
    }
  });
  t.after(async () => {
    await automations.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const first = automations.run("slow");
  await started;
  const second = await automations.run("slow");
  assert.equal(second.status, "rejected");
  assert.match(second.error ?? "", /maxConcurrentRuns/);
  assert.equal((await first).status, "completed");

  const third = await automations.run("slow");
  assert.equal(third.status, "completed");
});

test("a rejected run is kept in the durable history, not just the receipt file", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "automations-rejected-"));
  const root = path.join(base, "automations");
  fs.mkdirSync(path.join(root, "slow"), { recursive: true });
  fs.writeFileSync(path.join(root, "slow", "automation.json"), JSON.stringify({
    name: "Slow",
    triggers: [{ kind: "manual" }],
    steps: [{ kind: "command", name: "wait", argv: ["/bin/sleep", "1"] }],
    limits: { maxConcurrentRuns: 1, queueLimit: 0 }
  }), "utf8");

  let release: (() => void) | null = null;
  const started = new Promise<void>((resolve) => { release = resolve; });
  const automations = new Automations({
    root,
    stateDir: path.join(base, "state"),
    executors: {
      async command() {
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "ok";
      },
      async http() { return "ok"; }
    }
  });
  t.after(async () => {
    await automations.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const first = automations.run("slow");
  await started;
  await automations.run("slow");
  await first;

  const history = await automations.recentRuns("slow", 10);
  assert.equal(history.filter((run) => run.status === "rejected").length, 1);
});

test("rejections landing in the same millisecond each get their own run id", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "automations-burst-"));
  const root = path.join(base, "automations");
  fs.mkdirSync(path.join(root, "slow"), { recursive: true });
  fs.writeFileSync(path.join(root, "slow", "automation.json"), JSON.stringify({
    name: "Slow",
    triggers: [{ kind: "manual" }],
    steps: [{ kind: "command", name: "wait", argv: ["/bin/sleep", "1"] }],
    limits: { maxConcurrentRuns: 1, queueLimit: 0 }
  }), "utf8");

  const frozen = new Date("2026-08-02T10:00:00.000Z");
  let release: (() => void) | null = null;
  const started = new Promise<void>((resolve) => { release = resolve; });
  const automations = new Automations({
    root,
    stateDir: path.join(base, "state"),
    now: () => frozen,
    executors: {
      async command() {
        release?.();
        await new Promise((resolve) => setTimeout(resolve, 150));
        return "ok";
      },
      async http() { return "ok"; }
    }
  });
  t.after(async () => {
    await automations.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  const first = automations.run("slow");
  await started;
  const rejected = await Promise.all([1, 2, 3, 4].map(() => automations.run("slow")));
  await first;

  assert.deepEqual(rejected.map((run) => run.status), ["rejected", "rejected", "rejected", "rejected"]);
  assert.equal(new Set(rejected.map((run) => run.id)).size, 4);
  const history = await automations.recentRuns("slow", 10);
  assert.equal(history.filter((run) => run.status === "rejected").length, 4);
});

test("a long automation does not hold back the others that came due with it", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "automations-tick-"));
  const root = path.join(base, "automations");
  for (const id of ["a-slow", "z-quick"]) {
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, "automation.json"), JSON.stringify({
      name: id,
      triggers: [{ kind: "schedule", cron: "* * * * *", tz: "UTC" }],
      steps: [{ kind: "command", name: id, argv: ["/bin/true"] }]
    }), "utf8");
  }

  let now = new Date("2026-08-02T10:00:00.000Z");
  let releaseSlow: () => void = () => {};
  const slowHeld = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const automations = new Automations({
    root,
    stateDir: path.join(base, "state"),
    now: () => now,
    executors: {
      async command(step) {
        if (step.name === "a-slow") await slowHeld;
        return "ok";
      },
      async http() { return "ok"; }
    }
  });
  t.after(async () => {
    releaseSlow();
    await tick.catch(() => {});
    await automations.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  await automations.sync();
  now = new Date("2026-08-02T10:01:30.000Z");
  const tick = automations.tick();

  // The quick automation must finish while the slow one is still blocked.
  let quickFinished = false;
  const deadline = Date.now() + 2000;
  while (!quickFinished && Date.now() < deadline) {
    quickFinished = (await automations.recentRuns("z-quick", 1)).length > 0;
    if (!quickFinished) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(quickFinished, "a slow automation blocked one that came due in the same tick");

  releaseSlow();
  const runs = await tick;
  assert.deepEqual([...runs].map((run) => run.status).sort(), ["completed", "completed"]);
});

test("a claim left behind by a killed daemon is reclaimed within a few heartbeats", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "automations-stale-"));
  const root = path.join(base, "automations");
  const stateDir = path.join(base, "state");
  fs.mkdirSync(path.join(root, "job"), { recursive: true });
  fs.writeFileSync(path.join(root, "job", "automation.json"), JSON.stringify({
    name: "Job",
    triggers: [{ kind: "manual" }],
    steps: [{ kind: "command", name: "work", argv: ["/bin/true"] }],
    limits: { maxConcurrentRuns: 1 }
  }), "utf8");

  const executors = { async command() { return "ok"; }, async http() { return "ok"; } };
  // A run that never returns, holding its claim the way a daemon killed
  // mid-run leaves one behind.
  let started: () => void = () => {};
  let abandon: () => void = () => {};
  const inFlight = new Promise<void>((resolve) => { started = resolve; });
  const held = new Promise<void>((resolve) => { abandon = resolve; });
  const killed = new Automations({
    root,
    stateDir,
    executors: {
      async command() {
        started();
        await held;
        return "ok";
      },
      async http() { return "ok"; }
    }
  });
  t.after(async () => {
    abandon();
    await killed.stop();
    fs.rmSync(base, { recursive: true, force: true });
  });

  void killed.run("job");
  await inFlight;

  const blocked = await killed.run("job");
  assert.equal(blocked.status, "rejected");

  // A minute later the run that stopped beating no longer holds the slot.
  const later = new Automations({
    root,
    stateDir,
    now: () => new Date(Date.now() + 120_000),
    executors
  });
  t.after(async () => { await later.stop(); });
  const recovered = await later.run("job");
  assert.equal(recovered.status, "completed");
});
