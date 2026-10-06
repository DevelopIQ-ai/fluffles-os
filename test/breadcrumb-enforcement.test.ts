import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { host, services } from "./support/host";

const root = path.resolve(__dirname, "..");

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function walkFiles(dir: string, predicate: (filePath: string) => boolean): string[] {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    const child = path.join(absolute, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(path.relative(root, child), predicate));
    else if (entry.isFile() && predicate(child)) out.push(path.relative(root, child));
  }
  return out.sort();
}

test("all source automation command steps are wrapped by breadcrumb run", () => {
  const specs = walkFiles("automations", (filePath) => filePath.endsWith("automation.json"));
  assert.ok(specs.length > 0, "automation specs should exist");

  for (const spec of specs) {
    const parsed = JSON.parse(read(spec)) as { steps: Array<{ kind: string; name: string; argv?: string[] }> };
    for (const step of parsed.steps) {
      if (step.kind !== "command") continue;
      const argv = step.argv ?? [];
      assert.equal(argv[0], "{{ROOT}}/bin/breadcrumb", `${spec} step ${step.name} must run through breadcrumb`);
      assert.ok(argv.includes("--scope") && argv.includes("fluffles"), `${spec} step ${step.name} must set breadcrumb scope`);
      assert.ok(argv.includes("--source") && argv.includes("automations"), `${spec} step ${step.name} must set breadcrumb source`);
    }
  }
});

test("every supervised service on every host starts through breadcrumb-service", () => {
  for (const name of ["prod", "dev"]) {
    const hostServices = services(name);
    assert.ok(hostServices.length > 0, `${name} should declare services`);
    for (const service of hostServices) {
      assert.equal(
        service.program[0],
        `${host(name).home}/bin/breadcrumb-service`,
        `${service.label} must launch through breadcrumb-service`
      );
      assert.equal(service.program[1], service.label, `${service.label} must name itself to breadcrumb-service`);
    }
  }
});

test("Codex hook config forces breadcrumb hook coverage", () => {
  const config = JSON.parse(read("hooks/codex/hooks.json"));
  for (const eventName of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const hooks = JSON.stringify(config.hooks?.[eventName] || []);
    assert.match(hooks, /\$HOME\/hooks\/codex\/bin\/breadcrumb-hook/, `${eventName} must include breadcrumb-hook`);
  }
});

test("Slack and subagent Codex launchers emit model and tool breadcrumbs", () => {
  const slack = read("channels/slack/src/server.ts");
  for (const expected of ["model.turn_start", "model.turn_stop", "model.turn_error", "emitCodexToolBreadcrumbs", "tool.use.start", "tool.use"]) {
    assert.match(slack, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `Slack bridge must include ${expected}`);
  }

  const subagent = read("subagents/bin/run-subagent");
  for (const expected of ["model.turn_start", "model.turn_stop", "model.turn_error", "tool.use.start", "tool.use"]) {
    assert.match(subagent, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `run-subagent must include ${expected}`);
  }
});

test("breadcrumb process wrapper propagates parent run ids and waits on SQLite locks", () => {
  const breadcrumb = read("tools/breadcrumbs/bin/breadcrumb.ts");
  assert.match(breadcrumb, /PRAGMA busy_timeout = 5000/, "breadcrumb CLI must wait on SQLite locks");
  assert.match(breadcrumb, /BREADCRUMB_PARENT_RUN_ID/, "breadcrumb run must pass parent run id to children");
});
