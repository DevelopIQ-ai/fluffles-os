import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadHooks } from "../src/registries";

test("flattens hook manifests into one row per command hook", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "chat-console-hooks-"));
  try {
    await mkdir(path.join(root, "codex"), { recursive: true });
    await writeFile(path.join(root, "codex", "hooks.json"), JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "bash bin/breadcrumb-hook SessionStart", timeout: 1, statusMessage: "record breadcrumb" }] },
          { hooks: [{ type: "command", command: "bash bin/session-time" }, { type: "prompt", prompt: "ignored" }] }
        ],
        Stop: [{ hooks: [{ type: "command", command: "bash bin/breadcrumb-hook Stop", timeout: 2 }] }]
      }
    }));
    await mkdir(path.join(root, "no-manifest"), { recursive: true });

    assert.deepEqual(loadHooks(root), [
      {
        tool: "codex",
        event: "SessionStart",
        command: "bash bin/breadcrumb-hook SessionStart",
        timeoutSeconds: 1,
        statusMessage: "record breadcrumb"
      },
      { tool: "codex", event: "SessionStart", command: "bash bin/session-time", timeoutSeconds: null, statusMessage: null },
      { tool: "codex", event: "Stop", command: "bash bin/breadcrumb-hook Stop", timeoutSeconds: 2, statusMessage: null }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns no hooks when the tree is missing", async () => {
  assert.deepEqual(loadHooks(path.join(os.tmpdir(), "chat-console-hooks-missing")), []);
});
