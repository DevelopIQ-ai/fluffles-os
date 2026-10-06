import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  loadHarnessCharter,
  loadToolRegistry,
  toolDefinitionFingerprint,
  unclassifiedCommands,
  unclassifiedTools,
  type ToolDefinition
} from "../src/registry";
import { checkToolHealth, ToolHealthStore } from "../src/health";
import { reconcileToolRepairTask } from "../src/repair-task-client";
import { checkAndPersistToolHealth, persistToolHealthResult } from "../src/health-service";
import { SQLiteTaskLedger } from "../../../packages/tasks/src/task-ledger";

const root = path.resolve(__dirname, "..", "..", "..");
// Production's home, used only where a manifest or document is checked against
// the production declarations. The live harness under test is whichever account
// this is.
const productionRoot = "/Users/ai";
const liveRoot = process.env.HOME ?? productionRoot;
const portable = process.env.SOURCE_VERIFY_PORTABLE === "1";
const manifestsDir = path.join(root, "tools", "mcp", "manifests");
const harnessPath = path.join(root, "tools", "capabilities", "harness.json");

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function modeHasExec(filePath: string): boolean {
  return (fs.statSync(filePath).mode & 0o111) !== 0;
}

function productionRegistry() {
  return loadToolRegistry({ manifestsDir, harnessPath, home: productionRoot });
}

test("capability registry files are wired into the harness", () => {
  const required = [
    "bin/capabilities",
    "tools/capabilities/TOOL.md",
    "tools/capabilities/health",
    "tools/capabilities/harness.json",
    "packages/capabilities/bin/capabilities.ts",
    "packages/capabilities/src/health-service.ts",
    "packages/capabilities/src/health.ts",
    "packages/capabilities/src/registry.ts"
  ];

  for (const relative of required) {
    assert.equal(fs.existsSync(path.join(root, relative)), true, `${relative} should exist`);
  }

  assert.equal(modeHasExec(path.join(root, "bin/capabilities")), true, "bin/capabilities should be executable");
  assert.equal(modeHasExec(path.join(root, "tools/capabilities/health")), true, "health should be executable");
  assert.equal(
    modeHasExec(path.join(root, "packages/capabilities/bin/capabilities.ts")),
    true,
    "capabilities.ts should be executable"
  );

  const tsconfig = readJson(path.join(root, "packages/capabilities/tsconfig.json"));
  assert.ok(tsconfig.include.includes("src/**/*.ts"));
  assert.ok(tsconfig.include.includes("bin/**/*.ts"));
});

test("the retired locker inventory stays retired", () => {
  assert.equal(fs.existsSync(path.join(root, "tools/capabilities/lockers.json")), false,
    "lockers.json must not return; the MCP manifests are the only callable-tool inventory");
  assert.equal(fs.existsSync(path.join(root, "tools/capabilities/locker-health")), false);
  for (const relative of [
    "packages/capabilities/bin/capabilities.ts",
    "tools/smoke/bin/smoke.ts",
    "bin/deploy-main"
  ]) {
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    assert.doesNotMatch(text, /lockers\.json/, `${relative} must not reference the retired inventory`);
  }
});

test("the MCP manifests and harness charter classify every source-owned tool surface", () => {
  const registry = productionRegistry();
  const tools = fs.readdirSync(path.join(root, "tools"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && entry.name !== "payloads")
    .map((entry) => entry.name);
  assert.deepEqual(unclassifiedTools(registry, tools), []);
});

test("the MCP manifests and harness charter classify every executable command surface", () => {
  const registry = productionRegistry();
  const commands = fs.readdirSync(path.join(root, "bin"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && modeHasExec(path.join(root, "bin", entry.name)))
    .map((entry) => entry.name);
  assert.deepEqual(unclassifiedCommands(registry, commands), []);
});

test("no surface is classified as both a callable tool and a harness organ", () => {
  const registry = productionRegistry();
  const manifestNames = new Set(registry.tools.map((tool) => tool.name));
  for (const harnessTool of registry.harness.tools) {
    assert.equal(manifestNames.has(harnessTool), false, `${harnessTool} is charted as harness but has an MCP manifest`);
  }
  const wrapperBasenames = new Set(registry.tools.map((tool) => path.basename(tool.command)));
  for (const command of registry.harness.commands) {
    assert.equal(wrapperBasenames.has(path.basename(command)), false,
      `${command} is charted as harness but is also an MCP manifest wrapper`);
  }
});

test("every charted harness surface exists and is executable", () => {
  const charter = loadHarnessCharter(harnessPath);
  for (const relative of charter.commands) {
    const filePath = path.join(root, relative);
    assert.equal(fs.existsSync(filePath), true, `${relative} should exist`);
    assert.equal(modeHasExec(filePath), true, `${relative} should be executable`);
  }
  for (const tool of charter.tools) {
    assert.equal(fs.statSync(path.join(root, "tools", tool)).isDirectory(), true, `tools/${tool} should exist`);
  }
  for (const commandRoot of charter.commandRoots) {
    assert.equal(fs.statSync(path.join(root, commandRoot)).isDirectory(), true,
      `commandRoot ${commandRoot} should exist in the source tree (an absent root derives nothing)`);
  }
});

test("a command root absent at runtime derives nothing instead of failing the load", () => {
  const directory = fs.mkdtempSync(path.join("/tmp", "capabilities-roots-"));
  const charterDir = path.join(directory, "tools", "capabilities");
  fs.mkdirSync(charterDir, { recursive: true });
  const charterPath = path.join(charterDir, "harness.json");
  try {
    fs.writeFileSync(charterPath, JSON.stringify({
      version: 1, tools: [], commands: ["bin/a"], commandRoots: ["not-deployed/scripts"]
    }), "utf8");
    const charter = loadHarnessCharter(charterPath);
    assert.deepEqual(charter.commands, ["bin/a"]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("every manifest wrapper and declared health command exists and is executable in source", () => {
  const registry = productionRegistry();
  for (const tool of registry.tools) {
    assert.equal(modeHasExec(sourcePath(tool.command)), true, `${tool.name} wrapper should be executable`);
    if (tool.health !== null) {
      assert.equal(modeHasExec(sourcePath(tool.health[0])), true, `${tool.name} health command should be executable`);
    }
  }
});

test("required deploy-gating tools are declared once, in their manifests", () => {
  const registry = productionRegistry();
  const required = registry.tools.filter((tool) => tool.required).map((tool) => tool.name).sort();
  assert.deepEqual(required, ["breadcrumbs", "capabilities", "memory"]);
  for (const tool of registry.tools.filter((item) => item.required)) {
    assert.notEqual(tool.health, null, `required tool ${tool.name} must declare a real health probe`);
  }
});

test("manifest names match their file names and the registry rejects drift", () => {
  const registry = productionRegistry();
  for (const tool of registry.tools) {
    assert.equal(`${tool.name}.json`, path.basename(tool.manifestPath));
  }
  const directory = fs.mkdtempSync(path.join("/tmp", "capabilities-manifest-drift-"));
  const driftManifestsDir = path.join(directory, "manifests");
  try {
    fs.mkdirSync(driftManifestsDir, { recursive: true });
    fs.writeFileSync(path.join(driftManifestsDir, "renamed.json"), JSON.stringify({
      name: "original",
      tools: [{
        name: "original.run",
        description: "fixture",
        inputSchema: { type: "object", properties: {} },
        command: ["/tmp/fixture"]
      }]
    }), "utf8");
    fs.writeFileSync(path.join(directory, "harness.json"), JSON.stringify({ version: 1, tools: [], commands: [] }), "utf8");
    assert.throws(() => loadToolRegistry({
      manifestsDir: driftManifestsDir,
      harnessPath: path.join(directory, "harness.json")
    }), /does not match its file name/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the harness charter validates its shape and rejects duplicates", () => {
  const directory = fs.mkdtempSync(path.join("/tmp", "capabilities-charter-"));
  const charterPath = path.join(directory, "harness.json");
  try {
    fs.writeFileSync(charterPath, JSON.stringify({ version: 1, tools: ["a"], commands: ["bin/a"] }), "utf8");
    assert.deepEqual(loadHarnessCharter(charterPath).tools, ["a"]);
    fs.writeFileSync(charterPath, JSON.stringify({ version: 2, tools: [], commands: [] }), "utf8");
    assert.throws(() => loadHarnessCharter(charterPath), /version must be 1/);
    fs.writeFileSync(charterPath, JSON.stringify({ version: 1, tools: ["a", "a"], commands: [] }), "utf8");
    assert.throws(() => loadHarnessCharter(charterPath), /duplicate entry/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("tool definition fingerprints are stable and change with the definition", () => {
  const tool: ToolDefinition = {
    name: "example",
    description: "example tool",
    manifestPath: "/tmp/example.json",
    command: "/tmp/example",
    toolNames: ["example.run"],
    health: ["/tmp/example-health"],
    required: false,
    manifestHash: "fixture-hash"
  };
  const fingerprint = toolDefinitionFingerprint(tool);
  assert.equal(toolDefinitionFingerprint({ ...tool }), fingerprint);
  assert.equal(toolDefinitionFingerprint({ ...tool, manifestPath: "/elsewhere/example.json" }), fingerprint,
    "where the manifest was read from must not change the fingerprint");
  assert.notEqual(toolDefinitionFingerprint({ ...tool, command: "/tmp/other" }), fingerprint);
  assert.notEqual(toolDefinitionFingerprint({ ...tool, health: null }), fingerprint);
  assert.notEqual(toolDefinitionFingerprint({ ...tool, required: true }), fingerprint);
  assert.notEqual(toolDefinitionFingerprint({ ...tool, manifestHash: "edited-hash" }), fingerprint,
    "any manifest edit must invalidate cached health");
});

test("the manifest health command is the canonical per-tool probe", async () => {
  const tool: ToolDefinition = {
    name: "example",
    description: "example tool",
    manifestPath: "/tmp/example.json",
    command: "/tmp/example",
    toolNames: ["example.run"],
    health: ["/tmp/example-health"],
    required: false,
    manifestHash: "fixture-hash"
  };
  const healthy = await checkToolHealth(tool, async () => ({ stdout: '{"ok":true,"detail":"ready"}', stderr: "", exitCode: 0 }), "2026-07-21T00:00:00.000Z");
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.detail, "ready");

  const plainText = await checkToolHealth(tool, async () => ({ stdout: "wrapper is healthy", stderr: "", exitCode: 0 }), "2026-07-21T00:00:00.000Z");
  assert.equal(plainText.status, "healthy", "exit 0 without a JSON payload is healthy");

  const failedPayload = await checkToolHealth(tool, async () => ({ stdout: '{"ok":false,"detail":"offline"}', stderr: "", exitCode: 0 }), "2026-07-21T00:00:00.000Z");
  assert.equal(failedPayload.status, "for_repair");
  assert.equal(failedPayload.lastError, "offline");

  const failedExit = await checkToolHealth(tool, async () => ({ stdout: "", stderr: "boom", exitCode: 1 }), "2026-07-21T00:00:00.000Z");
  assert.equal(failedExit.status, "for_repair");
  assert.equal(failedExit.lastError, "boom");
});

test("a manifest without a health command falls back to the wrapper executable check", async () => {
  const directory = fs.mkdtempSync(path.join("/tmp", "capabilities-health-fallback-"));
  const commandPath = path.join(directory, "wrapper");
  const tool: ToolDefinition = {
    name: "example",
    description: "example tool",
    manifestPath: "/tmp/example.json",
    command: commandPath,
    toolNames: ["example.run"],
    health: null,
    required: false,
    manifestHash: "fixture-hash"
  };
  try {
    const missing = await checkToolHealth(tool, undefined, "2026-07-21T00:00:00.000Z");
    assert.equal(missing.status, "for_repair");
    assert.match(missing.lastError || "", /missing or not executable/);

    fs.writeFileSync(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const present = await checkToolHealth(tool, undefined, "2026-07-21T00:00:00.000Z");
    assert.equal(present.status, "healthy");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("tool health checks and persists a failed state", async () => {
  const directory = fs.mkdtempSync(path.join("/tmp", "capabilities-health-"));
  const statePath = path.join(directory, "registry.sqlite");
  const tool: ToolDefinition = {
    name: "example",
    description: "example tool",
    manifestPath: "/tmp/example.json",
    command: "/tmp/example",
    toolNames: ["example.run"],
    health: ["/tmp/example-health"],
    required: false,
    manifestHash: "fixture-hash"
  };
  try {
    const failed = await checkToolHealth(tool, async () => ({ stdout: '{"ok":false,"detail":"offline"}', stderr: "" }), "2026-07-21T00:00:00.000Z");
    assert.equal(failed.status, "for_repair");
    assert.equal(failed.lastError, "offline");
    const store = new ToolHealthStore(statePath);
    store.set(failed);
    store.close();
    const reopened = new ToolHealthStore(statePath);
    assert.deepEqual(reopened.get("example"), {
      tool: "example",
      status: "for_repair",
      lastCheckedAt: "2026-07-21T00:00:00.000Z",
      lastError: "offline",
      repairTaskId: null,
      definitionFingerprint: toolDefinitionFingerprint(tool)
    });
    reopened.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent health workers serialize observation before persistence", async () => {
  const directory = fs.mkdtempSync(path.join("/tmp", "capabilities-health-observation-"));
  const taskLedgerPath = path.join(directory, "tasks.sqlite");
  const statePath = path.join(directory, "registry.sqlite");
  const tool = fixtureTool({ name: "serialized" });
  let active = 0;
  let maxActive = 0;
  let sequence = 0;
  const runner = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    const index = sequence++;
    await new Promise((resolve) => setTimeout(resolve, index === 0 ? 60 : 5));
    active -= 1;
    return index === 0
      ? { stdout: '{"ok":false,"detail":"first check failed"}', stderr: "", exitCode: 1 }
      : { stdout: '{"ok":true,"detail":"second check passed"}', stderr: "", exitCode: 0 };
  };
  try {
    const results = await Promise.all([
      checkAndPersistToolHealth(tool, { statePath, taskLedgerPath, runner }),
      checkAndPersistToolHealth(tool, { statePath, taskLedgerPath, runner })
    ]);
    assert.equal(maxActive, 1, "the later worker must not observe health while an earlier worker owns the lease");
    assert.equal(results[0].status, "for_repair");
    assert.equal(results[1].status, "healthy");
    const store = new ToolHealthStore(statePath);
    assert.equal(store.get(tool.name)?.status, "healthy");
    store.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed tool health creates one repair task that a passed check closes", async () => {
  const directory = fs.mkdtempSync(path.join("/tmp", "capabilities-repair-"));
  const taskLedgerPath = path.join(directory, "tasks.sqlite");
  try {
    const first = await reconcileToolRepairTask({
      tool: "gws",
      status: "for_repair",
      detail: "token invalid",
      taskLedgerPath
    });
    const second = await reconcileToolRepairTask({
      tool: "gws",
      status: "for_repair",
      detail: "still invalid",
      taskLedgerPath
    });
    assert.equal(second, first);
    await reconcileToolRepairTask({
      tool: "gws",
      status: "healthy",
      detail: "ok",
      taskLedgerPath
    });
    const ledger = new SQLiteTaskLedger({ filePath: taskLedgerPath });
    assert.equal(await ledger.activeRepairTaskForTool("gws"), null);
    ledger.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("persisted tool health owns the repair-task transition", async () => {
  const directory = fs.mkdtempSync(path.join("/tmp", "capabilities-health-service-"));
  const taskLedgerPath = path.join(directory, "tasks.sqlite");
  const statePath = path.join(directory, "registry.sqlite");
  try {
    const failed = await persistToolHealthResult({
      tool: "example",
      status: "for_repair",
      lastCheckedAt: "2026-07-21T00:00:00.000Z",
      lastError: "offline",
      repairTaskId: null,
      detail: "offline"
    }, { statePath, taskLedgerPath });
    assert.ok(failed.repairTaskId);
    const store = new ToolHealthStore(statePath);
    assert.equal(store.get("example")?.repairTaskId, failed.repairTaskId);
    store.close();

    const healthy = await persistToolHealthResult({
      ...failed,
      status: "healthy",
      lastCheckedAt: "2026-07-21T00:01:00.000Z",
      lastError: null,
      detail: "ok"
    }, { statePath, taskLedgerPath });
    assert.equal(healthy.repairTaskId, null);
    const ledger = new SQLiteTaskLedger({ filePath: taskLedgerPath });
    assert.equal(await ledger.activeRepairTaskForTool("example"), null);
    ledger.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("tool health persistence ignores stale concurrent results", async () => {
  const directory = fs.mkdtempSync(path.join("/tmp", "capabilities-health-race-"));
  const taskLedgerPath = path.join(directory, "tasks.sqlite");
  const statePath = path.join(directory, "registry.sqlite");
  try {
    const newer = await persistToolHealthResult({
      tool: "example",
      status: "for_repair",
      lastCheckedAt: "2026-07-21T00:05:00.000Z",
      lastError: "newer failure",
      repairTaskId: null,
      detail: "newer failure"
    }, { statePath, taskLedgerPath });
    assert.equal(newer.status, "for_repair");

    const stale = await persistToolHealthResult({
      tool: "example",
      status: "healthy",
      lastCheckedAt: "2026-07-21T00:01:00.000Z",
      lastError: null,
      repairTaskId: null,
      detail: "old success"
    }, { statePath, taskLedgerPath });
    assert.equal(stale.status, "for_repair");
    assert.equal(stale.lastError, "newer failure");

    const store = new ToolHealthStore(statePath);
    assert.equal(store.get("example")?.lastCheckedAt, "2026-07-21T00:05:00.000Z");
    store.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent health results serialize state and repair-task ownership", async () => {
  const directory = fs.mkdtempSync(path.join("/tmp", "capabilities-health-concurrent-"));
  const taskLedgerPath = path.join(directory, "tasks.sqlite");
  const statePath = path.join(directory, "registry.sqlite");
  try {
    const [older, newer] = await Promise.all([
      persistToolHealthResult({
        tool: "example",
        status: "healthy",
        lastCheckedAt: "2026-07-21T00:01:00.000Z",
        lastError: null,
        repairTaskId: null,
        detail: "older success"
      }, { statePath, taskLedgerPath }),
      persistToolHealthResult({
        tool: "example",
        status: "for_repair",
        lastCheckedAt: "2026-07-21T00:02:00.000Z",
        lastError: "newer failure",
        repairTaskId: null,
        detail: "newer failure"
      }, { statePath, taskLedgerPath })
    ]);
    assert.ok([older.status, newer.status].includes("for_repair"));
    const store = new ToolHealthStore(statePath);
    const persisted = store.get("example");
    assert.equal(persisted?.status, "for_repair");
    assert.equal(persisted?.lastCheckedAt, "2026-07-21T00:02:00.000Z");
    assert.equal(store.pendingReconciliation("example"), null);
    store.close();
    const ledger = new SQLiteTaskLedger({ filePath: taskLedgerPath });
    assert.equal((await ledger.activeRepairTaskForTool("example"))?.id, persisted?.repairTaskId);
    ledger.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("pending health reconciliation recovers after a process restart", async () => {
  const directory = fs.mkdtempSync(path.join("/tmp", "capabilities-health-restart-"));
  const taskLedgerPath = path.join(directory, "tasks.sqlite");
  const statePath = path.join(directory, "registry.sqlite");
  const failed = {
    tool: "example",
    status: "for_repair" as const,
    lastCheckedAt: "2026-07-21T00:02:00.000Z",
    lastError: "offline",
    repairTaskId: null,
    detail: "offline"
  };
  try {
    const interrupted = new ToolHealthStore(statePath);
    interrupted.stageReconciliation(failed);
    assert.ok(interrupted.pendingReconciliation(failed.tool));
    interrupted.close();

    const recovered = await persistToolHealthResult(failed, { statePath, taskLedgerPath });
    assert.equal(recovered.status, "for_repair");
    assert.ok(recovered.repairTaskId);
    const reopened = new ToolHealthStore(statePath);
    assert.equal(reopened.pendingReconciliation(failed.tool), null);
    assert.equal(reopened.get(failed.tool)?.repairTaskId, recovered.repairTaskId);
    reopened.close();
    const ledger = new SQLiteTaskLedger({ filePath: taskLedgerPath });
    assert.equal((await ledger.activeRepairTaskForTool(failed.tool))?.id, recovered.repairTaskId);
    ledger.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the production capability command registers health and repair state end to end", async () => {
  const fixture = writeCliFixture("capabilities-register-integration-");
  try {
    fixture.health(true, "ready");
    const healthy = JSON.parse(execFileSync(process.execPath, [
      "--import", "tsx", fixture.capabilityCommand, "register", "--json"
    ], { env: fixture.env, encoding: "utf8" }));
    assert.equal(healthy.ok, true);
    assert.equal(healthy.results[0].status, "healthy");

    fixture.health(false, "offline");
    let failedOutput = "";
    try {
      execFileSync(process.execPath, ["--import", "tsx", fixture.capabilityCommand, "register", "--json"], {
        env: fixture.env,
        encoding: "utf8"
      });
      assert.fail("failed health registration should exit non-zero");
    } catch (error) {
      failedOutput = String((error as { stdout?: unknown }).stdout || "");
    }
    const failed = JSON.parse(failedOutput);
    assert.equal(failed.ok, false);
    assert.equal(failed.results[0].status, "for_repair");
    assert.ok(failed.results[0].repairTaskId);

    const store = new ToolHealthStore(fixture.statePath);
    assert.equal(store.get("fixture")?.repairTaskId, failed.results[0].repairTaskId);
    store.close();
    const ledger = new SQLiteTaskLedger({ filePath: fixture.taskLedgerPath });
    assert.equal((await ledger.activeRepairTaskForTool("fixture"))?.id, failed.results[0].repairTaskId);
    ledger.close();
  } finally {
    fixture.cleanup();
  }
});

test("a failed tool reconciliation does not abort the remaining scheduler batch", () => {
  const fixture = writeCliFixture("capabilities-scheduler-isolation-", { secondFixture: true });
  const taskControlPath = path.join(fixture.directory, "task-control.ts");
  fs.writeFileSync(taskControlPath, `
    if (process.argv.includes("repair-upsert")) throw new Error("simulated ledger write failure");
    console.log(JSON.stringify({ ok: true }));
  `, "utf8");
  const env = { ...fixture.env, FLUFFLES_TASK_CONTROL_PATH: taskControlPath };
  try {
    fixture.health(true, "ready");
    fixture.secondHealth?.(false, "offline");
    let output = "";
    try {
      execFileSync(process.execPath, ["--import", "tsx", fixture.capabilityCommand, "register", "--json"], { env, encoding: "utf8" });
      assert.fail("the failing fixture should leave the batch unhealthy");
    } catch (error) {
      output = String((error as { stdout?: unknown }).stdout || "");
    }
    const result = JSON.parse(output) as { results: Array<{ tool: string; status: string; detail: string }> };
    assert.equal(result.results.find((item) => item.tool === "fixture")?.status, "healthy");
    const failed = result.results.find((item) => item.tool === "fixture-failing");
    assert.equal(failed?.status, "for_repair");
    assert.match(failed?.detail || "", /health persistence failed/);
  } finally {
    fixture.cleanup();
  }
});

test("the registry refuses an unclassified tool surface", () => {
  const fixture = writeCliFixture("capabilities-unclassified-");
  try {
    fs.mkdirSync(path.join(fixture.toolsDir, "stray"), { recursive: true });
    fs.writeFileSync(path.join(fixture.toolsDir, "stray", "TOOL.md"), "# stray\n", "utf8");
    fixture.health(true, "ready");
    assert.throws(() => execFileSync(process.execPath, [
      "--import", "tsx", fixture.capabilityCommand, "current", "--json"
    ], { env: fixture.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), /classify/);
  } finally {
    fixture.cleanup();
  }
});

test("a changed manifest invalidates cached health until a fresh check passes", () => {
  const fixture = writeCliFixture("capabilities-fingerprint-");
  try {
    fixture.health(true, "ready");
    execFileSync(process.execPath, ["--import", "tsx", fixture.capabilityCommand, "register", "--json"], {
      env: fixture.env,
      encoding: "utf8"
    });
    let current = JSON.parse(execFileSync(process.execPath, [
      "--import", "tsx", fixture.capabilityCommand, "current", "--json"
    ], { env: fixture.env, encoding: "utf8" }));
    assert.equal(current.mcpTools.find((tool: any) => tool.name === "fixture").status, "healthy");

    const manifest = readJson(fixture.manifestPath);
    manifest.tools[0].description = "changed fixture";
    fs.writeFileSync(fixture.manifestPath, JSON.stringify(manifest), "utf8");
    current = JSON.parse(execFileSync(process.execPath, [
      "--import", "tsx", fixture.capabilityCommand, "current", "--json"
    ], { env: fixture.env, encoding: "utf8" }));
    const stale = current.mcpTools.find((tool: any) => tool.name === "fixture");
    assert.equal(stale.status, "for_repair");
    assert.match(stale.lastError, /definition changed/);
  } finally {
    fixture.cleanup();
  }
});

test("capability health scheduler runs every five minutes without overlap", () => {
  const spec = readJson(path.join(root, "automations/capability-health/automation.json"));
  assert.equal(spec.enabled, true);
  assert.deepEqual(spec.triggers[0], { kind: "schedule", cron: "*/5 * * * *", tz: "America/Los_Angeles" });
  assert.equal(spec.limits.maxConcurrentRuns, 1);
  assert.equal(spec.limits.queueLimit, 1);
  assert.match(JSON.stringify(spec.steps), /\{\{ROOT\}\}\/bin\/capabilities register --json/);
});

test("the deploy gate reads required tools from the MCP manifests", () => {
  const smoke = fs.readFileSync(path.join(root, "tools/smoke/bin/smoke.ts"), "utf8");
  assert.match(smoke, /tools", "mcp", "manifests/);
  assert.match(smoke, /required === true/);
  assert.match(smoke, /required-tools/);
});

test("capability registry docs describe the operational contract", () => {
  const toolDoc = fs.readFileSync(path.join(root, "tools/capabilities/TOOL.md"), "utf8");
  for (const expected of [
    "/Users/ai/bin/capabilities",
    "/Users/ai/state/capabilities/current.json",
    "tools/mcp/manifests",
    "harness.json",
    "desired state",
    "current state",
    "repair path",
    "escalation boundary",
    "refresh"
  ]) {
    assert.match(toolDoc, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(toolDoc, /lockers\.json/);

  const readme = fs.readFileSync(path.join(root, "tools/README.md"), "utf8");
  assert.match(readme, /capabilities/);
  assert.match(readme, /state\/capabilities/);
  assert.match(readme, /tools\/mcp\/manifests/);
  assert.doesNotMatch(readme, /lockers\.json/);
});

test("repair task reconciliation prefers runtime task-control over the source checkout", () => {
  const client = fs.readFileSync(path.join(root, "packages", "capabilities", "src", "repair-task-client.ts"), "utf8");
  assert.match(client, /runtimeTaskControlPath/);
  assert.match(client, /FLUFFLES_TASK_CONTROL_PATH/);
  assert.match(client, /path\.resolve\(__dirname, "\.\.", "\.\.", "\.\."\)/);
  assert.doesNotMatch(client, /\/Users\/ai\/projects\/source-code/);
  assert.match(client, /fs\.existsSync\(runtimeTaskControlPath\) \? runtimeTaskControlPath : sourceTaskControlPath/);
});

test("live capability command emits the expected machine-readable shape", () => {
  if (portable) {
    test.skip("portable source verification does not inspect the live harness");
    return;
  }
  if (!fs.existsSync(path.join(liveRoot, "bin/capabilities"))) {
    test.skip("the live capability command is unavailable in this home");
    return;
  }

  const output = execFileSync(path.join(liveRoot, "bin/capabilities"), ["current", "--json"], {
    cwd: liveRoot,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024
  });
  const registry = JSON.parse(output);

  assert.equal(registry.sources.toolsDir, `${liveRoot}/tools`);
  assert.ok(registry.totals.total >= 20);
  assert.ok(Array.isArray(registry.capabilities));
  assert.ok(Array.isArray(registry.mcpTools));

  const byName = new Map(registry.mcpTools.map((item: any) => [item.name, item]));
  for (const name of ["capabilities", "gws", "gcloud", "memory"]) {
    assert.ok(byName.has(name), `${name} should be in the manifest-derived inventory`);
  }
});

test("live and source capability files stay byte-for-byte aligned", () => {
  if (portable) {
    test.skip("portable source verification does not inspect the live harness");
    return;
  }
  if (!fs.existsSync(path.join(liveRoot, "bin/capabilities"))) {
    test.skip("this home holds no installed harness");
    return;
  }

  for (const relative of [
    "bin/capabilities",
    "tools/capabilities/TOOL.md",
    "tools/capabilities/health",
    "packages/capabilities/bin/capabilities.ts"
  ]) {
    const source = fs.readFileSync(path.join(root, relative));
    const live = fs.readFileSync(path.join(liveRoot, relative));
    assert.deepEqual(source, live, `${relative} should match live runtime`);
  }
});

function fixtureTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: "example",
    description: "example tool",
    manifestPath: "/tmp/example.json",
    command: "/tmp/example",
    toolNames: ["example.run"],
    health: ["/tmp/example-health"],
    required: false,
    manifestHash: "fixture-hash",
    ...overrides
  };
}

interface CliFixture {
  directory: string;
  toolsDir: string;
  manifestPath: string;
  statePath: string;
  taskLedgerPath: string;
  capabilityCommand: string;
  env: Record<string, string | undefined>;
  health: (ok: boolean, detail: string) => void;
  secondHealth?: (ok: boolean, detail: string) => void;
  cleanup: () => void;
}

function writeCliFixture(prefix: string, options: { secondFixture?: boolean } = {}): CliFixture {
  const directory = fs.mkdtempSync(path.join("/tmp", prefix));
  const toolsDir = path.join(directory, "tools");
  const manifestsFixtureDir = path.join(directory, "manifests");
  const charterPath = path.join(directory, "harness.json");
  const manifestPath = path.join(manifestsFixtureDir, "fixture.json");
  const statePath = path.join(directory, "registry.sqlite");
  const currentPath = path.join(directory, "current.json");
  const taskLedgerPath = path.join(directory, "tasks.sqlite");
  const healthPath = path.join(directory, "health");
  const commandPath = path.join(directory, "command");
  const capabilityCommand = path.join(root, "packages/capabilities/bin/capabilities.ts");
  fs.mkdirSync(path.join(toolsDir, "fixture"), { recursive: true });
  fs.mkdirSync(manifestsFixtureDir, { recursive: true });
  fs.writeFileSync(path.join(toolsDir, "fixture", "TOOL.md"), "# fixture\n", "utf8");
  fs.writeFileSync(commandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(charterPath, JSON.stringify({ version: 1, tools: [], commands: [] }), "utf8");
  const writeHealth = (filePath: string) => (ok: boolean, detail: string) => {
    const body = `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ ok, detail })}'\n${ok ? "" : "exit 1\n"}`;
    fs.writeFileSync(filePath, body, { mode: 0o755 });
  };
  const manifest = (name: string, health: string, command: string) => ({
    name,
    description: `${name} fixture`,
    tools: [{
      name: `${name}.run`,
      description: "run the fixture",
      inputSchema: { type: "object", properties: {} },
      command: [command]
    }],
    health: [health],
    required: false
  });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest("fixture", healthPath, commandPath)), "utf8");
  let secondHealth: CliFixture["secondHealth"];
  if (options.secondFixture) {
    const failingHealthPath = path.join(directory, "failing-health");
    const failingCommandPath = path.join(directory, "failing-command");
    fs.mkdirSync(path.join(toolsDir, "fixture-failing"), { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "fixture-failing", "TOOL.md"), "# fixture-failing\n", "utf8");
    fs.writeFileSync(failingCommandPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(manifestsFixtureDir, "fixture-failing.json"),
      JSON.stringify(manifest("fixture-failing", failingHealthPath, failingCommandPath)),
      "utf8"
    );
    secondHealth = writeHealth(failingHealthPath);
  }
  const env = {
    ...process.env,
    SOURCE_VERIFY_PORTABLE: "1",
    CAPABILITIES_TOOLS_DIR: toolsDir,
    CAPABILITIES_MCP_MANIFESTS_DIR: manifestsFixtureDir,
    CAPABILITIES_HARNESS_CHARTER_PATH: charterPath,
    CAPABILITIES_TOOL_STATE_PATH: statePath,
    CAPABILITIES_CURRENT_PATH: currentPath,
    CAPABILITIES_STATE_DIR: directory,
    CAPABILITIES_TASK_LEDGER_PATH: taskLedgerPath
  };
  return {
    directory,
    toolsDir,
    manifestPath,
    statePath,
    taskLedgerPath,
    capabilityCommand,
    env,
    health: writeHealth(healthPath),
    secondHealth,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  };
}

function sourcePath(runtimePath: string): string {
  if (runtimePath.startsWith("/Users/ai/projects/source-code/")) {
    return path.join(root, runtimePath.slice("/Users/ai/projects/source-code/".length));
  }
  if (runtimePath.startsWith("/Users/ai/")) {
    return path.join(root, runtimePath.slice("/Users/ai/".length));
  }
  return runtimePath;
}
