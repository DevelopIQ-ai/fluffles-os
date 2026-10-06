import {
  checkToolHealth,
  type HealthCommandRunner,
  ToolHealthStore,
  type ToolHealthCheckResult,
  type ToolHealthState,
  type PendingToolHealthReconciliation
} from "./health";
import { randomUUID } from "node:crypto";
import { reconcileToolRepairTask } from "./repair-task-client";
import type { ToolDefinition } from "./registry";

/** Persistent dependencies for a registry-owned tool health check. */
export interface ToolHealthServiceOptions {
  statePath: string;
  taskLedgerPath?: string;
  leaseWaitMs?: number;
  runner?: HealthCommandRunner;
}

/** Runs one health check, reconciles its repair task, and persists the resulting state. */
export async function checkAndPersistToolHealth(
  tool: ToolDefinition,
  options: ToolHealthServiceOptions
): Promise<ToolHealthCheckResult> {
  const store = new ToolHealthStore(options.statePath);
  const ownerToken = randomUUID();
  try {
    await acquireLease(store, tool.name, ownerToken, options.leaseWaitMs);
    await reconcileExistingPending(store, tool.name, options);
    const checked = await checkToolHealth(tool, options.runner);
    return persistHeldResult(store, checked, options);
  } finally {
    store.releaseLease(tool.name, ownerToken);
    store.close();
  }
}

/** Persists a previously computed health result through the same repair-task lifecycle. */
export async function persistToolHealthResult(
  result: ToolHealthCheckResult,
  options: ToolHealthServiceOptions
): Promise<ToolHealthCheckResult> {
  const store = new ToolHealthStore(options.statePath);
  const ownerToken = randomUUID();
  try {
    await acquireLease(store, result.tool, ownerToken, options.leaseWaitMs);
    await reconcileExistingPending(store, result.tool, options);
    return persistHeldResult(store, result, options);
  } finally {
    store.releaseLease(result.tool, ownerToken);
    store.close();
  }
}

function isOlderResult(result: ToolHealthCheckResult, current: ToolHealthState | null): current is ToolHealthState {
  if (!current?.lastCheckedAt || !result.lastCheckedAt) return false;
  return result.lastCheckedAt <= current.lastCheckedAt;
}

async function reconcileExistingPending(
  store: ToolHealthStore,
  tool: string,
  options: ToolHealthServiceOptions
): Promise<void> {
  const pending = store.pendingReconciliation(tool);
  if (pending) await reconcilePending(store, pending, options);
}

async function persistHeldResult(
  store: ToolHealthStore,
  result: ToolHealthCheckResult,
  options: ToolHealthServiceOptions
): Promise<ToolHealthCheckResult> {
  const current = store.get(result.tool);
  if (isOlderResult(result, current)) {
    return { ...current, detail: current.lastError || "newer tool health state already persisted" };
  }
  store.stageReconciliation(result);
  return reconcilePending(store, result, options);
}

async function reconcilePending(
  store: ToolHealthStore,
  pending: PendingToolHealthReconciliation,
  options: ToolHealthServiceOptions
): Promise<ToolHealthCheckResult> {
  const repairTaskId = await reconcileToolRepairTask({
    tool: pending.tool,
    status: pending.status,
    detail: pending.detail,
    ...(options.taskLedgerPath ? { taskLedgerPath: options.taskLedgerPath } : {})
  });
  const persisted: ToolHealthCheckResult = { ...pending, repairTaskId };
  return { ...store.finishReconciliation(persisted), detail: persisted.detail };
}

async function acquireLease(
  store: ToolHealthStore,
  tool: string,
  ownerToken: string,
  waitMs = 10_000
): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const nowMs = Date.now();
    if (store.tryAcquireLease(
      tool,
      ownerToken,
      new Date(nowMs).toISOString(),
      new Date(nowMs + 60_000).toISOString()
    )) return;
    if (nowMs >= deadline) throw new Error(`timed out waiting for tool health lease ${tool}`);
    await delay(25);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
