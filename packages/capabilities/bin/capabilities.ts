#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const HOME = process.env.HOME ?? os.homedir();
const TOOLS_DIR = process.env.CAPABILITIES_TOOLS_DIR || path.join(HOME, "tools");
const SMOKE_RECEIPT_PATH = process.env.CAPABILITIES_SMOKE_RECEIPT_PATH || path.join(HOME, "state", "smoke", "last-run.json");
const STATE_DIR = process.env.CAPABILITIES_STATE_DIR || path.join(HOME, "state", "capabilities");
const CURRENT_PATH = process.env.CAPABILITIES_CURRENT_PATH || path.join(STATE_DIR, "current.json");
const MCP_MANIFESTS_DIR = process.env.CAPABILITIES_MCP_MANIFESTS_DIR || path.join(TOOLS_DIR, "mcp", "manifests");
const HARNESS_CHARTER_PATH = process.env.CAPABILITIES_HARNESS_CHARTER_PATH || path.join(TOOLS_DIR, "capabilities", "harness.json");
const TOOL_STATE_PATH = process.env.CAPABILITIES_TOOL_STATE_PATH || path.join(STATE_DIR, "registry.sqlite");
const TASK_LEDGER_PATH = process.env.CAPABILITIES_TASK_LEDGER_PATH;

const HUMAN_ONLY_BOUNDARY = [
  "Escalate only for true human-only blockers:",
  "CAPTCHA, passkey/2FA that cannot be completed in the managed environment,",
  "missing account/workspace/repo access, physical-device access,",
  "or information only Kush can provide."
].join(" ");

const LOCAL_REPAIR_BOUNDARY = [
  "Do not escalate until local logs, source, health receipts, restart paths,",
  "and bounded repair attempts have been tried. Escalate only for host permissions,",
  "missing external access, or other human-only blockers."
].join(" ");

const REPAIR_OVERRIDES = {
  gws: `${HOME}/tools/gws/TOOL.md#reauth-runbook; ${HOME}/skills/auth-recovery/SKILL.md`,
  gcloud: `${HOME}/tools/gcloud/TOOL.md; ${HOME}/skills/auth-recovery/SKILL.md`,
  "imsg-mcp": `${HOME}/tools/imsg-mcp/TOOL.md; macOS Full Disk Access may require human-only host permission`,
  "agent-browser": `${HOME}/skills/browser-control/SKILL.md; ${HOME}/skills/auth-recovery/SKILL.md`,
  "slack-send": `${HOME}/tools/slack-send/TOOL.md`,
  communications: `${HOME}/tools/communications/TOOL.md`
};

const ESCALATION_OVERRIDES = {
  gws: HUMAN_ONLY_BOUNDARY,
  gcloud: HUMAN_ONLY_BOUNDARY,
  "imsg-mcp": "Escalate if macOS Full Disk Access, Messages identity, or physical-device approval is required; otherwise use local diagnostics first.",
  "agent-browser": HUMAN_ONLY_BOUNDARY,
  "slack-send": "Escalate only if the Slack token/account is missing, revoked, or workspace access is unavailable.",
  communications: LOCAL_REPAIR_BOUNDARY
};

function parseArgs(argv): any {
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  const inputIndex = argv.indexOf("--input");
  return {
    command: positional[0] || "current",
    id: positional[1] || null,
    json: argv.includes("--json"),
    input: inputIndex >= 0 ? argv[inputIndex + 1] || null : null,
    help: argv.includes("--help") || argv.includes("-h")
  };
}

function usage(): any {
  return `Usage: capabilities <current|summary|list|show|register|check|write|refresh|health> [id] [--json]

Commands:
  current  Print the cached capability registry. Default command.
  summary  Print a concise operational summary.
  list     Print one line per tool.
  show     Print one tool by name.
  register Run the manifest health probe for every callable tool and persist the results.
  check    Run and persist one tool health probe.
  write    Write cached registry to ${CURRENT_PATH}.
  refresh  Run smoke first, then write the updated registry.
  health   Validate that the registry can be generated and written.

The callable-tool inventory is the MCP manifest directory (${MCP_MANIFESTS_DIR});
invocation goes through the local Executor gateway, not this command.`;
}

function readJsonIfExists(filePath): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJson(filePath, value): Promise<any> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, filePath);
}

function stripMarkup(value): any {
  return String(value || "")
    .trim()
    .replace(/^`|`$/g, "")
    .replace(/^["']|["']$/g, "");
}

function expandHome(value): any {
  const text = stripMarkup(value);
  if (text === "none") return null;
  if (text.startsWith("~/")) return path.join(HOME, text.slice(2));
  return text || null;
}

function parseToolDoc(text): any {
  const fields: any = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+([A-Za-z][A-Za-z0-9 -]+):\s+(.+?)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase().replace(/\s+/g, "");
    const value = match[2].trim();
    if (key === "command") fields.command = expandHome(value);
    if (key === "registry") fields.registry = expandHome(value);
    if (key === "source") fields.source = expandHome(value);
    if (key === "auth") fields.auth = expandHome(value);
    if (key === "state") fields.state = expandHome(value);
    if (key === "schedule") fields.schedule = expandHome(value);
    if (key === "defaultchannel") fields.defaultChannel = stripMarkup(value);
    if (key === "slackdestination") fields.slackDestination = stripMarkup(value);
  }
  return fields;
}

function healthByTool(smoke): any {
  const map = new Map();
  const checks = Array.isArray(smoke?.checks) ? smoke.checks : [];
  for (const check of checks) {
    const match = String(check.id || "").match(/^tool-health:(.+)$/);
    if (!match) continue;
    map.set(match[1], check);
  }
  return map;
}

function compact(value, fallback = null): any {
  if (value === undefined || value === null || value === "") return fallback;
  return value;
}

function currentState(health, disabled): any {
  if (disabled) return "disabled";
  if (!health) return "unknown";
  if (health.ok === true) return "healthy";
  return "unhealthy";
}

function repairPath(tool, docText, fields): any {
  if (REPAIR_OVERRIDES[tool]) return REPAIR_OVERRIDES[tool];
  if (String(docText || "").includes(`${HOME}/skills/auth-recovery/SKILL.md`)) {
    return `${HOME}/skills/auth-recovery/SKILL.md`;
  }
  if (fields.auth) return `${fields.registry || path.join(TOOLS_DIR, tool)}/TOOL.md; add executable auth-recovery recipe if this recurs`;
  return `${fields.registry || path.join(TOOLS_DIR, tool)}/TOOL.md`;
}

function escalationBoundary(tool, fields): any {
  if (ESCALATION_OVERRIDES[tool]) return ESCALATION_OVERRIDES[tool];
  if (fields.auth) return HUMAN_ONLY_BOUNDARY;
  return LOCAL_REPAIR_BOUNDARY;
}

async function toolDirectories(): Promise<any> {
  const entries = await fsp.readdir(TOOLS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !name.startsWith("_") && name !== "payloads")
    .sort();
}

async function buildRegistry(): Promise<any> {
  const { loadToolRegistry, toolDefinitionFingerprint, unclassifiedTools } = await import("../src/registry");
  const { ToolHealthStore } = await import("../src/health");
  const smoke = readJsonIfExists(SMOKE_RECEIPT_PATH);
  const healthMap = healthByTool(smoke);
  const tools = await toolDirectories();
  const capabilities = [];

  for (const tool of tools) {
    const registryPath = path.join(TOOLS_DIR, tool);
    const toolDocPath = path.join(registryPath, "TOOL.md");
    const disabledPath = path.join(registryPath, "health.disabled.json");
    const disabled = fs.existsSync(disabledPath);
    const docText = fs.existsSync(toolDocPath) ? fs.readFileSync(toolDocPath, "utf8") : "";
    const fields = parseToolDoc(docText);
    const health = healthMap.get(tool) || null;
    const authPath = compact(fields.auth, null);
    const command = compact(fields.command, fs.existsSync(path.join(HOME, "bin", tool)) ? path.join(HOME, "bin", tool) : null);
    const state = currentState(health, disabled);

    capabilities.push({
      id: tool,
      desiredState: disabled ? "disabled" : "healthy",
      currentState: state,
      ok: state === "healthy" || state === "disabled",
      critical: health ? health.critical !== false : !disabled,
      component: health?.component || null,
      detail: health?.detail || (disabled ? "health disabled" : "no cached health receipt"),
      lastVerifiedAt: smoke?.ranAt || null,
      firstUnhealthyAt: null,
      consecutiveFailures: 0,
      command,
      registryPath,
      toolDocPath: fs.existsSync(toolDocPath) ? toolDocPath : null,
      sourcePath: compact(fields.source, registryPath),
      authPath,
      declaredAuthStatus: null,
      authKind: null,
      statePath: fields.state || null,
      schedulePath: fields.schedule || null,
      owner: "fluffles@puffle.ai",
      repairPath: repairPath(tool, docText, { ...fields, registry: registryPath, auth: authPath }),
      escalationBoundary: escalationBoundary(tool, { ...fields, auth: authPath }),
      notes: [
        fields.defaultChannel ? `default channel: ${fields.defaultChannel}` : null,
        fields.slackDestination ? `Slack destination: ${fields.slackDestination}` : null
      ].filter(Boolean)
    });
  }

  const unhealthy = capabilities.filter((item) => item.currentState === "unhealthy");
  const unknown = capabilities.filter((item) => item.currentState === "unknown");
  const authBacked = capabilities.filter((item) => item.authPath);
  const toolRegistry = loadToolRegistry({ manifestsDir: MCP_MANIFESTS_DIR, harnessPath: HARNESS_CHARTER_PATH });
  const unclassified = unclassifiedTools(toolRegistry, tools);
  if (unclassified.length > 0) {
    throw new Error(`neither the MCP manifests nor the harness charter classify: ${unclassified.join(", ")}`);
  }
  const healthStore = new ToolHealthStore(TOOL_STATE_PATH);
  const capabilitiesByTool = new Map(capabilities.map((capability) => [capability.id, capability]));
  const mcpTools = toolRegistry.tools.map((tool) => {
    const capability = capabilitiesByTool.get(tool.name);
    const stored = healthStore.get(tool.name);
    const disabled = capability?.currentState === "disabled";
    // A stored fingerprint that no longer matches the manifest means the tool
    // definition changed after its last check, so its cached health is stale.
    const staleDefinition = Boolean(
      stored?.definitionFingerprint && stored.definitionFingerprint !== toolDefinitionFingerprint(tool)
    );
    const status = disabled ? "disabled" : staleDefinition ? "for_repair" : stored?.status || "for_repair";
    return {
      ...tool,
      status,
      lastCheckedAt: disabled || staleDefinition ? null : stored?.lastCheckedAt || null,
      lastError: staleDefinition
        ? "tool definition changed; health recheck required"
        : stored?.lastError || (status === "healthy" ? null : disabled ? capability?.detail || "health disabled" : "no registry health check"),
      repairTaskId: stored?.repairTaskId || null
    };
  });
  healthStore.close();
  const toolTotals = {
    total: mcpTools.length,
    healthy: mcpTools.filter((tool) => tool.status === "healthy").length,
    forRepair: mcpTools.filter((tool) => tool.status === "for_repair").length,
    disabled: mcpTools.filter((tool) => tool.status === "disabled").length
  };
  const payload = {
    ok: unhealthy.length === 0 && unknown.length === 0 && toolTotals.forRepair === 0,
    generatedAt: new Date().toISOString(),
    sources: {
      toolsDir: TOOLS_DIR,
      smokeReceiptPath: SMOKE_RECEIPT_PATH,
      smokeRanAt: smoke?.ranAt || null,
      mcpManifestsDir: MCP_MANIFESTS_DIR,
      harnessCharterPath: HARNESS_CHARTER_PATH,
      toolStatePath: TOOL_STATE_PATH
    },
    totals: {
      total: capabilities.length,
      healthy: capabilities.filter((item) => item.currentState === "healthy").length,
      unhealthy: unhealthy.length,
      unknown: unknown.length,
      disabled: capabilities.filter((item) => item.currentState === "disabled").length,
      authBacked: authBacked.length
    },
    capabilities,
    mcpTools,
    harnessTools: toolRegistry.harness.tools,
    toolTotals
  };
  return payload;
}

async function runToolChecks(registry, toolName: string | null): Promise<any[]> {
  const { checkAndPersistToolHealth, persistToolHealthResult } = await import("../src/health-service");
  const { loadToolRegistry } = await import("../src/registry");
  const toolRegistry = loadToolRegistry({ manifestsDir: MCP_MANIFESTS_DIR, harnessPath: HARNESS_CHARTER_PATH });
  const definitions = toolName
    ? toolRegistry.tools.filter((tool) => tool.name === toolName)
    : toolRegistry.tools;
  if (toolName && definitions.length === 0) throw new Error(`unknown tool ${toolName}`);
  const byTool = new Map<string, any>(registry.capabilities.map((capability) => [capability.id, capability]));
  return mapWithConcurrency(definitions, 24, async (tool) => {
    const legacy = byTool.get(tool.name);
    const disabled = legacy?.currentState === "disabled";
    const options = {
      statePath: TOOL_STATE_PATH,
      ...(TASK_LEDGER_PATH ? { taskLedgerPath: TASK_LEDGER_PATH } : {})
    };
    const result: any = disabled
      ? {
          tool: tool.name,
          status: "disabled",
          lastCheckedAt: null,
          lastError: legacy?.detail || "health disabled",
          repairTaskId: null,
          detail: legacy?.detail || "health disabled"
        }
      : null;
    try {
      return result
        ? await persistToolHealthResult(result, options)
        : await checkAndPersistToolHealth(tool, options);
    } catch (error) {
      return {
        ...(result || {
          tool: tool.name,
          repairTaskId: null,
          lastCheckedAt: new Date().toISOString()
        }),
        status: "for_repair",
        lastError: `health persistence failed: ${errorMessage(error)}`.slice(0, 1000),
        detail: `health persistence failed: ${errorMessage(error)}`.slice(0, 1000)
      };
    }
  });
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<U>
): Promise<U[]> {
  const output = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      output[index] = await operation(values[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

function errorMessage(error: unknown): string {
  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : String(error);
}

function printSummary(registry): any {
  const totals = registry.totals;
  console.log(`capabilities: ${totals.healthy}/${totals.total} healthy, ${totals.unhealthy} unhealthy, ${totals.unknown} unknown, ${totals.authBacked} auth-backed`);
  const toolTotals = registry.toolTotals;
  console.log(`mcp tools: ${toolTotals.healthy}/${toolTotals.total} healthy, ${toolTotals.forRepair} for repair, ${toolTotals.disabled} disabled`);
  console.log(`health receipt: ${registry.sources.smokeRanAt || "none"}`);
  const attention = registry.capabilities.filter((item) => item.currentState === "unhealthy" || item.currentState === "unknown");
  if (!attention.length) return;
  console.log("");
  console.log("needs attention:");
  for (const item of attention) {
    console.log(`- ${item.id}: ${item.currentState}; ${item.detail}`);
  }
}

function printList(registry): any {
  console.log("mcp tools:");
  for (const tool of registry.mcpTools) {
    console.log(`${tool.name.padEnd(18)} ${tool.status.padEnd(11)} ${tool.required ? "required" : "        "} ${tool.toolNames.join(",")}`);
  }
  if (registry.harnessTools.length) console.log(`harness-owned: ${registry.harnessTools.join(", ")}`);
  console.log("\ntool catalog:");
  for (const item of registry.capabilities) {
    const state = item.currentState.padEnd(9);
    const auth = item.authPath ? "auth" : "no-auth";
    console.log(`${item.id.padEnd(18)} ${state} ${auth.padEnd(7)} ${item.detail}`);
  }
}

async function refreshSmoke(): Promise<any> {
  try {
    await execFileAsync(path.join(HOME, "bin", "smoke"), ["--json", "--quiet"], {
      cwd: HOME,
      timeout: 150000,
      maxBuffer: 12 * 1024 * 1024,
      env: { ...process.env, STASH_TELEMETRY: "0" }
    });
  } catch (error) {
    if (!fs.existsSync(SMOKE_RECEIPT_PATH)) throw error;
  }
}

async function main(): Promise<any> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (args.command === "refresh") {
    await refreshSmoke();
    const registry = await buildRegistry();
    await writeJson(CURRENT_PATH, registry);
    if (args.json) console.log(JSON.stringify(registry, null, 2));
    else {
      printSummary(registry);
      console.log(`written: ${CURRENT_PATH}`);
    }
    return;
  }

  const registry = await buildRegistry();

  if (args.command === "register" || args.command === "check") {
    if (args.command === "check" && !args.id) {
      console.error("tool name is required");
      process.exit(2);
    }
    const results = await runToolChecks(registry, args.command === "check" ? args.id : null);
    const refreshed = await buildRegistry();
    await writeJson(CURRENT_PATH, refreshed);
    const ok = results.every((result) => result.status === "healthy" || result.status === "disabled");
    const payload = { ok, results, statePath: TOOL_STATE_PATH };
    if (args.json) console.log(JSON.stringify(payload, null, 2));
    else console.log(`checked ${results.length} tools: ${ok ? "ok" : "repair needed"}`);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (args.command === "current") {
    if (args.json) console.log(JSON.stringify(registry, null, 2));
    else printSummary(registry);
    return;
  }

  if (args.command === "summary") {
    printSummary(registry);
    return;
  }

  if (args.command === "list") {
    printList(registry);
    return;
  }

  if (args.command === "show") {
    const item = registry.capabilities.find((capability) => capability.id === args.id);
    const mcpTool = registry.mcpTools.find((candidate) => candidate.name === args.id);
    if (!item && !mcpTool) {
      console.error(`unknown capability: ${args.id || "(missing id)"}`);
      process.exit(2);
    }
    if (args.json) console.log(JSON.stringify(mcpTool || item, null, 2));
    else if (mcpTool) {
      console.log(`${mcpTool.name}: ${mcpTool.status}`);
      console.log(`manifest: ${mcpTool.manifestPath}`);
      console.log(`required: ${mcpTool.required}`);
      console.log(`tools: ${mcpTool.toolNames.join(", ")}`);
      console.log(`health: ${mcpTool.health ? mcpTool.health.join(" ") : "wrapper executable check"}`);
    }
    else {
      console.log(`${item.id}: ${item.currentState}`);
      console.log(`detail: ${item.detail}`);
      console.log(`command: ${item.command || "none"}`);
      console.log(`auth: ${item.authPath || "none"}`);
      console.log(`last verified: ${item.lastVerifiedAt || "never"}`);
      console.log(`repair: ${item.repairPath}`);
      console.log(`escalation: ${item.escalationBoundary}`);
    }
    return;
  }

  if (args.command === "write") {
    await writeJson(CURRENT_PATH, registry);
    if (args.json) console.log(JSON.stringify({ ok: true, path: CURRENT_PATH, totals: registry.totals }, null, 2));
    else {
      printSummary(registry);
      console.log(`written: ${CURRENT_PATH}`);
    }
    return;
  }

  if (args.command === "health") {
    await writeJson(CURRENT_PATH, registry);
    const payload = {
      ok: true,
      tool: "capabilities",
      component: "registry",
      critical: true,
      detail: `registry built with ${registry.totals.total} catalog entries and ${registry.toolTotals.total} mcp tools; ${registry.toolTotals.forRepair} tools for repair`,
      statePath: CURRENT_PATH,
      totals: registry.totals,
      toolTotals: registry.toolTotals
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.error(usage());
  process.exit(2);
}

main().catch((error) => {
  console.error(`capabilities: ${error.message}`);
  process.exit(1);
});

export {};
