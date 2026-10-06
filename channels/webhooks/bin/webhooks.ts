#!/usr/bin/env node
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../src/config";

// The label and manifest belong to whichever harness this home is, so the same
// command manages the dev service without naming production's job.
const HOME = process.env.HOME ?? os.homedir();
// Installed, the resolver sits in the home; run from a checkout it sits two
// directories up from this file.
function hostConfigPath(): string {
  const installed = path.join(HOME, "deploy", "bin", "host-config.mjs");
  if (fs.existsSync(installed)) return installed;
  return path.resolve(__dirname, "..", "..", "deploy", "bin", "host-config.mjs");
}
const LABEL = (
  JSON.parse(
    execFileSync(process.execPath, [hostConfigPath(), "--service", "webhooks"], { encoding: "utf8" })
  ) as { label: string }
).label;
const PLIST = path.join(HOME, "Library", "LaunchAgents", `${LABEL}.plist`);
const config = loadConfig();
const logFile = path.join(config.logDir, "service.log");
const execFileAsync = promisify(execFile);

type CommandResult = { ok: boolean; stdout: string; stderr: string; code?: unknown };
type StatusReason = "status" | "already-running" | "started-launchd" | "started-launchd-retry" | "started" | "doctor";

type ChildProcessError = Error & { stdout?: string; stderr?: string; code?: unknown };

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function usage(): string {
  return `Usage: webhooks <start|stop|restart|status|logs|smoke|doctor|launchd-status>

Local webhook ingress manager. Automation definitions live in ${HOME}/automations
and are managed with ${HOME}/bin/automations.

Examples:
  webhooks status
  webhooks smoke
  webhooks logs`;
}

async function ensureDirs(): Promise<void> {
  await fsp.mkdir(config.logDir, { recursive: true });
  await fsp.mkdir(config.eventDir, { recursive: true });
}

async function readPid(): Promise<number | null> {
  try {
    const value = Number((await fsp.readFile(config.pidFile, "utf8")).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch (_error) {
    return null;
  }
}

function isRunning(pid: number | null): pid is number {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_error) { return false; }
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function runLaunchctl(args: string[]): Promise<CommandResult> {
  try {
    const result = await execFileAsync("/bin/launchctl", args, { timeout: 10000, maxBuffer: 1024 * 1024 });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const childError = error as ChildProcessError;
    return { ok: false, stdout: childError.stdout || "", stderr: childError.stderr || childError.message, code: childError.code };
  }
}

function launchdTarget(): string {
  return `${launchdDomain()}/${LABEL}`;
}

function launchdDomain(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 501;
  return `gui/${uid}`;
}

async function isLaunchdLoaded(): Promise<boolean> { return (await runLaunchctl(["print", launchdTarget()])).ok; }

function requestJson(options: http.RequestOptions, body?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(text || "{}"); } catch (_error) { reject(new Error(`invalid json from ${String(options.path)}: ${text.slice(0, 120)}`)); return; }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) { reject(new Error(`${String(options.path)} returned ${res.statusCode}: ${text.slice(0, 200)}`)); return; }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("request-timeout")));
    if (body) req.write(body);
    req.end();
  });
}

async function health(): Promise<Record<string, unknown>> {
  return requestJson({ hostname: "127.0.0.1", port: config.port, path: "/healthz", method: "GET" });
}

async function waitForHealth(deadlineMs = 10000): Promise<Record<string, unknown>> {
  const start = Date.now();
  let lastError: unknown = null;
  while (Date.now() - start < deadlineMs) {
    try { return await health(); } catch (error) { lastError = error; await sleep(250); }
  }
  throw lastError || new Error("health-timeout");
}

async function status(reason: StatusReason = "status"): Promise<Record<string, unknown>> {
  const pid = await readPid();
  const running = isRunning(pid);
  let healthPayload: Record<string, unknown> | null = null;
  let healthError: string | null = null;
  if (running) {
    try { healthPayload = await health(); } catch (error) { healthError = errorMessage(error); }
  }
  return { ok: running && healthPayload?.ok === true, reason, service: config.serviceName, running, pid: running ? pid : null, healthUrl: `http://127.0.0.1:${config.port}/healthz`, routesUrl: `http://127.0.0.1:${config.port}/routes`, stateDir: config.stateDir, logFile, health: healthPayload, healthError };
}

async function start(): Promise<void> {
  await ensureDirs();
  const currentPid = await readPid();
  if (isRunning(currentPid)) { console.log(JSON.stringify(await status("already-running"), null, 2)); return; }
  if (!fs.existsSync(PLIST)) {
    throw new Error(`webhook launchd service is not installed: ${PLIST}`);
  }
  let loaded = await isLaunchdLoaded();
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (!loaded) {
      const boot = await runLaunchctl(["bootstrap", launchdDomain(), PLIST]);
      if (!boot.ok) { lastError = new Error(`launchd bootstrap failed: ${boot.stderr.trim()}`); await sleep(750); loaded = await isLaunchdLoaded(); continue; }
      loaded = true;
    }
    try { await waitForHealth(7000); console.log(JSON.stringify(await status(attempt === 1 ? "started-launchd" : "started-launchd-retry"), null, 2)); return; }
    catch (error) { lastError = error; if (attempt < 3) { if (await isLaunchdLoaded()) await runLaunchctl(["bootout", launchdTarget()]); await sleep(1000); loaded = false; } }
  }
  throw lastError || new Error("launchd start failed");
}

async function stop(): Promise<void> {
  if (await isLaunchdLoaded()) {
    const bootout = await runLaunchctl(["bootout", launchdTarget()]);
    if (!bootout.ok) throw new Error(`launchd bootout failed: ${bootout.stderr.trim()}`);
    const startTime = Date.now();
    while (Date.now() - startTime < 5000) { if (!(await isLaunchdLoaded())) break; await sleep(200); }
    await fsp.rm(config.pidFile, { force: true }).catch(() => undefined);
    console.log(`${config.serviceName} stopped through launchd.`); return;
  }
  const pid = await readPid();
  if (!isRunning(pid)) { await fsp.rm(config.pidFile, { force: true }).catch(() => undefined); console.log(`${config.serviceName} is not running.`); return; }
  process.kill(pid, "SIGTERM");
  const startTime = Date.now();
  while (Date.now() - startTime < 8000) { if (!isRunning(pid)) break; await sleep(200); }
  if (isRunning(pid)) process.kill(pid, "SIGKILL");
  await fsp.rm(config.pidFile, { force: true }).catch(() => undefined);
  console.log(`${config.serviceName} stopped.`);
}

async function logs(): Promise<void> {
  await ensureDirs();
  if (!fs.existsSync(logFile)) { console.log(`no log file yet: ${logFile}`); return; }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tail", ["-n", process.env.WEBHOOK_LOG_LINES || "120", logFile], { stdio: "inherit" });
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`tail exited ${code}`)));
    child.on("error", reject);
  });
}

async function smoke(): Promise<void> {
  const payload = JSON.stringify({ smoke: true, sentAt: new Date().toISOString(), source: "webhooks smoke" });
  const receipt = await requestJson({ hostname: "127.0.0.1", port: config.port, path: "/events/test", method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, payload);
  console.log(JSON.stringify(receipt, null, 2));
}

async function doctor(): Promise<void> {
  console.log(JSON.stringify({ ...(await status("doctor")), paths: { pidFile: config.pidFile, stateFile: config.stateFile, latestEventFile: config.latestEventFile }, configured: { genericSecret: Boolean(config.genericSecret), githubSecret: Boolean(config.githubSecret) } }, null, 2));
}

async function launchdStatus(): Promise<void> {
  const result = await runLaunchctl(["print", launchdTarget()]);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (!result.ok) process.exit(1);
}

async function main(): Promise<void> {
  const command = process.argv[2] || "status";
  if (command === "start") return start();
  if (command === "stop") return stop();
  if (command === "restart") { await stop(); return start(); }
  if (command === "status") { console.log(JSON.stringify(await status(), null, 2)); return; }
  if (command === "logs") return logs();
  if (command === "smoke") return smoke();
  if (command === "doctor") return doctor();
  if (command === "launchd-status") return launchdStatus();
  if (command === "--help" || command === "-h" || command === "help") { console.log(usage()); return; }
  console.error(usage()); process.exit(2);
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exit(1); });
