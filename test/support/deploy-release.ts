import childProcess from "node:child_process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { installFakeLaunchd } from "./fake-launchd";

// A throwaway machine: a git remote, a source checkout, a home with the release
// installed into it, and a fake launchd running its services. Everything a
// deploy does runs for real against it, which is the only way the stages that
// broke production get exercised before production.
//
// The deployer is installed the way the real one is, so the launcher performing
// a deploy is the one the previous release shipped. That is the sequence the
// mini performs every minute, and the one bug class the harness could not see.
const root = path.resolve(__dirname, "..", "..");

export const DEPLOY_SOURCE = ["bin/deploy-main", "scripts/install-system-services"] as const;

// npm is the one thing a throwaway tree cannot have: no network. This stands in
// for the parts the deploy uses, so package discovery, ordering and the builds
// themselves still run.
const NPM = String.raw`#!/usr/bin/env node
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const prefixIndex = args.indexOf("--prefix");
const directory = prefixIndex === -1 ? process.cwd() : args[prefixIndex + 1];
const log = process.env.FAKE_NPM_LOG;
const record = (line) => { if (log) fs.appendFileSync(log, line + "\n"); };

if (args[0] === "ci") {
  record("ci\t" + directory);
  fs.mkdirSync(path.join(directory, "node_modules"), { recursive: true });
  process.exit(0);
}
if (args[0] === "run") {
  const script = args[1];
  record(script + "\t" + directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  const command = (manifest.scripts || {})[script];
  if (!command) {
    process.stderr.write("missing script: " + script + "\n");
    process.exit(1);
  }
  const result = childProcess.spawnSync("sh", ["-c", command], { cwd: directory, stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}
process.stderr.write("unsupported npm invocation: " + args.join(" ") + "\n");
process.exit(1);
`;

export interface ReleaseHarnessOptions {
  serviceNames?: string[];
  labelPrefix?: string;
  wrapper?: string;
  /** The Infisical path every service declares, as the real ones do. */
  secretsPath?: string;
}

export interface ReleaseHarness {
  fixture: string;
  home: string;
  repo: string;
  daemons: string;
  serviceNames: string[];
  labelFor(name: string): string;
  /** Run the launcher installed in the harness home, the way the poller does. */
  deploy(): childProcess.SpawnSyncReturns<string>;
  receipt(): {
    ok: boolean;
    status: string;
    targetSha: string | null;
    deployedSha: string | null;
    message: string | null;
  };
  jobs(): Record<string, { argv: string[]; running: boolean }>;
  /** Commit and push the current working tree, returning the released sha. */
  commit(message: string): string;
  /** Repoint every service at a different wrapper path, as #37 did. */
  moveWrapper(wrapper: string): void;
  /** Edit the deployer this release ships, before committing it. */
  editReleaseDeployer(edit: (source: string) => string): void;
  /** Install the release's launcher into the home, which is what a deploy does. */
  installLauncher(): void;
  npmLog(): string[];
  write(file: string, contents: string, mode?: number): void;
}

function run(command: string, args: string[], options: childProcess.ExecFileSyncOptions = {}): string {
  return childProcess.execFileSync(command, args, { ...options, encoding: "utf8" });
}

function write(file: string, contents: string, mode?: number) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, mode === undefined ? undefined : { mode });
}

export function replaceShellFunction(script: string, name: string, replacement: string): string {
  const expression = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}\\n`, "m");
  if (!expression.test(script)) throw new Error(`could not replace ${name}`);
  return script.replace(expression, replacement);
}

// The deployer, with the two things a throwaway tree cannot have removed: the
// Mac's PATH and the task registry that admission control lives in. Every other
// stage, manifest sync included, runs unmodified.
function harnessDeployer(fakeBin: string): string {
  let source = fs
    .readFileSync(path.join(root, "bin", "deploy-main"), "utf8")
    .replace(
      'export PATH="${HOME:-}/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
      `export PATH="${fakeBin}:${process.env.PATH}"`
    )
    .replace(
      'export PATH="${home}/bin:${home}/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
      `export PATH="${fakeBin}:${process.env.PATH}"`
    )
    .replace('export GIT_SSH_COMMAND="${home}/bin/github-ssh"', "");
  source = replaceShellFunction(
    source,
    "task_control",
    `task_control() {
  case "$1" in
    status) printf '%s' '{"lifecycle":{"state":"normal"}}' ;;
  esac
}
`
  );
  return source;
}

export function setUpRelease(options: ReleaseHarnessOptions = {}): ReleaseHarness {
  const serviceNames = options.serviceNames ?? ["slack", "email", "phone", "chat-console", "webhooks", "automations"];
  const prefix = options.labelPrefix ?? "com.puffle.test";
  const labelFor = (name: string) => `${prefix}.${name}`;

  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-release-"));
  const home = path.join(fixture, "home");
  const remote = path.join(fixture, "origin.git");
  const daemons = path.join(fixture, "LaunchDaemons");
  const repo = path.join(fixture, "source");
  const npmLogPath = path.join(fixture, "npm.log");
  const launchd = installFakeLaunchd(fixture);
  fs.writeFileSync(path.join(launchd.binDir, "npm"), NPM, { mode: 0o755 });
  const deployer = harnessDeployer(launchd.binDir);

  function writeServices(wrapper: string) {
    fs.rmSync(path.join(repo, "bin", "infisical-run"), { force: true });
    fs.rmSync(path.join(repo, "packages", "auth", "bin", "infisical-run"), { force: true });
    write(path.join(repo, wrapper), "#!/bin/sh\nexit 0\n", 0o755);
    const services: Record<string, unknown>[] = serviceNames.map((name) => ({
      name,
      label: `{{PREFIX}}.${name}`,
      ...(options.secretsPath ? { secretsPath: options.secretsPath } : {}),
      entry: [`{{HOME}}/${wrapper}`, "{{LABEL}}"],
      workingDirectory: "{{HOME}}",
      keepAlive: true,
      env: {},
      stdout: `{{HOME}}/state/${name}/stdout.log`,
      stderr: `{{HOME}}/state/${name}/stderr.log`
    }));
    services.push({
      name: "deploy-main",
      label: "{{PREFIX}}.harness.deploy-main",
      entry: ["{{HOME}}/bin/deploy-main"],
      workingDirectory: "{{HOME}}",
      keepAlive: false,
      env: {},
      stdout: "{{HOME}}/state/deploy-main/stdout.log",
      stderr: "{{HOME}}/state/deploy-main/stderr.log"
    });
    write(path.join(repo, "deploy", "services.json"), `${JSON.stringify({ services }, null, 2)}\n`);
  }

  fs.mkdirSync(repo, { recursive: true });
  run("git", ["init", "-b", "main", repo]);
  run("git", ["-C", repo, "config", "user.email", "deploy-test@example.invalid"]);
  run("git", ["-C", repo, "config", "user.name", "deploy test"]);

  // The release ships its own deployer, so the tree under test carries the
  // harness copy of it and the installed launcher is a copy of that.
  write(path.join(repo, "bin", "deploy-main"), deployer, 0o755);
  write(path.join(repo, "deploy", "scripts", "install-system-services"), fs.readFileSync(path.join(root, "deploy", "scripts", "install-system-services"), "utf8"), 0o755);
  write(path.join(repo, "deploy", "contract"), fs.readFileSync(path.join(root, "deploy", "contract"), "utf8"));
  write(path.join(repo, "deploy", "scripts", "verify-source.sh"), "#!/usr/bin/env bash\nexit 0\n", 0o755);
  // The renderer derives the breadcrumb scaffold onto every service, so the
  // throwaway tree ships a pass-through stand-in for it.
  write(path.join(repo, "bin", "breadcrumb-service"), '#!/bin/sh\nshift 2\nexec "$@"\n', 0o755);
  write(path.join(repo, "bin", "automations"), "#!/usr/bin/env bash\nexit 0\n", 0o755);
  write(path.join(repo, "bin", "slack-send"), "#!/usr/bin/env bash\nexit 0\n", 0o755);
  for (const relative of [
    path.join("deploy", "lib", "host.mjs"),
    path.join("deploy", "bin", "host-config.mjs"),
    path.join("deploy", "bin", "render-services.mjs")
  ]) {
    write(path.join(repo, relative), fs.readFileSync(path.join(root, relative), "utf8"), 0o755);
  }
  // The live check the deployment is gated on: every service loaded and running
  // under the manifests the deploy just installed.
  write(
    path.join(repo, "bin", "smoke"),
    `#!/usr/bin/env bash
set -uo pipefail
for label in ${serviceNames.map(labelFor).join(" ")}; do
  if ! launchctl print "system/\${label}" 2>/dev/null | grep -q 'state = running'; then
    echo "fail harness-launchd: \${label} is not running" >&2
    exit 1
  fi
done
echo "smoke passed"
`,
    0o755
  );
  writeServices(options.wrapper ?? path.join("bin", "infisical-run"));
  write(
    path.join(repo, "deploy", "hosts", "test.json"),
    `${JSON.stringify(
      {
        name: "test",
        home,
        user: os.userInfo().username,
        group: "staff",
        repo,
        ref: "origin/main",
        labelPrefix: prefix,
        supervisor: "launchd",
        domain: "system",
        systemDaemonRoot: daemons,
        alertChannel: "#deploy-test",
        services: [...serviceNames, "deploy-main"],
        env: {}
      },
      null,
      2
    )}\n`
  );

  run("git", ["init", "--bare", remote]);
  run("git", ["-C", repo, "remote", "add", "origin", remote]);
  run("git", ["-C", repo, "add", "-A"]);
  run("git", ["-C", repo, "commit", "-m", "release"]);
  run("git", ["-C", repo, "push", "-u", "origin", "main"]);

  // The live runtime: the released tree installed, its daemon manifests staged,
  // and every service loaded from them.
  fs.mkdirSync(home, { recursive: true });
  // The runtime's ledger, which is where admission state lives and where the
  // launcher reads it from. Only the one table the launcher touches: the rest of
  // the schema is the release's business, not the launcher's.
  fs.mkdirSync(path.join(home, "state", "tasks"), { recursive: true });
  {
    const ledger = new DatabaseSync(path.join(home, "state", "tasks", "tasks.sqlite"));
    ledger.exec("CREATE TABLE deployment_lifecycle (id INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at TEXT NOT NULL)");
    ledger.exec("INSERT INTO deployment_lifecycle (id, state, updated_at) VALUES (1, 'normal', '2026-01-01T00:00:00.000Z')");
    ledger.close();
  }
  for (const managed of ["bin", "packages", "channels", "automations", "deploy"]) {
    if (fs.existsSync(path.join(repo, managed))) {
      fs.cpSync(path.join(repo, managed), path.join(home, managed), { recursive: true });
    }
  }
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${launchd.binDir}:${process.env.PATH}`,
    HOME: home,
    FLUFFLES_HOST: "test",
    DEPLOY_NODE: process.execPath,
    FAKE_LAUNCHD_STATE: launchd.statePath,
    FAKE_LAUNCHD_GUI: "1",
    FAKE_NPM_LOG: npmLogPath,
    INSTALL_SYSTEM_SERVICES_DESTINATION: daemons,
    INSTALL_SYSTEM_SERVICES_PLISTBUDDY: path.join(launchd.binDir, "PlistBuddy"),
    INSTALL_SYSTEM_SERVICES_NODE: process.execPath,
    INSTALL_SYSTEM_SERVICES_HOME: home,
    // This tree's launchd is a stand-in, so its manifests need no root owner.
    INSTALL_SYSTEM_SERVICES_PRIVILEGED: "0"
  };
  run(path.join(repo, "deploy", "scripts", "install-system-services"), ["--stage-only"], { env: environment });
  for (const name of serviceNames) {
    run(path.join(launchd.binDir, "launchctl"), ["bootstrap", "system", path.join(daemons, `${labelFor(name)}.plist`)], {
      env: environment
    });
  }

  const launcher = path.join(home, "bin", "deploy-main-under-test");
  const installLauncher = () => {
    write(launcher, fs.readFileSync(path.join(repo, "bin", "deploy-main"), "utf8"), 0o755);
  };
  installLauncher();

  const receiptPath = path.join(home, "state", "deploy-main", "last-run.json");
  return {
    fixture,
    home,
    repo,
    daemons,
    serviceNames,
    labelFor,
    receipt: () => JSON.parse(fs.readFileSync(receiptPath, "utf8")),
    jobs: launchd.jobs,
    moveWrapper: writeServices,
    editReleaseDeployer: (edit: (source: string) => string) => {
      const file = path.join(repo, "bin", "deploy-main");
      write(file, edit(fs.readFileSync(file, "utf8")), 0o755);
    },
    installLauncher,
    npmLog: () => (fs.existsSync(npmLogPath) ? fs.readFileSync(npmLogPath, "utf8").trimEnd().split("\n").filter(Boolean) : []),
    write: (file: string, contents: string, mode?: number) => write(file, contents, mode),
    commit: (message: string) => {
      run("git", ["-C", repo, "add", "-A"]);
      run("git", ["-C", repo, "commit", "-m", message]);
      run("git", ["-C", repo, "push", "origin", "main"]);
      return run("git", ["-C", repo, "rev-parse", "HEAD"]).trim();
    },
    deploy: () =>
      childProcess.spawnSync("bash", [launcher], {
        encoding: "utf8",
        env: {
          ...environment,
          DEPLOY_SYSTEM_DAEMON_ROOT: daemons,
          DEPLOY_PLISTBUDDY: path.join(launchd.binDir, "PlistBuddy"),
          DEPLOY_SYSTEM_SERVICES_PRIVILEGED: "0",
          DEPLOY_RESTART_WAIT_ATTEMPTS: "2",
          DEPLOY_RESTART_WAIT_INTERVAL_SECONDS: "0",
          DEPLOY_SMOKE_ATTEMPTS: "1",
          DEPLOY_SMOKE_INTERVAL_SECONDS: "0"
        }
      })
  };
}
