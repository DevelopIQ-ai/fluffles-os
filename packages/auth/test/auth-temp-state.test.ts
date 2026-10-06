import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "..");
const helper = path.join(root, "bin", "auth-temp-state");

test("temporary auth state is private, owned, and reclaimed after an interrupted owner", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-temp-state-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const stale = path.join(tmp, "codex-auth.stale01");
  fs.mkdirSync(stale, { mode: 0o700 });
  fs.chmodSync(stale, 0o700);
  fs.writeFileSync(path.join(stale, ".infisical-owner"), "pid:999999\n", { mode: 0o600 });
  fs.chmodSync(path.join(stale, ".infisical-owner"), 0o600);
  fs.writeFileSync(path.join(stale, "auth.json"), "plaintext", { mode: 0o600 });

  const created = execFileSync(helper, ["create", "codex-auth", String(process.pid)], {
    env: { ...process.env, TMPDIR: tmp },
    encoding: "utf8"
  }).trim();
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.statSync(created).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(created, ".infisical-owner")).mode & 0o777, 0o600);
});

test("temporary auth recovery never deletes state owned by a live process", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-temp-state-live-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // The running test process is a live owner, which exercises the same liveness
  // guard without leaving a background process behind.
  const live = path.join(tmp, "gws-auth.live001");
  fs.mkdirSync(live, { mode: 0o700 });
  fs.chmodSync(live, 0o700);
  fs.writeFileSync(path.join(live, ".infisical-owner"), `pid:${process.pid}\n`, { mode: 0o600 });
  fs.chmodSync(path.join(live, ".infisical-owner"), 0o600);

  execFileSync(helper, ["create", "gws-auth", String(process.pid)], {
    env: { ...process.env, TMPDIR: tmp },
    encoding: "utf8"
  });
  assert.equal(fs.existsSync(live), true);
});

test("temporary auth recovery preserves state owned by a live provider process group", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-temp-state-group-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const state = execFileSync(helper, ["create", "gws-auth", String(process.pid)], {
    env: { ...process.env, TMPDIR: tmp }, encoding: "utf8"
  }).trim();

  const provider = spawn(path.join(root, "bin", "auth-run-child"), ["/bin/sleep", "30"]);
  await once(provider, "spawn");
  t.after(() => provider.kill("SIGTERM"));
  execFileSync(helper, ["set-owner-group", state, String(provider.pid)], {
    env: { ...process.env, TMPDIR: tmp }
  });
  execFileSync(helper, ["create", "gws-auth", String(process.pid)], {
    env: { ...process.env, TMPDIR: tmp }
  });
  assert.equal(fs.existsSync(state), true);
});

test("owner-group publication waits for a provider to finish creating its process group", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-temp-state-group-ready-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const state = execFileSync(helper, ["create", "gws-auth", String(process.pid)], {
    env: { ...process.env, TMPDIR: tmp }, encoding: "utf8"
  }).trim();

  // A child PID is observable before auth-run-child has called setpgrp().
  // Reproduce that window deterministically and require the helper to wait
  // rather than publish a marker that recovery would consider stale.
  const provider = spawn("/usr/bin/perl", ["-e", "select undef, undef, undef, 0.15; setpgrp(0, 0) or die $!; sleep 30"]);
  await once(provider, "spawn");
  t.after(() => provider.kill("SIGTERM"));

  const startedAt = Date.now();
  execFileSync(helper, ["set-owner-group", state, String(provider.pid)], {
    env: { ...process.env, TMPDIR: tmp }
  });
  assert.ok(Date.now() - startedAt >= 100);
  assert.match(
    fs.readFileSync(path.join(state, ".infisical-owner"), "utf8"),
    new RegExp(`^pgid:${provider.pid}:[a-f0-9]{64}\\n$`)
  );

  execFileSync(helper, ["create", "gws-auth", String(process.pid)], {
    env: { ...process.env, TMPDIR: tmp }
  });
  assert.equal(fs.existsSync(state), true);
});

test("owner-group publication permits cleanup after a provider has already exited", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-temp-state-group-exited-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const state = execFileSync(helper, ["create", "github-ssh", String(process.pid)], {
    env: { ...process.env, TMPDIR: tmp }, encoding: "utf8"
  }).trim();

  const provider = spawn(path.join(root, "bin", "auth-run-child"), [process.execPath, "-e", ""]);
  await once(provider, "exit");

  execFileSync(helper, ["set-owner-group", state, String(provider.pid)], {
    env: { ...process.env, TMPDIR: tmp }
  });
  assert.match(
    fs.readFileSync(path.join(state, ".infisical-owner"), "utf8"),
    new RegExp(`^pid:${process.pid}:[a-f0-9]{64}\\n$`)
  );
});

test("recovery rejects a reused PID whose process identity does not match", (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-temp-state-reused-pid-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const stale = path.join(tmp, "codex-auth.reused01");
  fs.mkdirSync(stale, { mode: 0o700 });
  fs.writeFileSync(
    path.join(stale, ".infisical-owner"),
    `pid:${process.pid}:${"0".repeat(64)}\n`,
    { mode: 0o600 }
  );
  fs.writeFileSync(path.join(stale, "auth.json"), "plaintext", { mode: 0o600 });

  execFileSync(helper, ["create", "codex-auth", String(process.pid)], {
    env: { ...process.env, TMPDIR: tmp }
  });
  assert.equal(fs.existsSync(stale), false);
});

test("a SIGKILL leaves runtime state for deterministic recovery by the next invocation", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-temp-state-kill-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const owner = spawn("/bin/sh", ["-c", `"${helper}" create infisical-runtime $$ >/dev/null; exec /bin/sleep 30`], {
    env: { ...process.env, TMPDIR: tmp }
  });
  for (let attempts = 0; !fs.readdirSync(tmp).some((entry) => entry.startsWith("infisical-runtime.")) && attempts < 50; attempts += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(fs.readdirSync(tmp).some((entry) => entry.startsWith("infisical-runtime.")));
  owner.kill("SIGKILL");
  await once(owner, "exit");
  execFileSync(helper, ["create", "infisical-runtime", String(process.pid)], {
    env: { ...process.env, TMPDIR: tmp }
  });
  assert.equal(fs.readdirSync(tmp).filter((entry) => entry.startsWith("infisical-runtime.")).length, 1);
});

test("persistent native auth is reclaimed only after its owner process group exits", async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "auth-persistent-state-test-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const runtime = path.join(tmp, "runtime");
  const source = path.join(tmp, "source.json");
  fs.mkdirSync(runtime, { mode: 0o700 });
  fs.writeFileSync(source, '{"machine":{"token":"test"}}', { mode: 0o600 });
  fs.chmodSync(runtime, 0o700);
  fs.chmodSync(source, 0o600);

  execFileSync(helper, ["materialize-persistent", runtime, source, String(process.pid)]);
  assert.equal(fs.existsSync(path.join(runtime, "auth.json")), true);

  const provider = spawn(path.join(root, "bin", "auth-run-child"), ["/bin/sleep", "30"]);
  await once(provider, "spawn");
  t.after(() => provider.kill("SIGTERM"));
  execFileSync(helper, ["set-persistent-owner-group", runtime, String(provider.pid)]);
  assert.throws(
    () => execFileSync(helper, ["materialize-persistent", runtime, source, String(process.pid)]),
    (error: NodeJS.ErrnoException) => error.status === 75
  );
  provider.kill("SIGTERM");
  await once(provider, "exit");
  execFileSync(helper, ["materialize-persistent", runtime, source, String(process.pid)]);
  execFileSync(helper, ["remove-persistent", runtime, String(process.pid)]);
  assert.equal(fs.existsSync(path.join(runtime, "auth.json")), false);
});
