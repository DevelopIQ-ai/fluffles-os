import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const syncScript = path.join(repoRoot, "projects", "fluffles-site", "scripts", "sync-infisical-env.sh");

function createFakeVercel(rootDir: string): { cli: string; state: string } {
  const state = path.join(rootDir, "vercel-state");
  const cli = path.join(rootDir, "vercel");
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(cli, `#!/bin/sh
set -eu
state="\${FAKE_VERCEL_STATE:?}"
if [ "\${1:-}" = "env" ] && [ "\${2:-}" = "update" ]; then
  key="$3"
  value="$(/bin/cat)"
  if [ "\${FAKE_VERCEL_FAIL_KEY:-}" = "$key" ] && [ -n "\${FAKE_VERCEL_FAILURES:-}" ]; then
    remaining="$(/bin/cat "$FAKE_VERCEL_FAILURES")"
    if [ "$remaining" -gt 0 ]; then
      printf '%s' "$((remaining - 1))" >"$FAKE_VERCEL_FAILURES"
      exit 92
    fi
  fi
  if [ "\${FAKE_VERCEL_HANG_KEY:-}" = "$key" ]; then exec /bin/sleep 30; fi
  printf '%s' "$value" >"$state/$key"
  exit 0
fi
if [ "\${1:-}" = "env" ] && [ "\${2:-}" = "run" ]; then
  shift 2
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--" ]; then shift; break; fi
    shift
  done
  for key in EMAIL_PUBSUB_PUSH_TOKEN AMALGM_EVENTS_URL AMALGM_EMAIL_INBOUND_SECRET; do
    value="$(/bin/cat "$state/$key")"
    export "$key=$value"
  done
  exec "$@"
fi
exit 64
`, { mode: 0o700 });
  fs.chmodSync(cli, 0o700);
  return { cli, state };
}

test("Vercel production values are synchronized and verified without printing values", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "infisical-vercel-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fake = createFakeVercel(temp);
  const values = {
    EMAIL_PUBSUB_PUSH_TOKEN: "fake-push-token",
    AMALGM_EVENTS_URL: "https://example.invalid/events",
    AMALGM_EMAIL_INBOUND_SECRET: "fake-inbound-secret"
  };

  const result = await execFileAsync(syncScript, [], {
    cwd: temp,
    env: {
      ...process.env,
      ...values,
      VERCEL_CLI: fake.cli,
      VERCEL_SYNC_STATE_DIR: path.join(temp, "sync-state"),
      FAKE_VERCEL_STATE: fake.state,
      NODE: process.execPath
    }
  });

  assert.match(result.stdout, /Vercel production environment matches Infisical/);
  for (const [key, value] of Object.entries(values)) {
    assert.equal(fs.readFileSync(path.join(fake.state, key), "utf8"), value);
    assert.doesNotMatch(result.stdout, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(result.stderr, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("Vercel synchronization fails before mutation when an Infisical value is missing", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "infisical-vercel-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fake = createFakeVercel(temp);

  await assert.rejects(
    execFileAsync(syncScript, [], {
      cwd: temp,
      env: {
        ...process.env,
        EMAIL_PUBSUB_PUSH_TOKEN: "fake-push-token",
        AMALGM_EVENTS_URL: "https://example.invalid/events",
        AMALGM_EMAIL_INBOUND_SECRET: "",
        VERCEL_CLI: fake.cli,
        VERCEL_SYNC_STATE_DIR: path.join(temp, "sync-state"),
        FAKE_VERCEL_STATE: fake.state,
        NODE: process.execPath
      }
    }),
    (error: any) => error.code === 78
  );

  assert.deepEqual(fs.readdirSync(fake.state), []);
});

test("Vercel synchronization retries partial updates and removes recovery metadata only after convergence", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "infisical-vercel-retry-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fake = createFakeVercel(temp);
  const failures = path.join(temp, "failures");
  const syncState = path.join(temp, "sync-state");
  fs.writeFileSync(failures, "1", { mode: 0o600 });

  const result = await execFileAsync(syncScript, [], {
    cwd: temp,
    env: {
      ...process.env,
      EMAIL_PUBSUB_PUSH_TOKEN: "retry-push-token",
      AMALGM_EVENTS_URL: "https://retry.example.invalid/events",
      AMALGM_EMAIL_INBOUND_SECRET: "retry-inbound-secret",
      VERCEL_CLI: fake.cli,
      VERCEL_SYNC_STATE_DIR: syncState,
      FAKE_VERCEL_STATE: fake.state,
      FAKE_VERCEL_FAIL_KEY: "EMAIL_PUBSUB_PUSH_TOKEN",
      FAKE_VERCEL_FAILURES: failures,
      NODE: process.execPath
    }
  });

  assert.match(result.stdout, /matches Infisical/);
  assert.equal(fs.readFileSync(failures, "utf8"), "0");
  assert.equal(fs.existsSync(path.join(syncState, "pending.json")), false);
  assert.equal(fs.readFileSync(path.join(fake.state, "EMAIL_PUBSUB_PUSH_TOKEN"), "utf8"), "retry-push-token");
});

test("Vercel synchronization bounds a hung provider command and retains recovery metadata", async (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "infisical-vercel-timeout-test-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const fake = createFakeVercel(temp);
  const syncState = path.join(temp, "sync-state");
  const boundedScript = path.join(temp, "sync-infisical-env.sh");
  fs.writeFileSync(
    boundedScript,
    fs.readFileSync(syncScript, "utf8")
      .replace("max_reconciliation_rounds=3", "max_reconciliation_rounds=1")
      .replace("operation_timeout_seconds=30", "operation_timeout_seconds=1"),
    { mode: 0o700 }
  );
  fs.chmodSync(boundedScript, 0o700);

  const startedAt = Date.now();
  await assert.rejects(
    execFileAsync(boundedScript, [], {
      cwd: temp,
      env: {
        ...process.env,
        EMAIL_PUBSUB_PUSH_TOKEN: "timeout-push-token",
        AMALGM_EVENTS_URL: "https://timeout.example.invalid/events",
        AMALGM_EMAIL_INBOUND_SECRET: "timeout-inbound-secret",
        VERCEL_CLI: fake.cli,
        VERCEL_SYNC_STATE_DIR: syncState,
        FAKE_VERCEL_STATE: fake.state,
        FAKE_VERCEL_HANG_KEY: "EMAIL_PUBSUB_PUSH_TOKEN",
        NODE: process.execPath
      }
    }),
    (error: NodeJS.ErrnoException & { code?: number; stderr?: string }) => {
      assert.equal(error.code, 75);
      assert.match(String(error.stderr), /"event":"update-failed"/);
      return true;
    }
  );
  // A provider that is never bounded hangs forever, so this only has to be
  // faster than never; the reason it returned is asserted above.
  assert.ok(Date.now() - startedAt < 60_000);
  assert.equal(fs.existsSync(path.join(syncState, "pending.json")), true);
});

test("site deployment synchronizes Infisical before invoking Vercel", () => {
  const deploy = fs.readFileSync(path.join(repoRoot, "projects", "fluffles-site", "scripts", "deploy.sh"), "utf8");
  const syncIndex = deploy.indexOf("sync-infisical-env.sh");
  const deployIndex = deploy.lastIndexOf('"${VERCEL_CLI}" --prod');
  assert.ok(syncIndex >= 0);
  assert.ok(deployIndex > syncIndex);
  assert.match(deploy, /--path \/services\/email-pubsub --/);
});
