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
const SESSIONS_DIR = path.join(HOME, ".codex", "sessions");
const STATE_DIR = path.join(HOME, "state", "communications");
const CURRENT_PATH = path.join(STATE_DIR, "current.json");
const SLACK_STATUS_PATH = path.join(HOME, "state", "channels", "slack", "status.json");
const SLACK_SESSIONS_PATH = path.join(HOME, "state", "channels", "slack", "slack-sessions.json");
const EMAIL_STATUS_PATH = path.join(HOME, "state", "channels", "email", "status.json");
const PHONE_STATUS_PATH = path.join(HOME, "state", "channels", "phone", "status.json");

const CHANNEL_NAMES = {
  C0000000001: "#agent-feed",
  C0000000002: "#agent-requests",
  C0000000004: "#agent-alerts"
};

function usage(): any {
  return `Usage: communications <current|sessions|surfaces|snapshot|health> [--json]

Commands:
  current   Show current communications awareness. Default command.
  sessions  Show live Codex sessions.
  surfaces  Show communication surface health.
  snapshot  Write and print the current communications snapshot.
  health    Low-risk health check for the communications tool.`;
}

function parseArgs(argv): any {
  return {
    command: argv.find((arg) => !arg.startsWith("-")) || "current",
    json: argv.includes("--json"),
    help: argv.includes("--help") || argv.includes("-h")
  };
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

function truncate(value, length = 360): any {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= length) return text;
  return `${text.slice(0, length - 3)}...`;
}

function ageMs(isoOrMs, now = Date.now()) {
  const value = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs || "");
  if (!Number.isFinite(value)) return null;
  return Math.max(0, now - value);
}

function formatAge(ms): any {
  if (!Number.isFinite(ms)) return "unknown";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

async function run(file, args, options: any = {}): Promise<any> {
  try {
    const result = await execFileAsync(file, args, {
      cwd: options.cwd || HOME,
      timeout: options.timeoutMs || 15000,
      maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
      env: {
        ...process.env,
        STASH_TELEMETRY: "0"
      }
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || ""),
      stderr: String(error.stderr || error.message || "")
    };
  }
}

function parseLsof(text): any {
  const sessions = new Map();
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("COMMAND")) continue;
    const match = line.match(/^(\S+)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\/Users\/ai\/\.codex\/sessions\/.+\.jsonl)$/);
    if (!match) continue;
    const command = match[1];
    const pid = Number(match[2]);
    const filePath = match[3];
    if (command !== "codex" || !Number.isInteger(pid)) continue;
    sessions.set(`${pid}:${filePath}`, { pid, filePath });
  }
  return [...sessions.values()];
}

async function processMap(): Promise<any> {
  const result = await run("/bin/ps", ["-axo", "pid=,ppid=,lstart=,command="], {
    timeoutMs: 10000,
    maxBuffer: 8 * 1024 * 1024
  });
  const map = new Map();
  if (!result.ok) return map;
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/);
    if (!match) continue;
    map.set(Number(match[1]), {
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startedAtText: match[3],
      command: match[4]
    });
  }
  return map;
}

function currentCodexPid(map): any {
  let pid = process.ppid;
  const seen = new Set();
  while (pid && !seen.has(pid)) {
    seen.add(pid);
    const item = map.get(pid);
    if (!item) return null;
    if (item.command.includes("/homebrew/bin/codex -m") || item.command.includes("/Applications/Codex.app/Contents/Resources/codex -m")) {
      return item.pid;
    }
    pid = item.ppid;
  }
  return null;
}

function sessionIdFromPath(filePath): any {
  const match = path.basename(filePath).match(/rollout-.+-(019[0-9a-f-]+)\.jsonl$/);
  return match ? match[1] : null;
}

function statFile(filePath): any {
  try {
    const stat = fs.statSync(filePath);
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mtime: stat.mtime.toISOString()
    };
  } catch (_error) {
    return {
      size: null,
      mtimeMs: null,
      mtime: null
    };
  }
}

function parseTextContent(content): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => item?.text || item?.input_text || item?.output_text || "")
    .filter(Boolean)
    .join("\n");
}

function digestSessionFile(filePath): any {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    return {
      error: error.message,
      meta: null,
      lastUserMessage: null,
      lastAssistantMessage: null,
      lastTask: null,
      lastEventAt: null
    };
  }

  const lines = text.split(/\r?\n/).filter(Boolean);
  const recent = lines.slice(-500);
  let meta = null;
  let lastUserMessage = null;
  let lastAssistantMessage = null;
  let lastTask = null;
  let lastEventAt = null;
  let turnId = null;

  for (const line of lines.slice(0, 80)) {
    let item = null;
    try {
      item = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    if (item.type !== "session_meta") continue;
    meta = {
      id: item.payload?.id || null,
      cwd: item.payload?.cwd || null,
      startedAt: item.payload?.timestamp || item.timestamp || null,
      originator: item.payload?.originator || null,
      modelProvider: item.payload?.model_provider || null,
      source: item.payload?.source || null
    };
    break;
  }

  for (const line of recent) {
    let item = null;
    try {
      item = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    if (item.timestamp) lastEventAt = item.timestamp;
    if (item.type === "session_meta" && !meta) {
      meta = {
        id: item.payload?.id || null,
        cwd: item.payload?.cwd || null,
        startedAt: item.payload?.timestamp || item.timestamp || null,
        originator: item.payload?.originator || null,
        modelProvider: item.payload?.model_provider || null,
        source: item.payload?.source || null
      };
      continue;
    }
    if (item.type === "turn_context") {
      turnId = item.payload?.turn_id || turnId;
      continue;
    }
    if (item.type !== "event_msg" && item.type !== "response_item") continue;
    const payload = item.payload || {};
    if (payload.type === "user_message") {
      lastUserMessage = {
        at: item.timestamp,
        text: truncate(payload.message, 500)
      };
      continue;
    }
    if (payload.type === "agent_message") {
      lastAssistantMessage = {
        at: item.timestamp,
        phase: payload.phase || null,
        text: truncate(payload.message, 500)
      };
      continue;
    }
    if (payload.type === "task_started") {
      turnId = payload.turn_id || turnId;
      lastTask = {
        turnId,
        status: "running",
        startedAt: payload.started_at ? new Date(payload.started_at * 1000).toISOString() : item.timestamp
      };
      continue;
    }
    if (payload.type === "task_complete") {
      lastTask = {
        turnId: payload.turn_id || turnId,
        status: "complete",
        completedAt: payload.completed_at ? new Date(payload.completed_at * 1000).toISOString() : item.timestamp,
        durationMs: payload.duration_ms || null,
        lastAgentMessage: truncate(payload.last_agent_message, 500)
      };
      continue;
    }
    if (payload.type === "message") {
      const role = payload.role;
      const message = {
        at: item.timestamp,
        text: truncate(parseTextContent(payload.content), 500)
      };
      if (role === "user") lastUserMessage = message;
      if (role === "assistant") lastAssistantMessage = message;
    }
  }

  return {
    meta,
    lastUserMessage,
    lastAssistantMessage,
    lastTask,
    lastEventAt
  };
}

async function codexSessions(): Promise<any> {
  const lsof = await run("/usr/sbin/lsof", ["-n", "-w", "+D", SESSIONS_DIR], {
    timeoutMs: 15000,
    maxBuffer: 8 * 1024 * 1024
  });
  const open = parseLsof(lsof.stdout);
  const procs = await processMap();
  const currentPid = currentCodexPid(procs);
  const now = Date.now();

  const sessions = open.map((item) => {
    const stat = statFile(item.filePath);
    const digest = digestSessionFile(item.filePath);
    const mtimeAgeMs = ageMs(stat.mtimeMs, now);
    const eventAge = ageMs(digest.lastEventAt, now);
    const status = mtimeAgeMs !== null && mtimeAgeMs <= 10 * 60 * 1000 ? "active" : "open-stale";
    return {
      surface: "codex",
      id: digest.meta?.id || sessionIdFromPath(item.filePath),
      pid: item.pid,
      current: currentPid === item.pid,
      status,
      cwd: digest.meta?.cwd || null,
      file: item.filePath,
      startedAt: digest.meta?.startedAt || null,
      lastWriteAt: stat.mtime,
      lastWriteAge: formatAge(mtimeAgeMs),
      lastEventAt: digest.lastEventAt,
      lastEventAge: formatAge(eventAge),
      lastTask: digest.lastTask,
      lastUserMessage: digest.lastUserMessage,
      lastAssistantMessage: digest.lastAssistantMessage,
      process: procs.get(item.pid)?.command || null
    };
  }).sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return Date.parse(b.lastWriteAt || 0) - Date.parse(a.lastWriteAt || 0);
  });

  return {
    ok: true,
    error: open.length > 0 || lsof.ok ? null : "no open Codex sessions",
    currentPid,
    openCount: sessions.length,
    activeCount: sessions.filter((item) => item.status === "active").length,
    staleCount: sessions.filter((item) => item.status === "open-stale").length,
    sessions
  };
}

function slackSurface(): any {
  const status = readJsonIfExists(SLACK_STATUS_PATH);
  const store = readJsonIfExists(SLACK_SESSIONS_PATH);
  const sessions = Object.entries((store?.sessions || {}) as Record<string, any>).map(([key, value]) => {
    const lastUsedAge = ageMs(value.lastUsedAt);
    return {
      surface: "slack",
      id: key,
      channel: value.channel,
      channelName: CHANNEL_NAMES[value.channel] || value.channel,
      threadTs: value.threadTs || null,
      surfaceMode: value.surface || null,
      user: value.user || null,
      status: value.runStatus === "idle" ? "open-stale" : "active",
      lastUsedAt: value.lastUsedAt || null,
      lastUsedAge: formatAge(lastUsedAge),
      runStatus: value.runStatus || null,
      codexSessionId: value.codexSessionId || null,
      lastError: value.lastError || null
    };
  }).sort((a, b) => Date.parse(b.lastUsedAt || 0) - Date.parse(a.lastUsedAt || 0));

  const recentSessions = sessions.filter((item) => {
    const ms = ageMs(item.lastUsedAt);
    return ms !== null && ms <= 24 * 60 * 60 * 1000;
  });

  return {
    ok: status?.ok === true && status?.socketConnected === true,
    connected: status?.socketConnected === true,
    botName: status?.botName || null,
    team: status?.team || null,
    activeTransport: status?.activeTransport || null,
    allowedChannels: status?.allowedChannels || 0,
    ambientChannels: status?.ambientChannels || 0,
    activeRuns: status?.activeRuns || 0,
    queuedReplies: status?.queuedReplies || 0,
    lastEventAt: status?.lastEventAt || null,
    lastHandledAt: status?.lastHandledAt || null,
    lastIgnoredAt: status?.lastIgnoredAt || null,
    lastIgnoredReason: status?.lastIgnoredReason || null,
    sessionCount: sessions.length,
    recentSessionCount: recentSessions.length,
    activeSessionCount: sessions.filter((item) => item.status === "active").length,
    recentSessions: recentSessions.slice(0, 12)
  };
}

function channelStatusSurface(name, statusPath): any {
  const status = readJsonIfExists(statusPath);
  const lastEventAt = status?.lastWebhookAt || status?.lastPollAt || status?.lastRunAt || null;
  return {
    ok: status?.ok === true,
    implemented: true,
    service: status?.service || name,
    statusPath,
    pollingEnabled: status?.pollingEnabled ?? null,
    webhookEnabled: status?.webhookEnabled ?? null,
    outboundMode: status?.outboundMode ?? null,
    lastEventAt,
    lastEventAge: formatAge(ageMs(lastEventAt)),
    lastPollAt: status?.lastPollAt || null,
    lastWebhookAt: status?.lastWebhookAt || null,
    lastRunAt: status?.lastRunAt || null,
    lastRunStatus: status?.lastRunStatus || null,
    lastRunError: status?.lastRunError || null,
    lastPollError: status?.lastPollError || null,
    lastWebhookError: status?.lastWebhookError || null,
    transport: status?.transport || null
  };
}

async function snapshot(): Promise<any> {
  const codex = await codexSessions();
  const slack = slackSurface();
  const email = channelStatusSurface("email", EMAIL_STATUS_PATH);
  const phone = channelStatusSurface("phone", PHONE_STATUS_PATH);
  const currentCodex = codex.sessions.find((item) => item.current) || codex.sessions[0] || null;
  const currentSurface = currentCodex ? "codex" : (slack.connected ? "slack" : null);
  const pending: string[] = [];
  if (slack.activeRuns > 0) pending.push("slack reply run in progress");
  if (slack.queuedReplies > 0) pending.push(`${slack.queuedReplies} queued Slack replies`);

  const payload = {
    ok: codex.ok && slack.ok,
    generatedAt: new Date().toISOString(),
    current: currentCodex ? {
      surface: "codex",
      sessionId: currentCodex.id,
      pid: currentCodex.pid,
      status: currentCodex.status,
      cwd: currentCodex.cwd,
      lastUserMessage: currentCodex.lastUserMessage,
      lastAssistantMessage: currentCodex.lastAssistantMessage
    } : {
      surface: currentSurface,
      sessionId: null,
      status: "unknown"
    },
    summary: {
      currentSurface,
      codexOpen: codex.openCount,
      codexActive: codex.activeCount,
      codexStale: codex.staleCount,
      slackConnected: slack.connected,
      slackActiveRuns: slack.activeRuns,
      slackQueuedReplies: slack.queuedReplies,
      emailOk: email.ok,
      phoneOk: phone.ok,
      pendingCount: pending.length
    },
    pending,
    surfaces: {
      codex,
      slack,
      email,
      phone,
      imessage: {
        ok: null,
        implemented: false,
        detail: "available only when explicitly used"
      }
    },
    paths: {
      state: STATE_DIR,
      current: CURRENT_PATH,
      codexSessions: SESSIONS_DIR,
      slackStatus: SLACK_STATUS_PATH,
      slackSessions: SLACK_SESSIONS_PATH,
      emailStatus: EMAIL_STATUS_PATH,
      phoneStatus: PHONE_STATUS_PATH
    }
  };

  await writeJson(CURRENT_PATH, payload);
  return payload;
}

function printHuman(payload, mode = "current"): any {
  if (mode === "sessions") {
    console.log(`codex sessions: ${payload.openCount} open, ${payload.activeCount} active, ${payload.staleCount} stale`);
    for (const session of payload.sessions) {
      const mark = session.current ? "*" : "-";
      console.log(`${mark} ${session.id || "unknown"} pid=${session.pid} ${session.status} last=${session.lastWriteAge} cwd=${session.cwd || "unknown"}`);
      if (session.lastUserMessage?.text) console.log(`  user: ${session.lastUserMessage.text}`);
    }
    return;
  }

  if (mode === "surfaces") {
    console.log(`codex: ${payload.surfaces.codex.openCount} open, ${payload.surfaces.codex.activeCount} active`);
    console.log(`slack: ${payload.surfaces.slack.connected ? "connected" : "not connected"}, activeRuns=${payload.surfaces.slack.activeRuns}, queued=${payload.surfaces.slack.queuedReplies}`);
    console.log(`email: ${payload.surfaces.email.ok ? "ok" : "not ok"}, last=${payload.surfaces.email.lastEventAge}`);
    console.log(`phone: ${payload.surfaces.phone.ok ? "ok" : "not ok"}, last=${payload.surfaces.phone.lastEventAge}`);
    console.log("imessage: explicit use only");
    return;
  }

  console.log(`current surface: ${payload.current?.surface || "unknown"}`);
  if (payload.current?.surface === "codex") {
    console.log(`current codex session: ${payload.current.sessionId || "unknown"} pid=${payload.current.pid || "unknown"} ${payload.current.status || ""}`);
    if (payload.current.lastUserMessage?.text) console.log(`last user: ${payload.current.lastUserMessage.text}`);
  }
  console.log(`codex chats: ${payload.summary.codexOpen} open, ${payload.summary.codexActive} active, ${payload.summary.codexStale} stale`);
  console.log(`slack: ${payload.summary.slackConnected ? "connected" : "not connected"}, activeRuns=${payload.summary.slackActiveRuns}, queued=${payload.summary.slackQueuedReplies}`);
  console.log(`email: ${payload.summary.emailOk ? "ok" : "not ok"}`);
  console.log(`phone: ${payload.summary.phoneOk ? "ok" : "not ok"}`);
  console.log(`snapshot: ${CURRENT_PATH}`);
}

async function commandHealth(): Promise<any> {
  const data = await snapshot();
  const ok = data.surfaces.slack.connected === true || data.surfaces.codex.openCount >= 1;
  const detail = ok
    ? `slackConnected=${data.surfaces.slack.connected}, codexOpen=${data.surfaces.codex.openCount}`
    : `codexOpen=${data.surfaces.codex.openCount}, slackConnected=${data.surfaces.slack.connected}`;
  console.log(JSON.stringify({
    ok,
    tool: "communications",
    component: "communications",
    detail,
    codexOpen: data.surfaces.codex.openCount,
    slackConnected: data.surfaces.slack.connected
  }, null, 2));
  if (!ok) process.exit(1);
}

async function main(): Promise<any> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.command === "health") return commandHealth();

  const data = await snapshot();
  if (args.command === "current" || args.command === "snapshot") {
    if (args.json) console.log(JSON.stringify(data, null, 2));
    else printHuman(data, "current");
    return;
  }
  if (args.command === "sessions") {
    if (args.json) console.log(JSON.stringify(data.surfaces.codex, null, 2));
    else printHuman(data.surfaces.codex, "sessions");
    return;
  }
  if (args.command === "surfaces") {
    if (args.json) console.log(JSON.stringify(data.surfaces, null, 2));
    else printHuman(data, "surfaces");
    return;
  }
  console.error(usage());
  process.exit(2);
}

main().catch((error) => {
  console.error(`communications failed: ${error.message || error}`);
  process.exit(1);
});

export {};
