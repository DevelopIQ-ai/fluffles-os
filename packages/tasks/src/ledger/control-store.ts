import { deploymentLifecycleInDb } from "./deployment-lifecycle";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { LedgerDb } from "./db";
import { ActiveSubagentRunRow, DeploymentLifecycleRow, channelSnapshotRowFromSql, deploymentLifecycleStates, oldestQueuedRowFromSql, requireNonEmptyText, requireRuntimeRecord, requiredEnumField, requiredStringField, runtimeRecordArray, snapshotRowFromSql } from "./rows";
import { ActiveSubagentRun, ControlLedger, DeploymentLifecycle, DeploymentLifecycleState, TaskChannel, TaskConversationStatus, TaskLedgerSnapshot } from "./types";

let currentProcessStartIdentity: string | null | undefined;
const defaultSubagentLeaseMs = 2 * 60 * 1000;

export interface ControlStoreOptions {
  subagentLeaseMs?: number;
  subagentProcessStartedAt?: (pid: number) => string | null;
  subagentProcessExists?: (pid: number) => boolean;
  isLegacySubagentProcessAlive?: (name: string) => boolean;
}

/**
 * Operational control plane: ledger snapshots, the deployment lifecycle
 * admission gate, and subagent run leases.
 */
export class ControlStore implements ControlLedger {
  private readonly subagentLeaseMs: number;
  private readonly subagentProcessStartedAt: (pid: number) => string | null;
  private readonly subagentProcessExists: (pid: number) => boolean;
  private readonly isLegacySubagentProcessAlive: (name: string) => boolean;

  constructor(private readonly db: LedgerDb, options: ControlStoreOptions = {}) {
    this.subagentLeaseMs = options.subagentLeaseMs ?? defaultSubagentLeaseMs;
    if (!Number.isInteger(this.subagentLeaseMs) || this.subagentLeaseMs < 1) throw new Error("subagentLeaseMs must be a positive integer");
    this.subagentProcessStartedAt = options.subagentProcessStartedAt ?? processStartedAt;
    this.subagentProcessExists = options.subagentProcessExists ?? processExists;
    this.isLegacySubagentProcessAlive = options.isLegacySubagentProcessAlive ?? legacySubagentProcessIsAlive;
  }


  async snapshot(channel?: TaskChannel): Promise<TaskLedgerSnapshot> {
    const db = this.db.ensureDb();
    const rowValues = channel
      ? db.prepare(`
        SELECT status, COUNT(*) AS count
        FROM conversations
        WHERE channel = ?
        GROUP BY status
      `).all(channel)
      : db.prepare(`
        SELECT status, COUNT(*) AS count
        FROM conversations
        GROUP BY status
      `).all();
    const rows = runtimeRecordArray(rowValues, "snapshot rows").map((row) => snapshotRowFromSql(row, "snapshot row"));
    const channelRowValues = channel
      ? db.prepare(`
        SELECT channel, COUNT(*) AS count
        FROM conversations
        WHERE channel = ?
        GROUP BY channel
      `).all(channel)
      : db.prepare(`
        SELECT channel, COUNT(*) AS count
        FROM conversations
        GROUP BY channel
      `).all();
    const channelRows = runtimeRecordArray(channelRowValues, "channel snapshot rows").map((row) => channelSnapshotRowFromSql(row, "channel snapshot row"));
    const counts: Record<TaskConversationStatus, number> = { queued: 0, running: 0, done: 0, failed: 0, stopped: 0 };
    for (const row of rows) counts[row.status] = row.count;
    const byChannel: Partial<Record<TaskChannel, number>> = {};
    for (const row of channelRows) byChannel[row.channel] = row.count;
    const oldestValue = channel
      ? db.prepare(`
        SELECT MIN(updated_at) AS oldestQueuedAt
        FROM conversations
        WHERE status = 'queued' AND channel = ?
      `).get(channel)
      : db.prepare(`
        SELECT MIN(updated_at) AS oldestQueuedAt
        FROM conversations
        WHERE status = 'queued'
      `).get();
    const oldest = oldestQueuedRowFromSql(oldestValue, "oldest queued row");
    return {
      total: counts.queued + counts.running + counts.done + counts.failed + counts.stopped,
      queued: counts.queued,
      running: counts.running,
      done: counts.done,
      failed: counts.failed,
      stopped: counts.stopped,
      byChannel,
      oldestQueuedAt: oldest?.oldestQueuedAt ?? null
    };
  }

  async deploymentLifecycle(): Promise<DeploymentLifecycle> {
    return deploymentLifecycleInDb(this.db.ensureDb());
  }

  async setDeploymentLifecycle(state: DeploymentLifecycleState): Promise<DeploymentLifecycle> {
    if (!deploymentLifecycleStates.includes(state)) throw new Error(`Unsupported deployment lifecycle state: ${state}`);
    return this.db.mutate<DeploymentLifecycle>((db) => {
      const updatedAt = this.db.isoNow();
      db.prepare("UPDATE deployment_lifecycle SET state = ?, updated_at = ? WHERE id = 1").run(state, updatedAt);
      return deploymentLifecycleInDb(db);
    });
  }

  async startSubagentRun(id: string, name: string, ownerPid = process.pid, ownerStartedAt?: string): Promise<ActiveSubagentRun | null> {
    return this.db.mutate<ActiveSubagentRun | null>((db) => {
      if (deploymentLifecycleInDb(db).state !== "normal") return null;
      const startedAt = this.db.isoNow();
      const leaseExpiresAt = new Date(this.db.nowDate().getTime() + this.subagentLeaseMs).toISOString();
      if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) throw new Error("subagent owner pid must be a positive integer");
      const resolvedOwnerStartedAt = ownerStartedAt ?? this.subagentProcessStartedAt(ownerPid);
      if (!resolvedOwnerStartedAt) throw new Error("subagent owner process identity is required");
      db.prepare("INSERT INTO subagent_runs (id, name, started_at, finished_at, lease_expires_at, owner_pid, owner_started_at) VALUES (?, ?, ?, NULL, ?, ?, ?)").run(id, requireNonEmptyText(name, "subagent name"), startedAt, leaseExpiresAt, ownerPid, resolvedOwnerStartedAt);
      return { id: requireNonEmptyText(id, "subagent run id"), name, startedAt, leaseExpiresAt };
    });
  }

  async heartbeatSubagentRun(id: string): Promise<boolean> {
    return this.db.mutate<boolean>((db) => {
      const leaseExpiresAt = new Date(this.db.nowDate().getTime() + this.subagentLeaseMs).toISOString();
      const result = db.prepare("UPDATE subagent_runs SET lease_expires_at = ? WHERE id = ? AND finished_at IS NULL").run(leaseExpiresAt, requireNonEmptyText(id, "subagent run id"));
      return result.changes > 0;
    });
  }

  async finishSubagentRun(id: string): Promise<void> {
    await this.db.mutate<void>((db) => {
      db.prepare("UPDATE subagent_runs SET finished_at = ? WHERE id = ? AND finished_at IS NULL").run(this.db.isoNow(), requireNonEmptyText(id, "subagent run id"));
    });
  }

  async activeSubagentRuns(): Promise<ActiveSubagentRun[]> {
    return this.db.mutate<ActiveSubagentRun[]>((db) => {
      this.reconcileExpiredSubagentRunsInDb(db);
      const rows = runtimeRecordArray(db.prepare(`
        SELECT id, name, started_at AS startedAt, lease_expires_at AS leaseExpiresAt FROM subagent_runs
        WHERE finished_at IS NULL ORDER BY started_at ASC, id ASC
      `).all(), "active subagent run rows");
      return rows.map((raw) => {
        const row: ActiveSubagentRunRow = {
          id: requiredStringField(raw, "id", "active subagent run row"),
          name: requiredStringField(raw, "name", "active subagent run row"),
          startedAt: requiredStringField(raw, "startedAt", "active subagent run row"),
          leaseExpiresAt: requiredStringField(raw, "leaseExpiresAt", "active subagent run row")
        };
        return { ...row };
      });
    });
  }


  private reconcileExpiredSubagentRunsInDb(db: DatabaseSync): void {
    const now = this.db.isoNow();
    const expired = runtimeRecordArray(db.prepare(`
      SELECT id, name, owner_pid AS ownerPid, owner_started_at AS ownerStartedAt FROM subagent_runs
      WHERE finished_at IS NULL AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).all(now), "expired subagent run rows");
    for (const row of expired) {
      const ownerPid = row.ownerPid;
      const ownerStartedAt = row.ownerStartedAt;
      if (typeof ownerPid === "number" && Number.isSafeInteger(ownerPid) && ownerPid > 0 && typeof ownerStartedAt === "string" && ownerStartedAt) {
        const observedOwnerStartedAt = this.subagentProcessStartedAt(ownerPid);
        if (observedOwnerStartedAt === ownerStartedAt || (observedOwnerStartedAt == null && this.subagentProcessExists(ownerPid))) continue;
      } else if (this.isLegacySubagentProcessAlive(requiredStringField(row, "name", "expired subagent run row"))) {
        continue;
      }
      db.prepare("UPDATE subagent_runs SET finished_at = ? WHERE id = ? AND finished_at IS NULL").run(now, requiredStringField(row, "id", "expired subagent run row"));
    }
  }
}

function processStartedAt(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) {
    if (currentProcessStartIdentity === undefined) currentProcessStartIdentity = readProcessStartedAt(pid);
    return currentProcessStartIdentity;
  }
  return readProcessStartedAt(pid);
}


function readProcessStartedAt(pid: number): string | null {
  try {
    const value = process.platform === "win32"
      ? execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
      : execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trimEnd();
    return value || null;
  } catch {
    return null;
  }
}


function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}


function legacySubagentProcessIsAlive(name: string): boolean {
  const runner = `${process.env.HOME ?? os.homedir()}/subagents/bin/run-subagent`;
  const pattern = new RegExp(`${escapeRegExp(runner)}\\s+${escapeRegExp(name)}(?:\\s|$)`);
  try {
    return execFileSync("/bin/ps", ["-axo", "command="], { encoding: "utf8" })
      .split("\n")
      .some((command) => pattern.test(command));
  } catch {
    return true;
  }
}


function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
