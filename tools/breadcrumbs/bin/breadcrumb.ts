#!/usr/bin/env node
import os from "node:os";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import * as safety from "../../../subagents/lib/memory/memory-safety.cjs";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type SafetyApi = {
  isSensitiveKey: (key: string) => boolean;
  redactSensitiveText: (value: string, redactHighEntropy?: boolean) => string;
};
const safetyApi = ((safety as { default?: unknown }).default ?? safety) as SafetyApi;
const { isSensitiveKey, redactSensitiveText } = safetyApi;

type BreadcrumbInput = {
  id?: string;
  at?: string;
  scope?: string;
  component?: string;
  kind?: string;
  subject?: string | null;
  result?: string;
  summary?: string | null;
  runId?: string | null;
  parentId?: string | null;
  source?: string;
  evidence?: JsonValue;
  metadata?: JsonObject;
};

type Breadcrumb = {
  id: string;
  at: string;
  scope: string;
  component: string;
  kind: string;
  subject: string | null;
  result: string;
  summary: string;
  runId: string | null;
  parentId: string | null;
  source: string;
  evidence: JsonValue;
  metadata: JsonObject;
  createdAt: string;
};

const HOME_DIR = process.env.HOME || os.homedir();
const DEFAULT_LEDGER_PATH = path.join(HOME_DIR, "state", "tasks", "tasks.sqlite");
const LEDGER_PATH = process.env.BREADCRUMB_LEDGER_PATH || process.env.FLUFFLES_TASK_LEDGER_PATH || DEFAULT_LEDGER_PATH;
const ERROR_LOG = path.join(HOME_DIR, "state", "breadcrumbs", "errors.log");
const RETENTION_DAYS = 45;

function usage(): string {
  return [
    "Usage:",
    "  breadcrumb emit --scope S --component C --kind K [--subject X] [--result R] [--summary T]",
    "  breadcrumb hook <event-name>",
    "  breadcrumb run --scope S --component C --kind K --subject X -- command ...",
    "  breadcrumb tail [--scope S] [--component C] [--from ISO] [--until ISO] [--limit N] [--json]",
    "  breadcrumb health"
  ].join("\n");
}

function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS breadcrumbs (
      id TEXT PRIMARY KEY,
      occurred_at TEXT NOT NULL,
      scope TEXT NOT NULL,
      component TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT,
      result TEXT NOT NULL,
      summary TEXT NOT NULL,
      run_id TEXT,
      parent_id TEXT,
      source TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_breadcrumbs_scope_time ON breadcrumbs(scope, occurred_at, id);
    CREATE INDEX IF NOT EXISTS idx_breadcrumbs_component_time ON breadcrumbs(component, occurred_at, id);
    CREATE INDEX IF NOT EXISTS idx_breadcrumbs_kind_time ON breadcrumbs(kind, occurred_at, id);
    CREATE INDEX IF NOT EXISTS idx_breadcrumbs_run ON breadcrumbs(run_id);
    CREATE INDEX IF NOT EXISTS idx_breadcrumbs_parent ON breadcrumbs(parent_id);
  `);
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  db.prepare("DELETE FROM breadcrumbs WHERE created_at < ?").run(cutoff);
}

function openDb(): DatabaseSync {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  const db = new DatabaseSync(LEDGER_PATH);
  db.exec("PRAGMA busy_timeout = 5000");
  ensureSchema(db);
  return db;
}

function nowIso(): string {
  return new Date().toISOString();
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
}

function flagValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  return args[index + 1] ?? null;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseJsonFlag(args: string[], name: string, fallback: JsonValue): JsonValue {
  const raw = flagValue(args, name);
  if (!raw) return fallback;
  return JSON.parse(raw) as JsonValue;
}

function parseObjectFlag(args: string[], name: string, fallback: JsonObject = {}): JsonObject {
  const value = parseJsonFlag(args, name, fallback);
  return isJsonObject(value) ? value : {};
}

function cleanText(value: unknown, limit = 500): string {
  const text = redactSensitiveText(String(value ?? ""), true)
    .replace(/https:\/\/puffle-workspace\.slack\.com\/\S+/g, "[internal-slack-link]")
    .replace(/\/Users\/ai\/[^\s)"']+/g, "[internal-path]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\+\d{7,15}\b/g, "[phone]")
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, "[phone]")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function cleanId(value: unknown, fallback: string): string {
  const text = cleanText(value, 160);
  return text || fallback;
}

function normalizeInput(input: BreadcrumbInput): Breadcrumb {
  const createdAt = nowIso();
  const evidence = input.evidence === undefined ? null : sanitizeJson(input.evidence);
  const metadata = isJsonObject(input.metadata ?? {}) ? sanitizeJsonObject(input.metadata ?? {}) : {};
  return {
    id: cleanText(input.id, 120) || randomUUID(),
    at: cleanText(input.at, 80) || createdAt,
    scope: cleanId(input.scope, "fluffles"),
    component: cleanId(input.component, "unknown"),
    kind: cleanId(input.kind, "event"),
    subject: input.subject == null ? null : cleanText(input.subject, 180),
    result: cleanId(input.result, "info"),
    summary: cleanText(input.summary, 700) || cleanId(input.kind, "event"),
    runId: input.runId == null ? null : cleanText(input.runId, 160),
    parentId: input.parentId == null ? null : cleanText(input.parentId, 160),
    source: cleanId(input.source, "breadcrumb"),
    evidence,
    metadata,
    createdAt
  };
}

function emit(input: BreadcrumbInput): Breadcrumb {
  const breadcrumb = normalizeInput(input);
  const db = openDb();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO breadcrumbs (
        id, occurred_at, scope, component, kind, subject, result, summary,
        run_id, parent_id, source, evidence_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      breadcrumb.id,
      breadcrumb.at,
      breadcrumb.scope,
      breadcrumb.component,
      breadcrumb.kind,
      breadcrumb.subject,
      breadcrumb.result,
      breadcrumb.summary,
      breadcrumb.runId,
      breadcrumb.parentId,
      breadcrumb.source,
      JSON.stringify(breadcrumb.evidence),
      JSON.stringify(breadcrumb.metadata),
      breadcrumb.createdAt
    );
  } finally {
    db.close();
  }
  return breadcrumb;
}

function emitBestEffort(input: BreadcrumbInput): Breadcrumb | null {
  try {
    return emit(input);
  } catch (error) {
    logError(error);
    return null;
  }
}

function logError(error: unknown): void {
  try {
    fs.mkdirSync(path.dirname(ERROR_LOG), { recursive: true });
    fs.appendFileSync(ERROR_LOG, `${nowIso()} ${error instanceof Error ? error.stack || error.message : String(error)}\n`, "utf8");
  } catch {
    // Breadcrumb failures must never break the caller.
  }
}

function inputFromFlags(args: string[]): BreadcrumbInput {
  const stdinJson = flagValue(args, "--json");
  const fromJson = stdinJson ? JSON.parse(stdinJson) as BreadcrumbInput : {};
  return {
    ...fromJson,
    id: flagValue(args, "--id") ?? fromJson.id,
    at: flagValue(args, "--at") ?? fromJson.at,
    scope: flagValue(args, "--scope") ?? fromJson.scope,
    component: flagValue(args, "--component") ?? fromJson.component,
    kind: flagValue(args, "--kind") ?? fromJson.kind,
    subject: flagValue(args, "--subject") ?? fromJson.subject,
    result: flagValue(args, "--result") ?? fromJson.result,
    summary: flagValue(args, "--summary") ?? fromJson.summary,
    runId: flagValue(args, "--run-id") ?? fromJson.runId,
    parentId: flagValue(args, "--parent-id") ?? fromJson.parentId,
    source: flagValue(args, "--source") ?? fromJson.source,
    evidence: parseJsonFlag(args, "--evidence-json", fromJson.evidence ?? null),
    metadata: parseObjectFlag(args, "--metadata-json", fromJson.metadata ?? {})
  };
}

async function commandEmit(args: string[]): Promise<void> {
  let input = inputFromFlags(args);
  if (hasFlag(args, "--stdin")) {
    const text = (await readStdin()).trim();
    if (text) input = { ...JSON.parse(text) as BreadcrumbInput, ...input };
  }
  const breadcrumb = emit(input);
  console.log(JSON.stringify({ ok: true, breadcrumb }, null, 2));
}

async function commandHook(args: string[]): Promise<void> {
  const eventNameArg = args[0] || "";
  const text = await readStdin();
  const payload = text.trim() ? JSON.parse(text) as Record<string, unknown> : {};
  const eventName = cleanText(eventNameArg || payload.hook_event_name || payload.hookEventName || "unknown", 80);
  const breadcrumb = hookBreadcrumb(eventName, payload);
  emitBestEffort(breadcrumb);
}

function hookBreadcrumb(eventName: string, payload: Record<string, unknown>): BreadcrumbInput {
  const sessionId = cleanText(payload.session_id ?? payload.sessionId, 120);
  const turnId = cleanText(payload.turn_id ?? payload.turnId, 120);
  const model = cleanText(payload.model, 80);
  const cwd = cleanText(payload.cwd, 160);
  const runId = turnId || sessionId || null;
  const parentId = turnId && sessionId ? sessionId : null;
  const common: BreadcrumbInput = {
    scope: "fluffles",
    component: "codex",
    source: "codex-hook",
    runId,
    parentId,
    metadata: compactMetadata({
      sessionId,
      turnId,
      model,
      cwd,
      permissionMode: payload.permission_mode ?? payload.permissionMode,
      hookEventName: eventName
    })
  };

  if (eventName === "SessionStart") {
    return {
      ...common,
      kind: "model.session_start",
      subject: sessionId || "session",
      result: "start",
      summary: `session started${model ? ` on ${model}` : ""}${cwd ? ` in ${cwd}` : ""}`
    };
  }

  if (eventName === "UserPromptSubmit") {
    return {
      ...common,
      kind: "model.turn_start",
      subject: turnId || sessionId || "turn",
      result: "start",
      summary: "user prompt submitted"
    };
  }

  if (eventName === "PostToolUse") {
    const toolName = cleanText(payload.tool_name ?? payload.toolName, 80) || "tool";
    const toolInput = isRecord(payload.tool_input) ? payload.tool_input : isRecord(payload.toolInput) ? payload.toolInput : {};
    const toolResponse = isRecord(payload.tool_response) ? payload.tool_response : isRecord(payload.toolResponse) ? payload.toolResponse : {};
    const exitCode = toolResponse.exit_code ?? toolResponse.exitCode;
    const result = exitCode === 0 ? "ok" : exitCode == null ? "done" : "attention";
    return {
      ...common,
      component: "tool",
      kind: "tool.use",
      subject: toolName,
      result,
      summary: exitCode == null
        ? `${toolName} completed`
        : `${toolName} ${exitCode === 0 ? "succeeded" : "failed"} with exit ${cleanText(exitCode, 24)}`,
      metadata: compactMetadata({
        ...common.metadata,
        toolName,
        toolUseId: payload.tool_use_id ?? payload.toolUseId,
        exitCode
      })
    };
  }

  if (eventName === "Stop") {
    return {
      ...common,
      kind: "model.turn_stop",
      subject: turnId || sessionId || "turn",
      result: "done",
      summary: "assistant turn completed"
    };
  }

  return {
    ...common,
    kind: `hook.${eventName}`,
    subject: turnId || sessionId || "hook",
    result: "info",
    summary: `${eventName} hook observed`
  };
}

async function commandRun(args: string[]): Promise<void> {
  const separator = args.indexOf("--");
  if (separator < 0) throw new Error("breadcrumb run requires -- before the command");
  const flagArgs = args.slice(0, separator);
  const command = args.slice(separator + 1);
  if (command.length === 0) throw new Error("breadcrumb run requires a command");

  const base = inputFromFlags(flagArgs);
  const startedAt = nowIso();
  const runId = base.runId || randomUUID();
  emitBestEffort({
    ...base,
    id: `${runId}:start`,
    at: startedAt,
    runId,
    kind: `${base.kind || "process"}.start`,
    result: "start",
    summary: base.summary || `${base.subject || command[0]} started`,
    evidence: { executable: path.basename(command[0]), argumentCount: command.length - 1 }
  });

  const child = spawn(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BREADCRUMB_PARENT_RUN_ID: runId,
      BREADCRUMB_PARENT_SUBJECT: base.subject || "",
      BREADCRUMB_PARENT_COMPONENT: base.component || "",
      BREADCRUMB_PARENT_KIND: base.kind || ""
    },
    stdio: "inherit"
  });
  let spawnError: Error | null = null;
  child.on("error", (error) => {
    spawnError = error;
  });

  const forward = (signal: NodeJS.Signals): void => {
    emitBestEffort({
      ...base,
      at: nowIso(),
      runId,
      kind: `${base.kind || "process"}.signal`,
      result: "interrupted",
      summary: `${base.subject || command[0]} received ${signal}`,
      evidence: { executable: path.basename(command[0]), signal }
    });
    child.kill(signal);
  };

  process.once("SIGTERM", () => forward("SIGTERM"));
  process.once("SIGINT", () => forward("SIGINT"));

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("error", () => resolve({ code: 127, signal: null }));
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  const ok = result.code === 0 && result.signal == null;
  emitBestEffort({
    ...base,
    at: nowIso(),
    runId,
    parentId: runId,
    kind: `${base.kind || "process"}.exit`,
    result: ok ? "ok" : "attention",
    summary: spawnError
      ? `${base.subject || path.basename(command[0])} failed to start`
      : `${base.subject || path.basename(command[0])} exited ${result.signal || result.code}`,
    evidence: { executable: path.basename(command[0]), exitCode: result.code, signal: result.signal, startedAt, spawnFailed: spawnError != null }
  });
  if (result.signal) process.kill(process.pid, result.signal);
  process.exit(result.code ?? 1);
}

function commandTail(args: string[]): void {
  const limit = Math.max(1, Math.min(Number(flagValue(args, "--limit") || 40), 10_000));
  const scope = flagValue(args, "--scope");
  const component = flagValue(args, "--component");
  const from = flagValue(args, "--from");
  const until = flagValue(args, "--until");
  const json = hasFlag(args, "--json");
  const db = openDb();
  try {
    const clauses: string[] = [];
    const values: string[] = [];
    if (scope) {
      clauses.push("scope = ?");
      values.push(scope);
    }
    if (component) {
      clauses.push("component = ?");
      values.push(component);
    }
    if (from) {
      clauses.push("occurred_at >= ?");
      values.push(from);
    }
    if (until) {
      clauses.push("occurred_at < ?");
      values.push(until);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = db.prepare(`
      SELECT id, occurred_at AS at, scope, component, kind, subject, result, summary,
        run_id AS runId, parent_id AS parentId, source, evidence_json AS evidenceJson,
        metadata_json AS metadataJson, created_at AS createdAt
      FROM breadcrumbs
      ${where}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `).all(...values, limit).map(rowFromSql);
    if (json) {
      console.log(JSON.stringify({ ok: true, breadcrumbs: rows }, null, 2));
      return;
    }
    for (const row of rows) {
      console.log(`${row.at}\t${row.scope}\t${row.component}\t${row.kind}\t${row.result}\t${row.summary}`);
    }
  } finally {
    db.close();
  }
}

function commandHealth(): void {
  const db = openDb();
  try {
    const total = db.prepare("SELECT COUNT(*) AS count FROM breadcrumbs").get() as { count: number | bigint };
    const latest = db.prepare("SELECT occurred_at AS at FROM breadcrumbs ORDER BY occurred_at DESC LIMIT 1").get() as { at?: string } | undefined;
    console.log(JSON.stringify({
      ok: true,
      tool: "breadcrumbs",
      component: "observability",
      ledgerPath: LEDGER_PATH,
      count: Number(total.count),
      latestAt: latest?.at ?? null
    }, null, 2));
  } finally {
    db.close();
  }
}

function rowFromSql(row: unknown): Breadcrumb {
  if (!isRecord(row)) throw new Error("breadcrumb row must be object");
  return {
    id: String(row.id),
    at: String(row.at),
    scope: String(row.scope),
    component: String(row.component),
    kind: String(row.kind),
    subject: row.subject == null ? null : String(row.subject),
    result: String(row.result),
    summary: String(row.summary),
    runId: row.runId == null ? null : String(row.runId),
    parentId: row.parentId == null ? null : String(row.parentId),
    source: String(row.source),
    evidence: JSON.parse(String(row.evidenceJson || "null")) as JsonValue,
    metadata: parseJsonObject(String(row.metadataJson || "{}")),
    createdAt: String(row.createdAt)
  };
}

function parseJsonObject(text: string): JsonObject {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed)) return {};
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(parsed)) out[cleanText(key, 80)] = sanitizeJson(value);
  return out;
}

function compactMetadata(input: Record<string, unknown>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value == null || value === "") continue;
    output[key] = sanitizeJson(value);
  }
  return output;
}

function sanitizeJson(value: unknown): JsonValue {
  if (value == null) return null;
  if (typeof value === "string") return cleanText(value, 700);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(sanitizeJson);
  if (isRecord(value)) {
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(value).slice(0, 50)) {
      out[cleanText(key, 80)] = isSensitiveKey(key) ? "[redacted]" : sanitizeJson(child);
    }
    return out;
  }
  return cleanText(value, 700);
}

function sanitizeJsonObject(value: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    out[cleanText(key, 80)] = isSensitiveKey(key) ? "[redacted]" : sanitizeJson(child);
  }
  return out;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage());
    return;
  }
  if (command === "emit") return commandEmit(args);
  if (command === "hook") return commandHook(args);
  if (command === "run") return commandRun(args);
  if (command === "tail") return commandTail(args);
  if (command === "health") return commandHealth();
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    tool: "breadcrumb",
    component: "observability",
    detail: error instanceof Error ? error.message : String(error)
  }, null, 2));
  process.exit(1);
});
