import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { SQLiteTaskLedger, type CommunicationChannel, type DeploymentLifecycleState, type PersistentTaskStatus, type TaskChannel } from "./task-ledger";

const defaultLedgerPath = process.env.TASK_LEDGER_PATH || process.env.FLUFFLES_TASK_LEDGER_PATH || path.join(process.env.HOME || os.homedir(), "state", "tasks", "tasks.sqlite");
const subagentLeaseMs = positiveIntegerEnv("SUBAGENT_LEASE_MS", 2 * 60 * 1000);
const states: readonly DeploymentLifecycleState[] = ["normal", "draining", "deploying", "restarting"];
const channelTaskTypes: readonly TaskChannel[] = ["slack", "email", "phone", "web"];

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const ledger = new SQLiteTaskLedger({ filePath: defaultLedgerPath, subagentLeaseMs });
  try {
    if (command === "status") {
      write(await status(ledger));
      return;
    }
    if (command === "set") {
      const state = args[0];
      if (!states.includes(state as DeploymentLifecycleState)) throw new Error("Usage: task-control set <normal|draining|deploying|restarting>");
      await ledger.setDeploymentLifecycle(state as DeploymentLifecycleState);
      write(await status(ledger));
      return;
    }
    if (command === "wait-idle") {
      const timeoutMs = numberFlag(args, "--timeout-ms", 15 * 60 * 1000, 1, 24 * 60 * 60 * 1000);
      const intervalMs = numberFlag(args, "--interval-ms", 1000, 50, 60 * 1000);
      const startedAt = Date.now();
      for (;;) {
        const current = await status(ledger);
        if (current.activeChannelRuns === 0 && current.activeSubagentRuns === 0) {
          write({ ok: true, waitedMs: Date.now() - startedAt, ...current });
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          write({ ok: false, reason: "drain_timeout", waitedMs: Date.now() - startedAt, ...current });
          process.exitCode = 1;
          return;
        }
        await delay(intervalMs);
      }
    }
    if (command === "subagent-start") {
      const [id, name, ownerPidValue, ownerStartedAtValue] = args;
      if (!id || !name) throw new Error("Usage: task-control subagent-start <id> <name>");
      const ownerPid = ownerPidValue == null ? process.ppid : positiveInteger(ownerPidValue, "subagent owner pid");
      const ownerStartedAt = ownerStartedAtValue || processStartedAt(ownerPid);
      if (!ownerStartedAt) throw new Error("could not determine subagent owner process identity");
      const run = await ledger.startSubagentRun(id, name, ownerPid, ownerStartedAt);
      write({ ok: run != null, run, ...(await status(ledger)) });
      if (!run) process.exitCode = 75;
      return;
    }
    if (command === "subagent-heartbeat") {
      const [id] = args;
      if (!id) throw new Error("Usage: task-control subagent-heartbeat <id>");
      const renewed = await ledger.heartbeatSubagentRun(id);
      write({ ok: renewed, ...(await status(ledger)) });
      if (!renewed) process.exitCode = 75;
      return;
    }
    if (command === "subagent-finish") {
      const [id] = args;
      if (!id) throw new Error("Usage: task-control subagent-finish <id>");
      await ledger.finishSubagentRun(id);
      write({ ok: true, ...(await status(ledger)) });
      return;
    }
    if (command === "repair-upsert") {
      const toolId = requiredFlag(args, "--tool");
      const objective = requiredFlag(args, "--objective");
      const progress = optionalFlag(args, "--progress");
      const nextAction = optionalFlag(args, "--next-action");
      const task = await ledger.upsertRepairTask({
        toolId,
        objective,
        ...(progress ? { progress } : {}),
        ...(nextAction ? { nextAction } : {})
      });
      write({ ok: true, task });
      return;
    }
    if (command === "repair-complete") {
      const toolId = requiredFlag(args, "--tool");
      const active = await ledger.activeRepairTaskForTool(toolId);
      if (!active) {
        write({ ok: true, task: null });
        return;
      }
      const task = await ledger.completeRepairTask(active.id, requiredFlag(args, "--result"));
      write({ ok: true, task });
      return;
    }
    if (command === "task-create") {
      const createProgress = optionalFlag(args, "--progress");
      const createNextAction = optionalFlag(args, "--next-action");
      const task = await ledger.createConversationTask({
        channel: communicationChannelFlag(args, "--channel"),
        conversationKey: requiredFlag(args, "--conversation-key"),
        objective: requiredFlag(args, "--objective"),
        ...(statusFlag(args, "--status", ["pending", "in_progress"]) ?? {}),
        ...(createProgress != null ? { progress: createProgress } : {}),
        ...(createNextAction != null ? { nextAction: createNextAction } : {})
      });
      write({ ok: true, task });
      return;
    }
    if (command === "task-update") {
      const status = statusFlag(args, "--status", ["pending", "in_progress", "completed", "failed", "cancelled"]);
      const progress = optionalFlag(args, "--progress");
      const nextAction = optionalFlag(args, "--next-action");
      const result = optionalFlag(args, "--result");
      const task = await ledger.updateConversationTask(requiredFlag(args, "--id"), {
        ...(status ?? {}),
        ...(progress != null ? { progress } : {}),
        ...(nextAction != null ? { nextAction } : {}),
        ...(result != null ? { result } : {})
      });
      write({ ok: true, task });
      return;
    }
    if (command === "task-list") {
      const channel = communicationChannelFlag(args, "--channel");
      const conversationKey = requiredFlag(args, "--conversation-key");
      write({
        ok: true,
        tasks: await ledger.conversationTasks(channel, conversationKey),
        unfinished: await ledger.unfinishedConversationTask(channel, conversationKey)
      });
      return;
    }
    if (command === "reminder-create") {
      const channel = communicationChannelFlag(args, "--channel");
      const conversationKey = requiredFlag(args, "--conversation-key");
      const reminder = await ledger.createReminder({
        channel,
        conversationKey,
        companyId: optionalFlag(args, "--company-id") ?? null,
        instruction: requiredFlag(args, "--instruction"),
        scheduledFor: requiredFlag(args, "--scheduled-for"),
        displayTimezone: requiredFlag(args, "--display-timezone")
      });
      write({ ok: true, reminder });
      return;
    }
    if (command === "reminder-list") {
      write({ ok: true, reminders: await ledger.listReminders() });
      return;
    }
    if (command === "reminder-cancel") {
      write({ ok: true, reminder: await ledger.cancelReminder(requiredFlag(args, "--id")) });
      return;
    }
    if (command === "reminder-reschedule") {
      write({ ok: true, reminder: await ledger.rescheduleReminder(
        requiredFlag(args, "--id"),
        requiredFlag(args, "--scheduled-for"),
        optionalFlag(args, "--display-timezone")
      ) });
      return;
    }
    throw new Error("Usage: task-control <status|set|wait-idle|subagent-start|subagent-heartbeat|subagent-finish|repair-upsert|repair-complete|task-create|task-update|task-list|reminder-create|reminder-list|reminder-cancel|reminder-reschedule>");
  } finally {
    ledger.close();
  }
}

async function status(ledger: SQLiteTaskLedger) {
  const snapshots = await Promise.all(channelTaskTypes.map(async (channel) => [channel, await ledger.snapshot(channel)] as const));
  const channels = Object.fromEntries(snapshots);
  const activeChannelRuns = snapshots.reduce((total, [, snapshot]) => total + snapshot.running, 0);
  const activeSubagents = await ledger.activeSubagentRuns();
  return { lifecycle: await ledger.deploymentLifecycle(), activeChannelRuns, activeSubagentRuns: activeSubagents.length, activeSubagents, channels };
}

function numberFlag(args: string[], name: string, fallback: number, min: number, max: number): number {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(args[index + 1]);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

function optionalFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function requiredFlag(args: string[], name: string): string {
  const value = optionalFlag(args, name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function statusFlag<S extends PersistentTaskStatus>(
  args: string[],
  name: string,
  allowed: readonly S[]
): { status: S } | null {
  const value = optionalFlag(args, name);
  if (value == null) return null;
  if (!allowed.includes(value as S)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return { status: value as S };
}

function communicationChannelFlag(args: string[], name: string): CommunicationChannel {
  const value = requiredFlag(args, name);
  if (value === "slack" || value === "email" || value === "phone" || value === "web") return value;
  throw new Error(`${name} must be slack, email, phone, or web`);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  return value == null ? fallback : positiveInteger(value, name);
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function processStartedAt(pid: number): string | null {
  try {
    const value = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trimEnd();
    return value || null;
  } catch {
    return null;
}
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
