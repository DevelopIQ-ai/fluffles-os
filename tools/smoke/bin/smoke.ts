#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

// Which harness is being checked comes from the host file, so smoke proves the
// dev harness the same way it proves production instead of asserting against
// production's paths, labels and ports.
const HOME = process.env.HOME || os.homedir();
const HOST_CONFIG = path.join(HOME, "deploy", "bin", "host-config.mjs");
const SERVICES = JSON.parse(execFileSync(process.execPath, [HOST_CONFIG, "--services"], { encoding: "utf8" }));
const HOST = JSON.parse(execFileSync(process.execPath, [HOST_CONFIG], { encoding: "utf8" }));

function service(name): any {
  const found = SERVICES.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`this host does not run the ${name} service`);
  return found;
}

// Services the deploy stops and starts, in the order smoke reports them. The
// poller is not one of them: it is the job a deploy runs inside.
const SUPERVISED = SERVICES.filter((candidate) => candidate.name !== "deploy-main");

const STATE_DIR = path.join(HOME, "state", "smoke");
const RECEIPT_PATH = path.join(STATE_DIR, "last-run.json");

function parseArgs(argv): any {
  return {
    json: argv.includes("--json"),
    deep: argv.includes("--deep"),
    deploy: argv.includes("--deploy"),
    quiet: argv.includes("--quiet")
  };
}

function usage(): any {
  return `Usage: smoke [--json] [--quiet] [--deep] [--deploy]

Checks the core harness without sending Slack messages.

Options:
  --json   Print machine-readable JSON.
  --quiet  Print only the final summary unless there is a failure.
  --deep   Also run slower live scheduler smoke checks.
  --deploy Check only components managed by the source deployment.`;
}

function pathStatus(filePath, kind = "any"): any {
  try {
    const stat = fs.statSync(filePath);
    if (kind === "file" && !stat.isFile()) return `${filePath} is not a file`;
    if (kind === "dir" && !stat.isDirectory()) return `${filePath} is not a directory`;
    if (kind === "exec" && (stat.mode & 0o111) === 0) return `${filePath} is not executable`;
    return null;
  } catch (error) {
    return `${filePath} missing: ${error.code || error.message}`;
  }
}

function mustExist(paths): any {
  const missing = [];
  for (const [filePath, kind] of paths) {
    const error = pathStatus(filePath, kind);
    if (error) missing.push(error);
  }
  return missing;
}

async function readText(filePath): Promise<string> {
  return fsp.readFile(filePath, "utf8");
}

async function command(file, args, options: any = {}): Promise<any> {
  const result = await execFileAsync(file, args, {
    cwd: options.cwd || HOME,
    timeout: options.timeoutMs || 15000,
    maxBuffer: options.maxBuffer || 1024 * 1024,
    env: {
      ...process.env,
      STASH_TELEMETRY: "0",
      ...options.env
    }
  });
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

async function commandRaw(file, args, options: any = {}): Promise<any> {
  try {
    return {
      ok: true,
      ...(await command(file, args, options))
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || "").trim(),
      stderr: String(error.stderr || error.message || "").trim()
    };
  }
}

async function httpJson(url, timeoutMs = 5000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_error) {
      throw new Error(`invalid json from ${url}: ${text.slice(0, 120)}`);
    }
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObjects(text): any {
  const values = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        values.push(JSON.parse(text.slice(start, index + 1)));
        start = -1;
      }
    }
  }

  return values;
}

const TOOL_HEALTH_DEPENDENCIES = [
  {
    root: "browser-control",
    downstream: "gws",
    reason: "browser-control is failing, so browser/OAuth-dependent GWS evidence is downstream until the control surface is fixed"
  }
];

function annotateToolHealthRelationships(items): any {
  const results = Array.isArray(items) ? items.map((item) => ({ ...item })) : [];
  const failedByTool = new Map(results
    .filter((item) => item && item.ok !== true)
    .map((item) => [String(item.tool || item.id || "").replace(/^tool-health:/, ""), item]));

  for (const dependency of TOOL_HEALTH_DEPENDENCIES) {
    const root = failedByTool.get(dependency.root);
    const downstream = failedByTool.get(dependency.downstream);
    if (!root || !downstream) continue;
    const rootId = root.id || `tool-health:${dependency.root}`;
    downstream.classification = "consequential";
    downstream.rootCauseId = rootId;
    downstream.blockedBy = [...new Set([...(Array.isArray(downstream.blockedBy) ? downstream.blockedBy : []), rootId])];
    downstream.relationshipReason = dependency.reason;
  }

  return results;
}

function relationshipOutputFields(item): any {
  return {
    ...(item.classification ? { classification: item.classification } : {}),
    ...(item.rootCauseId ? { rootCauseId: item.rootCauseId } : {}),
    ...(Array.isArray(item.blockedBy) && item.blockedBy.length ? { blockedBy: item.blockedBy } : {}),
    ...(item.relationshipReason ? { relationshipReason: item.relationshipReason } : {})
  };
}

function okDetail(value): any {
  return typeof value === "string" ? value : JSON.stringify(value);
}

async function runCheck(results, id, label, fn, options: any = {}): Promise<any> {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    results.push({
      id,
      label,
      ...(options.component ? { component: options.component } : {}),
      ok: true,
      critical: options.critical !== false,
      durationMs: Date.now() - startedAt,
      detail: detail === undefined ? "ok" : okDetail(detail)
    });
  } catch (error) {
    results.push({
      id,
      label,
      ...(options.component ? { component: options.component } : {}),
      ok: false,
      critical: options.critical !== false,
      durationMs: Date.now() - startedAt,
      detail: error.message
    });
  }
}

async function appendToolHealthChecks(results): Promise<any> {
  const startedAt = Date.now();
  const result = await commandRaw(path.join(HOME, "bin", "capabilities"), ["register", "--json"], {
    timeoutMs: 180000,
    maxBuffer: 8 * 1024 * 1024
  });
  const parsed = parseJsonObjects(result.stdout).find((item) => Array.isArray(item.results));
  if (!parsed) {
    results.push({
      id: "tool-health",
      label: "tool health convention",
      ok: false,
      critical: true,
      durationMs: Date.now() - startedAt,
      component: "tools",
      detail: `could not parse tool health output: ${(result.stderr || result.stdout).slice(0, 300)}`
    });
    return;
  }
  const durationMs = Date.now() - startedAt;
  const toolResults = parsed.results.map((item) => ({
    ...item,
    id: `tool-health:${item.tool || "unknown"}`,
    tool: item.tool || "unknown",
    ok: item.status === "healthy" || item.status === "disabled",
    critical: item.status !== "disabled"
  }));
  for (const item of annotateToolHealthRelationships(toolResults)) {
    results.push({
      id: item.id || `tool-health:${item.tool || "unknown"}`,
      label: `tool health: ${item.tool || "unknown"}`,
      ok: item.ok === true,
      critical: item.critical !== false,
      durationMs,
      component: item.component || "tools",
      detail: item.detail || (item.ok ? "ok" : "failed"),
      ...relationshipOutputFields(item)
    });
  }
}

async function checkStructure(): Promise<any> {
  const errors = mustExist([
    [path.join(HOME, "AGENTS.md"), "file"],
    [path.join(HOME, "bin"), "dir"],
    [path.join(HOME, "tools"), "dir"],
    [path.join(HOME, "auth"), "dir"],
    [path.join(HOME, "memory", "PROTOCOL.md"), "file"],
    [path.join(HOME, "memory", "MEMORY.md"), "file"],
    [path.join(HOME, "memory", "wiki"), "dir"],
    [path.join(HOME, "state"), "dir"],
    [path.join(HOME, "tools", "communications"), "dir"],
    [path.join(HOME, "channels", "slack"), "dir"],
    [path.join(HOME, "automations"), "dir"],
    [path.join(HOME, "hooks", "codex"), "dir"],
    [path.join(HOME, "channels", "webhooks"), "dir"],
    [path.join(HOME, "tools", "smoke"), "dir"],
  ]);
  if (errors.length) throw new Error(errors.join("; "));
  return "core directories present";
}

async function checkWrappers(): Promise<any> {
  const errors = mustExist([
    [path.join(HOME, "bin", "automations"), "exec"],
    [path.join(HOME, "bin", "amalgm"), "exec"],
    [path.join(HOME, "bin", "gh"), "exec"],
    [path.join(HOME, "bin", "gws"), "exec"],
    [path.join(HOME, "bin", "vercel"), "exec"],
    [path.join(HOME, "bin", "agent-browser"), "exec"],
    [path.join(HOME, "bin", "resources"), "exec"],
    [path.join(HOME, "bin", "webhooks"), "exec"],
    [path.join(HOME, "bin", "smoke"), "exec"],
    [path.join(HOME, "bin", "communications"), "exec"],
    [path.join(HOME, "bin", "memory"), "exec"],
    [path.join(HOME, "bin", "executor-daemon"), "exec"],
    [path.join(HOME, "bin", "executor-register"), "exec"],
    [path.join(HOME, "bin", "mcp-serve"), "exec"]
  ]);
  if (errors.length) throw new Error(errors.join("; "));
  return "core wrappers executable";
}

async function checkInfisicalBootstrap(): Promise<any> {
  const bootstrapDirectory = path.join(HOME, "auth", "infisical");
  const bootstrap = path.join(HOME, "auth", "infisical", "machine-identity.env");
  const wrapper = path.join(HOME, "packages", "auth", "bin", "infisical-run");
  const errors = mustExist([[bootstrapDirectory, "dir"], [bootstrap, "file"], [wrapper, "exec"]]);
  if (errors.length) throw new Error(errors.join("; "));
  const directoryStat = fs.lstatSync(bootstrapDirectory);
  const bootstrapStat = fs.lstatSync(bootstrap);
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : bootstrapStat.uid;
  if (directoryStat.isSymbolicLink()) {
    throw new Error(`${bootstrapDirectory} must not be a symlink`);
  }
  if ((directoryStat.mode & 0o777) !== 0o700 || directoryStat.uid !== expectedUid) {
    throw new Error(`${bootstrapDirectory} must be owned by the service user with mode 700`);
  }
  if (bootstrapStat.isSymbolicLink()) {
    throw new Error(`${bootstrap} must not be a symlink`);
  }
  if ((bootstrapStat.mode & 0o777) !== 0o600 || bootstrapStat.uid !== expectedUid) {
    throw new Error(`${bootstrap} must be owned by the service user with mode 600`);
  }
  return "Infisical bootstrap ownership and permissions valid";
}

async function checkMemoryDoctor(): Promise<any> {
  const result = await command(path.join(HOME, "bin", "memory"), ["doctor"], { timeoutMs: 30000 });
  const parsed = JSON.parse(result.stdout);
  if (parsed.ok !== true) throw new Error(`memory doctor failed: ${result.stdout}`);
  return `index healthy with ${parsed.documents} documents`;
}

async function checkMemorySearch(): Promise<any> {
  const result = await command(path.join(HOME, "bin", "memory"), ["search", "memory", "--limit", "1"], { timeoutMs: 30000 });
  const parsed = JSON.parse(result.stdout);
  if (parsed.ok !== true) throw new Error(`memory search failed: ${result.stdout}`);
  return `search ok in ${parsed.durationMs}ms`;
}

async function launchdService(label: string): Promise<any> {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  let firstLoaded: any;
  for (const domain of [`gui/${uid}`, `user/${uid}`, "system"]) {
    const result = await commandRaw("/bin/launchctl", ["print", `${domain}/${label}`], {
      timeoutMs: 10000
    });
    if (!result.ok) continue;
    if (result.stdout.includes("state = running")) return result;
    firstLoaded ??= result;
  }
  if (firstLoaded) return firstLoaded;
  throw new Error(`${label} is not loaded in a GUI, user, or system launchd domain`);
}

async function checkHarnessLaunchd(): Promise<any> {
  const labels = SUPERVISED.map((candidate) => candidate.label);
  for (const label of labels) {
    const result = await launchdService(label);
    if (!result.stdout.includes("state = running")) {
      throw new Error(`${label} is not running`);
    }
  }
  return `${labels.length} harness services running`;
}

function launchdPid(text: string): string | null {
  return text.match(/\n\s*pid = ([^\n]+)/)?.[1]?.trim() || null;
}

// A supervised job being "running" says nothing about whether it stays up: a
// KeepAlive service that exits immediately is running again ten seconds later,
// so a job that never survives its own startup passes a liveness check forever.
// That is what the chat console did on the mini, crash-looping on an
// unprovisioned Infisical path while the deploy reported smoke passed. Two
// samples a restart window apart tell a service apart from a loop: the pid a
// job reports moved only because the job it belongs to died and was restarted.
// A job whose pid launchd does not report is left to the liveness check, so a
// pid this cannot read is never a failed deploy on its own.
async function checkServiceStability(): Promise<any> {
  const windowMs = Number(process.env.SMOKE_STABILITY_WINDOW_MS || 12000);
  const sample = async () => {
    const seen = new Map<string, string | null>();
    for (const supervised of SUPERVISED) {
      const result = await launchdService(supervised.label);
      seen.set(supervised.label, launchdPid(result.stdout + result.stderr));
    }
    return seen;
  };
  const before = await sample();
  await new Promise((resolve) => setTimeout(resolve, windowMs));
  const after = await sample();
  const failures = [];
  let compared = 0;
  for (const [label, first] of before) {
    const second = after.get(label);
    if (first === null || second === undefined || second === null) continue;
    compared += 1;
    if (first !== second) {
      failures.push(`${label} is a different process than it was ${windowMs}ms ago (${first} then ${second}), so it is restarting`);
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
  return `${compared} of ${SUPERVISED.length} services held the same process for ${windowMs}ms`;
}

// Keys launchd itself injects into every job, so their presence is not drift.
const LAUNCHD_INJECTED_ENV = new Set(["XPC_SERVICE_NAME", "XPC_FLAGS", "MallocSpaceEfficient", "OSLogRateLimit"]);

function launchdBlock(text, name): any {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${name} = {`);
  if (start === -1) return null;
  const entries = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "}") break;
    entries.push(line);
  }
  return entries;
}

async function checkLaunchdDrift(): Promise<any> {
  // What actually runs is the loaded launchd job, and it can silently differ
  // from the declared configuration: a job keeps the arguments and environment
  // of whatever manifest it was bootstrapped from until it is booted out, so a
  // stale load survives every later render and install. Environment values are
  // compared but never printed.
  const failures = [];
  for (const declared of SERVICES) {
    let loaded;
    try {
      loaded = await launchdService(declared.label);
    } catch (error) {
      failures.push(`${declared.label}: ${error.message}`);
      continue;
    }
    const args = launchdBlock(loaded.stdout, "arguments");
    if (!args) {
      failures.push(`${declared.label}: loaded job reports no arguments`);
    } else if (args.join("\u0000") !== declared.program.join("\u0000")) {
      failures.push(`${declared.label}: loaded arguments [${args.join(" ")}] differ from declared [${declared.program.join(" ")}]`);
    }
    const environmentLines = launchdBlock(loaded.stdout, "environment") || [];
    const loadedEnv = new Map<string, string>(environmentLines.map((line) => {
      const separator = line.indexOf(" => ");
      return separator === -1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 4)];
    }));
    for (const [key, value] of Object.entries(declared.env)) {
      if (!loadedEnv.has(key)) {
        failures.push(`${declared.label}: loaded job is missing ${key}`);
      } else if (loadedEnv.get(key) !== value) {
        failures.push(`${declared.label}: loaded ${key} differs from the declared value`);
      }
    }
    for (const key of loadedEnv.keys()) {
      if (!(key in declared.env) && !LAUNCHD_INJECTED_ENV.has(key)) {
        failures.push(`${declared.label}: loaded job carries undeclared ${key}`);
      }
    }
  }
  if (failures.length) throw new Error(failures.join("; "));
  return `${SERVICES.length} loaded launchd jobs match the declared configuration`;
}

async function checkSlackLaunchd(): Promise<any> {
  const result = await launchdService(service("slack").label);
  if (!result.stdout.includes("state = running")) {
    throw new Error("Slack launchd service is not running");
  }
  if (!result.stdout.includes("NODE_EXTRA_CA_CERTS")) {
    throw new Error("Slack launchd service is missing Node certificate env");
  }
  return "launchd running";
}

async function checkSlackHealth(): Promise<any> {
  const health = await httpJson(`http://127.0.0.1:${service("slack").env.PORT || "3000"}/healthz`);
  const failures = [];
  if (health.ok !== true) failures.push("health ok flag is false");
  if (health.slackConfigured !== true) failures.push("Slack auth is not configured");
  if (health.activeTransport !== "socket" && health.activeTransport !== "socket+polling") failures.push(`transport is ${health.activeTransport}`);
  if (health.socketConnected !== true) failures.push("socket is not connected");
  // One allowed channel is a valid harness: the dev app is only ever in its own
  // channel. What matters is that the bot is allowed somewhere.
  if (health.allowedChannels < 1) failures.push(`allowed channel count is ${health.allowedChannels}`);
  if (health.ambientChannels < 1) failures.push(`ambient channel count is ${health.ambientChannels}`);
  if (health.lastError) failures.push(`last error: ${health.lastError}`);
  if (failures.length) throw new Error(failures.join("; "));
  return `socket connected as ${health.botName || "unknown bot"}`;
}

async function checkWebhooksLaunchd(): Promise<any> {
  const result = await launchdService(service("webhooks").label);
  if (!result.stdout.includes("state = running")) {
    throw new Error("webhooks launchd service is not running");
  }
  return "launchd running";
}

async function checkWebhooksHealth(): Promise<any> {
  const port = Number(service("webhooks").env.WEBHOOK_PORT);
  const health = await httpJson(`http://127.0.0.1:${port}/healthz`);
  const failures = [];
  if (health.ok !== true) failures.push("health ok flag is false");
  if (health.service !== "webhooks") failures.push(`service is ${health.service}`);
  if (health.routeCount !== 7) failures.push(`route count is ${health.routeCount}`);
  if (health.config?.port !== port) failures.push(`port is ${health.config?.port}`);
  if (failures.length) throw new Error(failures.join("; "));

  const smoke = await command(path.join(HOME, "bin", "webhooks"), ["smoke"], {
    timeoutMs: 10000
  });
  const receipt = JSON.parse(smoke.stdout);
  if (receipt.ok !== true || receipt.routeId !== "test" || receipt.trusted !== true) {
    throw new Error(`unexpected webhook smoke receipt: ${smoke.stdout.slice(0, 200)}`);
  }
  return `smoke event ${receipt.id}`;
}

async function checkExecutorLaunchd(): Promise<any> {
  const result = await launchdService(service("executor").label);
  if (!result.stdout.includes("state = running")) {
    throw new Error("executor launchd service is not running");
  }
  return "launchd running";
}

async function checkExecutorCatalog(): Promise<any> {
  const registered = await command(path.join(HOME, "bin", "executor-register"), [], {
    timeoutMs: 30000,
    env: { ...process.env, EXECUTOR_PORT: String(service("executor").env.EXECUTOR_PORT || "4788") }
  });
  const receipt = JSON.parse(registered.stdout);
  if (receipt.ok !== true) throw new Error(`executor-register failed: ${registered.stdout.slice(0, 200)}`);
  const names = (receipt.integrations || []).map((item) => item.name);
  if (!names.includes("memory")) throw new Error(`memory integration missing from catalog: ${names.join(", ")}`);
  return `${names.length} manifest integrations registered (${names.join(", ")})`;
}

async function checkAutomationsLaunchd(): Promise<any> {
  const result = await launchdService(service("automations").label);
  if (!result.stdout.includes("state = running")) {
    throw new Error("automations launchd service is not running");
  }
  return "launchd running";
}

async function checkAutomationsValidate(): Promise<any> {
  const result = await command(path.join(HOME, "bin", "automations"), ["validate"], {
    timeoutMs: 20000
  });
  const parsed = JSON.parse(result.stdout);
  if (parsed.ok !== true) throw new Error(`automation validation failed: ${result.stdout}`);
  const ids = new Set((parsed.automations || []).map((item) => item.id));
  for (const id of ["nightly-memory-sweep", "deploy-main", "email-inbound", "agentphone-inbound"]) {
    if (!ids.has(id)) throw new Error(`${id} missing from validation output: ${result.stdout}`);
  }
  return `${parsed.count} automation specs valid`;
}

async function checkAutomationsSchedule(): Promise<any> {
  // The clock is ours now, so smoke proves the daemon is holding live next-run
  // times rather than that a provider accepted a definition.
  const health = await httpJson(`http://127.0.0.1:${service("automations").env.AUTOMATIONS_PORT}/automations`);
  const automations = health.automations || [];
  const byId = new Map<string, any>(automations.map((item) => [item.id, item]));
  const memoryCycle = byId.get("nightly-memory-sweep");
  const deployMain = byId.get("deploy-main");
  const emailInbound = byId.get("email-inbound");
  if (!memoryCycle || !deployMain || !emailInbound) {
    throw new Error(`automation registry incomplete: ${JSON.stringify(automations.map((item) => item.id))}`);
  }
  if (deployMain.enabled !== false) throw new Error("legacy deploy-main automation must stay disabled");
  for (const automation of [memoryCycle]) {
    if (automation.enabled !== true) throw new Error(`${automation.id} is disabled`);
    if (!automation.nextRunAt) throw new Error(`${automation.id} nextRunAt is empty`);
  }
  if (!emailInbound.triggers.some((trigger) => trigger === "event email.inbound")) {
    throw new Error(`email-inbound is not bound to email.inbound: ${JSON.stringify(emailInbound.triggers)}`);
  }
  return `memory next ${memoryCycle.nextRunAt}; legacy deploy-main disabled`;
}

async function checkAutomationsExecution(): Promise<any> {
  // The live counterpart of source verification: prove the installed daemon
  // actually executes an automation end to end, not just that it parsed one.
  // smoke-probe exists for this and nothing else. Running a real automation
  // here instead made the check report that automation's subject matter: a
  // tool awaiting repair failed capability-health, which failed the deploy.
  const result = await command(path.join(HOME, "bin", "automations"), ["run", "smoke-probe"], {
    timeoutMs: 60000
  });
  const record = JSON.parse(result.stdout);
  if (record.status !== "completed") throw new Error(`smoke-probe run ${record.status}: ${record.error || ""}`);
  if (!Array.isArray(record.steps) || record.steps.length === 0) throw new Error("smoke-probe produced no steps");
  return `run ${record.id} completed ${record.steps.length} step(s)`;
}

/**
 * A deployment is only admitted when every tool whose MCP manifest is marked
 * required passes a fresh registry health check. Other tools may be
 * unhealthy without blocking a deploy; they surface through capability-health
 * and the repair-task loop instead.
 */
async function checkRequiredTools(): Promise<any> {
  const manifestsDir = path.join(HOME, "tools", "mcp", "manifests");
  const requiredIds = fs.readdirSync(manifestsDir)
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => JSON.parse(fs.readFileSync(path.join(manifestsDir, entry), "utf8")))
    .filter((manifest) => manifest && manifest.required === true)
    .map((manifest) => String(manifest.name));
  if (requiredIds.length === 0) return "no required tools declared";
  const result = await commandRaw(path.join(HOME, "bin", "capabilities"), ["register", "--json"], {
    timeoutMs: 180000,
    maxBuffer: 8 * 1024 * 1024
  });
  const parsed = parseJsonObjects(result.stdout).find((item) => Array.isArray(item.results));
  if (!parsed) {
    throw new Error(`could not parse capability register output: ${(result.stderr || result.stdout).slice(0, 300)}`);
  }
  const byId = new Map<string, any>(parsed.results.map((item: any) => [String(item.tool), item]));
  const unhealthy = requiredIds.filter((id) => byId.get(id)?.status !== "healthy");
  if (unhealthy.length > 0) {
    const details = unhealthy.map((id) => {
      const item = byId.get(id);
      return `${id}: ${item ? item.detail || item.status : "missing from registry results"}`;
    });
    throw new Error(`required tools unhealthy: ${details.join("; ")}`);
  }
  return `${requiredIds.length} required tool(s) healthy`;
}

async function checkDeployMainPoller(): Promise<any> {
  const poller = service("deploy-main");
  const label = poller.label;
  const plistPath = path.join(HOST.systemDaemonRoot, `${label}.plist`);
  const plist = fs.readFileSync(plistPath, "utf8");
  const deployer = path.join(HOME, "bin", "deploy-main");
  if (!plist.includes(deployer)) {
    throw new Error(`${label} does not execute ${deployer}`);
  }
  if (!/<key>StartInterval<\/key>\s*<integer>60<\/integer>/.test(plist)) {
    throw new Error(`${label} is not scheduled every 60 seconds`);
  }
  await command("/bin/launchctl", ["print", `system/${label}`], { timeoutMs: 10000 });
  return `${label} loaded with 60-second interval`;
}

async function checkDeployMainReceipt(): Promise<any> {
  const receiptPath = path.join(HOME, "state", "deploy-main", "last-run.json");
  let receipt;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  } catch (error) {
    throw new Error(`deploy-main receipt missing or invalid: ${error.message}`);
  }
  if (receipt.ok !== true) {
    throw new Error(`deploy-main last run failed: ${receipt.status || "unknown"}`);
  }
  const ranAt = Date.parse(String(receipt.ranAt || ""));
  if (!Number.isFinite(ranAt)) {
    throw new Error("deploy-main receipt has invalid ranAt");
  }
  const ageMs = Date.now() - ranAt;
  const maxAgeMs = 5 * 60 * 1000;
  if (ageMs > maxAgeMs) {
    throw new Error(`deploy-main receipt stale: ${Math.round(ageMs / 60000)} minutes old`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(receipt.deployedSha || ""))) {
    throw new Error("deploy-main receipt has invalid deployedSha");
  }
  return `${receipt.status || "ok"} ${receipt.deployedSha} at ${receipt.ranAt}`;
}

async function checkCodexHooks(): Promise<any> {
  const result = await command(path.join(HOME, "hooks", "codex", "bin", "smoke-test"), [], {
    timeoutMs: 30000
  });
  if (!result.stdout.includes("codex hooks smoke test passed")) {
    throw new Error(`unexpected hook smoke output: ${result.stdout}`);
  }
  return "hook pipeline ok";
}

async function checkBreadcrumbEnforcement(): Promise<any> {
  const failures = [];
  for (const supervised of SUPERVISED) {
    const plistPath = path.join(HOME, "Library", "LaunchAgents", `${supervised.label}.plist`);
    const text = await readText(plistPath);
    if (!text.includes(path.join(HOME, "bin", "breadcrumb-service"))) {
      failures.push(`${supervised.label} is not wrapped by breadcrumb-service`);
    }
  }

  const hookConfig = JSON.parse(await readText(path.join(HOME, ".codex", "hooks.json")));
  for (const eventName of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
    const eventHooks = hookConfig.hooks?.[eventName] || [];
    // Hook commands name the home by variable so one file serves every harness,
    // and older installed copies name it literally. Both mean the same hook.
    const text = JSON.stringify(eventHooks).replace(/\$\{?HOME\}?/g, HOME);
    if (!text.includes(path.join(HOME, "hooks", "codex", "bin", "breadcrumb-hook"))) {
      failures.push(`${eventName} is missing breadcrumb-hook`);
    }
  }

  const automationsDir = path.join(HOME, "automations");
  const automationEntries = (await fsp.readdir(automationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name !== "launchd");
  for (const entry of automationEntries) {
    const specPath = path.join(automationsDir, entry.name, "automation.json");
    if (!fs.existsSync(specPath)) continue;
    const spec = JSON.parse(await readText(specPath));
    for (const step of spec.steps || []) {
      if (step.kind !== "command") continue;
      if (!String((step.argv || [])[0] || "").endsWith("/bin/breadcrumb")) {
        failures.push(`${entry.name} command step ${step.name} is not wrapped by breadcrumb run`);
      }
    }
  }

  const subagentRunner = await readText(path.join(HOME, "subagents", "bin", "run-subagent"));
  for (const expected of ["model.turn_start", "model.turn_stop", "model.turn_error", "tool.use.start", "tool.use"]) {
    if (!subagentRunner.includes(expected)) failures.push(`run-subagent missing ${expected}`);
  }

  const slackBridge = await readText(path.join(HOME, "channels", "slack", "src", "server.ts"));
  for (const expected of ["model.turn_start", "model.turn_stop", "model.turn_error", "emitCodexToolBreadcrumbs", "tool.use.start", "tool.use"]) {
    if (!slackBridge.includes(expected)) failures.push(`Slack bridge missing ${expected}`);
  }

  if (failures.length) throw new Error(failures.join("; "));
  return `${SUPERVISED.length} services, ${automationEntries.length} automations, Codex hooks, Slack bridge, and subagent runner enforce breadcrumbs`;
}

async function writeCapabilitiesSnapshot(): Promise<any> {
  const commandPath = path.join(HOME, "bin", "capabilities");
  if (pathStatus(commandPath, "exec")) return;
  await commandRaw(commandPath, ["write"], {
    timeoutMs: 20000,
    maxBuffer: 2 * 1024 * 1024
  });
}

async function checkSchedulerDeep(): Promise<any> {
  // Our own clock, so lateness is measured against the stored next-run time
  // the daemon published rather than against a provider receipt.
  const result = await command(path.join(HOME, "bin", "automations"), ["doctor"], {
    timeoutMs: 60000,
    maxBuffer: 2 * 1024 * 1024
  });
  const report = JSON.parse(result.stdout);
  if (report.ok !== true) {
    throw new Error(`automation clock is behind: ${JSON.stringify({ invalid: report.invalid, overdue: report.overdue })}`);
  }
  const runs = await command(path.join(HOME, "bin", "automations"), ["runs", "capability-health", "1"], {
    timeoutMs: 30000
  });
  const latest = JSON.parse(runs.stdout)[0];
  if (!latest) throw new Error("capability-health has never run");
  const lateMs = Date.parse(latest.startedAt) - Date.parse(latest.event?.payload?.dueAt || latest.startedAt);
  return `${report.count} automations scheduled; last scheduled run fired ${lateMs}ms late`;
}

function printHuman(receipt, args): any {
  if (!args.quiet) {
    for (const check of receipt.checks) {
      const mark = check.ok ? "ok" : "fail";
      if (check.ok || !args.quiet) {
        console.log(`${mark.padEnd(4)} ${check.id.padEnd(18)} ${check.detail}`);
      }
    }
  } else {
    for (const check of receipt.checks.filter((item) => !item.ok)) {
      console.log(`fail ${check.id}: ${check.detail}`);
    }
  }

  const summary = receipt.ok
    ? `smoke passed: ${receipt.passed}/${receipt.total} checks, ${receipt.durationMs}ms`
    : `smoke failed: ${receipt.failed}/${receipt.total} checks failed, ${receipt.durationMs}ms`;
  console.log(summary);
  console.log(`receipt: ${RECEIPT_PATH}`);
}

async function main(): Promise<any> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const checks = [];

  if (args.deploy) {
    // memory doctor runs first: it seeds the runtime memory layout that the
    // structure check requires, which the deployment itself never ships.
    await runCheck(checks, "memory-doctor", "memory index health", checkMemoryDoctor);
    await runCheck(checks, "memory-search", "memory search", checkMemorySearch);
    await runCheck(checks, "structure", "core directory structure", checkStructure);
    await runCheck(checks, "wrappers", "core command wrappers", checkWrappers);
    await runCheck(checks, "harness-launchd", "harness launchd services", checkHarnessLaunchd);
    await runCheck(checks, "service-stability", "supervised services are not restarting", checkServiceStability);
    await runCheck(checks, "launchd-drift", "loaded launchd jobs match configuration", checkLaunchdDrift);
    await runCheck(checks, "slack-health", "Slack socket health", checkSlackHealth);
    await runCheck(checks, "webhooks-health", "webhooks health and smoke", checkWebhooksHealth);
    await runCheck(checks, "automations-validate", "automation registry validation", checkAutomationsValidate);
    await runCheck(checks, "automations-schedule", "automation schedule liveness", checkAutomationsSchedule);
    await runCheck(checks, "automations-execute", "live automation execution", checkAutomationsExecution);
    await runCheck(checks, "executor-catalog", "executor tool catalog", checkExecutorCatalog);
    await runCheck(checks, "required-tools", "required callable tools", checkRequiredTools, { component: "tools" });
    await runCheck(checks, "deploy-main-poller", "local deployment poller", checkDeployMainPoller, { component: "deploy-main" });
    await runCheck(checks, "breadcrumb-enforcement", "breadcrumb coverage enforcement", checkBreadcrumbEnforcement);
  } else {
    await runCheck(checks, "structure", "core directory structure", checkStructure);
    await runCheck(checks, "wrappers", "core command wrappers", checkWrappers);
    await runCheck(checks, "auth", "Infisical bootstrap", checkInfisicalBootstrap);
    await appendToolHealthChecks(checks);
    await runCheck(checks, "memory-doctor", "memory index health", checkMemoryDoctor);
    await runCheck(checks, "memory-search", "memory search", checkMemorySearch);
    await runCheck(checks, "service-stability", "supervised services are not restarting", checkServiceStability);
    await runCheck(checks, "launchd-drift", "loaded launchd jobs match configuration", checkLaunchdDrift);
    await runCheck(checks, "slack-launchd", "Slack launchd service", checkSlackLaunchd);
    await runCheck(checks, "slack-health", "Slack socket health", checkSlackHealth);
    await runCheck(checks, "webhooks-launchd", "webhooks launchd service", checkWebhooksLaunchd);
    await runCheck(checks, "webhooks-health", "webhooks health and smoke", checkWebhooksHealth);
    await runCheck(checks, "automations-launchd", "automations launchd service", checkAutomationsLaunchd);
    await runCheck(checks, "executor-launchd", "executor launchd service", checkExecutorLaunchd);
    await runCheck(checks, "executor-catalog", "executor tool catalog", checkExecutorCatalog);
    await runCheck(checks, "automations-validate", "automation registry validation", checkAutomationsValidate);
    await runCheck(checks, "automations-schedule", "automation schedule liveness", checkAutomationsSchedule);
    await runCheck(checks, "automations-execute", "live automation execution", checkAutomationsExecution);
    await runCheck(checks, "deploy-main-poller", "local deployment poller", checkDeployMainPoller, { component: "deploy-main" });
    await runCheck(checks, "deploy-main", "deploy-main latest receipt", checkDeployMainReceipt, { component: "deploy-main" });
    await runCheck(checks, "codex-hooks", "Codex hook pipeline", checkCodexHooks);
    await runCheck(checks, "breadcrumb-enforcement", "breadcrumb coverage enforcement", checkBreadcrumbEnforcement);
    if (args.deep) {
      await runCheck(checks, "scheduler", "recent scheduled automation run", checkSchedulerDeep);
    }
  }

  const failedChecks = checks.filter((check) => !check.ok && check.critical);
  const receipt = {
    ok: failedChecks.length === 0,
    ranAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    mode: args.deploy ? "deploy" : args.deep ? "deep" : "standard",
    total: checks.length,
    passed: checks.filter((check) => check.ok).length,
    failed: failedChecks.length,
    checks
  };

  await fsp.mkdir(STATE_DIR, { recursive: true });
  await fsp.writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  await writeCapabilitiesSnapshot();

  if (args.json) {
    console.log(JSON.stringify(receipt, null, 2));
  } else {
    printHuman(receipt, args);
  }

  if (!receipt.ok) process.exit(1);
}

main().catch(async (error) => {
  const receipt = {
    ok: false,
    ranAt: new Date().toISOString(),
    durationMs: 0,
    mode: "startup",
    total: 1,
    passed: 0,
    failed: 1,
    checks: [{
      id: "startup",
      label: "smoke runner startup",
      ok: false,
      critical: true,
      durationMs: 0,
      detail: error.message
    }]
  };
  await fsp.mkdir(STATE_DIR, { recursive: true }).catch(() => {});
  await fsp.writeFile(RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, "utf8").catch(() => {});
  console.error(`smoke failed to start: ${error.message}`);
  process.exit(1);
});

export {};
