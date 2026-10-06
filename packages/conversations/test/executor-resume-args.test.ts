import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexProcessRunner, type ExecutorSessions } from "../src";

const CAPTURE_SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.ARGV_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "thread.started", thread_id: "session-1" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } }) + "\\n");
});
`;

// Exactly what `codex exec --json` prints: the model's message arrives as an
// item.completed carrying an agent_message item, never as a top-level
// agent_message event.
const REAL_CODEX_SCRIPT = `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  for (const event of [
    { type: "thread.started", thread_id: "session-9" },
    { type: "item.completed", item: { id: "item_0", type: "error", message: "ignored" } },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_1", type: "agent_message", text: JSON.stringify({ should_reply: true, reason: "asked", subject: "re: hi", body: "hello" }) } },
    { type: "turn.completed", usage: {} }
  ]) process.stdout.write(JSON.stringify(event) + "\\n");
});
`;

function sessions(priorSessionId: string | null): ExecutorSessions {
  return {
    getSession: async () => priorSessionId,
    saveSession: async () => undefined
  };
}

async function capturedArgs(priorSessionId: string | null): Promise<string[]> {
  const dir = mkdtempSync(path.join(tmpdir(), "executor-args-"));
  const scriptPath = path.join(dir, "fake-codex.js");
  const capturePath = path.join(dir, "argv.json");
  writeFileSync(scriptPath, CAPTURE_SCRIPT);
  chmodSync(scriptPath, 0o755);
  await new CodexProcessRunner().runConversation({
    channel: "email",
    conversationKey: "email:fluffles@puffle.ai:m1",
    request: {
      command: scriptPath,
      args: [
        "exec",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "--model",
        "gpt-5.5",
        "--output-schema",
        "/schema.json",
        "-"
      ],
      cwd: dir,
      env: { ...process.env, ARGV_CAPTURE: capturePath },
      input: "hello",
      timeoutMs: 30_000
    }
  }, sessions(priorSessionId));
  return JSON.parse(readFileSync(capturePath, "utf8")) as string[];
}

// `codex exec resume` rejects `--sandbox`, so a resumed turn used to exit 2 and
// every follow-up message and every reminder failed on the machine.
test("a resumed turn expresses the sandbox as a config override codex exec resume accepts", async () => {
  const args = await capturedArgs("session-1");
  assert.equal(args.includes("--sandbox"), false);
  assert.equal(args.includes("-s"), false);
  assert.ok(args.includes(`sandbox_mode=${JSON.stringify("workspace-write")}`));
  assert.equal(args[0], "exec");
  assert.equal(args[1], "resume");
  assert.equal(args[args.length - 1], "-");
  assert.equal(args[args.length - 2], "session-1");
});

// Without this the output fell back to the whole JSONL stream, so the email
// channel parsed a transport event instead of the reply and skipped every send.
test("the model's reply is read out of the item.completed event codex actually emits", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "executor-output-"));
  const scriptPath = path.join(dir, "fake-codex.js");
  writeFileSync(scriptPath, REAL_CODEX_SCRIPT);
  chmodSync(scriptPath, 0o755);
  const result = await new CodexProcessRunner().runConversation({
    channel: "email",
    conversationKey: "email:fluffles@puffle.ai:m2",
    request: {
      command: scriptPath,
      args: ["exec", "--skip-git-repo-check", "--sandbox", "workspace-write", "-"],
      cwd: dir,
      env: { ...process.env },
      input: "hello",
      timeoutMs: 30_000
    }
  }, sessions(null));
  assert.deepEqual(JSON.parse(result.output), { should_reply: true, reason: "asked", subject: "re: hi", body: "hello" });
  assert.equal(result.codexSessionId, "session-9");
});

test("a first turn keeps the sandbox flag codex exec accepts", async () => {
  const args = await capturedArgs(null);
  assert.equal(args.includes("resume"), false);
  assert.deepEqual(args.slice(args.indexOf("--sandbox"), args.indexOf("--sandbox") + 2), ["--sandbox", "workspace-write"]);
});
