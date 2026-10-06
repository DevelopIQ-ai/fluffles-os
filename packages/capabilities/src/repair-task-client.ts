import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ToolStatus } from "./registry";

const execFileAsync = promisify(execFile);
const runtimeTaskControlPath = path.join(process.env.HOME ?? os.homedir(), "packages", "tasks", "src", "task-control.ts");
const sourceRoot = path.resolve(__dirname, "..", "..", "..");
const sourceTaskControlPath = path.join(sourceRoot, "packages", "tasks", "src", "task-control.ts");

// The task ledger keys repair tasks by its tool_id column; the key passed
// here is the manifest name.
export interface ReconcileToolRepairInput {
  tool: string;
  status: ToolStatus;
  detail: string;
  taskLedgerPath?: string;
}

export async function reconcileToolRepairTask(input: ReconcileToolRepairInput): Promise<string | null> {
  if (input.status === "healthy" || input.status === "disabled") {
    await taskControl("repair-complete", [
      "--tool", input.tool,
      "--result", input.status === "healthy" ? "registry health check passed" : "tool disabled"
    ], input.taskLedgerPath);
    return null;
  }
  const result = await taskControl("repair-upsert", [
    "--tool", input.tool,
    "--objective", `repair tool ${input.tool}`,
    "--progress", input.detail.slice(0, 1000),
    "--next-action", "repair the tool and request a registry health check"
  ], input.taskLedgerPath);
  const task = result.task;
  if (typeof task !== "object" || task === null || typeof (task as { id?: unknown }).id !== "string") {
    throw new Error("task-control repair-upsert returned no repair task id");
  }
  return (task as { id: string }).id;
}

async function taskControl(command: string, args: string[], taskLedgerPath?: string): Promise<Record<string, unknown>> {
  const taskControlPath = process.env.FLUFFLES_TASK_CONTROL_PATH
    || (taskLedgerPath ? sourceTaskControlPath : fs.existsSync(runtimeTaskControlPath) ? runtimeTaskControlPath : sourceTaskControlPath);
  const result = await execFileAsync(process.execPath, ["--import", "tsx", taskControlPath, command, ...args], {
    env: {
      ...process.env,
      ...(taskLedgerPath ? { FLUFFLES_TASK_LEDGER_PATH: taskLedgerPath } : {})
    },
    maxBuffer: 1024 * 1024,
    timeout: taskControlTimeoutMs()
  });
  const parsed = JSON.parse(result.stdout.trim()) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("task-control returned invalid JSON");
  if ((parsed as { ok?: unknown }).ok !== true) throw new Error("task-control repair operation failed");
  return parsed as Record<string, unknown>;
}

/** Bounded so a stalled task ledger cannot consume an entire five-minute health pass. */
function taskControlTimeoutMs(): number {
  const requested = Number(process.env.CAPABILITIES_REPAIR_TASK_TIMEOUT_MS || 8_000);
  return Number.isFinite(requested) ? Math.max(1_000, Math.min(20_000, Math.floor(requested))) : 8_000;
}
