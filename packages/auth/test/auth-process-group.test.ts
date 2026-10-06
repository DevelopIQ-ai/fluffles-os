import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const helper = path.join(root, "bin", "auth-process-group");
const runChild = path.join(root, "bin", "auth-run-child");

test("process-group cleanup terminates TERM-resistant descendants within a fixed bound", async (t) => {
  const child = spawn(runChild, [
    "/bin/sh",
    "-c",
    "trap '' TERM; /bin/sh -c \"trap '' TERM; while :; do sleep 1; done\" & wait"
  ]);
  await once(child, "spawn");
  t.after(() => {
    try { process.kill(-child.pid!, "SIGKILL"); } catch {}
  });

  const startedAt = Date.now();
  const draining = execFileAsync(helper, ["drain", String(child.pid), "100", "2000"]);
  await once(child, "exit");
  await draining;
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 75, `TERM grace period was skipped: ${elapsed}ms`);
  assert.ok(elapsed < 2500, `cleanup exceeded its absolute bound: ${elapsed}ms`);
  assert.throws(() => process.kill(-child.pid!, 0), { code: "ESRCH" });
});

test("process-group cleanup rejects unsafe and malformed targets", async () => {
  await assert.rejects(execFileAsync(helper, ["drain", "0"]), (error: NodeJS.ErrnoException) => error.code === 64);
  const { stdout } = await execFileAsync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)]);
  const ownProcessGroup = stdout.trim();
  assert.match(ownProcessGroup, /^[1-9][0-9]*$/);
  await assert.rejects(
    execFileAsync(helper, ["drain", ownProcessGroup]),
    (error: NodeJS.ErrnoException) => error.code === 64
  );
  assert.equal((fs.statSync(helper).mode & 0o111) !== 0, true);
});

