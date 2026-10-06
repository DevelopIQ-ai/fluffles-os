import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const sourceCleanup = path.join(root, "bin", "cleanup-legacy-infisical-secrets");

type CleanupHarness = {
  root: string;
  script: string;
  env: NodeJS.ProcessEnv;
  legacyFiles: string[];
};

function createHarness(): CleanupHarness {
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), "infisical-cleanup-test-"));
  const bin = path.join(harnessRoot, "bin");
  const plists = path.join(harnessRoot, "Library", "LaunchAgents");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(plists, { recursive: true });

  for (const label of [
    "com.puffle.fluffles.channel.slack",
    "com.puffle.fluffles.channel.email",
    "com.puffle.fluffles.channel.phone",
    "com.puffle.harness.webhooks"
  ]) {
    fs.writeFileSync(
      path.join(plists, `${label}.plist`),
      `<string>${harnessRoot}/packages/auth/bin/infisical-run</string>\n`
    );
  }

  for (const relative of [
    "channels/slack/src/server.ts",
    "channels/webhooks/src/server.ts",
    "channels/phone/src/executor-mcp-client.ts"
  ]) {
    const target = path.join(harnessRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "const migrated = true;\n");
  }

  const wrapper = path.join(bin, "infisical-run");
  fs.writeFileSync(wrapper, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    --path) shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
exec env \
  SLACK_BOT_TOKEN=fake \
  SLACK_APP_TOKEN=fake \
  EMAIL_PUBSUB_PUSH_TOKEN=fake \
  AMALGM_EMAIL_INBOUND_SECRET=fake \
  PHONE_EXECUTOR_MCP_AUTHORIZATION=fake \
  "$@"
`, { mode: 0o700 });
  fs.chmodSync(wrapper, 0o700);

  const launchctl = path.join(bin, "launchctl");
  fs.writeFileSync(launchctl, `#!/bin/sh
if [ "\${FAKE_LEGACY_LAUNCHD:-0}" = "1" ]; then
  printf 'program = ${harnessRoot}/homebrew/bin/node\\n'
else
  printf 'arguments = ${harnessRoot}/packages/auth/bin/infisical-run\\n'
fi
`, { mode: 0o700 });
  fs.chmodSync(launchctl, 0o700);

  const counter = path.join(harnessRoot, "curl-count");
  const curl = path.join(bin, "curl");
  fs.writeFileSync(curl, `#!/bin/sh
count=0
if [ -f "\${FAKE_CURL_COUNTER}" ]; then count="$(/bin/cat "\${FAKE_CURL_COUNTER}")"; fi
count=$((count + 1))
printf '%s' "$count" >"\${FAKE_CURL_COUNTER}"
if [ "\${FAKE_CURL_FAIL_AFTER:-0}" -gt 0 ] && [ "$count" -gt "\${FAKE_CURL_FAIL_AFTER}" ]; then exit 22; fi
if [ "\${FAKE_CURL_PARTIAL_FAILURE_AFTER:-0}" -gt 0 ] && [ "$count" -gt "\${FAKE_CURL_PARTIAL_FAILURE_AFTER}" ]; then
  printf '{"ok":true}\\n'
  exit 22
fi
if [ "\${FAKE_CURL_UNHEALTHY_AFTER:-0}" -gt 0 ] && [ "$count" -gt "\${FAKE_CURL_UNHEALTHY_AFTER}" ]; then
  printf '{"ok":false}\\n'
  exit 0
fi
printf '{"ok":true}\\n'
exit 0
`, { mode: 0o700 });
  fs.chmodSync(curl, 0o700);

  const legacyFiles = [
    "auth/channels/slack/secrets.env",
    "auth/providers/webhooks/email-pubsub.env",
    "auth/providers/webhooks/webhooks.env",
    "auth/registry.json"
  ].map((relative) => path.join(harnessRoot, relative));
  for (const file of legacyFiles) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fake legacy material\n", { mode: 0o600 });
  }

  const script = path.join(bin, "cleanup-legacy-infisical-secrets");
  fs.writeFileSync(script, fs.readFileSync(sourceCleanup, "utf8"), { mode: 0o700 });
  fs.chmodSync(script, 0o700);

  return {
    root: harnessRoot,
    script,
    legacyFiles,
    env: {
      ...process.env,
      FLUFFLES_HOME: harnessRoot,
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_CURL_COUNTER: counter
    }
  };
}

test("cleanup dry-run preserves files and apply is idempotent", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  await execFileAsync(harness.script, [], { env: harness.env });
  assert.ok(harness.legacyFiles.every((file) => fs.existsSync(file)));

  await execFileAsync(harness.script, ["--apply"], { env: harness.env });
  assert.ok(harness.legacyFiles.every((file) => !fs.existsSync(file)));

  await execFileAsync(harness.script, ["--apply"], { env: harness.env });
  assert.ok(harness.legacyFiles.every((file) => !fs.existsSync(file)));
});

test("cleanup refuses a loaded legacy launch definition", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(harness.script, ["--apply"], {
      env: { ...harness.env, FAKE_LEGACY_LAUNCHD: "1" }
    }),
    (error: any) => error.code === 69
  );
  assert.ok(harness.legacyFiles.every((file) => fs.existsSync(file)));
});

test("cleanup restores staged files when post-removal health fails", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(harness.script, ["--apply"], {
      env: { ...harness.env, FAKE_CURL_FAIL_AFTER: "4" }
    })
  );
  assert.ok(harness.legacyFiles.every((file) => fs.existsSync(file)));
  assert.ok(harness.legacyFiles.every((file) => !fs.existsSync(`${file}.infisical-cleanup-backup`)));
});

test("cleanup requires healthy response content after staging", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(harness.script, ["--apply"], {
      env: { ...harness.env, FAKE_CURL_UNHEALTHY_AFTER: "4" }
    })
  );
  assert.ok(harness.legacyFiles.every((file) => fs.existsSync(file)));
});

test("cleanup propagates a transport failure after a complete-looking body", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(harness.script, ["--apply"], {
      env: { ...harness.env, FAKE_CURL_PARTIAL_FAILURE_AFTER: "4" }
    })
  );
  assert.ok(harness.legacyFiles.every((file) => fs.existsSync(file)));
});
