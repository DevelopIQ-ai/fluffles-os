import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { installDeploySource, serviceNamed, services, shellLabels, shellVariables, writeHostFile } from "./support/host";

const root = path.resolve(__dirname, "..");
const deployer = fs.readFileSync(path.join(root, "bin", "deploy-main"), "utf8");
const smoke = fs.readFileSync(path.join(root, "tools", "smoke", "bin", "smoke.ts"), "utf8");
const taskControl = fs.readFileSync(path.join(root, "packages", "tasks", "src", "task-control.ts"), "utf8");
const installer = fs.readFileSync(path.join(root, "deploy", "scripts", "install-system-services"), "utf8");

function processState(pid: number): string {
  try {
    return childProcess.execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8"
    }).trim();
  } catch {
    return "";
  }
}

function processIsAlive(pid: number): boolean {
  const state = processState(pid);
  return state !== "" && !state.startsWith("Z");
}

function run(command: string, args: string[], options: Omit<childProcess.ExecFileSyncOptions, "encoding"> = {}): string {
  return childProcess.execFileSync(command, args, { ...options, encoding: "utf8" });
}

function manifestFor(root: string, deployedSha: string) {
  const entries: Array<{ path: string; type: "file"; sha256: string }> = [];
  const walk = (directory: string, prefix = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.posix.join(prefix, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isDirectory()) walk(absolute, relative);
      else if (stat.isFile()) {
        entries.push({
          path: relative,
          type: "file",
          sha256: crypto.createHash("sha256").update(fs.readFileSync(absolute)).digest("hex")
        });
      }
    }
  };
  walk(root);
  return {
    version: 1,
    deployedSha,
    generatedAt: "2026-07-24T00:00:00.000Z",
    manifestSha: crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    entries
  };
}

function replaceShellFunction(script: string, name: string, replacement: string): string {
  const expression = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}\\n`, "m");
  assert.match(script, expression, `could not replace ${name} in the deploy integration harness`);
  return script.replace(expression, replacement);
}

test("deploy-main follows only the canonical main branch", () => {
  // The branch is the host's, and production's host is merged main.
  assert.equal(shellVariables("prod").deploy_ref, "origin/main");
  assert.equal(shellVariables("dev").deploy_ref, "origin/main");
  assert.match(deployer, /rev-parse "\$deploy_ref"/);
  assert.match(deployer, /checkout --quiet --force -B "\$deploy_branch" "\$deploy_ref"/);
  assert.doesNotMatch(deployer, /git[^\n]*push/);
  assert.doesNotMatch(deployer, /--reconcile-reviewed/, "there is no manual path around merged main");
});

test("deploy-main rejects unknown arguments before deployment setup", () => {
  const parserStart = deployer.indexOf('while [[ "$#" -gt "0" ]]; do');
  const parserEnd = deployer.indexOf('if ! [[ "$drain_timeout_ms"', parserStart);
  const parser = deployer.slice(parserStart, parserEnd);
  const stateSetup = deployer.indexOf('mkdir -p "$state_dir"');
  const firstReceipt = deployer.indexOf("write_receipt()");
  const taskControl = deployer.indexOf("task_control()");
  const apply = deployer.indexOf('sync_managed_exact "$candidate" "$home"');

  assert.ok(parserStart >= 0 && parserEnd > parserStart, "the cli parser must be extractable");
  assert.ok(parserEnd < stateSetup, "invalid input must exit before state setup");
  assert.ok(parserEnd < firstReceipt, "invalid input must exit before receipt handling");
  assert.ok(parserEnd < taskControl && parserEnd < apply, "invalid input must not enter deployment");

  for (const args of [["--reconcile-reviewed", "a".repeat(40)], ["--force"], ["unexpected"]]) {
    const result = childProcess.spawnSync("bash", ["-c", [
      "set -euo pipefail",
      "dry_run=0",
      parser
    ].join("\n"), "--", ...args], { encoding: "utf8" });
    assert.equal(result.status, 64, `${args.join(" ")} must return a usage error`);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /unknown argument/);
  }
});

test("deploy-main fast-forwards a declared mirror before polling it", () => {
  // A host without GitHub credentials deploys from a local bare mirror, and
  // mirrorUpstream names where that mirror advances from. The deployer
  // fast-forwards the mirror on every poll, so the host rolls on its own
  // instead of waiting for someone to fetch into the mirror by hand.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-mirror-"));
  const git = (cwd: string, ...args: string[]) =>
    run("git", ["-C", cwd, "-c", "user.email=test@test", "-c", "user.name=test", ...args]).trim();
  try {
    const upstream = path.join(home, "upstream");
    fs.mkdirSync(upstream, { recursive: true });
    git(upstream, "init", "--quiet", "--initial-branch", "main");
    git(upstream, "commit", "--quiet", "--allow-empty", "--message", "one");
    const mirror = path.join(home, "mirrors", "source.git");
    run("git", ["clone", "--quiet", "--bare", upstream, mirror]);
    const repo = path.join(home, "projects", "source-code");
    run("git", ["clone", "--quiet", mirror, repo]);
    git(upstream, "commit", "--quiet", "--allow-empty", "--message", "two");
    const ahead = git(upstream, "rev-parse", "main");

    const hostFile = writeHostFile(path.join(home, "host.json"), {
      home,
      repo,
      mirrorUpstream: upstream
    });
    const result = childProcess.spawnSync(path.join(root, "bin", "deploy-main"), ["--dry-run"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        FLUFFLES_HOST_FILE: hostFile,
        DEPLOY_NODE: process.execPath
      }
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`target=${ahead}`), "the poll must see the commit the upstream is ahead by");
    assert.equal(git(mirror, "rev-parse", "main"), ahead, "the mirror itself must have been advanced");

    // An unreachable upstream degrades to polling what the mirror has instead
    // of failing the deploy.
    fs.rmSync(upstream, { recursive: true, force: true });
    const degraded = childProcess.spawnSync(path.join(root, "bin", "deploy-main"), ["--dry-run"], {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        FLUFFLES_HOST_FILE: hostFile,
        DEPLOY_NODE: process.execPath
      }
    });
    assert.equal(degraded.status, 0, degraded.stderr);
    assert.match(degraded.stderr, /polling what the mirror has/);
    assert.match(degraded.stdout, new RegExp(`target=${ahead}`));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("deploy-main verifies before applying and rolls back failed smoke", () => {
  const verify = deployer.indexOf('"$candidate/deploy/scripts/verify-source.sh"');
  const apply = deployer.indexOf('sync_managed_exact "$candidate" "$home"');
  const smoke = deployer.indexOf('"${home}/bin/smoke" --quiet');
  const rollback = deployer.indexOf("rollback smoke_failed");
  assert.ok(verify >= 0 && verify < apply, "candidate verification must happen before live copy");
  assert.ok(smoke >= 0 && smoke < rollback, "failed smoke must invoke rollback");
});

test("deploy-main quarantines managed drift before converging instead of refusing to deploy", () => {
  const verification = deployer.indexOf('"$candidate/deploy/scripts/verify-source.sh"');
  const drift = deployer.indexOf('check_managed_drift "$manifest" "$home"');
  const quarantine = deployer.indexOf("quarantine_managed_drift", drift);
  const backup = deployer.indexOf('copy_managed "$home" "$backup"');
  const apply = deployer.indexOf('sync_managed_exact "$candidate" "$home"');
  const restartRollback = deployer.indexOf("rollback restart_failed");
  const smokeRollback = deployer.indexOf("rollback smoke_failed");
  const persist = deployer.indexOf('persist_manifest "$candidate_manifest" "$manifest"');

  assert.ok(verification >= 0 && verification < drift, "drift handling must follow candidate verification");
  assert.ok(drift >= 0 && drift < quarantine, "detected drift must be quarantined");
  assert.ok(quarantine >= 0 && quarantine < backup, "drifted files must be preserved before the backup and apply steps");
  assert.ok(backup >= 0 && backup < apply, "the backup must exist before the live apply");
  assert.ok(apply >= 0 && apply < restartRollback, "restart failure enters the rollback path");
  assert.ok(apply >= 0 && apply < smokeRollback, "smoke failure enters the rollback path");
  assert.ok(smokeRollback < persist, "manifest persistence remains after smoke success");
  assert.match(deployer, /write_receipt false quarantine_failed/, "an unpreserved quarantine must stop the deployment");
  assert.match(deployer, /notify_drift_quarantined/);
  assert.doesNotMatch(deployer, /write_receipt false drift_detected/, "drift no longer refuses deployment");
});

test("deploy smoke does not require the deployment receipt it is about to finalize", () => {
  const deployStart = smoke.indexOf("if (args.deploy) {");
  const standardStart = smoke.indexOf("} else {", deployStart);
  const checksEnd = smoke.indexOf("const failedChecks", standardStart);
  const deployChecks = smoke.slice(deployStart, standardStart);
  const standardChecks = smoke.slice(standardStart, checksEnd);

  assert.doesNotMatch(deployChecks, /checkDeployMainReceipt/);
  assert.match(standardChecks, /checkDeployMainReceipt/);
});

test("live-runtime suites gate the deployment from smoke, not from source verification", () => {
  const verify = fs.readFileSync(path.join(root, "deploy", "scripts", "verify-source.sh"), "utf8");

  // Source verification judges the candidate; anything that drives the running
  // machine belongs to the post-install smoke, which deploy-main retries.
  assert.match(verify, /^export SOURCE_VERIFY_PORTABLE=1$/m);
  assert.doesNotMatch(verify, /SOURCE_VERIFY_PORTABLE=1 npm test/);

  const deployStart = smoke.indexOf("if (args.deploy) {");
  const standardStart = smoke.indexOf("} else {", deployStart);
  const checksEnd = smoke.indexOf("const failedChecks", standardStart);
  assert.match(smoke.slice(deployStart, standardStart), /checkAutomationsExecution/);
  assert.match(smoke.slice(standardStart, checksEnd), /checkAutomationsExecution/);
});

test("deploy-main unloads services before the sync and bootstraps them after", () => {
  const stop = deployer.indexOf("if ! task_control set restarting >/dev/null || ! stop_services; then");
  const apply = deployer.indexOf('sync_managed_exact "$candidate" "$home"');
  const start = deployer.indexOf("if ! start_services; then\n  rollback restart_failed");
  assert.ok(stop >= 0 && stop < apply, "services must be fully unloaded before the live tree changes");
  assert.ok(apply >= 0 && apply < start, "services must start only after the whole managed sync completes");
  assert.match(deployer, /bootout "\$service"/, "stop removes the launchd job so KeepAlive cannot respawn mid-sync");
  assert.match(deployer, /bootstrap "\$domain" "\$plist"/);
  assert.match(deployer, /kickstart -k "\$service"/, "a job left running by another path is still recycled onto the converged tree");
  assert.match(deployer, /install-system-services as root/);
  const rollbackBody = deployer.slice(deployer.indexOf("rollback() {"), deployer.indexOf("admission_must_remain_blocked=1\nif ! task_control set restarting"));
  assert.match(rollbackBody, /stop_services/, "rollback restores files with services unloaded too");
});

// What a deploy would install and build in this tree, read out of the deployer
// itself. The plan used to be a hand-written list, and a release that added a
// package to it was a release the installed deployer could not build: #80 added
// packages/memory, the list did not have it, and the deploy looped for half an
// hour. The plan is now derived from the tree, so these assert on the answer it
// produces for the real repository rather than on a list anyone has to maintain.
function packagePlan(root: string): Array<{ action: string; directory: string }> {
  const helper = deployer.slice(deployer.indexOf("package_plan() {"), deployer.indexOf("install_dependencies() {"));
  const output = run("bash", [
    "-c",
    [`set -euo pipefail`, `node=${JSON.stringify(process.execPath)}`, helper, `package_plan ${JSON.stringify(root)}`].join("\n")
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [action, directory] = line.split("\t");
      return { action: action as string, directory: directory as string };
    });
}

function manifestIn(directory: string): { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; fluffles?: { deploy?: boolean } } {
  return JSON.parse(fs.readFileSync(path.join(root, directory, "package.json"), "utf8"));
}

test("a deploy builds every package the runtime resolves through dist, in dependency order", () => {
  const plan = packagePlan(root);
  const builds = plan.filter((step) => step.action === "build").map((step) => step.directory);
  const nameOf = new Map(builds.map((directory) => [manifestIn(directory).name, directory]));

  // The two that have taken production down: channels import @fluffles/tasks
  // through its dist, and @fluffles/memory imports @fluffles/storage the same way.
  assert.ok(builds.includes("packages/tasks"), "@fluffles/tasks resolves through dist, so stale compiled output must never survive a deploy");
  for (const directory of builds) {
    const manifest = manifestIn(directory);
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) {
      const dependencyDirectory = nameOf.get(dependency);
      if (!dependencyDirectory || dependencyDirectory === directory) continue;
      assert.ok(
        builds.indexOf(dependencyDirectory) < builds.indexOf(directory),
        `${directory} resolves ${dependency} through dist, so ${dependencyDirectory} must build first`
      );
    }
  }
});

test("a deploy needs no list of packages kept in step with the tree", () => {
  const plan = packagePlan(root);
  const planned = new Set(plan.map((step) => step.directory));
  const missing: string[] = [];
  const walk = (relative: string, depth: number) => {
    if (relative !== "." && fs.existsSync(path.join(root, relative, "package.json"))) {
      const manifest = manifestIn(relative);
      // A package the runtime does not need says so itself.
      if (manifest.fluffles?.deploy !== false && !planned.has(relative)) missing.push(relative);
      return;
    }
    if (depth === 0) return;
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(path.join(relative, entry.name), depth - 1);
    }
  };
  walk(".", 2);

  assert.deepEqual(missing, [], "every package in the tree is installed or built by a deploy without being named in the deployer");
  assert.ok(planned.has("packages/memory"), "the package #80 added is planned by reading the tree");
  // The root's build script is a repository-wide typecheck. Verification runs it
  // against the release; running it against the live runtime typechecks whatever
  // else the runtime contains, and failed a real dev deploy for doing so.
  assert.deepEqual(
    plan.filter((step) => step.directory === "."),
    [{ action: "install", directory: "." }],
    "a deploy installs the root's dependencies and does not run its repository-wide check against the runtime"
  );
  assert.equal(planned.has("projects/fluffles-site"), false, "a package that opts out of the runtime is not installed on the mini");
});

test("deploy-main treats the runtime memory surface as runtime-owned", () => {
  for (const pattern of [
    "'memory/????-??-??.md'",
    "'memory/MEMORY.md'",
    "'memory/people.md'",
    "'memory/PROMOTIONS.md'",
    "'memory/wiki/*'",
    "'memory/quarantine/*'"
  ]) {
    assert.ok(deployer.includes(pattern), `deploys must never overwrite or delete ${pattern}`);
  }
});

test("deploy-main syncs changed system daemon manifests through the canonical installer", () => {
  assert.match(deployer, /sync_system_daemons "\$candidate"/);
  assert.match(deployer, /sudo -n env "\$\{installer_env\[@\]\}" "\$installer" --stage-only/, "deploys stage daemon manifests without reloading services mid-sync");
  assert.match(deployer, /env "\$\{installer_env\[@\]\}" "\$installer" --check/);
  assert.match(installer, /--stage-only/);
  assert.match(installer, /--changed-only/);
  assert.match(installer, /"\$label" == \*"\.harness\.deploy-main"/);
  assert.match(installer, /staged for next reload/);
});

test("daemon manifests sync wherever the services are installed, GUI session or not", () => {
  const body = deployer.slice(deployer.indexOf("sync_system_daemons() {"), deployer.indexOf("sync_launchd_files() {"));
  assert.doesNotMatch(body, /launchctl print "gui\//, "a GUI session does not mean the services are agents");
  assert.match(body, /if ! system_daemons_installed; then\n    return 0\n  fi/);

  const helper = deployer.slice(deployer.indexOf("system_daemons_installed() {"), deployer.indexOf("sync_system_daemons() {"));
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-daemons-"));
  try {
    const ask = (daemonRoot: string, domain: string) =>
      childProcess.execFileSync("bash", ["-c", [
        "set -euo pipefail",
        `system_daemon_root=${JSON.stringify(daemonRoot)}`,
        `supervisor_domain=${JSON.stringify(domain)}`,
        "service_labels=(com.puffle.fluffles.channel.slack com.puffle.harness.webhooks)",
        helper,
        "if system_daemons_installed; then echo installed; else echo absent; fi"
      ].join("\n")], { encoding: "utf8" }).trim();

    assert.equal(ask(fixture, "system"), "absent");
    fs.writeFileSync(path.join(fixture, "com.puffle.harness.webhooks.plist"), "");
    assert.equal(ask(fixture, "system"), "installed");
    // A host whose services are its own agents has nothing in the system
    // domain, whatever files happen to sit in that directory.
    assert.equal(ask(fixture, "user"), "absent");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("rollback reinstalls the restored tree's daemon manifests before starting services", () => {
  const body = deployer.slice(deployer.indexOf("rollback() {"), deployer.indexOf("admission_must_remain_blocked=1\nif ! task_control"));
  const restore = body.indexOf('sync_system_daemons "$candidate" "$home"');
  assert.ok(restore > 0, "a rollback that leaves the failed candidate's manifests installed restarts the failed release");
  assert.ok(restore < body.indexOf("if ! start_services; then"), "manifests are restored before the services are bootstrapped from them");
});

test("deploy-main exactly syncs managed paths without deleting excluded runtime files", () => {
  assert.match(deployer, /rsync_options\+=\(--checksum --delete\)/);
  assert.doesNotMatch(deployer, /--delete-excluded/);
  assert.match(deployer, /smoke" --quiet --deploy/);
});

test("deploy-main records a managed manifest and checks it before backing up or applying", () => {
  const manifest = deployer.indexOf('write_managed_manifest "$candidate" "$candidate_manifest" "$target"');
  const drift = deployer.indexOf('check_managed_drift "$manifest" "$home"');
  const backup = deployer.indexOf('copy_managed "$home" "$backup"');
  const apply = deployer.indexOf('sync_managed_exact "$candidate" "$home"');
  assert.ok(manifest >= 0 && manifest < drift, "candidate manifest must exist before drift detection");
  assert.ok(drift >= 0 && drift < backup, "drift must be handled before the backup and apply steps");
  assert.ok(backup >= 0 && backup < apply, "existing backup behavior must remain before live apply");
  assert.match(deployer, /manifestPath/);
  assert.match(deployer, /manifestSha/);
});

test("deploy-main verifies the managed runtime before skipping an up-to-date receipt", () => {
  const skip = deployer.indexOf('if [[ "$repair_required" != "1" && "$recorded" == "$target" ]]; then');
  const verify = deployer.indexOf('verify_runtime_for_skip "$manifest" "$home" "$target"');
  const repair = deployer.indexOf("repair_required=1", skip);
  const apply = deployer.indexOf('sync_managed_exact "$candidate" "$home"');
  assert.ok(skip >= 0 && verify > skip, "the SHA-only skip condition must verify the runtime");
  assert.ok(repair > verify && repair < apply, "runtime drift must continue into the existing exact-sync repair path");
});

test("deploy-main preserves drifted managed file content in the quarantine", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-quarantine-"));
  const runtime = path.join(fixture, "runtime");
  const quarantineRoot = path.join(fixture, "quarantine");
  const changes = path.join(fixture, "managed-changes.json");
  const quote = (value: string) => JSON.stringify(value);
  const helper = deployer.slice(deployer.indexOf("quarantine_managed_drift() {"), deployer.indexOf("# Preserve any local commits"));

  try {
    fs.mkdirSync(path.join(runtime, "channels", "slack"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "channels", "slack", "modified.ts"), "live edit\n");
    fs.writeFileSync(path.join(runtime, "channels", "slack", "untracked.ts"), "only live\n");
    fs.symlinkSync("modified.ts", path.join(runtime, "channels", "slack", "live-link.ts"));
    fs.writeFileSync(changes, JSON.stringify({
      added: ["channels/slack/removed-live.ts"],
      modified: ["channels/slack/modified.ts", "channels/slack/live-link.ts"],
      deleted: ["channels/slack/untracked.ts", "channels/slack/already-gone.ts"]
    }));

    const output = childProcess.execFileSync("bash", ["-c", [
      "set -euo pipefail",
      `node=${quote(process.execPath)}`,
      `home=${quote(runtime)}`,
      `changes=${quote(changes)}`,
      `quarantine_root=${quote(quarantineRoot)}`,
      'quarantine_path=""',
      helper,
      "quarantine_managed_drift",
      'echo "$quarantine_path"'
    ].join("\n")], { encoding: "utf8" }).trim();

    assert.ok(output.startsWith(quarantineRoot), "the quarantine path must live under the quarantine root");
    assert.equal(fs.readFileSync(path.join(output, "channels", "slack", "modified.ts"), "utf8"), "live edit\n");
    assert.equal(fs.readFileSync(path.join(output, "channels", "slack", "untracked.ts"), "utf8"), "only live\n");
    assert.equal(fs.readlinkSync(path.join(output, "channels", "slack", "live-link.ts")), "modified.ts");
    assert.equal(fs.existsSync(path.join(output, "channels", "slack", "already-gone.ts")), false, "missing live files are skipped");
    assert.equal(fs.existsSync(path.join(output, "channels", "slack", "removed-live.ts")), false, "locally removed files have no live content to preserve");
    assert.ok(fs.existsSync(path.join(output, "managed-changes.json")), "the change plan is preserved with the quarantined files");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "modified.ts"), "utf8"), "live edit\n", "quarantining never mutates the live tree");

    assert.throws(() => childProcess.execFileSync("bash", ["-c", [
      "set -euo pipefail",
      `node=${quote(process.execPath)}`,
      `home=${quote(runtime)}`,
      `changes=${quote(path.join(fixture, "missing.json"))}`,
      `quarantine_root=${quote(quarantineRoot)}`,
      'quarantine_path=""',
      helper,
      "quarantine_managed_drift"
    ].join("\n")], { encoding: "utf8", stdio: "pipe" }), "a quarantine that cannot preserve content must fail");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("deploy-main converges the source checkout onto origin/main while preserving local work", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-converge-"));
  const repo = path.join(fixture, "source");
  const remote = path.join(fixture, "origin.git");
  const quarantineRoot = path.join(fixture, "quarantine");
  const quote = (value: string) => JSON.stringify(value);
  const helper = deployer.slice(deployer.indexOf("converge_source_checkout() {"), deployer.indexOf("# Everything up to the handoff is the launcher's"));

  try {
    run("git", ["init", "-b", "main", repo]);
    run("git", ["-C", repo, "config", "user.email", "deploy-test@example.invalid"]);
    run("git", ["-C", repo, "config", "user.name", "deploy test"]);
    fs.writeFileSync(path.join(repo, "managed"), "main\n");
    run("git", ["-C", repo, "add", "managed"]);
    run("git", ["-C", repo, "commit", "-m", "main"]);
    run("git", ["init", "--bare", remote]);
    run("git", ["-C", repo, "remote", "add", "origin", remote]);
    run("git", ["-C", repo, "push", "-u", "origin", "main"]);
    const mainSha = run("git", ["-C", repo, "rev-parse", "HEAD"]).trim();

    run("git", ["-C", repo, "checkout", "-b", "feature/unmerged"]);
    fs.writeFileSync(path.join(repo, "managed"), "feature commit\n");
    run("git", ["-C", repo, "add", "managed"]);
    run("git", ["-C", repo, "commit", "-m", "feature"]);
    const featureSha = run("git", ["-C", repo, "rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(repo, "managed"), "uncommitted edit\n");
    fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked\n");

    childProcess.execFileSync("bash", ["-c", [
      "set -euo pipefail",
      `repo=${quote(repo)}`,
      `quarantine_root=${quote(quarantineRoot)}`,
      // The ref is the host's, not a constant in the deployer.
      'deploy_ref="origin/main"',
      'deploy_branch="main"',
      helper,
      "git -C \"$repo\" fetch --prune origin main",
      "converge_source_checkout"
    ].join("\n")], { encoding: "utf8", stdio: "pipe" });

    assert.equal(run("git", ["-C", repo, "branch", "--show-current"]).trim(), "main", "the checkout ends on main");
    assert.equal(run("git", ["-C", repo, "rev-parse", "HEAD"]).trim(), mainSha, "the checkout ends at origin/main");
    assert.equal(run("git", ["-C", repo, "status", "--porcelain"]).trim(), "", "the checkout ends clean");
    assert.equal(fs.readFileSync(path.join(repo, "managed"), "utf8"), "main\n");

    const quarantines = fs.readdirSync(quarantineRoot).filter((name) => name.endsWith("-checkout"));
    assert.equal(quarantines.length, 1, "uncommitted work is preserved in exactly one quarantine");
    const preserved = path.join(quarantineRoot, quarantines[0]);
    assert.match(fs.readFileSync(path.join(preserved, "uncommitted.patch"), "utf8"), /uncommitted edit/);
    assert.equal(fs.readFileSync(path.join(preserved, "untracked", "untracked.txt"), "utf8"), "untracked\n");
    const quarantineBranches = run("git", ["-C", repo, "branch", "--list", "quarantine/*", "--format=%(objectname)"]).trim().split("\n");
    assert.deepEqual(quarantineBranches, [featureSha], "unmerged local commits are preserved on a quarantine branch");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("deploy-main heals the production stale-manifest state through the existing deployment path", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-stale-manifest-"));
  const previous = path.join(fixture, "previous");
  const candidate = path.join(fixture, "candidate");
  const runtime = path.join(fixture, "runtime");
  const backup = path.join(fixture, "backup");
  const manifest = path.join(fixture, "managed-manifest.json");
  const candidateManifest = path.join(fixture, "candidate-manifest.json");
  const runtimeManifest = path.join(fixture, "runtime-manifest.json");
  const receipt = path.join(fixture, "last-run.json");
  const manifestStage = path.join(fixture, "manifest-stage");
  const changes = path.join(fixture, "changes.json");
  const target = "a".repeat(40);
  const quote = (value: string) => JSON.stringify(value);
  const receiptHelpers = deployer.slice(deployer.indexOf("write_receipt() {"), deployer.indexOf("deployment_lifecycle_state() {"));
  const manifestHelpers = deployer.slice(deployer.indexOf("manifest_sha_for() {"), deployer.indexOf("install_dependencies() {"));

  try {
    const script = [
      "set -euo pipefail",
      "node=" + quote(process.execPath),
      "receipt=" + quote(receipt),
      "changes=" + quote(changes),
      "manifest_stage=" + quote(manifestStage),
      "runtime_manifest=" + quote(runtimeManifest),
      "manifest=" + quote(manifest),
      "repo=" + quote(path.join(fixture, "source")),
      "host_name=test",
      'alert_channel="#deploy-test"',
      receiptHelpers,
      manifestHelpers,
      "mkdir -p " + quote(path.join(previous, "bin")) + " " + quote(path.join(candidate, "bin")),
      "printf previous\\n > " + quote(path.join(previous, "bin", "managed")),
      "printf candidate\\n > " + quote(path.join(candidate, "bin", "managed")),
      "write_managed_manifest " + quote(previous) + " " + quote(manifest) + " " + quote("b".repeat(40)),
      "copy_managed " + quote(candidate) + " " + quote(runtime),
      "write_managed_manifest " + quote(candidate) + " " + quote(candidateManifest) + " " + quote(target),
      "printf '{\"ok\":false,\"status\":\"drift_detected\"}\\n' > " + quote(receipt),
      "test -z \"$(receipt_deployed_sha)\"",
      "if check_managed_drift " + quote(manifest) + " " + quote(runtime) + "; then exit 1; else test \"$?\" = 1; fi",
      "runtime_matches_manifest " + quote(candidateManifest) + " " + quote(runtime),
      "write_managed_manifest " + quote(runtime) + " " + quote(runtimeManifest) + " " + quote(target),
      "write_managed_changes " + quote(runtimeManifest) + " " + quote(candidateManifest) + " " + quote(changes),
      "test \"$(managed_changes_count " + quote(changes) + ")\" = 0",
      "copy_managed " + quote(runtime) + " " + quote(backup),
      "cp " + quote(manifest) + " " + quote(path.join(backup, "managed-manifest.json")),
      "sync_managed_exact " + quote(candidate) + " " + quote(runtime) + " " + quote(runtimeManifest) + " " + quote(candidateManifest),
      "runtime_matches_manifest " + quote(candidateManifest) + " " + quote(runtime),
      "persist_manifest " + quote(candidateManifest) + " " + quote(manifest),
      "test \"$(manifest_sha_for " + quote(manifest) + ")\" = \"$(manifest_sha_for " + quote(candidateManifest) + ")\"",
      "current=" + quote(target),
      "manifest_sha=$(manifest_sha_for " + quote(manifest) + ")",
      "drift_detected=false",
      "drift_count=0",
      "drain_forced=false",
      'quarantine_path=""',
      "write_receipt true deployed \"$current\" \"$current\" \"$current\" false recovered",
      process.execPath + " -e " + quote(`const value = require(${JSON.stringify(receipt)}); if (!value.ok || value.status !== "deployed" || value.deployedSha !== ${JSON.stringify(target)}) process.exit(1);`)
    ].join("\n");
    childProcess.execFileSync("bash", ["-c", script], { stdio: "pipe" });
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// The launcher reads admission state out of the ledger rather than out of the
// release's own cli, so a fixture runtime needs the one table it reads.
function writeLifecycleLedger(home: string, state = "normal") {
  fs.mkdirSync(path.join(home, "state", "tasks"), { recursive: true });
  const ledger = new DatabaseSync(path.join(home, "state", "tasks", "tasks.sqlite"));
  ledger.exec("CREATE TABLE IF NOT EXISTS deployment_lifecycle (id INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)");
  ledger.prepare("INSERT OR REPLACE INTO deployment_lifecycle (id, state, updated_at) VALUES (1, ?, '2026-01-01T00:00:00.000Z')").run(state);
  ledger.close();
  return path.join(home, "state", "tasks", "tasks.sqlite");
}

test("deploy-main deploys, skips when up to date, and converges drift through the quarantine", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-integration-"));
  const repo = path.join(fixture, "source");
  const remote = path.join(fixture, "origin.git");
  const home = path.join(fixture, "home");
  const previous = path.join(fixture, "previous");
  const state = path.join(home, "state", "deploy-main");
  const receipt = path.join(state, "last-run.json");
  const manifest = path.join(state, "managed-manifest.json");
  const taskLog = path.join(fixture, "task-control.log");
  // The deployer under test sits beside a deploy/ directory, the way the
  // installed one does, outside the managed tree it rewrites.
  const installed = path.join(fixture, "installed");
  const runner = path.join(installed, "bin", "deploy-main");

  try {
    run("git", ["init", "-b", "main", repo]);
    run("git", ["-C", repo, "config", "user.email", "deploy-test@example.invalid"]);
    run("git", ["-C", repo, "config", "user.name", "deploy test"]);
    fs.mkdirSync(path.join(repo, "bin"), { recursive: true });
    fs.mkdirSync(path.join(repo, "deploy", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, "bin", "deploy-main"), deployer, { mode: 0o755 });
    fs.writeFileSync(path.join(repo, "bin", "managed"), "candidate\n");
    fs.writeFileSync(path.join(repo, "bin", "automations"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(repo, "bin", "smoke"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(path.join(repo, "deploy", "scripts", "verify-source.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
    run("git", ["-C", repo, "add", "."]);
    run("git", ["-C", repo, "commit", "-m", "candidate"]);
    run("git", ["init", "--bare", remote]);
    run("git", ["-C", repo, "remote", "add", "origin", remote]);
    run("git", ["-C", repo, "push", "-u", "origin", "main"]);

    fs.mkdirSync(path.join(home, "bin"), { recursive: true });
    fs.cpSync(path.join(repo, "bin"), path.join(home, "bin"), { recursive: true });
    writeLifecycleLedger(home);
    fs.mkdirSync(path.join(previous, "bin"), { recursive: true });
    fs.cpSync(path.join(repo, "bin"), path.join(previous, "bin"), { recursive: true });
    fs.writeFileSync(path.join(previous, "bin", "managed"), "previous\n");
    fs.mkdirSync(state, { recursive: true });
    const previousSha = "b".repeat(40);
    fs.writeFileSync(manifest, `${JSON.stringify(manifestFor(previous, previousSha), null, 2)}\n`);
    fs.writeFileSync(receipt, "{\"ok\":false,\"status\":\"drift_detected\"}\n");

    // The deployer takes its paths from a host file, so the fixture is a host
    // whose home and repo are inside the temporary directory.
    installDeploySource(installed);
    installDeploySource(repo);
    run("git", ["-C", repo, "add", "."]);
    run("git", ["-C", repo, "commit", "-m", "release carries its own deploy shape"]);
    run("git", ["-C", repo, "push", "origin", "main"]);
    const hostFile = writeHostFile(path.join(fixture, "host.json"), { home, repo });

    let harness = deployer;
    harness = replaceShellFunction(harness, "task_control", `task_control() {
  case "$1" in
    status) printf '%s' '{"lifecycle":{"state":"normal"}}' ;;
    set) printf 'set:%s\\n' "$2" >>"$DEPLOY_TEST_TASK_LOG" ;;
    wait-idle) printf 'wait-idle\\n' >>"$DEPLOY_TEST_TASK_LOG" ;;
  esac
}
`);
    harness = replaceShellFunction(harness, "sync_launchd_files", `sync_launchd_files() {
  printf 'sync-launchd\\n' >>"$DEPLOY_TEST_TASK_LOG"
}
`);
    harness = replaceShellFunction(harness, "install_dependencies", `install_dependencies() {
  printf 'install-dependencies\\n' >>"$DEPLOY_TEST_TASK_LOG"
}
`);
    harness = replaceShellFunction(harness, "stop_services", `stop_services() {
  printf 'stop-services\\n' >>"$DEPLOY_TEST_TASK_LOG"
}
`);
    harness = replaceShellFunction(harness, "start_services", `start_services() {
  printf 'start-services\\n' >>"$DEPLOY_TEST_TASK_LOG"
}
`);
    // Proving the declared Infisical paths needs the vault this fixture has no
    // identity for; that the proof happens, and happens before the services
    // start, is what the log records.
    harness = replaceShellFunction(harness, "preflight_secret_paths", `preflight_secret_paths() {
  printf 'preflight-secrets\\n' >>"$DEPLOY_TEST_TASK_LOG"
}
`);
    fs.mkdirSync(path.dirname(runner), { recursive: true });
    fs.writeFileSync(runner, harness, { mode: 0o755 });

    const environment = {
      ...process.env,
      HOME: home,
      FLUFFLES_HOST_FILE: hostFile,
      DEPLOY_NODE: process.execPath,
      DEPLOY_TEST_TASK_LOG: taskLog
    };
    const first = run("bash", [runner], { env: environment });
    const firstReceipt = JSON.parse(fs.readFileSync(receipt, "utf8"));
    const candidateSha = run("git", ["-C", repo, "rev-parse", "HEAD"]).trim();
    const manifestAfterFirst = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const firstLog = fs.readFileSync(taskLog, "utf8");

    assert.doesNotMatch(first, /drift_detected/);
    assert.equal(firstReceipt.ok, true);
    assert.equal(firstReceipt.status, "deployed");
    assert.equal(firstReceipt.deployedSha, candidateSha);
    assert.equal(manifestAfterFirst.deployedSha, candidateSha);
    assert.notEqual(manifestAfterFirst.manifestSha, manifestFor(previous, previousSha).manifestSha);
    assert.match(firstLog, /set:draining\nwait-idle\nset:deploying/);
    assert.match(firstLog, /set:restarting\nstop-services\nsync-launchd\ninstall-dependencies\npreflight-secrets\nstart-services\nset:normal/);

    const second = run("bash", [runner], { env: environment });
    const secondReceipt = JSON.parse(fs.readFileSync(receipt, "utf8"));

    assert.match(second, new RegExp(`deploy-main: up to date at ${candidateSha}`));
    assert.equal(secondReceipt.ok, true);
    assert.equal(secondReceipt.status, "up_to_date");
    assert.equal(fs.readFileSync(taskLog, "utf8"), firstLog, "the second cycle must not drain, apply, restart, or use recovery");

    fs.writeFileSync(path.join(repo, "bin", "managed"), "reviewed candidate\n");
    run("git", ["-C", repo, "add", "bin/managed"]);
    run("git", ["-C", repo, "commit", "-m", "reviewed candidate"]);
    run("git", ["-C", repo, "push", "origin", "main"]);
    fs.writeFileSync(path.join(home, "bin", "managed"), "manual runtime change\n");

    const convergedSha = run("git", ["-C", repo, "rev-parse", "HEAD"]).trim();
    const converged = run("bash", [runner], { env: environment });
    const convergedReceipt = JSON.parse(fs.readFileSync(receipt, "utf8"));
    const convergedManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const convergeLog = fs.readFileSync(taskLog, "utf8").slice(firstLog.length);

    assert.equal(convergedReceipt.ok, true);
    assert.equal(convergedReceipt.status, "deployed");
    assert.equal(convergedReceipt.deployedSha, convergedSha);
    assert.equal(convergedReceipt.driftDetected, true, "the receipt records that live drift was found");
    assert.ok(convergedReceipt.quarantinePath, "the receipt records where the drifted files were preserved");
    assert.equal(convergedManifest.deployedSha, convergedSha, "the drifted runtime converges to merged main");
    assert.equal(fs.readFileSync(path.join(home, "bin", "managed"), "utf8"), "reviewed candidate\n");
    assert.equal(
      fs.readFileSync(path.join(convergedReceipt.quarantinePath, "bin", "managed"), "utf8"),
      "manual runtime change\n",
      "the manual edit is preserved in the quarantine before being overwritten"
    );
    assert.match(converged, new RegExp(`deploy-main: deployed ${convergedSha}`));
    assert.match(convergeLog, /set:draining\nwait-idle\nset:deploying/);
    assert.match(convergeLog, /set:restarting\nstop-services\nsync-launchd\ninstall-dependencies\npreflight-secrets\nstart-services\nset:normal/);

    fs.writeFileSync(path.join(repo, "deploy", "scripts", "verify-source.sh"), "#!/usr/bin/env bash\nexit 1\n");
    fs.writeFileSync(path.join(repo, "bin", "managed"), "verification must block\n");
    run("git", ["-C", repo, "add", "bin/managed", "deploy/scripts/verify-source.sh"]);
    run("git", ["-C", repo, "commit", "-m", "failing candidate verification"]);
    run("git", ["-C", repo, "push", "origin", "main"]);
    fs.writeFileSync(path.join(home, "bin", "managed"), "manual runtime change again\n");

    const verificationFailure = childProcess.spawnSync("bash", [runner], { env: environment, encoding: "utf8" });
    assert.equal(verificationFailure.status, 1);
    assert.equal(JSON.parse(fs.readFileSync(receipt, "utf8")).status, "verification_failed");
    assert.equal(fs.readFileSync(path.join(home, "bin", "managed"), "utf8"), "manual runtime change again\n", "a failed candidate never touches the live runtime");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("deploy-main recovers an interrupted deployment before considering a verified skip", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-recovery-"));
  const quote = (value: string) => JSON.stringify(value);
  const lifecycleHelper = deployer.slice(deployer.indexOf("deployment_lifecycle_state() {"), deployer.indexOf("manifest_sha_for() {"));
  const recoveryGate = deployer.slice(deployer.indexOf('if ! prior_lifecycle="$(deployment_lifecycle_state)"; then'), deployer.indexOf('git -C "$repo" worktree prune'));
  const forcedDrain = deployer.slice(deployer.indexOf("drain_active=1"), deployer.indexOf("if ! task_control set deploying"));

  try {
    writeLifecycleLedger(fixture, "restarting");
    const output = childProcess.execFileSync("bash", ["-c", [
      "set -euo pipefail",
      `node=${quote(process.execPath)}`,
      `home=${quote(fixture)}`,
      "write_receipt() { :; }",
      "notify_failure() { :; }",
      "verify_runtime_for_skip() { echo verifier-called; return 0; }",
      "current=target",
      "target=target",
      "recorded=target",
      "repair_required=0",
      "admission_must_remain_blocked=0",
      lifecycleHelper,
      recoveryGate,
      "echo repair_required=${repair_required} admission_must_remain_blocked=${admission_must_remain_blocked}"
    ].join("\n")], { encoding: "utf8" });
    assert.equal(output.trim(), "repair_required=1 admission_must_remain_blocked=1", "an interrupted lifecycle must bypass the receipt-based skip and keep admission fail-closed until recovery completes");
    assert.match(deployer, /write_receipt false verifying "\$current" "\$target" "" false/, "pre-smoke receipts must never be successful deployment receipts");
    assert.match(deployer, /if \[\[ "\$repair_required" != "1" && "\$recorded" == "\$target"/, "a non-normal lifecycle must block the verified skip gate");
    assert.match(deployer, /if ! persist_manifest "\$candidate_manifest" "\$manifest"; then[\s\S]*?fi\nmanifest_sha="\$candidate_manifest_sha"/, "the receipt manifest identity advances only after the manifest is persisted");

    const drainTimeout = childProcess.spawnSync("bash", ["-c", [
      "set -euo pipefail",
      "drain_forced=false",
      "drain_timeout_ms=1",
      "drain_interval_ms=1",
      "task_control() { [[ \"$1\" == wait-idle ]] && return 1; return 0; }",
      forcedDrain,
      "echo drain_forced=${drain_forced}"
    ].join("\n")], { encoding: "utf8" });
    assert.equal(drainTimeout.status, 0, "a drain timeout no longer aborts the deployment");
    assert.match(drainTimeout.stdout, /drain_forced=true/, "a forced drain is recorded so the receipt can report it");
    assert.match(drainTimeout.stderr, /recovered as interrupted after restart/, "remaining runs are recovered as interrupted work");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("deploy-main propagates admission, manifest, deletion, and rsync helper failures", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-failure-"));
  const source = path.join(fixture, "source");
  const destination = path.join(fixture, "destination");
  const manifestStage = path.join(fixture, "manifest-stage");
  const blockedOutputParent = path.join(fixture, "not-a-directory");
  const fakeBin = path.join(fixture, "fake-bin");
  const deletionRuntime = path.join(fixture, "deletion-runtime");
  const currentManifest = path.join(fixture, "current-manifest.json");
  const desiredManifest = path.join(fixture, "desired-manifest.json");
  const quote = (value: string) => JSON.stringify(value);
  const helpers = deployer.slice(
    deployer.indexOf("receipt_manifest_sha() {"),
    deployer.indexOf("install_dependencies() {")
  );
  const resume = deployer.slice(deployer.indexOf("resume_normal() {"), deployer.indexOf("cleanup() {"));

  try {
    fs.mkdirSync(path.join(source, "channels", "slack"), { recursive: true });
    fs.writeFileSync(path.join(source, "channels", "slack", "managed.ts"), "managed\n");
    fs.writeFileSync(blockedOutputParent, "blocked\n");
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, "rsync"), "#!/usr/bin/env bash\nexit 42\n", { mode: 0o755 });
    fs.mkdirSync(path.join(deletionRuntime, "channels", "slack", "removed.ts"), { recursive: true });
    fs.writeFileSync(currentManifest, JSON.stringify({ version: 1, entries: [{ path: "channels/slack/removed.ts", type: "file", sha256: "unused" }] }));
    fs.writeFileSync(desiredManifest, JSON.stringify({ version: 1, entries: [] }));

    const run = (commands: string, pathPrefix = process.env.PATH || "") => childProcess.execFileSync("bash", ["-c", commands], {
      encoding: "utf8",
      env: { ...process.env, PATH: pathPrefix },
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();

    assert.equal(run([
      "set -euo pipefail",
      "drain_active=1",
      "task_control() { return 23; }",
      resume,
      "if resume_normal; then echo unexpected; else echo admission-failed; fi",
      "echo drain_active=${drain_active}"
    ].join("\n")), "admission-failed\ndrain_active=1");

    assert.equal(run([
      "set -euo pipefail",
      `node=${quote(process.execPath)}`,
      `manifest_stage=${quote(manifestStage)}`,
      helpers,
      `if write_managed_manifest ${quote(source)} ${quote(path.join(blockedOutputParent, "manifest.json"))} source; then echo unexpected; else echo manifest-failed; fi`
    ].join("\n")), "manifest-failed");

    assert.equal(run([
      "set -euo pipefail",
      `node=${quote(process.execPath)}`,
      `manifest_stage=${quote(manifestStage)}`,
      helpers,
      `if copy_managed ${quote(source)} ${quote(destination)}; then echo unexpected; else echo rsync-failed; fi`
    ].join("\n"), `${fakeBin}:${process.env.PATH || ""}`), "rsync-failed");

    assert.equal(run([
      "set -euo pipefail",
      `node=${quote(process.execPath)}`,
      `manifest_stage=${quote(manifestStage)}`,
      helpers,
      `if sync_managed_exact ${quote(source)} ${quote(deletionRuntime)} ${quote(currentManifest)} ${quote(desiredManifest)}; then echo unexpected; else echo deletion-failed; fi`
    ].join("\n")), "deletion-failed");

    const finalResume = deployer.lastIndexOf("if ! resume_normal; then");
    const deployedReceipt = deployer.lastIndexOf('write_receipt true deployed');
    assert.ok(finalResume >= 0 && finalResume < deployedReceipt, "deployment must reopen admission before writing its successful receipt");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("deploy-main recovers only stale locks and preserves mutual exclusion", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-lock-"));
  const lockDir = path.join(fixture, "lock");
  const lockDb = path.join(fixture, "lock.sqlite");
  const goFile = path.join(fixture, "go");
  const lockHelpers = deployer.slice(deployer.indexOf("lock_command() {"), deployer.indexOf('if lock_token="$(lock_command acquire)"; then'));
  const quote = (value: string) => JSON.stringify(value);
  const setup = [
    `node=${quote(process.execPath)}`,
    `lock_dir=${quote(lockDir)}`,
    `lock_owner_file=${quote(path.join(lockDir, "owner.pid"))}`,
    `lock_db=${quote(lockDb)}`,
    "lock_recovery_grace_seconds=0",
    lockHelpers
  ].join("\n");
  const holder = childProcess.spawn("bash", ["-c", `${setup}\nlock_token="$(lock_command acquire)"\necho acquired\nexec sleep 30`], { stdio: ["ignore", "pipe", "pipe"] });

  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      holder.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("acquired\n")) resolve();
      });
      holder.once("error", reject);
      holder.once("exit", (code) => reject(new Error(`lock holder exited ${code} before acquiring`)));
    });

    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));

    const contenderScript = [
      setup,
      `while [[ ! -f ${quote(goFile)} ]]; do sleep 0.01; done`,
      "if lock_token=\"$(lock_command acquire)\"; then",
      "  echo acquired",
      "  sleep 0.5",
      "  IFS=$'\\t' read -r owner_pid owner_started owner_token < \"$lock_owner_file\"",
      "  if [[ \"$owner_token\" == \"$lock_token\" ]]; then echo owner-intact; else echo owner-lost; fi",
      "  lock_command release \"$lock_token\"",
      "else",
      "  lock_status=$?",
      "  echo busy:${lock_status}",
      "fi"
    ].join("\n");
    const contenders = [
      childProcess.spawn("bash", ["-c", contenderScript], { stdio: ["ignore", "pipe", "pipe"] }),
      childProcess.spawn("bash", ["-c", contenderScript], { stdio: ["ignore", "pipe", "pipe"] })
    ];
    fs.writeFileSync(goFile, "go\n");
    const outputs = await Promise.all(contenders.map((contender) => new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      contender.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      contender.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      contender.once("error", reject);
      contender.once("exit", (code) => {
        if (code === 0) resolve(stdout.trim());
        else reject(new Error(`lock contender exited ${code}: ${stderr}`));
      });
    })));
    assert.equal(outputs.filter((output) => output.includes("acquired")).length, 1, "exactly one contender recovers the stale lock");
    assert.equal(outputs.filter((output) => output === "busy:75").length, 1, "the other contender observes the recovered live lock");
    assert.equal(outputs.filter((output) => output.includes("owner-intact")).length, 1, "concurrent recovery cannot replace the winner's ownership");
    assert.equal(fs.existsSync(lockDir), false, "the owner releases only its own lock");
  } finally {
    if (!holder.killed) holder.kill("SIGKILL");
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("deploy-main records rollback_failed whenever restoration is incomplete", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-rollback-"));
  const rollback = deployer.slice(deployer.indexOf("rollback() {"), deployer.indexOf("if ! task_control set restarting >/dev/null || ! stop_services; then"));
  const quote = (value: string) => JSON.stringify(value);
  const home = path.join(fixture, "home");
  const backup = path.join(fixture, "backup");
  const manifest = path.join(fixture, "managed-manifest.json");
  const backupManifest = path.join(backup, "managed-manifest.json");
  const admissionLog = path.join(fixture, "admission.log");
  const lifecycleFile = path.join(fixture, "lifecycle");
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  fs.writeFileSync(manifest, "before\n");
  fs.writeFileSync(backupManifest, "restored\n");

  try {
    for (const failure of ["stop", "runtime", "verify", "manifest", "restart", "smoke", "resume"]) {
      const script = [
        "set -euo pipefail",
        `home=${quote(home)}`,
        `backup=${quote(backup)}`,
        `manifest=${quote(manifest)}`,
        `candidate_manifest=${quote(path.join(fixture, "candidate-manifest.json"))}`,
        `runtime_manifest=${quote(path.join(fixture, "runtime-manifest.json"))}`,
        "had_manifest=1",
        "current=previous",
        "target=target",
        "manifest_sha=",
        "drain_active=1",
        "admission_must_remain_blocked=0",
        "smoke_attempts=2",
        "smoke_interval_seconds=0",
        `ROLLBACK_FAILURE=${quote(failure)}`,
        "sync_managed_exact() { [[ \"$ROLLBACK_FAILURE\" != runtime ]]; }",
        "runtime_matches_manifest() { [[ \"$ROLLBACK_FAILURE\" != verify ]]; }",
        "write_managed_manifest() { return 0; }",
        "cp() { if [[ \"$ROLLBACK_FAILURE\" == manifest ]]; then return 1; fi; command cp \"$@\"; }",
        "manifest_sha_for() { echo manifest-sha; }",
        `candidate=${quote(path.join(fixture, "candidate"))}`,
        "sync_launchd_files() { return 0; }",
        "sync_system_daemons() { return 0; }",
        "install_dependencies() { return 0; }",
        "reload_service_labels() { return 0; }",
        "task_control() { return 0; }",
        "stop_services() { [[ \"$ROLLBACK_FAILURE\" != stop ]]; }",
        "start_services() { [[ \"$ROLLBACK_FAILURE\" != restart ]]; }",
        `resume_normal() { echo attempted > ${quote(admissionLog)}; if [[ "$ROLLBACK_FAILURE" == resume ]]; then return 1; fi; echo normal > ${quote(lifecycleFile)}; drain_active=0; }`,
        "write_receipt() { printf '%s\\n' \"$@\"; printf 'manifest_sha=%s\\n' \"$manifest_sha\"; }",
        "notify_failure() { :; }",
        `printf '#!/usr/bin/env bash\\nexit 0\\n' > ${quote(path.join(home, "bin", "automations"))}`,
        `chmod +x ${quote(path.join(home, "bin", "automations"))}`,
        `printf '#!/usr/bin/env bash\\n[[ "$ROLLBACK_FAILURE" != smoke ]]\\n' > ${quote(path.join(home, "bin", "smoke"))}`,
        `chmod +x ${quote(path.join(home, "bin", "smoke"))}`,
        "export ROLLBACK_FAILURE",
        rollback,
        "rollback apply_failed",
        "echo blocked=${admission_must_remain_blocked}"
      ].join("\n");
      fs.rmSync(admissionLog, { force: true });
      fs.rmSync(lifecycleFile, { force: true });
      const output = childProcess.execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim().split("\n");
      assert.equal(output[0], "false");
      assert.equal(output[1], "rollback_failed", `${failure} failure must not claim restoration`);
      assert.equal(output[4], "", "an incomplete rollback must report the deployed state as unknown");
      assert.equal(output[5], "true", "rollback receipt remains marked as a rollback attempt");
      assert.match(output[6] || "", /runtime admission remains blocked/);
      assert.equal(output[7], "manifest_sha=", "an incomplete rollback must not claim a deployed manifest identity");
      assert.equal(output[8], "blocked=1");
      assert.equal(fs.existsSync(lifecycleFile), false, "rollback failure must leave deployment lifecycle blocked");
      assert.equal(fs.existsSync(admissionLog), failure === "resume", "admission reopening is attempted only after complete restoration");
    }

    const success = childProcess.execFileSync("bash", ["-c", [
      "set -euo pipefail",
      `home=${quote(home)}`,
      `backup=${quote(backup)}`,
      `manifest=${quote(manifest)}`,
      `candidate_manifest=${quote(path.join(fixture, "candidate-manifest.json"))}`,
      `runtime_manifest=${quote(path.join(fixture, "runtime-manifest.json"))}`,
      "had_manifest=1",
      "current=previous",
      "target=target",
      "manifest_sha=",
      "drain_active=1",
      "admission_must_remain_blocked=0",
      "smoke_attempts=1",
      "smoke_interval_seconds=0",
      "sync_managed_exact() { return 0; }",
      "runtime_matches_manifest() { return 0; }",
      "write_managed_manifest() { return 0; }",
      "manifest_sha_for() { echo manifest-sha; }",
      `candidate=${quote(path.join(fixture, "candidate"))}`,
      "sync_launchd_files() { return 0; }",
      "sync_system_daemons() { return 0; }",
      "install_dependencies() { return 0; }",
        "reload_service_labels() { return 0; }",
      "task_control() { return 0; }",
      "stop_services() { return 0; }",
      "start_services() { return 0; }",
      `resume_normal() { echo normal > ${quote(lifecycleFile)}; drain_active=0; }`,
      "write_receipt() { printf '%s\\n' \"$@\"; printf 'manifest_sha=%s\\n' \"$manifest_sha\"; }",
      "notify_failure() { :; }",
      `printf '#!/usr/bin/env bash\\nexit 0\\n' > ${quote(path.join(home, "bin", "automations"))}`,
      `chmod +x ${quote(path.join(home, "bin", "automations"))}`,
      rollback,
      "rollback apply_failed",
      "echo blocked=${admission_must_remain_blocked}"
    ].join("\n")], { encoding: "utf8" }).trim().split("\n");
    assert.equal(success[1], "apply_failed", "a complete rollback preserves the original deployment failure status");
    assert.match(success[6] || "", /prior files were restored/);
    assert.equal(success[7], "manifest_sha=manifest-sha", "a complete rollback records the restored manifest identity");
    assert.equal(success[8], "blocked=0");
    assert.equal(fs.readFileSync(lifecycleFile, "utf8").trim(), "normal", "complete rollback reopens admission");
    assert.match(deployer, /if \[\[ "\$drain_active" == "1" && "\$admission_must_remain_blocked" != "1" \]\]; then/);
    assert.match(
      deployer,
      /}\n\nadmission_must_remain_blocked=1\nif ! task_control set restarting >\/dev\/null \|\| ! stop_services; then/,
      "admission becomes fail-closed immediately before the first live runtime mutation"
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("verified skips and manifest-backed repairs require exact runtime equality and receipt-manifest integrity", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-skip-"));
  const candidate = path.join(fixture, "candidate");
  const runtime = path.join(fixture, "runtime");
  const manifest = path.join(fixture, "managed-manifest.json");
  const receipt = path.join(fixture, "last-run.json");
  const candidateManifest = path.join(fixture, "candidate-manifest.json");
  const runtimeManifest = path.join(fixture, "runtime-manifest.json");
  const changes = path.join(fixture, "managed-changes.json");
  const manifestStage = path.join(fixture, "manifest-stage");
  const target = "a".repeat(40);
  const rootDailySummary = path.join(runtime, "memory", "summaries", "daily", "2026-07-24.md");
  const subagentDailySummary = path.join(runtime, "subagents", "example-agent", "memory", "summaries", "daily", "2026-07-24.md");
  const curatedSummary = path.join(runtime, "subagents", "example-agent", "memory", "summaries", "onboarding.md");

  try {
    fs.mkdirSync(path.join(candidate, "channels", "slack"), { recursive: true });
    fs.mkdirSync(path.join(candidate, "memory", "summaries", "daily"), { recursive: true });
    fs.mkdirSync(path.join(candidate, "subagents", "example-agent", "memory", "summaries", "daily"), { recursive: true });
    fs.writeFileSync(path.join(candidate, "channels", "slack", "managed.ts"), "expected\n");
    fs.writeFileSync(path.join(candidate, "channels", "slack", "other.ts"), "other\n");
    fs.writeFileSync(path.join(candidate, "channels", "slack", "renamed-new.ts"), "renamed\n");
    fs.writeFileSync(path.join(candidate, "memory", "summaries", "daily", "2026-07-24.md"), "source daily summary\n");
    fs.writeFileSync(path.join(candidate, "subagents", "example-agent", "memory", "summaries", "daily", "2026-07-24.md"), "source subagent summary\n");
    fs.writeFileSync(path.join(candidate, "subagents", "example-agent", "memory", "summaries", "onboarding.md"), "reviewed onboarding\n");
    fs.symlinkSync("managed.ts", path.join(candidate, "channels", "slack", "managed-link.ts"));

    const helpers = deployer.slice(
      deployer.indexOf("receipt_manifest_sha() {"),
      deployer.indexOf("install_dependencies() {")
    );
    const quote = (value: string) => JSON.stringify(value);
    const setup = [
      "set -euo pipefail",
      `node=${quote(process.execPath)}`,
      `manifest_stage=${quote(manifestStage)}`,
      `receipt=${quote(receipt)}`,
      `runtime_manifest=${quote(runtimeManifest)}`,
      `changes=${quote(changes)}`,
      `manifest=${quote(manifest)}`,
      "manifest_sha=",
      "drift_detected=false",
      "drift_count=0",
      helpers,
      `copy_managed ${quote(candidate)} ${quote(runtime)} true`,
      `write_managed_manifest ${quote(candidate)} ${quote(candidateManifest)} ${quote(target)}`,
      `cp ${quote(candidateManifest)} ${quote(manifest)}`,
      `mkdir -p ${quote(path.dirname(rootDailySummary))} ${quote(path.dirname(subagentDailySummary))}`,
      `printf 'runtime daily summary\\n' > ${quote(rootDailySummary)}`,
      `printf 'runtime subagent summary\\n' > ${quote(subagentDailySummary)}`,
      `${quote(process.execPath)} -e ${quote("const crypto=require('node:crypto');const fs=require('node:fs');const file=process.argv[1];const value=JSON.parse(fs.readFileSync(file,'utf8'));for(const [entryPath,entryFile] of [[process.argv[2],process.argv[3]],[process.argv[4],process.argv[5]]]) value.entries.push({path:entryPath,type:'file',sha256:crypto.createHash('sha256').update(fs.readFileSync(entryFile)).digest('hex')});value.entries.sort((left,right)=>left.path.localeCompare(right.path));value.manifestSha=crypto.createHash('sha256').update(JSON.stringify(value.entries)).digest('hex');fs.writeFileSync(file,JSON.stringify(value));")} ${quote(manifest)} ${quote("memory/summaries/daily/2026-07-24.md")} ${quote(rootDailySummary)} ${quote("subagents/example-agent/memory/summaries/daily/2026-07-24.md")} ${quote(subagentDailySummary)}`,
      `${quote(process.execPath)} -e ${quote("const fs=require('node:fs');const [manifest,receipt,target]=process.argv.slice(1);const value=JSON.parse(fs.readFileSync(manifest,'utf8'));fs.writeFileSync(receipt,JSON.stringify({ok:true,deployedSha:target,manifestSha:value.manifestSha}));")} ${quote(manifest)} ${quote(receipt)} ${quote(target)}`,
      "verify_status() { if verify_runtime_for_skip \"$1\" \"$2\" \"$3\"; then echo verified; else status=$?; echo status:${status}; fi; }",
      "repair() {",
      `  write_managed_manifest ${quote(runtime)} ${quote(runtimeManifest)} runtime`,
      `  sync_managed_exact ${quote(candidate)} ${quote(runtime)} ${quote(runtimeManifest)} ${quote(candidateManifest)}`,
      "}"
    ].join("\n");
    const runLegacy = (commands: string) => childProcess.execFileSync("bash", ["-c", `${setup}\n${commands}`], { encoding: "utf8" });
    const run = (commands: string) => runLegacy(`migrate_manifest_ownership ${quote(manifest)} ${quote(receipt)}\n${commands}`);

    // A legacy manifest incorrectly treats the generated summaries as deleted managed files.
    assert.equal(runLegacy(`verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`).trim(), "status:1");

    // Daily summaries are runtime-owned, while non-date summaries remain part of the source manifest.
    assert.equal(fs.existsSync(rootDailySummary), true);
    assert.equal(fs.existsSync(subagentDailySummary), true);
    assert.equal(fs.readFileSync(curatedSummary, "utf8"), "reviewed onboarding\n");
    assert.equal(
      run(`verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`).trim(),
      "verified"
    );
    assert.equal(
      run(`runtime_matches_manifest ${quote(candidateManifest)} ${quote(runtime)}`).trim(),
      "",
      "only an exact managed runtime tree can be recognized as an already-applied candidate"
    );
    const migratedManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const migratedReceipt = JSON.parse(fs.readFileSync(receipt, "utf8"));
    assert.equal(migratedReceipt.manifestSha, migratedManifest.manifestSha, "ownership migration preserves receipt-manifest integrity");
    assert.equal(migratedManifest.entries.some((entry: { path: string }) => /summaries\/2026-07-24\.md$/.test(entry.path)), false);
    assert.equal(migratedManifest.entries.some((entry: { path: string }) => entry.path.endsWith("summaries/onboarding.md")), true);

    // If interrupted after the receipt update but before the manifest update, the next run completes the migration.
    assert.equal(
      runLegacy([
        `${quote(process.execPath)} -e ${quote("const fs=require('node:fs');const [candidate,receipt]=process.argv.slice(1);const source=JSON.parse(fs.readFileSync(candidate,'utf8'));const value=JSON.parse(fs.readFileSync(receipt,'utf8'));value.manifestSha=source.manifestSha;fs.writeFileSync(receipt,JSON.stringify(value));")} ${quote(candidateManifest)} ${quote(receipt)}`,
        `migrate_manifest_ownership ${quote(manifest)} ${quote(receipt)}`,
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`
      ].join("\n")).trim(),
      "verified"
    );

    // Exact synchronization keeps runtime daily summaries while restoring reviewed source documents.
    assert.equal(
      run([
        `printf manual\\n > ${quote(curatedSummary)}`,
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`,
        "repair",
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`
      ].join("\n")).trim(),
      "status:1\nverified"
    );
    assert.equal(fs.readFileSync(curatedSummary, "utf8"), "reviewed onboarding\n");
    assert.equal(fs.readFileSync(rootDailySummary, "utf8"), "runtime daily summary\n");
    assert.equal(fs.readFileSync(subagentDailySummary, "utf8"), "runtime subagent summary\n");
    assert.throws(
      () => run(`printf manual\\n > ${quote(curatedSummary)}\nruntime_matches_manifest ${quote(candidateManifest)} ${quote(runtime)}`),
      "a partial or manual runtime change must never qualify as an interrupted candidate apply"
    );

    // A changed symlink is drift and exact sync repairs it.
    assert.equal(
      run([
        `ln -sfn other.ts ${quote(path.join(runtime, "channels", "slack", "managed-link.ts"))}`,
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`,
        "repair",
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`
      ].join("\n")).trim(),
      "status:1\nverified"
    );
    assert.equal(fs.readlinkSync(path.join(runtime, "channels", "slack", "managed-link.ts")), "managed.ts");

    // A deleted managed file is drift and exact sync restores it.
    assert.equal(
      run([
        `rm ${quote(path.join(runtime, "channels", "slack", "managed.ts"))}`,
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`,
        "repair",
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`
      ].join("\n")).trim(),
      "status:1\nverified"
    );
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "managed.ts"), "utf8"), "expected\n");

    // A manual managed-file modification is drift and exact sync repairs it.
    assert.equal(
      run([
        `printf manual\\n > ${quote(path.join(runtime, "channels", "slack", "managed.ts"))}`,
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`,
        "repair",
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`
      ].join("\n")).trim(),
      "status:1\nverified"
    );
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "managed.ts"), "utf8"), "expected\n");

    // An extra managed path and a stale path after source deletion are drift.
    for (const staleFile of ["unexpected.ts", "removed-from-source.ts"]) {
      assert.equal(
        run([
          `printf stale\\n > ${quote(path.join(runtime, "channels", "slack", staleFile))}`,
          `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`,
          "repair",
          `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`
        ].join("\n")).trim(),
        "status:1\nverified"
      );
      assert.equal(fs.existsSync(path.join(runtime, "channels", "slack", staleFile)), false);
    }

    // A rename presents as one missing expected path plus one unexpected stale path.
    assert.equal(
      run([
        `rm ${quote(path.join(runtime, "channels", "slack", "renamed-new.ts"))}`,
        `printf renamed\\n > ${quote(path.join(runtime, "channels", "slack", "renamed-old.ts"))}`,
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`,
        "repair",
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`
      ].join("\n")).trim(),
      "status:1\nverified"
    );
    assert.equal(fs.existsSync(path.join(runtime, "channels", "slack", "renamed-old.ts")), false);
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "renamed-new.ts"), "utf8"), "renamed\n");

    // A corrupt persisted manifest or a receipt-manifest mismatch is invalid, never drift or skip.
    const mutateJson = (file: string, expression: string) =>
      `${quote(process.execPath)} -e ${quote(`const fs=require('node:fs');const file=process.argv[1];const value=JSON.parse(fs.readFileSync(file,'utf8'));${expression};fs.writeFileSync(file,JSON.stringify(value));`)} ${quote(file)}`;
    assert.equal(
      run([
        mutateJson(manifest, 'value.manifestSha = "0".repeat(64)'),
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`
      ].join("\n")).trim(),
      "status:2"
    );
    assert.equal(
      run([
        mutateJson(receipt, 'value.manifestSha = "0".repeat(64)'),
        `verify_status ${quote(manifest)} ${quote(runtime)} ${quote(target)}`
      ].join("\n")).trim(),
      "status:2"
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("deploy-main drains ledger admission before deployment and restores it after smoke", () => {
  const drain = deployer.indexOf("task_control set draining");
  const waitForIdle = deployer.indexOf("task_control wait-idle");
  const deploying = deployer.indexOf("task_control set deploying");
  const verify = deployer.indexOf('"$candidate/deploy/scripts/verify-source.sh"');
  const install = deployer.indexOf('write_managed_manifest "$candidate" "$candidate_manifest"');
  const restarting = deployer.indexOf("task_control set restarting");
  const smoke = deployer.indexOf('"${home}/bin/smoke" --quiet --deploy');
  const resume = deployer.lastIndexOf("resume_normal");
  // A release proves itself before anyone is kept waiting for it: verification
  // runs the candidate's whole test matrix and touches nothing live, so draining
  // for it would be minutes of refused work per attempt, failed attempts too.
  assert.ok(verify >= 0 && verify < drain, "a candidate is verified before the runtime is drained for it");
  assert.ok(drain >= 0 && drain < waitForIdle, "deployment must enter draining before waiting");
  assert.ok(waitForIdle >= 0 && waitForIdle < deploying, "deployment must wait for active runs before changing lifecycle state");
  assert.ok(deploying >= 0 && deploying < install, "deployment must block admission before it changes the live tree");
  assert.ok(restarting >= 0 && restarting < smoke, "deployment must remain closed through service restart");
  assert.ok(smoke >= 0 && smoke < resume, "deployment must reopen admission only after smoke passes");
  assert.match(deployer, /drain_forced=true/, "a drain timeout is recorded instead of aborting the deployment");
  assert.match(deployer, /if \[\[ "\$drain_active" == "1" && "\$admission_must_remain_blocked" != "1" \]\]; then/);
  assert.match(taskControl, /\["slack", "email", "phone", "web"\]/);
  assert.match(taskControl, /current\.activeChannelRuns === 0/);
  assert.match(taskControl, /current\.activeSubagentRuns === 0/);
  assert.match(taskControl, /subagent-start/);
  assert.match(taskControl, /subagent-finish/);
});

test("subagent runner rejects a heartbeat interval that cannot renew its lease", () => {
  const runner = path.join(root, "subagents", "bin", "run-subagent");
  const result = childProcess.spawnSync(process.execPath, [runner], {
    env: { ...process.env, SUBAGENT_HEARTBEAT_MS: "120000", SUBAGENT_LEASE_MS: "120000" },
    encoding: "utf8"
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SUBAGENT_HEARTBEAT_MS must be less than SUBAGENT_LEASE_MS/);
});

test("subagent guardian waits for a TERM-ignoring grandchild before exiting", async () => {
  const runner = fs.readFileSync(path.join(root, "subagents", "bin", "run-subagent"), "utf8");
  const helper = runner.slice(runner.indexOf("function runGuardedProcess"), runner.indexOf("async function taskControl"));
  const guarded = new Function("runProcess", "SUBAGENT_OWNER_STARTED_AT", `${helper}\nreturn runGuardedProcess;`)((command: string, args: string[]) => ({ command, args }), "test-owner-start") as (command: string, args: string[]) => { command: string; args: string[] };
  const invocation = guarded("ignored-command", ["ignored-arg"]);
  const guardian = invocation.args[1];
  assert.ok(guardian, "test fixture must extract the production parent-death guardian");

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-guardian-"));
  const workerPidFile = path.join(fixture, "worker.pid");
  const grandchildPidFile = path.join(fixture, "grandchild.pid");
  const workerTermFile = path.join(fixture, "worker-term");
  const grandchildScript = [
    'grandchild_pid_file="$1"',
    'echo "$$" > "$grandchild_pid_file"',
    "trap '' TERM",
    "while :; do sleep 1; done"
  ].join("\n");
  const workerScript = [
    'worker_pid_file="$1"',
    'grandchild_pid_file="$2"',
    'worker_term_file="$3"',
    'grandchild_script="$4"',
    'echo "$$" > "$worker_pid_file"',
    "set -m",
    '/bin/bash -c "$grandchild_script" -- "$grandchild_pid_file" &',
    'trap \'echo term > "$worker_term_file"; exit 0\' TERM',
    "while :; do sleep 1; done"
  ].join("\n");
  const coordinatorSource = [
    'const { execFileSync, spawn } = require("node:child_process");',
    "const [guardian, workerScript, grandchildScript, ...files] = process.argv.slice(1);",
    'const startedAt = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(process.pid)], { encoding: "utf8" }).trimEnd();',
    'const child = spawn("/bin/bash", ["-c", guardian, "--", String(process.pid), startedAt, "/bin/bash", "-c", workerScript, "--", ...files, grandchildScript], { stdio: "inherit" });',
    'process.stdout.write(`ready:${child.pid}\\n`);',
    "setInterval(() => {}, 1000);"
  ].join("\n");
  const zombieHolder = childProcess.spawn("/usr/bin/perl", [
    "-e",
    '$| = 1; my $pid = fork(); die $! unless defined $pid; if ($pid == 0) { exec @ARGV; die $!; } print "coordinator:$pid\\n"; sleep 30;',
    process.execPath,
    "-e",
    coordinatorSource,
    guardian,
    workerScript,
    grandchildScript,
    workerPidFile,
    grandchildPidFile,
    workerTermFile
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let coordinatorPid = 0;
  let guardianPid = 0;
  let workerPid = 0;
  let grandchildPid = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      zombieHolder.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const coordinatorMatch = output.match(/coordinator:(\d+)\n/);
        const match = output.match(/ready:(\d+)\n/);
        if (coordinatorMatch && match) {
          coordinatorPid = Number(coordinatorMatch[1]);
          guardianPid = Number(match[1]);
          resolve();
        }
      });
      zombieHolder.once("error", reject);
      zombieHolder.once("exit", (code) => reject(new Error(`zombie holder exited ${code} before starting`)));
    });
    for (let attempt = 0; attempt < 40 && (!fs.existsSync(workerPidFile) || !fs.existsSync(grandchildPidFile)); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    workerPid = Number(fs.readFileSync(workerPidFile, "utf8").trim());
    grandchildPid = Number(fs.readFileSync(grandchildPidFile, "utf8").trim());
    assert.ok(Number.isSafeInteger(workerPid) && workerPid > 0);
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);

    process.kill(coordinatorPid, "SIGKILL");
    for (let attempt = 0; attempt < 40 && !processState(coordinatorPid).startsWith("Z"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(processState(coordinatorPid), /^Z/, "the guardian must treat its unreaped zombie owner as exited");
    for (let attempt = 0; attempt < 80 && !fs.existsSync(workerTermFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fs.existsSync(workerTermFile), true, "the worker receives TERM");
    assert.equal(processIsAlive(grandchildPid), true, "the TERM-ignoring grandchild remains alive until the guardian escalates");
    assert.equal(processIsAlive(guardianPid), true, "the guardian remains alive after the direct worker exits");
    for (let attempt = 0; attempt < 260; attempt += 1) {
      const workerAlive = processIsAlive(workerPid);
      const grandchildAlive = processIsAlive(grandchildPid);
      const guardianAlive = processIsAlive(guardianPid);
      if (!workerAlive && !grandchildAlive && !guardianAlive) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(processIsAlive(workerPid), false, "the worker exits");
    assert.equal(processIsAlive(grandchildPid), false, "the guardian escalates to KILL for the remaining grandchild");
    assert.equal(processIsAlive(guardianPid), false, "the guardian exits only after the process group is gone");
  } finally {
    if (!zombieHolder.killed) zombieHolder.kill("SIGKILL");
    for (const pid of [grandchildPid, workerPid, guardianPid]) {
      if (pid > 0) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("observability logs expose the existing deployment receipt", () => {
  const logs = fs.readFileSync(path.join(root, "tools", "logs", "bin", "logs.ts"), "utf8");
  assert.match(logs, /"deploy-main-last": path\.join\(HOME, "state", "deploy-main", "last-run\.json"\)/);
});

test("exact managed sync applies additions, modifications, deletions, renames, and rollback", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-"));
  const runtime = path.join(fixture, "runtime");
  const candidate = path.join(fixture, "candidate");
  const backup = path.join(fixture, "backup");
  const beforeManifest = path.join(fixture, "before.json");
  const candidateManifest = path.join(fixture, "candidate.json");
  const changes = path.join(fixture, "changes.json");
  const manifestStage = path.join(fixture, "manifest-stage");

  try {
    fs.mkdirSync(path.join(runtime, "channels", "slack"), { recursive: true });
    fs.mkdirSync(path.join(runtime, "channels", "slack", "logs"), { recursive: true });
    fs.mkdirSync(path.join(runtime, "channels", "slack", "cache"), { recursive: true });
    fs.mkdirSync(path.join(runtime, "auth"), { recursive: true });
    fs.mkdirSync(path.join(runtime, "state"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "channels", "slack", "removed.ts"), "remove me\n");
    fs.writeFileSync(path.join(runtime, "channels", "slack", "renamed-old.ts"), "rename me\n");
    fs.writeFileSync(path.join(runtime, "channels", "slack", "modified.ts"), "old\n");
    fs.writeFileSync(path.join(runtime, "channels", "slack", ".env"), "runtime secret\n");
    fs.writeFileSync(path.join(runtime, "channels", "slack", "cache.sqlite"), "runtime cache\n");
    fs.writeFileSync(path.join(runtime, "channels", "slack", "logs", "runtime.log"), "log\n");
    fs.writeFileSync(path.join(runtime, "channels", "slack", "cache", "entry"), "cache\n");
    fs.writeFileSync(path.join(runtime, "auth", "token"), "secret\n");
    fs.writeFileSync(path.join(runtime, "state", "tasks.sqlite"), "state\n");

    fs.mkdirSync(path.join(candidate, "channels", "slack"), { recursive: true });
    fs.writeFileSync(path.join(candidate, "channels", "slack", "renamed-new.ts"), "rename me\n");
    fs.writeFileSync(path.join(candidate, "channels", "slack", "modified.ts"), "new\n");
    fs.writeFileSync(path.join(candidate, "channels", "slack", "added.ts"), "added\n");
    fs.symlinkSync("added.ts", path.join(candidate, "channels", "slack", "added-link.ts"));

    const helpers = deployer.slice(
      deployer.indexOf("receipt_manifest_sha() {"),
      deployer.indexOf("install_dependencies() {")
    );
    assert.ok(helpers.includes("sync_managed_exact"), "test fixture must use deploy-main's managed sync helpers");
    const quote = (value: string) => JSON.stringify(value);
    const script = [
      "set -euo pipefail",
      `node=${quote(process.execPath)}`,
      `manifest_stage=${quote(manifestStage)}`,
      helpers,
      `write_managed_manifest ${quote(runtime)} ${quote(beforeManifest)} before`,
      `write_managed_manifest ${quote(candidate)} ${quote(candidateManifest)} candidate`,
      `write_managed_changes ${quote(beforeManifest)} ${quote(candidateManifest)} ${quote(changes)}`,
      `copy_managed ${quote(runtime)} ${quote(backup)}`,
      `sync_managed_exact ${quote(candidate)} ${quote(runtime)} ${quote(beforeManifest)} ${quote(candidateManifest)}`
    ].join("\n");
    childProcess.execFileSync("bash", ["-c", script], { stdio: "pipe" });

    const changePlan = JSON.parse(fs.readFileSync(changes, "utf8"));
    assert.deepEqual(changePlan.added, ["channels/slack/added-link.ts", "channels/slack/added.ts", "channels/slack/renamed-new.ts"]);
    assert.deepEqual(changePlan.modified, ["channels/slack/modified.ts"]);
    assert.deepEqual(changePlan.deleted, ["channels/slack/removed.ts", "channels/slack/renamed-old.ts"]);

    assert.equal(fs.existsSync(path.join(runtime, "channels", "slack", "removed.ts")), false, "apply removes deleted files");
    assert.equal(fs.existsSync(path.join(runtime, "channels", "slack", "renamed-old.ts")), false, "apply removes renamed sources");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "modified.ts"), "utf8"), "new\n");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "added.ts"), "utf8"), "added\n");
    assert.equal(fs.readlinkSync(path.join(runtime, "channels", "slack", "added-link.ts")), "added.ts");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", ".env"), "utf8"), "runtime secret\n");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "cache.sqlite"), "utf8"), "runtime cache\n");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "logs", "runtime.log"), "utf8"), "log\n");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "cache", "entry"), "utf8"), "cache\n");
    assert.equal(fs.readFileSync(path.join(runtime, "auth", "token"), "utf8"), "secret\n");
    assert.equal(fs.readFileSync(path.join(runtime, "state", "tasks.sqlite"), "utf8"), "state\n");

    const rollbackScript = [
      "set -euo pipefail",
      `node=${quote(process.execPath)}`,
      `manifest_stage=${quote(manifestStage)}`,
      helpers,
      `sync_managed_exact ${quote(backup)} ${quote(runtime)} ${quote(candidateManifest)} ${quote(beforeManifest)}`
    ].join("\n");
    childProcess.execFileSync("bash", ["-c", rollbackScript], { stdio: "pipe" });

    assert.equal(fs.existsSync(path.join(runtime, "channels", "slack", "added.ts")), false, "rollback removes added files");
    assert.equal(fs.existsSync(path.join(runtime, "channels", "slack", "renamed-new.ts")), false, "rollback removes renamed targets");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "modified.ts"), "utf8"), "old\n");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "removed.ts"), "utf8"), "remove me\n");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "renamed-old.ts"), "utf8"), "rename me\n");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", ".env"), "utf8"), "runtime secret\n");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "cache.sqlite"), "utf8"), "runtime cache\n");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "logs", "runtime.log"), "utf8"), "log\n");
    assert.equal(fs.readFileSync(path.join(runtime, "channels", "slack", "cache", "entry"), "utf8"), "cache\n");
    assert.equal(fs.readFileSync(path.join(runtime, "auth", "token"), "utf8"), "secret\n");
    assert.equal(fs.readFileSync(path.join(runtime, "state", "tasks.sqlite"), "utf8"), "state\n");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

// Found on dev: a release that added a package and failed left the package
// directory holding the node_modules and dist the deploy had derived. rsync
// will not delete a directory that still holds files it was told to exclude, so
// the rollback reported itself incomplete with admission blocked, and every
// later deploy failed on the same leftover until someone removed it by hand.
test("the exact sync retires a directory left holding only derived output, and nothing else", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-main-derived-"));
  const runtime = path.join(fixture, "runtime");
  const candidate = path.join(fixture, "candidate");
  const runtimeManifest = path.join(fixture, "runtime.json");
  const candidateManifest = path.join(fixture, "candidate.json");
  const manifestStage = path.join(fixture, "manifest-stage");
  const quote = (value: string) => JSON.stringify(value);

  try {
    // What a failed release left behind: build output and installed modules,
    // with none of the source that asked for them.
    fs.mkdirSync(path.join(runtime, "packages", "left-behind", "node_modules", "left-pad"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "packages", "left-behind", "node_modules", "left-pad", "index.js"), "module.exports = 1\n");
    fs.mkdirSync(path.join(runtime, "packages", "left-behind", "dist"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "packages", "left-behind", "dist", "index.js"), "built\n");
    // A package the release does have keeps its installed modules.
    fs.mkdirSync(path.join(runtime, "packages", "kept", "node_modules"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "packages", "kept", "node_modules", "installed"), "installed\n");
    fs.mkdirSync(path.join(runtime, "packages", "kept", "src"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "packages", "kept", "src", "index.ts"), "export const kept = true\n");
    // The runtime writes the memory surface and the release never contains it.
    fs.mkdirSync(path.join(runtime, "memory", "wiki"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "memory", "wiki", "page.md"), "durable\n");

    fs.mkdirSync(path.join(candidate, "packages", "kept", "src"), { recursive: true });
    fs.writeFileSync(path.join(candidate, "packages", "kept", "src", "index.ts"), "export const kept = true\n");
    fs.mkdirSync(path.join(candidate, "memory"), { recursive: true });

    const helpers = deployer.slice(deployer.indexOf("receipt_manifest_sha() {"), deployer.indexOf("install_dependencies() {"));
    childProcess.execFileSync("bash", ["-c", [
      "set -euo pipefail",
      `node=${quote(process.execPath)}`,
      `manifest_stage=${quote(manifestStage)}`,
      helpers,
      `write_managed_manifest ${quote(runtime)} ${quote(runtimeManifest)} runtime`,
      `write_managed_manifest ${quote(candidate)} ${quote(candidateManifest)} candidate`,
      `sync_managed_exact ${quote(candidate)} ${quote(runtime)} ${quote(runtimeManifest)} ${quote(candidateManifest)}`
    ].join("\n")], { stdio: "pipe" });

    assert.equal(fs.existsSync(path.join(runtime, "packages", "left-behind")), false, "a directory holding only derived output is retired");
    assert.equal(fs.readFileSync(path.join(runtime, "packages", "kept", "node_modules", "installed"), "utf8"), "installed\n", "a package the release has keeps its installed modules");
    assert.equal(fs.readFileSync(path.join(runtime, "memory", "wiki", "page.md"), "utf8"), "durable\n", "the runtime-owned memory surface is not derived output");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("deploy-main keeps the prior manifest available to rollback", () => {
  const converge = deployer.indexOf("if ! converge_source_checkout; then");
  const drain = deployer.indexOf("task_control set draining");
  const persist = deployer.indexOf('persist_manifest "$candidate_manifest" "$manifest"');
  assert.ok(converge >= 0 && converge < drain, "the source checkout converges to origin/main before any deployment work");
  assert.ok(persist >= 0, "the candidate manifest must be persisted after smoke");
  assert.doesNotMatch(deployer, /merge --ff-only/, "the checkout is converged up front, not fast-forwarded afterwards");
  assert.match(deployer, /cp "\$manifest" "\$\{backup\}\/managed-manifest\.json"/);
  assert.match(deployer, /cp "\$\{backup\}\/managed-manifest\.json" "\$manifest"/);
});

test("deploy-main does not source-manage secrets or runtime state", () => {
  const managedBlock = deployer.match(/managed_paths=\(([^]*?)\n\)/)?.[1] || "";
  for (const forbidden of ["auth", "state", "browser", ".codex", ".amalgm"]) {
    assert.doesNotMatch(managedBlock, new RegExp(`(^|\\s)${forbidden}(\\s|$)`));
  }
  for (const excluded of ["secrets.env", "webhooks.env", "*.key", "*.sqlite", "*.db", "*.jsonl", "payloads/"]) {
    assert.match(deployer, new RegExp(excluded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("every managed service the deployer restarts is a service the installer installs", () => {
  // Both sides read deploy/services.json through the host resolver, so the set
  // the deploy bounces and the set the installer loads cannot drift apart. The
  // deploy must never bounce the poller it is running inside.
  const labels = shellLabels("prod");
  const rendered = services("prod");
  assert.deepEqual(
    labels,
    rendered.filter((service) => service.name !== "deploy-main").map((service) => service.label)
  );
  assert.ok(labels.includes("com.puffle.fluffles.automations"));
  assert.match(installer, /render-services\.mjs/, "the installer installs the host's rendered manifests");
  assert.match(installer, /"\$\{service_home\}\/state\/automations\/logs"/);
  assert.match(installer, /install -d -o "\$service_user" -g "\$service_group" -m 755 "\$directory"/);
});

test("launchd owns the single durable deploy-main trigger", () => {
  const legacySpec = JSON.parse(
    fs.readFileSync(path.join(root, "automations", "deploy-main", "automation.json"), "utf8")
  );
  assert.equal(legacySpec.enabled, false);
  assert.match(installer, /for _ in \{1\.\.10\}/);
  assert.match(installer, /failed to install after retries/);
  assert.doesNotMatch(installer, /if launchctl print "system\/\$\{label\}"/);
  const poller = serviceNamed("prod", "deploy-main");
  assert.equal(poller.program[poller.program.length - 1], "/Users/ai/bin/deploy-main");
  assert.equal(poller.startInterval, 60);
  assert.match(deployer, /^\s*deploy\s*$/m);
});

test("rollback tolerates a restored tree that predates the automations registry", () => {
  // Rollback restores the previously installed tree, which can be older than
  // the registry itself. Insisting on running a binary that tree never had
  // turns a recoverable rollback into rollback_failed, which leaves admission
  // control closed.
  const rollbackBody = deployer.slice(deployer.indexOf("rollback() {"), deployer.indexOf("admission_must_remain_blocked=1\nif !"));
  assert.match(rollbackBody, /if \[\[ -x "\$\{home\}\/bin\/automations" \]\] && ! "\$\{home\}\/bin\/automations" sync; then/);
  // The apply path still requires it: a candidate without a registry is broken.
  const applyBody = deployer.slice(deployer.indexOf("admission_must_remain_blocked=1\nif !"));
  assert.match(applyBody, /\|\| ! "\$\{home\}\/bin\/automations" sync; then/);
  assert.doesNotMatch(applyBody, /-x "\$\{home\}\/bin\/automations"/);
});

test("every path source verification builds or tests is a directory the repo still has", () => {
  const verify = fs.readFileSync(path.join(root, "deploy", "scripts", "verify-source.sh"), "utf8");
  // A deleted directory left behind here fails the deploy inside verification,
  // and the deployer then rolls back, so the very commit that removed the
  // directory can never land.
  const referenced = [...verify.matchAll(/--prefix "?([\w./-]+)"?/g)]
    .map((match) => match[1])
    .filter((prefix): prefix is string => prefix !== undefined && !prefix.startsWith("$"));
  assert.ok(referenced.length > 0);
  for (const prefix of new Set(referenced)) {
    assert.ok(
      fs.existsSync(path.join(root, prefix, "package.json")),
      `verify-source.sh builds ${prefix}, which has no package.json`
    );
  }
});

// Step 4 moved tasks/ under packages/, and the launcher installed on dev, which
// predates that move, failed with lifecycle_state_failed before the deploy
// began: it shelled into the checkout that had already converged onto the
// release to ask where admission state was. The permanently installed piece
// must not depend on the release's source layout for anything it does before
// the handoff.
test("the launcher reads admission state without running the release's code", () => {
  const lifecycle = deployer.slice(deployer.indexOf("deployment_lifecycle_state() {"), deployer.indexOf("manifest_sha_for() {"));
  assert.match(lifecycle, /SELECT state FROM deployment_lifecycle WHERE id = 1/, "the launcher reads admission state out of the ledger");
  assert.equal(lifecycle.includes("task_control"), false, "reading admission state must not run the release's cli from a checkout that has already moved");

  const handoff = deployer.indexOf('"${candidate}/bin/deploy-main" --apply');
  const checkoutDependencies = deployer.indexOf('install_dependencies "$repo"');
  assert.ok(handoff >= 0 && checkoutDependencies > handoff, "only a release with no deployer of its own is built inside the source checkout");
});
