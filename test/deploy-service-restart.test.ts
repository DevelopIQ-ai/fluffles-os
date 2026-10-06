import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setUpRelease } from "./support/deploy-release";

// Every deployment bug so far has been found by production breaking: the
// service restart is the one stage the old integration test stubbed out, and it
// is where all of them lived. These tests run the real stop, manifest sync,
// bootstrap, smoke and rollback stages against a throwaway tree, driven by a
// throwaway host file so nothing about them is production shaped.
const serviceNames = ["slack", "email", "phone", "chat-console", "webhooks", "automations"];
const labelFor = (name: string) => `com.puffle.test.${name}`;
const setUp = () => setUpRelease({ serviceNames });

test("a candidate that moves the wrapper the services run still deploys", () => {
  const deployment = setUp();
  try {
    // Exactly what #37 did: the wrapper moves, and every manifest follows it.
    deployment.moveWrapper(path.join("packages", "auth", "bin", "infisical-run"));
    const target = deployment.commit("move the wrapper into packages/auth");

    const result = deployment.deploy();
    const receipt = deployment.receipt();
    const jobs = deployment.jobs();
    const wrapper = path.join(deployment.home, "packages", "auth", "bin", "infisical-run");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.status, "deployed");
    assert.equal(receipt.deployedSha, target);
    for (const name of serviceNames) {
      const label = labelFor(name);
      const job = jobs[`system/${label}`];
      assert.ok(job, `${label} is not loaded`);
      assert.equal(job.running, true, `${label} is not running`);
      assert.equal(job.argv[0], path.join(deployment.home, "bin", "breadcrumb-service"), `${label} does not start through the derived scaffold`);
      assert.ok(job.argv.includes(wrapper), `${label} still runs the wrapper's old path`);
      assert.match(
        fs.readFileSync(path.join(deployment.daemons, `${label}.plist`), "utf8"),
        new RegExp(wrapper),
        "the installed daemon manifest is stale"
      );
    }
    assert.equal(fs.existsSync(path.join(deployment.home, "bin", "infisical-run")), false);
  } finally {
    fs.rmSync(deployment.fixture, { recursive: true, force: true });
  }
});

test("a candidate whose services cannot start is rolled back onto the running release", () => {
  const deployment = setUp();
  try {
    const wrapper = path.join(deployment.home, "bin", "infisical-run");
    // A release that points every service at a program it never shipped: the
    // manifests are valid, the jobs simply cannot run.
    deployment.moveWrapper(path.join("bin", "wrapper-that-never-shipped"));
    fs.rmSync(path.join(deployment.repo, "bin", "wrapper-that-never-shipped"));
    const target = deployment.commit("point the services at a missing wrapper");

    const result = deployment.deploy();
    const receipt = deployment.receipt();
    const jobs = deployment.jobs();

    assert.equal(result.status, 1);
    assert.equal(receipt.ok, false);
    assert.equal(receipt.status, "restart_failed", result.stderr);
    assert.notEqual(receipt.deployedSha, target);
    for (const name of serviceNames) {
      const label = labelFor(name);
      const job = jobs[`system/${label}`];
      assert.ok(job, `${label} was left unloaded by the rollback`);
      assert.equal(job.running, true, `${label} did not come back up`);
      assert.ok(job.argv.includes(wrapper), `${label} was left on the failed candidate's manifest`);
    }
  } finally {
    fs.rmSync(deployment.fixture, { recursive: true, force: true });
  }
});
