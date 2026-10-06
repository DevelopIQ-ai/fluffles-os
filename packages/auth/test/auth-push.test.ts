import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "..");
const authPush = path.join(root, "bin", "auth-push");

type Harness = { workspace: string; run: (args: string[]) => { status: number | null; stderr: string }; calls: () => string };

// A stub Infisical CLI keeps the assertions about what auth-push decides to
// upload, without ever reaching a vault.
function harness(options: { failWrites?: boolean } = {}): Harness {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "auth-push-test-"));
  const calls = path.join(workspace, "calls");
  const cli = path.join(workspace, "infisical");
  fs.writeFileSync(
    cli,
    `#!/bin/sh
if [ "$1" = "login" ]; then echo "stub-access-token"; exit 0; fi
if [ "$1" = "secrets" ] && [ "$2" = "set" ] && [ "$3" = "--file" ]; then
  printf '%s | %s\n' "$*" "$(cat "$4")" >>"${calls}"
else
  echo "$*" >>"${calls}"
fi
exit ${options.failWrites ? 1 : 0}
`,
    { mode: 0o755 }
  );
  const bootstrap = path.join(workspace, "machine-identity.env");
  fs.writeFileSync(
    bootstrap,
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=stub-client\nINFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=stub-secret\n",
    { mode: 0o600 }
  );
  const state = path.join(workspace, "state");
  fs.mkdirSync(state);
  return {
    workspace,
    run: (args) => {
      const result = spawnSync(authPush, args, {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH ?? "",
          FLUFFLES_HOME: workspace,
          NODE: process.execPath,
          TMPDIR: state,
          AUTH_PUSH_BIN_DIR: path.join(root, "bin"),
          AUTH_PUSH_BOOTSTRAP_FILE: bootstrap,
          AUTH_PUSH_INFISICAL_BIN: cli,
          AUTH_PUSH_LOCK_FILE: path.join(workspace, "auth-push.lock"),
          AUTH_PUSH_PROJECT_ID: "stub-project",
          AUTH_PUSH_ENVIRONMENT: "dev"
        }
      });
      return { status: result.status, stderr: result.stderr };
    },
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "")
  };
}

test("a refreshed credential is uploaded to its own path and encoding", () => {
  const harnessed = harness();
  const json = path.join(harnessed.workspace, "auth.json");
  const binary = path.join(harnessed.workspace, "credentials.db");
  fs.writeFileSync(json, '{"tokens":{"refresh_token":"rotated"}}', { mode: 0o600 });
  fs.writeFileSync(binary, Buffer.from("sqlite-bytes"), { mode: 0o600 });

  const result = harnessed.run([
    "/services/codex", "CODEX_AUTH_JSON", json, "plain",
    "/services/gcloud", "GCLOUD_CREDENTIALS_DB_BASE64", binary, "base64"
  ]);
  assert.equal(result.status, 0, result.stderr);
  const calls = harnessed.calls();
  assert.match(calls, /secrets set --file .*set\.env .*--path=\/services\/codex.*\| CODEX_AUTH_JSON=\{"tokens":\{"refresh_token":"rotated"\}\}/);
  const encoded = Buffer.from("sqlite-bytes").toString("base64");
  assert.match(calls, new RegExp(`secrets set --file .*set\\.env .*--path=/services/gcloud.*\\| GCLOUD_CREDENTIALS_DB_BASE64=${encoded}`));
  assert.match(calls, /--projectId=stub-project/);
  assert.match(calls, /--env=dev/);
});

test("a locally corrupted credential is never made canonical", () => {
  const harnessed = harness();
  const json = path.join(harnessed.workspace, "auth.json");
  fs.writeFileSync(json, "not json at all", { mode: 0o600 });

  const result = harnessed.run(["/services/codex", "CODEX_AUTH_JSON", json, "plain"]);
  assert.equal(result.status, 75);
  assert.match(result.stderr, /refused-unparsable-refresh/);
  assert.equal(harnessed.calls(), "");
});

test("a failed upload reports itself and leaves no state behind to unblock", () => {
  const harnessed = harness({ failWrites: true });
  const json = path.join(harnessed.workspace, "auth.json");
  fs.writeFileSync(json, '{"tokens":{"refresh_token":"rotated"}}', { mode: 0o600 });

  const result = harnessed.run(["/services/codex", "CODEX_AUTH_JSON", json, "plain"]);
  assert.equal(result.status, 75);
  assert.match(result.stderr, /push-failed/);
  // The next invocation recomputes the same comparison, so nothing may be
  // journaled here for a human to clear.
  assert.deepEqual(fs.readdirSync(path.join(harnessed.workspace, "state")), []);
});
