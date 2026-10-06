import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installFakeLaunchd } from "./support/fake-launchd";
import { host, renderServices, serviceNamed, services, shellLabels, shellVariables, writeHostFile } from "./support/host";

const root = path.resolve(__dirname, "..");

// Production and the dev harness share a machine. Everything that could collide
// is checked here, because a dev deploy reaching a production job is the one
// failure the dev harness must never cause.
test("production runs system daemons under its own label prefix", () => {
  const prod = host("prod");
  assert.equal(prod.domain, "system");
  assert.equal(prod.systemDaemonRoot, "/Library/LaunchDaemons");
  assert.equal(prod.labelPrefix, "com.puffle");
  assert.equal(prod.home, "/Users/ai");
  assert.deepEqual(prod.services, ["slack", "email", "phone", "chat-console", "webhooks", "automations", "executor", "deploy-main"]);
});

test("the dev harness runs production's shape under its own prefix and account", () => {
  const dev = host("dev");
  // Dev runs system-domain jobs because that is what production runs, and a
  // harness that exercises a different supervisor path proves less. What it
  // does not share is the root-owned manifest directory: its own manifests
  // live in its own home, so a dev deploy cannot write a production daemon.
  assert.equal(dev.domain, "system");
  assert.equal(dev.home, "/Users/dev");
  assert.equal(dev.user, "dev");
  assert.equal(dev.labelPrefix, "com.puffle.dev");
  assert.ok(dev.systemDaemonRoot.startsWith("/Users/dev/"), "dev never installs into a root-owned directory");
  assert.notEqual(dev.systemDaemonRoot, host("prod").systemDaemonRoot);
  assert.equal(dev.alertChannel, "#dev-alerts");
});

test("the dev harness answers no real person", () => {
  const dev = host("dev");
  assert.ok(!dev.services.includes("email"), "dev has no mailbox of its own");
  assert.ok(!dev.services.includes("phone"), "dev has no phone number of its own");
  assert.ok(dev.services.includes("deploy-main"), "dev polls main so deploy changes land there first");
});

test("nothing rendered for dev names a production path, label or port", () => {
  const rendered = JSON.stringify(services("dev")) + JSON.stringify(shellVariables("dev")) + shellLabels("dev").join(" ");
  // The one deliberate crossing is mirrorUpstream: dev has no GitHub
  // credential, so its mirror fast-forwards from production's checkout. That
  // is a read-only fetch source, not a path dev's services run against.
  const upstream = host("dev").mirrorUpstream ?? "";
  assert.ok(upstream, "dev declares where its mirror advances from");
  const isolated = rendered.split(JSON.stringify(upstream).slice(1, -1)).join("");
  assert.doesNotMatch(isolated, /\/Users\/ai\b/);
  assert.doesNotMatch(rendered, /"com\.puffle\.(?!dev\b)/);
  // Dev keeps a directory of the same name inside its own home, which is the
  // point: nothing rendered for dev names the root-owned one.
  assert.doesNotMatch(rendered, /(?<!\/Users\/dev)\/Library\/LaunchDaemons/);
  for (const port of Object.values(host("prod").env ?? {}).flatMap((entry) => Object.values(entry))) {
    assert.doesNotMatch(rendered, new RegExp(`\\b${port}\\b`), `dev must not share production's port ${port}`);
  }
});

test("dev services listen on the dev ports", () => {
  const port = (name: string, variable: string) => services("dev").find((service) => service.name === name)?.env[variable];
  assert.equal(port("chat-console", "PORT"), "13004");
  assert.equal(port("webhooks", "WEBHOOK_PORT"), "18787");
  assert.equal(port("automations", "AUTOMATIONS_PORT"), "18788");
  assert.equal(port("executor", "EXECUTOR_PORT"), "14788");
});

test("the rendered host service is the only source of the executor port", () => {
  // The daemon wrapper and the registration script both derive the port from
  // the rendered executor service when EXECUTOR_PORT is not already exported,
  // so the port lives in exactly one place per host.
  const port = (name: string) => services(name).find((service) => service.name === "executor")?.env.EXECUTOR_PORT;
  assert.equal(port("dev"), "14788");
  assert.equal(port("prod"), "4788");
  for (const file of ["bin/executor-daemon", "packages/mcp/bin/register.ts"]) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /1?4788/, `${file} must not hard-code an executor port`);
    assert.match(text, /EXECUTOR_PORT/, `${file} must honor an explicit EXECUTOR_PORT`);
  }
});

test("a host file says which host this is, and does not answer for another host", () => {
  // The deploy exports FLUFFLES_HOST_FILE for everything it runs, including the
  // candidate's own tests, so asking for prod by name must still read prod.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-hosts-named-"));
  try {
    const file = writeHostFile(path.join(fixture, "host.json"), { name: "throwaway", home: fixture });
    const ask = (name: string) => childProcess.spawnSync(
      process.execPath,
      [path.join(root, "deploy", "bin", "host-config.mjs"), "--host", name],
      { encoding: "utf8", env: { ...process.env, HOME: fixture, FLUFFLES_HOST_FILE: file } }
    );
    assert.equal(JSON.parse(ask("prod").stdout).home, "/Users/ai");
    assert.equal(JSON.parse(ask("throwaway").stdout).home, fixture);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("host questions are answered through a symlinked path, not silently skipped", () => {
  // macOS temporary directories are reached through /var -> /private/var, and a
  // main guard comparing unresolved paths made every host answer empty with a
  // zero exit, so an installer read "" as the domain and refused a valid host.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-hosts-symlink-"));
  try {
    const link = path.join(fixture, "link");
    fs.symlinkSync(path.join(root, "deploy"), link);
    const file = writeHostFile(path.join(fixture, "host.json"), { home: fixture });
    for (const tool of ["host-config.mjs", "render-services.mjs"]) {
      const answered = childProcess.spawnSync(
        process.execPath,
        [path.join(link, "bin", tool), ...(tool === "host-config.mjs" ? ["--field", "domain"] : ["--out", path.join(fixture, "out")])],
        { encoding: "utf8", env: { ...process.env, HOME: fixture, FLUFFLES_HOST_FILE: file } }
      );
      assert.equal(answered.status, 0, `${tool} failed: ${answered.stderr}`);
      assert.notEqual(answered.stdout.trim(), "", `${tool} answered nothing through a symlinked path`);
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("a user-domain host loads its agents in the domain it actually has", () => {
  // A harness driven over ssh has no GUI login session, so gui/<uid> does not
  // exist and every bootstrap into it fails. user/<uid> always exists, and a
  // headless server does not care which of the two it runs in.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-hosts-domain-"));
  try {
    const launchd = installFakeLaunchd(fixture);
    const agents = path.join(fixture, "Library", "LaunchAgents");
    const file = writeHostFile(path.join(fixture, "host.json"), {
      home: fixture,
      domain: "user",
      systemDaemonRoot: agents,
      services: ["automations"]
    });
    const installed = childProcess.spawnSync("bash", [path.join(root, "deploy", "scripts", "install-system-services")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${launchd.binDir}:${process.env.PATH}`,
        HOME: fixture,
        FLUFFLES_HOST_FILE: file,
        INSTALL_SYSTEM_SERVICES_HOME: fixture,
        INSTALL_SYSTEM_SERVICES_NODE: process.execPath,
        INSTALL_SYSTEM_SERVICES_PLISTBUDDY: path.join(launchd.binDir, "PlistBuddy"),
        FAKE_LAUNCHD_STATE: launchd.statePath
      }
    });
    assert.equal(installed.status, 0, installed.stderr);
    const loaded = Object.keys(launchd.jobs());
    assert.equal(loaded.length, 1);
    assert.match(loaded[0], /^user\/\d+\/com\.puffle\.test\./);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("one account cannot install the other account's services", () => {
  // Production and the dev harness share a machine, and root can install
  // either. A dev tree running the installer without naming a host resolved
  // production and reinstalled its daemons; this is what stops that.
  const refused = childProcess.spawnSync("bash", [path.join(root, "deploy", "scripts", "install-system-services")], {
    encoding: "utf8",
    env: { ...process.env, FLUFFLES_HOST: "prod", INSTALL_SYSTEM_SERVICES_NODE: process.execPath }
  });
  assert.equal(refused.status, 78, refused.stderr || refused.stdout);
  assert.match(refused.stderr, /refusing to install ai's services/);
});

test("the installer's optional host argument survives bash 3.2", () => {
  // macOS ships bash 3.2, where expanding an empty array under set -u aborts.
  // CI runs bash 5, so this would only ever fail on the machines that matter.
  const installer = fs.readFileSync(path.join(root, "deploy", "scripts", "install-system-services"), "utf8");
  assert.doesNotMatch(installer, /(?<!\+)"\$\{host_args\[@\]\}"/, "expand host_args as ${host_args[@]+\"${host_args[@]}\"}");
  assert.match(installer, /\$\{host_args\[@\]\+"\$\{host_args\[@\]\}"\}/);
});

test("a host file with an unimplemented supervisor or domain is refused, not guessed at", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-hosts-"));
  try {
    const attempt = (overrides: Record<string, unknown>) => {
      const file = writeHostFile(path.join(fixture, "host.json"), { home: fixture, ...overrides });
      assert.throws(
        () => renderServices({ hostFile: file, out: path.join(fixture, "out") }),
        /only launchd is implemented|only system or user exist|missing /
      );
    };
    attempt({ supervisor: "systemd" });
    attempt({ domain: "gui" });
    attempt({ alertChannel: "" });
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("the poller carries its alert channel in its own manifest", () => {
  // A host file the deployer cannot read is also a host file it cannot read an
  // alert channel out of, so the channel is in the manifest launchd starts it
  // with.
  for (const name of ["prod", "dev"]) {
    assert.equal(serviceNamed(name, "deploy-main").env.DEPLOY_ALERT_CHANNEL, host(name).alertChannel);
  }
});

test("a user-domain host cannot be installed outside its own home", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-hosts-install-"));
  try {
    const file = writeHostFile(path.join(fixture, "host.json"), {
      home: fixture,
      domain: "user",
      systemDaemonRoot: path.join(fixture, "Library", "LaunchAgents")
    });
    const install = (destination?: string) =>
      childProcess.spawnSync("bash", [path.join(root, "deploy", "scripts", "install-system-services"), "--check"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixture,
          FLUFFLES_HOST_FILE: file,
          INSTALL_SYSTEM_SERVICES_HOME: fixture,
          // The fixture home holds no Node, and the installer looks for one
          // beside the harness it installs.
          INSTALL_SYSTEM_SERVICES_NODE: process.execPath,
          ...(destination ? { INSTALL_SYSTEM_SERVICES_DESTINATION: destination } : {})
        }
      });

    const refused = install("/Library/LaunchDaemons");
    assert.equal(refused.status, 78, "a user-domain host must not install into a root-owned directory");
    assert.match(refused.stderr, /belong under/);
    // With no destination given it takes the host's, which is inside the home,
    // so it gets as far as comparing manifests rather than refusing.
    assert.notEqual(install().status, 78);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("a host file the deployer cannot read leaves a receipt instead of a stack trace", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-hosts-broken-"));
  try {
    const file = writeHostFile(path.join(fixture, "host.json"), { home: fixture, domain: "gui" });
    const run = childProcess.spawnSync("bash", [path.join(root, "bin", "deploy-main")], {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture, FLUFFLES_HOST_FILE: file, DEPLOY_NODE: process.execPath }
    });
    assert.equal(run.status, 78, "an unusable host file is a configuration failure, not a deploy");
    assert.match(run.stderr, /nothing was deployed/);
    const receipt = JSON.parse(fs.readFileSync(path.join(fixture, "state", "deploy-main", "last-run.json"), "utf8"));
    assert.equal(receipt.ok, false);
    assert.equal(receipt.status, "host_config_failed");
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("a throwaway host renders every service it declares", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-hosts-render-"));
  try {
    const out = path.join(fixture, "LaunchDaemons");
    const file = writeHostFile(path.join(fixture, "host.json"), { home: fixture, services: ["webhooks", "deploy-main"] });
    renderServices({ hostFile: file, out });
    assert.deepEqual(fs.readdirSync(out).sort(), [
      "com.puffle.test.harness.deploy-main.plist",
      "com.puffle.test.harness.webhooks.plist"
    ]);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
