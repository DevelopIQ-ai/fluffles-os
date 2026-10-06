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
const STATE_DIR = path.join(HOME, "state", "resources");
const LAST_STATUS = path.join(STATE_DIR, "last-status.json");
const LAST_CLEANUP = path.join(STATE_DIR, "last-cleanup.json");
const RECEIPTS_DIR = path.join(STATE_DIR, "receipts");
const BROWSER_PROFILE = path.join(HOME, "state", "browser", "profiles", "fluffles");

const DEFAULTS = {
  highCpuPercent: 90,
  highCpuProcessCount: 3,
  totalCpuPercent: 250,
  minAgeSeconds: 15 * 60,
  staleBrowserSeconds: 45 * 60,
  staleComputerUseSeconds: 10 * 60,
  staleDiagnosticSeconds: 60 * 60,
  termGraceMs: 5000
};

function parseArgs(argv): any {
  const command = argv.find((arg) => !arg.startsWith("-")) || "status";
  return {
    command,
    json: argv.includes("--json"),
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    quiet: argv.includes("--quiet"),
    help: argv.includes("--help") || argv.includes("-h")
  };
}

function usage(): any {
  return `Usage: resources <status|health|cleanup> [--json] [--dry-run] [--force]

Monitors and cleans resource pressure caused by agent-owned local processes.

Commands:
  status   Inspect agent-owned resource use and write a status receipt.
  health   Health-check format for the harness tools/_health/run-all.
  cleanup  Stop stale or runaway agent-owned browser/control processes.

The cleanup target is intentionally narrow: owned agent browser processes, stale
completed Computer Use clients, and orphaned Chrome profile lock markers for:
  ${BROWSER_PROFILE}`;
}

function emit(payload, args: any = {}, code = payload.ok ? 0 : 1): any {
  if (args.json || args.command === "health") {
    console.log(JSON.stringify(payload, null, 2));
  } else if (!args.quiet) {
    console.log(payload.detail || (payload.ok ? "ok" : "failed"));
  }
  process.exit(code);
}

async function writeJson(filePath, value): Promise<any> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await fsp.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(tempPath, filePath);
}

function parseElapsed(value): any {
  const text = String(value || "").trim();
  const dayParts = text.split("-");
  let days = 0;
  let time = text;
  if (dayParts.length === 2) {
    days = Number(dayParts[0]) || 0;
    time = dayParts[1];
  }
  const pieces = time.split(":").map((item) => Number(item) || 0);
  let seconds = 0;
  if (pieces.length === 3) seconds = pieces[0] * 3600 + pieces[1] * 60 + pieces[2];
  if (pieces.length === 2) seconds = pieces[0] * 60 + pieces[1];
  if (pieces.length === 1) seconds = pieces[0];
  return days * 86400 + seconds;
}

async function processRows(): Promise<any> {
  const result = await execFileAsync("/bin/ps", [
    "-axo",
    "pid=,ppid=,user=,%cpu=,%mem=,etime=,stat=,command=",
    "-ww"
  ], {
    cwd: HOME,
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024
  });

  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\S+)\s+(\S+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        user: match[3],
        cpu: Number(match[4]) || 0,
        mem: Number(match[5]) || 0,
        etime: match[6],
        ageSeconds: parseElapsed(match[6]),
        stat: match[7],
        command: match[8] || ""
      };
    })
    .filter(Boolean);
}

function isAgentBrowserProcess(row): any {
  return row.user === "ai" && (
    row.command.includes(`${HOME}/tools/payloads/npm/agent-browser/`) ||
    row.command.includes(`${HOME}/state/browser/tools/agent-browser/`) ||
    row.command.includes("Google Chrome for Testing")
  );
}

function isFlufflesChromeProcess(row): any {
  return row.user === "ai" && row.command.includes(`${HOME}/Applications/Google Chrome.app`);
}

function isComputerUseClient(row): any {
  return row.user === "ai" && row.command.includes("SkyComputerUseClient");
}

function isCompletedComputerUseClient(row): any {
  return isComputerUseClient(row) && row.command.includes(" turn-ended ");
}

function isActiveComputerUseClient(row): any {
  return isComputerUseClient(row) && row.command.includes(" mcp");
}

function isComputerUseService(row): any {
  return row.user === "ai" && row.command.includes("SkyComputerUseService");
}

function isDiagnosticProcess(row): any {
  return row.user === "ai" && row.command.includes("grep -RIn") && row.command.includes(`${HOME}/state`);
}

function isBrowserProcess(row): any {
  if (row.user !== "ai") return false;
  const ownsProfile = row.command.includes(`--user-data-dir=${BROWSER_PROFILE}`) || row.command.includes(BROWSER_PROFILE);
  if (ownsProfile && (row.command.includes("Google Chrome for Testing") || row.command.includes(`${HOME}/Applications/Google Chrome.app`))) return true;
  return isAgentBrowserProcess(row) || isFlufflesChromeProcess(row);
}


function activityState(rows): any {
  const state = {
    activeAuth: false,
    activeComputerUse: false
  };
  for (const row of rows) {
    if (isActiveComputerUseClient(row)) {
      state.activeComputerUse = true;
      continue;
    }
    if (isComputerUseClient(row) || isComputerUseService(row)) continue;
    const command = row.command || "";
    if (
      command.includes(`${HOME}/homebrew/bin/gws auth login`) ||
      command.includes(`${HOME}/bin/gws auth login`)
    ) {
      state.activeAuth = true;
    }
  }
  return state;
}

function hasActiveAuthOrDoctor(rows): any {
  const state = activityState(rows);
  return state.activeAuth || state.activeComputerUse;
}

function classifyProcess(row, rows, activity): any {
  if (isCompletedComputerUseClient(row)) {
    return {
      category: "computer-use-client",
      stale: row.ageSeconds >= DEFAULTS.staleComputerUseSeconds,
      cleanupEligible: row.ageSeconds >= DEFAULTS.staleComputerUseSeconds,
      reason: "completed Computer Use client remained after turn end"
    };
  }

  if (isActiveComputerUseClient(row)) {
    return {
      category: "computer-use-mcp",
      stale: false,
      cleanupEligible: false,
      reason: "active Computer Use MCP sidecar"
    };
  }

  if (isComputerUseService(row)) {
    return {
      category: "computer-use-service",
      stale: false,
      cleanupEligible: false,
      reason: "Computer Use service"
    };
  }

  if (isAgentBrowserProcess(row)) {
    return {
      category: "agent-browser",
      stale: row.ageSeconds >= DEFAULTS.staleBrowserSeconds,
      cleanupEligible: row.ageSeconds >= DEFAULTS.staleBrowserSeconds,
      reason: "old agent-browser or Chrome-for-Testing process"
    };
  }

  if (isFlufflesChromeProcess(row)) {
    const protectedByLiveUse = activity.activeAuth;
    const stale = row.ageSeconds >= DEFAULTS.staleBrowserSeconds && !protectedByLiveUse;
    return {
      category: "headed-chrome",
      stale,
      cleanupEligible: stale,
      reason: protectedByLiveUse ? "headed Chrome kept for active auth flow" : "old headed Fluffles Chrome process"
    };
  }

  if (isDiagnosticProcess(row)) {
    return {
      category: "diagnostic-process",
      stale: row.ageSeconds >= DEFAULTS.staleDiagnosticSeconds,
      cleanupEligible: row.ageSeconds >= DEFAULTS.staleDiagnosticSeconds,
      reason: "old recursive diagnostic command"
    };
  }

  return null;
}

function processExists(rows, pid): any {
  return rows.some((row) => row.pid === pid);
}

function pidFromSingletonTarget(target): any {
  const match = String(target || "").match(/-(\d+)$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isFinite(pid) ? pid : null;
}

function profileMarkers(rows): any {
  const markerNames = ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"];
  const markers = [];
  const liveProfileBrowser = rows.some((row) => isBrowserProcess(row) && row.command.includes(BROWSER_PROFILE));
  for (const name of markerNames) {
    const filePath = path.join(BROWSER_PROFILE, name);
    let target = null;
    let ownerPid = null;
    let stale = false;
    try {
      const stat = fs.lstatSync(filePath);
      target = stat.isSymbolicLink() ? fs.readlinkSync(filePath) : null;
      ownerPid = name.startsWith("Singleton") ? pidFromSingletonTarget(target) : null;
      stale = !liveProfileBrowser || Boolean(ownerPid && !processExists(rows, ownerPid));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      stale = false;
    }
    markers.push({
      name,
      path: filePath,
      target,
      ownerPid,
      stale,
      cleanupEligible: stale,
      reason: stale ? "orphaned Chrome profile marker" : "active browser owns profile marker"
    });
  }
  return markers;
}

function summarize(rows): any {
  const activity = activityState(rows);
  const activeAuthOrDoctor = activity.activeAuth || activity.activeComputerUse;
  const browser = rows
    .filter(isBrowserProcess)
    .sort((a, b) => b.cpu - a.cpu);
  const control = rows
    .filter((row) => isBrowserProcess(row) || isComputerUseClient(row) || isComputerUseService(row) || isDiagnosticProcess(row))
    .map((row) => {
      const classification = classifyProcess(row, rows, activity) || {
        category: "unknown",
        stale: false,
        cleanupEligible: false,
        reason: "not cleanup eligible"
      };
      return {
        pid: row.pid,
        ppid: row.ppid,
        cpu: row.cpu,
        mem: row.mem,
        ageSeconds: row.ageSeconds,
        etime: row.etime,
        stat: row.stat,
        command: compactCommand(row.command),
        ...classification
      };
    })
    .sort((a, b) => Number(b.stale) - Number(a.stale) || b.ageSeconds - a.ageSeconds);
  const stale = control.filter((row) => row.stale);
  const highCpu = browser.filter((row) =>
    row.cpu >= DEFAULTS.highCpuPercent &&
    row.ageSeconds >= DEFAULTS.minAgeSeconds
  );
  const totalCpu = browser.reduce((sum, row) => sum + row.cpu, 0);
  const totalMem = browser.reduce((sum, row) => sum + row.mem, 0);
  const oldestAgeSeconds = browser.reduce((max, row) => Math.max(max, row.ageSeconds), 0);
  const runaway = highCpu.length >= DEFAULTS.highCpuProcessCount && totalCpu >= DEFAULTS.totalCpuPercent;
  const markers = profileMarkers(rows);
  const staleMarkers = markers.filter((marker) => marker.stale);

  return {
    ok: !runaway && stale.length === 0 && staleMarkers.length === 0,
    generatedAt: new Date().toISOString(),
    thresholds: DEFAULTS,
    activeAuthOrDoctor,
    activity,
    browser: {
      processCount: browser.length,
      highCpuProcessCount: highCpu.length,
      totalCpuPercent: Number(totalCpu.toFixed(1)),
      totalMemPercent: Number(totalMem.toFixed(1)),
      oldestAgeSeconds,
      runaway,
      top: browser.slice(0, 20).map((row) => ({
        pid: row.pid,
        ppid: row.ppid,
        cpu: row.cpu,
        mem: row.mem,
        ageSeconds: row.ageSeconds,
        etime: row.etime,
        stat: row.stat,
        command: compactCommand(row.command)
      }))
    },
    controlSurface: {
      processCount: control.length,
      staleProcessCount: stale.length,
      cleanupEligibleProcessCount: stale.filter((row) => row.cleanupEligible).length,
      stale: stale.slice(0, 40),
      top: control.slice(0, 40)
    },
    profileMarkers: {
      checked: markers.length,
      staleCount: staleMarkers.length,
      stale: staleMarkers,
      markers
    }
  };
}

function compactCommand(command): any {
  const text = String(command || "");
  if (text.length <= 260) return text;
  return `${text.slice(0, 170)} ... ${text.slice(-70)}`;
}

function statusDetail(summary): any {
  const browser = summary.browser;
  const control = summary.controlSurface;
  const markers = summary.profileMarkers;
  if (browser.runaway) {
    return `runaway browser CPU: ${browser.highCpuProcessCount} aged processes >=${DEFAULTS.highCpuPercent}% CPU, total ${browser.totalCpuPercent}%`;
  }
  if (control.staleProcessCount > 0 || markers.staleCount > 0) {
    return `stale control surface: ${control.staleProcessCount} stale processes, ${markers.staleCount} stale profile markers`;
  }
  return `browser/control resources ok: ${browser.processCount} browser processes, ${control.processCount} control processes, total browser CPU ${browser.totalCpuPercent}%`;
}

async function inspect(): Promise<any> {
  const rows = await processRows();
  const summary = summarize(rows);
  const payload = {
    ok: summary.ok,
    tool: "resources",
    component: "resources",
    critical: true,
    detail: statusDetail(summary),
    ...summary
  };
  await writeJson(LAST_STATUS, payload);
  return payload;
}

function cleanupTargets(status): any {
  const pids = new Set<number>();
  const staleRows = status.controlSurface?.stale || [];
  for (const row of staleRows) {
    if (row.cleanupEligible) pids.add(row.pid);
  }
  if (status.browser.runaway) {
    for (const row of status.browser.top) {
      if (row.ageSeconds < DEFAULTS.minAgeSeconds && row.cpu < DEFAULTS.highCpuPercent) continue;
      pids.add(row.pid);
    }
  }
  return [...pids].sort((a, b) => a - b);
}

async function cleanupProfileMarkers(markers, receipt): Promise<any> {
  const eligible = (markers || []).filter((marker) => marker.cleanupEligible);
  if (!eligible.length) return;
  const markerDir = path.join(RECEIPTS_DIR, `${receipt.ranAt.replace(/[:.]/g, "-")}-profile-markers`);
  await fsp.mkdir(markerDir, { recursive: true });
  for (const marker of eligible) {
    const target = path.join(markerDir, path.basename(marker.path));
    try {
      await fsp.rename(marker.path, target);
      receipt.profileMarkerMoves.push({ path: marker.path, movedTo: target, ok: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        receipt.profileMarkerMoves.push({ path: marker.path, ok: true, detail: "already gone" });
      } else {
        receipt.profileMarkerMoves.push({ path: marker.path, ok: false, detail: error.message });
      }
    }
  }
}

function signalPid(pid, signal): any {
  try {
    process.kill(pid, signal);
    return { pid, signal, ok: true };
  } catch (error) {
    if (error.code === "ESRCH") return { pid, signal, ok: true, detail: "already exited" };
    return { pid, signal, ok: false, detail: error.message };
  }
}

async function sleep(ms): Promise<any> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function existingPids(pids): Promise<any> {
  if (!pids.length) return [];
  const rows = await processRows();
  const existing = new Set(rows.map((row) => row.pid));
  return pids.filter((pid) => existing.has(pid));
}

async function cleanup(args): Promise<any> {
  const before = await inspect();
  const targets = args.force
    ? before.browser.top.map((row) => row.pid).sort((a, b) => a - b)
    : cleanupTargets(before);

  const receipt: any = {
    ok: true,
    ranAt: new Date().toISOString(),
    dryRun: args.dryRun,
    force: args.force,
    reason: before.browser.runaway ? "runaway-browser" : "no-runaway-detected",
    thresholds: DEFAULTS,
    before,
    targets,
    signals: [],
    profileMarkerMoves: [],
    after: null
  };

  const markerTargets = before.profileMarkers?.stale || [];

  if (!targets.length && !markerTargets.length) {
    receipt.detail = "no stale or runaway agent-owned browser/control resources to clean";
    receipt.after = before;
    await writeCleanupReceipt(receipt);
    return receipt;
  }

  if (!args.dryRun) {
    for (const pid of targets) receipt.signals.push(signalPid(pid, "SIGTERM"));
    await sleep(DEFAULTS.termGraceMs);
    const stillRunning = await existingPids(targets);
    for (const pid of stillRunning) receipt.signals.push(signalPid(pid, "SIGKILL"));
    await cleanupProfileMarkers(markerTargets, receipt);
    const afterProcesses = await inspect();
    await cleanupProfileMarkers(afterProcesses.profileMarkers?.stale || [], receipt);
    await sleep(1000);
  }

  receipt.after = await inspect();
  receipt.ok = args.dryRun || receipt.after.ok === true;
  receipt.detail = args.dryRun
    ? `would clean ${targets.length} processes and ${markerTargets.length} profile markers`
    : `cleaned ${targets.length} processes and ${receipt.profileMarkerMoves.length} profile markers; stale processes ${receipt.after.controlSurface.staleProcessCount}`;
  await writeCleanupReceipt(receipt);
  return receipt;
}

async function writeCleanupReceipt(receipt): Promise<any> {
  await writeJson(LAST_CLEANUP, receipt);
  const stamp = receipt.ranAt.replace(/[:.]/g, "-");
  await writeJson(path.join(RECEIPTS_DIR, `${stamp}.json`), receipt);
}

async function main(): Promise<any> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (args.command === "status") {
    const status = await inspect();
    emit(status, args, 0);
  }

  if (args.command === "health") {
    const status = await inspect();
    emit(status, { ...args, json: true }, status.ok ? 0 : 1);
  }

  if (args.command === "cleanup") {
    const receipt = await cleanup(args);
    emit({
      ok: receipt.ok,
      tool: "resources",
      component: "resources",
      critical: true,
      detail: receipt.detail,
      receipt
    }, args, receipt.ok ? 0 : 1);
  }

  emit({
    ok: false,
    tool: "resources",
    component: "resources",
    detail: `unknown command: ${args.command}`
  }, { ...args, json: true }, 64);
}

main().catch((error) => {
  console.log(JSON.stringify({
    ok: false,
    tool: "resources",
    component: "resources",
    critical: true,
    detail: error.message
  }, null, 2));
  process.exit(1);
});

export {};
