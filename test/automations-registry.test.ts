import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const registry = path.join(root, "automations");

type Trigger = Record<string, unknown> & { kind?: unknown };
type Step = Record<string, unknown> & { kind?: unknown; argv?: unknown };
type Spec = {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  triggers?: Trigger[];
  steps?: Step[];
  limits?: Record<string, unknown>;
};

function automationDirs(): string[] {
  return fs.readdirSync(registry, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "launchd")
    .map((entry) => entry.name)
    .sort();
}

function readSpec(id: string): Spec {
  return JSON.parse(fs.readFileSync(path.join(registry, id, "automation.json"), "utf8")) as Spec;
}

test("every automation is a single declarative spec named after its directory", () => {
  const ids = automationDirs();
  assert.ok(ids.length > 0);
  for (const id of ids) {
    const dir = path.join(registry, id);
    assert.deepEqual(
      fs.readdirSync(dir).sort(),
      ["automation.json"],
      `${id} should hold only automation.json, with no workflow code`
    );
    const spec = readSpec(id);
    assert.equal(spec.id, id);
    assert.equal(typeof spec.name, "string");
    assert.ok(Array.isArray(spec.triggers) && spec.triggers.length > 0, `${id} needs a trigger`);
    assert.ok(Array.isArray(spec.steps) && spec.steps.length > 0, `${id} needs a step`);
    for (const trigger of spec.triggers ?? []) {
      assert.ok(["schedule", "event", "http", "manual"].includes(String(trigger.kind)), `${id} has an unknown trigger kind`);
    }
    for (const step of spec.steps ?? []) {
      assert.ok(["command", "http"].includes(String(step.kind)), `${id} has an unknown step kind`);
      if (step.kind === "command") {
        assert.ok(Array.isArray(step.argv) && step.argv.length > 0, `${id} command steps must use argv`);
      }
    }
  }
});

test("the cutover carried every cron job and webhook trigger over", () => {
  assert.deepEqual(automationDirs(), [
    "agentphone-inbound",
    "capability-health",
    "deploy-main",
    "email-inbound",
    "email-watch-renewal",
    "nightly-memory-sweep",
    "smoke-probe"
  ]);
});

test("the deployment's execution probe stays independent of what other automations report", () => {
  const spec = readSpec("smoke-probe");
  assert.deepEqual(spec.triggers.map((trigger: { kind: string }) => trigger.kind), ["manual"]);
  assert.equal(spec.steps.length, 1);
  const smoke = fs.readFileSync(path.join(root, "tools", "smoke", "bin", "smoke.ts"), "utf8");
  assert.match(smoke, /\["run", "smoke-probe"\]/);
  assert.doesNotMatch(smoke, /\["run", "capability-health"\]/);
});

test("launchd owns deployment, so the legacy deploy trigger stays disabled", () => {
  assert.equal(readSpec("deploy-main").enabled, false);
});

test("specs carry no secret material", () => {
  for (const id of automationDirs()) {
    const text = fs.readFileSync(path.join(registry, id, "automation.json"), "utf8");
    assert.ok(!/"secret"\s*:/.test(text), `${id} must reference secrets by environment variable name`);
  }
});

test("the old cron and webhook trigger registries are gone", () => {
  assert.equal(fs.existsSync(path.join(root, "cron")), false);
  assert.equal(fs.existsSync(path.join(root, "channels", "webhooks", "triggers")), false);
  assert.equal(fs.existsSync(path.join(root, "bin", "cron")), false);
});
