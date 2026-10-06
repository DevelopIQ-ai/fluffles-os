import { execFile } from "node:child_process";
import fs from "node:fs";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { toolDefinitionFingerprint, type ToolDefinition, type ToolStatus } from "./registry";

const execFileAsync = promisify(execFile);

export interface ToolHealthState {
  tool: string;
  status: ToolStatus;
  lastCheckedAt: string | null;
  lastError: string | null;
  repairTaskId: string | null;
  /** Fingerprint of the tool definition this health result was checked against. */
  definitionFingerprint?: string | null;
}

export interface ToolHealthCheckResult extends ToolHealthState {
  detail: string;
}

export interface PendingToolHealthReconciliation extends ToolHealthCheckResult {}

export interface HealthCommandResult {
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export type HealthCommandRunner = (health: string[], tool: ToolDefinition) => Promise<HealthCommandResult>;

// Derived runtime state keyed by manifest name; delete the file and the next
// health pass rebuilds it.
export class ToolHealthStore {
  private db: DatabaseSync | null = null;

  constructor(private readonly filePath: string) {}

  get(tool: string): ToolHealthState | null {
    const row = this.database().prepare(`
      SELECT tool_id AS tool, status, last_checked_at AS lastCheckedAt,
        last_error AS lastError, repair_task_id AS repairTaskId,
        definition_fingerprint AS definitionFingerprint
      FROM tool_health WHERE tool_id = ?
    `).get(tool) as Record<string, unknown> | undefined;
    return row ? healthStateFromRow(row) : null;
  }

  set(state: ToolHealthState): ToolHealthState {
    const db = this.database();
    this.setInDb(db, state);
    return this.get(state.tool) || state;
  }

  pendingReconciliation(tool: string): PendingToolHealthReconciliation | null {
    const row = this.database().prepare(`
      SELECT tool_id AS tool, desired_status AS status,
        last_checked_at AS lastCheckedAt, last_error AS lastError,
        detail
      FROM tool_health_reconciliations
      WHERE tool_id = ?
    `).get(tool) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      ...healthStateFromRow({ ...row, repairTaskId: null }),
      detail: requiredText(row.detail, "tool health reconciliation detail")
    };
  }

  stageReconciliation(result: ToolHealthCheckResult): void {
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (result.status === "for_repair") {
        const current = this.get(result.tool);
        this.setInDb(db, {
          ...result,
          repairTaskId: current?.repairTaskId || result.repairTaskId
        });
      }
      db.prepare(`
        INSERT INTO tool_health_reconciliations (
          tool_id, desired_status, last_checked_at, last_error, detail
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tool_id) DO UPDATE SET
          desired_status = excluded.desired_status,
          last_checked_at = excluded.last_checked_at,
          last_error = excluded.last_error,
          detail = excluded.detail
        WHERE tool_health_reconciliations.last_checked_at IS NULL
          OR excluded.last_checked_at IS NULL
          OR excluded.last_checked_at > tool_health_reconciliations.last_checked_at
      `).run(result.tool, result.status, result.lastCheckedAt, result.lastError, result.detail);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  finishReconciliation(result: ToolHealthCheckResult): ToolHealthState {
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      this.setInDb(db, result);
      db.prepare("DELETE FROM tool_health_reconciliations WHERE tool_id = ?").run(result.tool);
      db.exec("COMMIT");
      return this.get(result.tool) || result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  tryAcquireLease(tool: string, ownerToken: string, now: string, expiresAt: string): boolean {
    const result = this.database().prepare(`
      INSERT INTO tool_health_leases (tool_id, owner_token, expires_at)
      VALUES (?, ?, ?)
      ON CONFLICT(tool_id) DO UPDATE SET
        owner_token = excluded.owner_token,
        expires_at = excluded.expires_at
      WHERE tool_health_leases.expires_at <= ?
        OR tool_health_leases.owner_token = excluded.owner_token
    `).run(tool, ownerToken, expiresAt, now);
    return result.changes > 0;
  }

  releaseLease(tool: string, ownerToken: string): void {
    this.database().prepare(`
      DELETE FROM tool_health_leases
      WHERE tool_id = ? AND owner_token = ?
    `).run(tool, ownerToken);
  }

  private setInDb(db: DatabaseSync, state: ToolHealthState): void {
    db.prepare(`
      INSERT INTO tool_health (tool_id, status, last_checked_at, last_error, repair_task_id, definition_fingerprint)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tool_id) DO UPDATE SET
        status = excluded.status,
        last_checked_at = excluded.last_checked_at,
        last_error = excluded.last_error,
        repair_task_id = excluded.repair_task_id,
        definition_fingerprint = excluded.definition_fingerprint
      WHERE tool_health.last_checked_at IS NULL
        OR excluded.last_checked_at IS NULL
        OR excluded.last_checked_at > tool_health.last_checked_at
        OR (
          excluded.last_checked_at = tool_health.last_checked_at
          AND excluded.status = tool_health.status
          AND tool_health.repair_task_id IS NULL
          AND excluded.repair_task_id IS NOT NULL
        )
    `).run(state.tool, state.status, state.lastCheckedAt, state.lastError, state.repairTaskId, state.definitionFingerprint ?? null);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  private database(): DatabaseSync {
    if (this.db) return this.db;
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const db = new DatabaseSync(this.filePath);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_health (
        tool_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('healthy', 'for_repair', 'disabled')),
        last_checked_at TEXT,
        last_error TEXT,
        repair_task_id TEXT,
        definition_fingerprint TEXT
      );
      CREATE TABLE IF NOT EXISTS tool_health_reconciliations (
        tool_id TEXT PRIMARY KEY,
        desired_status TEXT NOT NULL CHECK (desired_status IN ('healthy', 'for_repair', 'disabled')),
        last_checked_at TEXT,
        last_error TEXT,
        detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_health_leases (
        tool_id TEXT PRIMARY KEY,
        owner_token TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    this.db = db;
    return db;
  }
}

/**
 * Runs the canonical per-tool health probe: the manifest's health command
 * when declared, otherwise a check that the wrapper exists and is
 * executable. Exit 0 means healthy; a JSON payload with ok: false fails the
 * probe even on exit 0.
 */
export async function checkToolHealth(
  tool: ToolDefinition,
  runner: HealthCommandRunner = runHealthCommand,
  checkedAt?: string
): Promise<ToolHealthCheckResult> {
  const observedAt = () => checkedAt || new Date().toISOString();
  try {
    if (tool.health === null) {
      return checkExecutableWrapper(tool, observedAt());
    }
    const command = await runner(tool.health, tool);
    const payload = parseHealthPayload(command.stdout);
    if ((command.exitCode ?? 0) === 0 && payload?.ok !== false) {
      return {
        tool: tool.name,
        status: "healthy",
        lastCheckedAt: observedAt(),
        lastError: null,
        repairTaskId: null,
        definitionFingerprint: toolDefinitionFingerprint(tool),
        detail: textField(payload?.detail) || textField(command.stdout) || "ok"
      };
    }
    return failedHealthResult(tool, observedAt(), textField(payload?.detail) || command.stderr || command.stdout || "health check failed");
  } catch (error) {
    return failedHealthResult(tool, observedAt(), commandErrorDetail(error));
  }
}

function checkExecutableWrapper(tool: ToolDefinition, checkedAt: string): ToolHealthCheckResult {
  try {
    fs.accessSync(tool.command, fs.constants.X_OK);
  } catch (_error) {
    return failedHealthResult(tool, checkedAt, `wrapper is missing or not executable: ${tool.command}`);
  }
  return {
    tool: tool.name,
    status: "healthy",
    lastCheckedAt: checkedAt,
    lastError: null,
    repairTaskId: null,
    definitionFingerprint: toolDefinitionFingerprint(tool),
    detail: `wrapper present: ${tool.command}`
  };
}

async function runHealthCommand(health: string[], _tool: ToolDefinition): Promise<HealthCommandResult> {
  const [command, ...args] = health;
  if (command === undefined) throw new Error("health probe must declare a command");
  try {
    const result = await execFileAsync(command, args, {
      timeout: healthCommandTimeoutMs(),
      maxBuffer: 1024 * 1024,
      env: { ...process.env, STASH_TELEMETRY: "0" }
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), exitCode: 0 };
  } catch (error) {
    if (typeof error !== "object" || error === null) throw error;
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    return {
      stdout: typeof failure.stdout === "string" ? failure.stdout.trim() : "",
      stderr: typeof failure.stderr === "string" && failure.stderr.trim()
        ? failure.stderr.trim()
        : typeof failure.message === "string" ? failure.message.trim() : "health command failed",
      exitCode: typeof failure.code === "number" ? failure.code : 1
    };
  }
}

/** Keeps a full registry pass bounded while allowing a slower local override for diagnosis. */
function healthCommandTimeoutMs(): number {
  const requested = Number(process.env.CAPABILITIES_HEALTH_TIMEOUT_MS || 8_000);
  return Number.isFinite(requested) ? Math.max(1_000, Math.min(20_000, Math.floor(requested))) : 8_000;
}

function parseHealthPayload(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return record(JSON.parse(trimmed));
  } catch (_error) {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return record(JSON.parse(trimmed.slice(start, end + 1)));
    } catch (_innerError) {
      return null;
    }
  }
}

function failedHealthResult(tool: ToolDefinition, checkedAt: string, detail: string): ToolHealthCheckResult {
  return {
    tool: tool.name,
    status: "for_repair",
    lastCheckedAt: checkedAt,
    lastError: detail.slice(0, 1000),
    repairTaskId: null,
    definitionFingerprint: toolDefinitionFingerprint(tool),
    detail: detail.slice(0, 1000)
  };
}

function healthStateFromRow(row: Record<string, unknown>): ToolHealthState {
  const status = row.status;
  if (status !== "healthy" && status !== "for_repair" && status !== "disabled") {
    throw new Error(`invalid stored tool status ${String(status)}`);
  }
  return {
    tool: requiredText(row.tool, "tool health key"),
    status,
    lastCheckedAt: optionalText(row.lastCheckedAt),
    lastError: optionalText(row.lastError),
    repairTaskId: optionalText(row.repairTaskId),
    definitionFingerprint: optionalText(row.definitionFingerprint)
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function requiredText(value: unknown, context: string): string {
  const text = optionalText(value);
  if (!text) throw new Error(`${context} must be a non-empty string`);
  return text;
}

function commandErrorDetail(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const value = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return textField(value.stderr) || textField(value.stdout) || textField(value.message) || "health check failed";
}
