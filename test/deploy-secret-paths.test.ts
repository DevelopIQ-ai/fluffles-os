import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setUpRelease } from "./support/deploy-release";

// A launchd job whose Infisical path is not provisioned never runs its program:
// the injection wrapper exits before it, and KeepAlive turns that into a restart
// every ThrottleInterval. The deploy that shipped the chat console's
// /services/chat-console did exactly that and still reported success, because
// every gate after the apply asks whether a job is running and a crash loop
// always has one. The deploy proves the paths instead.
const wrapper = path.join("packages", "auth", "bin", "infisical-run");

test("a release whose declared secret path does not resolve is rolled back, not started", () => {
  const harness = setUpRelease({ secretsPath: "/services/test", wrapper });
  const first = harness.deploy();
  assert.equal(first.status, 0, first.stderr);

  harness.write(path.join(harness.repo, wrapper), "#!/bin/sh\nexit 78\n", 0o755);
  const target = harness.commit("declare a path the vault does not have");
  harness.installLauncher();

  const result = harness.deploy();
  assert.notEqual(result.status, 0);
  const receipt = harness.receipt();
  assert.equal(receipt.status, "secrets_unprovisioned");
  assert.equal(receipt.ok, false);
  assert.notEqual(receipt.deployedSha, target);
  assert.match(result.stderr, /\/services\/test is declared by .* does not resolve in the vault/);

  // The rollback is the point: the previous release is what runs, rather than a
  // job launchd restarts forever.
  for (const name of harness.serviceNames) {
    const job = harness.jobs()[`system/${harness.labelFor(name)}`];
    assert.ok(job, `${name} is not loaded`);
    assert.equal(job.running, true, `${name} is not running after the rollback`);
  }
  assert.equal(fs.readFileSync(path.join(harness.home, wrapper), "utf8").includes("exit 78"), false);
});

test("a release whose declared secret paths resolve deploys", () => {
  const harness = setUpRelease({ secretsPath: "/services/test", wrapper });
  harness.write(path.join(harness.repo, "channels", "slack", "note.txt"), "a change to deploy\n");
  const target = harness.commit("a release with a provisioned path");
  const result = harness.deploy();
  assert.equal(result.status, 0, result.stderr);
  const receipt = harness.receipt();
  assert.equal(receipt.status, "deployed");
  assert.equal(receipt.deployedSha, target);
});
