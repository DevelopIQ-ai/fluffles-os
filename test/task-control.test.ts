import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SQLiteTaskLedger } from "../packages/tasks/src/task-ledger";

const root = path.resolve(__dirname, "..");
const taskControl = path.join(root, "packages", "tasks", "src", "task-control.ts");

test("task-control wait-idle reconciles an orphaned subagent instead of timing out", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-control-orphaned-"));
  const filePath = path.join(dir, "tasks.sqlite");
  const ledger = new SQLiteTaskLedger({
    filePath,
    now: () => new Date(Date.UTC(2026, 0, 1)),
    subagentLeaseMs: 1000
  });
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const workerPid = worker.pid;
  assert.ok(workerPid);

  try {
    assert.ok(await ledger.startSubagentRun("hard-killed-subagent", "example-agent", workerPid));
    worker.kill("SIGKILL");
    await new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  } finally {
    ledger.close();
  }

  try {
    const output = childProcess.execFileSync(process.execPath, ["--import", "tsx", taskControl, "wait-idle", "--timeout-ms", "50", "--interval-ms", "50"], {
      cwd: root,
      env: { ...process.env, TASK_LEDGER_PATH: filePath },
      encoding: "utf8"
    });
    const result = JSON.parse(output) as { ok: boolean; activeSubagentRuns: number };
    assert.equal(result.ok, true);
    assert.equal(result.activeSubagentRuns, 0);
  } finally {
    if (!worker.killed) worker.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
