import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { replaceShellFunction, setUpRelease } from "./support/deploy-release";

const root = path.resolve(__dirname, "..");

// A deploy is performed by the launcher the previous release installed, and that
// is the one sequence the existing harness could not see: it ran the deployer
// under test against itself. Every test here deploys a new release using the
// launcher of the release before it, which is what the mini does every minute.
const serviceNames = ["slack", "chat-console", "webhooks", "automations"];
const labelFor = (name: string) => `com.puffle.test.${name}`;
const setUp = () => setUpRelease({ serviceNames });

// A package that has to be built before the runtime can use it, which is what
// packages/memory was when #80 added it.
function addPackage(harness: ReturnType<typeof setUp>, name: string) {
  const directory = path.join(harness.repo, "packages", name);
  harness.write(
    path.join(directory, "package.json"),
    `${JSON.stringify(
      {
        name: `@fluffles/${name}`,
        version: "1.0.0",
        scripts: { build: "mkdir -p dist && printf 'built\\n' > dist/index.js" }
      },
      null,
      2
    )}\n`
  );
  harness.write(path.join(directory, "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3 }, null, 2)}\n`);
  // The runtime needs the compiled entrypoint, so the deploy is gated on it the
  // way smoke gated on bin/memory.
  harness.write(
    path.join(harness.repo, "bin", "smoke"),
    `#!/usr/bin/env bash
set -uo pipefail
for label in ${serviceNames.map(labelFor).join(" ")}; do
  if ! launchctl print "system/\${label}" 2>/dev/null | grep -q 'state = running'; then
    echo "fail harness-launchd: \${label} is not running" >&2
    exit 1
  fi
done
if [[ ! -f "\${HOME}/packages/${name}/dist/index.js" ]]; then
  echo "fail harness-package: @fluffles/${name} was never built" >&2
  exit 1
fi
echo "smoke passed"
`,
    0o755
  );
}

test("the contract a release declares is the one its own launcher provides", () => {
  const declared = fs.readFileSync(path.join(root, "deploy", "contract"), "utf8").trim();
  const provided = /^launcher_contract=([0-9]+)$/m.exec(fs.readFileSync(path.join(root, "bin", "deploy-main"), "utf8"));

  assert.match(declared, /^[0-9]+$/, "deploy/contract is the launcher generation this release needs");
  assert.ok(provided, "the deployer states which launcher generation it provides");
  // They are the same number by definition: a release needs the launcher it
  // ships. Letting them drift would either refuse deploys that would have
  // worked or accept ones an old launcher cannot perform.
  assert.equal(declared, provided[1]);
});

test("a release that adds a package is installed by the launcher that predates it", () => {
  const harness = setUp();
  try {
    addPackage(harness, "new-thing");
    const target = harness.commit("add a package the installed launcher has never heard of");

    const result = harness.deploy();
    const receipt = harness.receipt();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(receipt.status, "deployed", receipt.message ?? "");
    assert.equal(receipt.deployedSha, target);
    assert.equal(fs.readFileSync(path.join(harness.home, "packages", "new-thing", "dist", "index.js"), "utf8"), "built\n");
    assert.ok(
      harness.npmLog().includes(`build\t${harness.home}/packages/new-thing`),
      `the new package was never built: ${harness.npmLog().join(", ")}`
    );
  } finally {
    fs.rmSync(harness.fixture, { recursive: true, force: true });
  }
});

// The negative control for the test above: with a deployer that does not know
// how to build what the release added, which is exactly what an installed
// deployer from the release before is, the deploy fails and rolls back. This is
// #80, reproduced, and it is what the harness has to be able to catch.
test("a release whose deployer cannot build what it added rolls back onto the running release", () => {
  const harness = setUp();
  try {
    addPackage(harness, "new-thing");
    harness.editReleaseDeployer((source) =>
      replaceShellFunction(source, "install_dependencies", "install_dependencies() {\n  return 0\n}\n")
    );
    const target = harness.commit("add a package and forget how to build it");

    const result = harness.deploy();
    const receipt = harness.receipt();

    assert.equal(result.status, 1);
    assert.equal(receipt.status, "smoke_failed", receipt.message ?? "");
    assert.notEqual(receipt.deployedSha, target);
    assert.equal(fs.existsSync(path.join(harness.home, "packages", "new-thing")), false);
    for (const name of serviceNames) {
      const job = harness.jobs()[`system/${labelFor(name)}`];
      assert.ok(job, `${name} was left unloaded by the rollback`);
      assert.equal(job.running, true, `${name} did not come back up`);
    }
  } finally {
    fs.rmSync(harness.fixture, { recursive: true, force: true });
  }
});

// Found on dev: the runtime home holds more than the release. Three abandoned
// checkouts sat under projects/, each declaring the repository root package, so
// discovering packages by reading the runtime ran the repository's own checks
// over a tree with merge conflict markers in it and failed every deploy. The
// release declares which packages exist; the runtime is only where they land.
test("a deploy installs the packages the release declares, not whatever else the runtime holds", () => {
  const harness = setUp();
  try {
    harness.write(
      path.join(harness.home, "projects", "abandoned-checkout", "package.json"),
      `${JSON.stringify({ name: "fluffles-harness-scripts", version: "1.0.0", scripts: { build: "exit 1" } }, null, 2)}\n`
    );
    harness.write(path.join(harness.home, "projects", "abandoned-checkout", "package-lock.json"), `${JSON.stringify({ lockfileVersion: 3 }, null, 2)}\n`);
    harness.write(path.join(harness.repo, "agent", "note.md"), "a release with something in it to deploy\n");
    const target = harness.commit("deploy a release while the runtime holds someone's checkout");

    const result = harness.deploy();
    const receipt = harness.receipt();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(receipt.deployedSha, target, receipt.message ?? "");
    assert.deepEqual(
      harness.npmLog().filter((entry) => entry.includes("abandoned-checkout")),
      [],
      "the deploy read the runtime's own directories for packages to install"
    );
  } finally {
    fs.rmSync(harness.fixture, { recursive: true, force: true });
  }
});

// Found on dev, by deploying a release that added a package and failed: the
// rollback unlinked the package's source files but could not retire the
// directory, because the build output and node_modules the deploy had just put
// there are excluded from the exact sync and rsync will not delete a directory
// that is not empty. The rollback reported itself incomplete and left admission
// blocked, which needs a person.
test("a rollback retires a package the failed release added, build output and all", () => {
  const harness = setUp();
  try {
    addPackage(harness, "new-thing");
    fs.appendFileSync(path.join(harness.repo, "bin", "smoke"), 'echo "fail harness-runtime: unhappy for an unrelated reason" >&2\nexit 1\n');
    const target = harness.commit("add a package that builds, and fail smoke anyway");

    const result = harness.deploy();
    const receipt = harness.receipt();

    assert.equal(result.status, 1);
    assert.equal(receipt.status, "smoke_failed", receipt.message ?? "");
    assert.equal(receipt.rollback, true);
    assert.notEqual(receipt.deployedSha, target);
    assert.equal(fs.existsSync(path.join(harness.home, "packages", "new-thing")), false, "the rollback left the added package behind");
    for (const name of serviceNames) {
      const job = harness.jobs()[`system/${labelFor(name)}`];
      assert.equal(job?.running, true, `${name} did not come back up`);
    }
  } finally {
    fs.rmSync(harness.fixture, { recursive: true, force: true });
  }
});

test("the deployer that performs a deploy is the release's own, driving admission from a tree the deploy is not rewriting", () => {
  const harness = setUp();
  try {
    harness.editReleaseDeployer((source) =>
      source.replace(
        '  echo "deploy-main: installing ${target} with its own deployer"',
        '  echo "deploy-main: installing ${target} with its own deployer"\n' +
          '  printf \'%s\\n%s\\n\' "${BASH_SOURCE[0]}" "$task_control_root" > "${state_dir}/applied-by"'
      )
    );
    const target = harness.commit("record which deployer performed the deploy");

    const result = harness.deploy();
    const [performedBy, admissionRoot] = fs
      .readFileSync(path.join(harness.home, "state", "deploy-main", "applied-by"), "utf8")
      .trimEnd()
      .split("\n");
    const candidate = path.join(harness.home, "state", "deploy-main", "candidate");

    assert.equal(result.status, 0, result.stderr);
    assert.equal(harness.receipt().deployedSha, target);
    assert.equal(performedBy, path.join(candidate, "bin", "deploy-main"));
    // Reopening admission out of the live checkout is how a finished deploy
    // ended up drained with resume_normal_failed: the checkout had just been
    // replaced underneath it. The candidate is the tree nothing rewrites.
    assert.equal(admissionRoot, candidate);
  } finally {
    fs.rmSync(harness.fixture, { recursive: true, force: true });
  }
});

test("a release that needs a newer launcher than this machine has is refused without touching the runtime", () => {
  const harness = setUp();
  try {
    const before = harness.jobs();
    harness.write(path.join(harness.repo, "deploy", "contract"), "2\n");
    const target = harness.commit("need a launcher this machine does not have yet");

    const result = harness.deploy();
    const receipt = harness.receipt();

    assert.equal(result.status, 78);
    assert.equal(receipt.status, "launcher_too_old", receipt.message ?? "");
    assert.notEqual(receipt.deployedSha, target);
    assert.match(receipt.message ?? "", /needs launcher contract 2/);
    // Refusing is only safe if it is inert: same code live, same jobs running.
    assert.equal(fs.readFileSync(path.join(harness.home, "deploy", "contract"), "utf8").trim(), "1");
    assert.deepEqual(harness.jobs(), before);
  } finally {
    fs.rmSync(harness.fixture, { recursive: true, force: true });
  }
});

test("a release older than the handoff is still installed by the launcher itself", () => {
  const harness = setUp();
  try {
    // What a rollback returns to, and what every release before this one is.
    fs.rmSync(path.join(harness.repo, "deploy", "contract"));
    const target = harness.commit("go back to a release that cannot install itself");

    const result = harness.deploy();
    const receipt = harness.receipt();

    assert.equal(result.status, 0, result.stderr);
    assert.equal(receipt.status, "deployed", receipt.message ?? "");
    assert.equal(receipt.deployedSha, target);
    assert.doesNotMatch(result.stdout, /with its own deployer/);
    for (const name of serviceNames) {
      assert.equal(harness.jobs()[`system/${labelFor(name)}`]?.running, true, `${name} is not running`);
    }
  } finally {
    fs.rmSync(harness.fixture, { recursive: true, force: true });
  }
});

// A runtime holds the managed subset of a release. Production's deploy of #91
// failed here: the plan named a package the runtime does not have, npm ci walked
// up to the runtime's own root lockfile, refused, and the whole deploy rolled
// back every cycle.
test("a deploy installs a release's packages only where the release was installed", () => {
  const harness = setUp();
  try {
    // The package has to sit outside the managed paths for the runtime to lack
    // it. projects/ is installed, so it cannot stand in for one that is not.
    harness.write(
      path.join(harness.repo, "test", "unmanaged-package", "package.json"),
      `${JSON.stringify({ name: "unmanaged-package", version: "1.0.0", scripts: { build: "exit 0" } }, null, 2)}\n`
    );
    harness.write(
      path.join(harness.repo, "test", "unmanaged-package", "package-lock.json"),
      `${JSON.stringify({ lockfileVersion: 3 }, null, 2)}\n`
    );
    const target = harness.commit("a release carries more than the runtime is given");

    const result = harness.deploy();
    const receipt = harness.receipt();

    assert.equal(result.status, 0, `${receipt.status}: ${receipt.message}\n${result.stderr}`);
    assert.equal(receipt.deployedSha, target, receipt.message ?? "");
    assert.deepEqual(
      harness.npmLog().filter((entry) => entry.includes(path.join(harness.home, "test", "unmanaged-package"))),
      [],
      "the deploy installed into a package the runtime does not have"
    );
  } finally {
    fs.rmSync(harness.fixture, { recursive: true, force: true });
  }
});

// The services a harness runs are declared by the release. Production's deploy of
// the executor daemon started the six services the previous release knew about
// and then failed smoke on the seventh, the one the release had just added.
test("a release that adds a service has it running before the deploy is verified", () => {
  const harness = setUp();
  try {
    // Production's case exactly: the release predates the handoff, so the
    // installed launcher performs the deploy and has to notice the new service.
    fs.rmSync(path.join(harness.repo, "deploy", "contract"));
    const hostFile = path.join(harness.repo, "deploy", "hosts", "test.json");
    const host = JSON.parse(fs.readFileSync(hostFile, "utf8")) as { services: string[] };
    const services = JSON.parse(fs.readFileSync(path.join(harness.repo, "deploy", "services.json"), "utf8")) as {
      services: Record<string, unknown>[];
    };
    const gateway = services.services.find((service) => service.name === "slack");
    services.services.push({ ...gateway, name: "gateway", label: "{{PREFIX}}.gateway" });
    harness.write(path.join(harness.repo, "deploy", "services.json"), `${JSON.stringify(services, null, 2)}\n`);
    harness.write(hostFile, `${JSON.stringify({ ...host, services: [...host.services, "gateway"] }, null, 2)}\n`);
    harness.write(
      path.join(harness.repo, "bin", "smoke"),
      `#!/usr/bin/env bash
set -uo pipefail
for label in ${[...serviceNames, "gateway"].map(labelFor).join(" ")}; do
  if ! launchctl print "system/\${label}" 2>/dev/null | grep -q 'state = running'; then
    echo "fail harness-launchd: \${label} is not running" >&2
    exit 1
  fi
done
echo "smoke passed"
`,
      0o755
    );
    const target = harness.commit("a release declares one more service than the launcher knows");

    const result = harness.deploy();
    const receipt = harness.receipt();

    assert.equal(result.status, 0, `${receipt.status}: ${receipt.message}\n${result.stderr}`);
    assert.equal(receipt.deployedSha, target, receipt.message ?? "");
  } finally {
    fs.rmSync(harness.fixture, { recursive: true, force: true });
  }
});
