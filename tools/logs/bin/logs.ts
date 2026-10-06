#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const HOME = process.env.HOME ?? os.homedir();
const UID = String(process.getuid?.() || 501);
const LAUNCH_AGENTS = path.join(HOME, "Library", "LaunchAgents");
const AMALGM_LOG_DIR = path.join(
  HOME,
  ".amalgm",
  "users",
  "00000000-0000-0000-0000-000000000000",
  "runtimes",
  "main",
  "logs"
);

const KNOWN_LOGS = {
  "amalgm-chat": path.join(AMALGM_LOG_DIR, "chat-server.log"),
  "amalgm-daemon": path.join(AMALGM_LOG_DIR, "daemon.log"),
  "amalgm-gateway": path.join(AMALGM_LOG_DIR, "local-gateway.log"),
  "amalgm-mcp": path.join(AMALGM_LOG_DIR, "amalgm-mcp.log"),
  "amalgm-port-monitor": path.join(AMALGM_LOG_DIR, "port-monitor.log"),
  "slack-stdout": path.join(HOME, "state", "channels", "slack", "logs", "stdout.log"),
  "slack-stderr": path.join(HOME, "state", "channels", "slack", "logs", "stderr.log"),
  "webhooks": path.join(HOME, "state", "webhooks", "logs", "service.log"),
  "tailscale": path.join(HOME, "state", "tools", "tailscale", "tailscaled.log"),
  "mac-system": "/var/log/system.log",
  "mac-launchd": "/var/log/com.apple.xpc.launchd/launchd.log"
};

const FIXED_JSON_RECEIPTS = {
  "deploy-main-last": path.join(HOME, "state", "deploy-main", "last-run.json"),
  "smoke-last": path.join(HOME, "state", "smoke", "last-run.json"),
  "communications-current": path.join(HOME, "state", "communications", "current.json"),
  "slack-status": path.join(HOME, "state", "channels", "slack", "status.json"),
  "webhooks-latest": path.join(HOME, "state", "webhooks", "latest-event.json")
};

function usage(): any {
  return [
    "Usage: logs <health|inventory|launchd|tail|receipt> [name] [--lines N]",
    "",
    "Examples:",
    "  logs health",
    "  logs inventory",
    "  logs launchd",
    "  logs tail slack-stderr --lines 80",
    "  logs receipt smoke-last"
  ].join("\n");
}

function run(file, args = [], options: any = {}): any {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: options.cwd || HOME,
      timeout: options.timeoutMs || 10000,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      env: { ...process.env, STASH_TELEMETRY: "0", ...options.env }
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        error: error?.message || null,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

function redact(text): any {
  return String(text || "")
    .replace(/(xox[baprs]-)[A-Za-z0-9-]+/g, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]")
    .replace(/("access_token"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/("refresh_token"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/("client_secret"\s*:\s*")[^"]+/gi, "$1[redacted]")
    .replace(/("token"\s*:\s*")[^"]{12,}/gi, "$1[redacted]");
}

async function fileMeta(filePath): Promise<any> {
  try {
    const stat = await fsp.stat(filePath);
    await fsp.access(filePath, fs.constants.R_OK);
    return {
      path: filePath,
      exists: true,
      readable: true,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString()
    };
  } catch (error) {
    return {
      path: filePath,
      exists: fs.existsSync(filePath),
      readable: false,
      detail: error.code || error.message
    };
  }
}

async function launchAgentPlists(): Promise<any> {
  try {
    const entries = await fsp.readdir(LAUNCH_AGENTS, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".plist"))
      .map((entry) => path.join(LAUNCH_AGENTS, entry.name))
      .sort();
  } catch (_error) {
    return [];
  }
}

async function parsePlist(filePath): Promise<any> {
  const result = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", filePath]);
  if (!result.ok) return { path: filePath, ok: false, detail: result.stderr.trim() || result.error };
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      path: filePath,
      ok: true,
      label: parsed.Label || path.basename(filePath, ".plist"),
      stdout: parsed.StandardOutPath || null,
      stderr: parsed.StandardErrorPath || null,
      program: Array.isArray(parsed.ProgramArguments) ? parsed.ProgramArguments[0] : null,
      args: parsed.ProgramArguments || [],
      keepAlive: parsed.KeepAlive || false,
      runAtLoad: parsed.RunAtLoad || false
    };
  } catch (error) {
    return { path: filePath, ok: false, detail: error.message };
  }
}

async function launchdStatus(label): Promise<any> {
  // Harness services are system daemons on some hosts and GUI agents on
  // others, and a headless account has no GUI session at all, so the job is
  // looked up in every domain it could be loaded in.
  let result = { ok: false, stdout: "", stderr: "", error: null };
  for (const domain of [`gui/${UID}`, `user/${UID}`, "system"]) {
    result = await run("/bin/launchctl", ["print", `${domain}/${label}`], { maxBuffer: 1024 * 1024 });
    if (result.ok) break;
  }
  const text = result.stdout + result.stderr;
  const state = text.match(/\n\s*state = ([^\n]+)/)?.[1]?.trim() || null;
  const pid = text.match(/\n\s*pid = ([^\n]+)/)?.[1]?.trim() || null;
  const lastExitCode = text.match(/\n\s*last exit code = ([^\n]+)/)?.[1]?.trim() || null;
  return {
    label,
    ok: result.ok,
    state,
    pid,
    lastExitCode,
    detail: result.ok ? "launchd state readable" : (result.stderr.trim() || result.error)
  };
}

async function unifiedLogAccess(): Promise<any> {
  const result = await run("/usr/bin/log", [
    "show",
    "--last",
    "1m",
    "--style",
    "compact",
    "--predicate",
    "process == \"launchd\""
  ], { timeoutMs: 10000, maxBuffer: 128 * 1024 });
  return {
    ok: result.ok,
    detail: result.ok ? "unified log readable" : (result.stderr.trim() || result.error)
  };
}

async function inventory(): Promise<any> {
  const plists = await Promise.all((await launchAgentPlists()).map(parsePlist));
  const launchd = await Promise.all(plists.filter((item) => item.label).map((item) => launchdStatus(item.label)));
  const logPaths = new Map();
  for (const [name, filePath] of Object.entries(KNOWN_LOGS)) logPaths.set(name, filePath);
  for (const plist of plists) {
    if (plist.stdout) logPaths.set(`launchd:${plist.label}:stdout`, plist.stdout);
    if (plist.stderr) logPaths.set(`launchd:${plist.label}:stderr`, plist.stderr);
  }
  const logs = [];
  for (const [name, filePath] of [...logPaths.entries()].sort()) {
    logs.push({ name, ...(await fileMeta(filePath)) });
  }
  const receipts = [];
  for (const [name, filePath] of Object.entries(FIXED_JSON_RECEIPTS)) {
    receipts.push({ name, ...(await fileMeta(filePath)) });
  }
  const unifiedLog = await unifiedLogAccess();
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    unifiedLog,
    launchAgents: plists,
    launchd,
    logs,
    receipts
  };
}

async function health(): Promise<any> {
  const inv = await inventory();
  const harnessLogsReadable = inv.logs.filter((item) => item.path.startsWith(HOME)).some((item) => item.readable);
  const launchdReadable = inv.launchd.some((item) => item.ok && item.state);
  const receiptsReadable = inv.receipts.some((item) => item.readable);
  const ok = harnessLogsReadable && launchdReadable && receiptsReadable;
  const detail = [
    harnessLogsReadable ? "harness logs readable" : "harness logs missing",
    launchdReadable ? "launchd state readable" : "launchd state unreadable",
    receiptsReadable ? "receipts readable" : "receipts unreadable",
    inv.unifiedLog.ok ? "macOS unified log readable" : "macOS unified log denied"
  ].join("; ");
  return {
    ok,
    tool: "logs",
    component: "observability",
    critical: true,
    detail,
    unifiedLog: inv.unifiedLog,
    counts: {
      launchAgents: inv.launchAgents.length,
      launchdReadable: inv.launchd.filter((item) => item.ok).length,
      readableLogs: inv.logs.filter((item) => item.readable).length,
      readableReceipts: inv.receipts.filter((item) => item.readable).length
    }
  };
}

function parseLines(argv): any {
  const index = argv.indexOf("--lines");
  if (index < 0) return 120;
  const value = Number(argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), 1000) : 120;
}

async function tail(name, lines): Promise<any> {
  const filePath = KNOWN_LOGS[name];
  if (!filePath) {
    throw new Error(`unknown log "${name}". known: ${Object.keys(KNOWN_LOGS).sort().join(", ")}`);
  }
  const result = await run("/usr/bin/tail", ["-n", String(lines), filePath], { maxBuffer: 2 * 1024 * 1024 });
  if (!result.ok) throw new Error(result.stderr.trim() || result.error);
  return {
    ok: true,
    name,
    path: filePath,
    lines,
    text: redact(result.stdout)
  };
}

async function receipt(name): Promise<any> {
  const filePath = FIXED_JSON_RECEIPTS[name];
  if (!filePath) {
    throw new Error(`unknown receipt "${name}". known: ${Object.keys(FIXED_JSON_RECEIPTS).sort().join(", ")}`);
  }
  const text = await fsp.readFile(filePath, "utf8");
  return {
    ok: true,
    name,
    path: filePath,
    json: JSON.parse(redact(text))
  };
}

async function main(): Promise<any> {
  const [command, name] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  let payload;
  if (command === "health") payload = await health();
  else if (command === "inventory") payload = await inventory();
  else if (command === "launchd") payload = { ok: true, launchd: (await inventory()).launchd };
  else if (command === "tail") payload = await tail(name, parseLines(process.argv.slice(2)));
  else if (command === "receipt") payload = await receipt(name);
  else throw new Error(`unknown command: ${command}`);

  if (payload.text) {
    console.log(JSON.stringify({ ...payload, text: undefined }, null, 2));
    process.stdout.write(payload.text);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
  if (payload.ok !== true) process.exit(1);
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    tool: "logs",
    component: "observability",
    critical: true,
    detail: error.message
  }, null, 2));
  process.exit(1);
});

export {};
