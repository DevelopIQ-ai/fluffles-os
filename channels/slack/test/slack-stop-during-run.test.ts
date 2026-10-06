import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexProcessRunner, ConversationEngine, ConversationRuntime, SQLiteTaskLedger } from "@fluffles/tasks";

const key = "slack:T1:C1:1000.0001";

test("Slack stop terminates the active Codex child without delivering a stale reply", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "slack-stop-run-test-"));
  const ledger = new SQLiteTaskLedger({ filePath: path.join(dir, "tasks.sqlite") });
  try {
    const engine = new ConversationEngine({ ledger });
    const runtime = new ConversationRuntime(engine);
    const runner = new CodexProcessRunner();
    await engine.ingest({
      channel: "slack",
      conversationKey: key,
      externalMessageId: "message-1",
      authorId: "U1",
      text: "start a slow response",
      intakeMode: "direct"
    });
    const started = await runtime.startRun("slack", key);
    assert.ok(started);
    await engine.ingest({
      channel: "slack",
      conversationKey: key,
      externalMessageId: "message-2",
      authorId: "U1",
      text: "steer this response while it is running",
      intakeMode: "direct"
    });

    const readyPath = path.join(dir, "ready");
    const scriptPath = path.join(dir, "slow-codex.cjs");
    await writeFile(scriptPath, [
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.env.READY_CAPTURE, 'ready');",
      "setInterval(() => {}, 50);",
      ""
    ].join("\n"));

    let deliveredReplies = 0;
    const result = runner.run({
      command: process.execPath,
      args: [scriptPath],
      cwd: dir,
      env: { ...process.env, READY_CAPTURE: readyPath },
      timeoutMs: 10_000,
      runKey: started.run.id
    }).then(() => {
      deliveredReplies += 1;
    });

    await waitForFile(readyPath);
    await runtime.stop("slack", key, "user_stop");
    await runtime.stop("slack", key, "user_stop");
    assert.equal(runner.cancel(started.run.id), true);
    assert.equal(runner.cancel(started.run.id), false);
    await assert.rejects(result, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, "RUN_STOPPED");
      return true;
    });

    assert.equal(deliveredReplies, 0);
    assert.equal(runner.activeCount, 0);

    const conversation = await engine.getConversation("slack", key);
    assert.equal(conversation?.status, "stopped");
    assert.equal(conversation?.runs[0]?.status, "stopped");
    assert.deepEqual(conversation?.messages.map((message) => [message.text, message.runId]), [
      ["start a slow response", started.run.id],
      ["steer this response while it is running", null]
    ]);
    const recovery = await runtime.recover("slack");
    assert.deepEqual(recovery.recoveredKeys, []);
  } finally {
    ledger.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(filePath, "utf8");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}
