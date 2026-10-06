import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { serviceNamed, services } from "./support/host";

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const wrapper = path.join(root, "packages", "auth", "bin", "infisical-run");
const allowlist = path.join(root, "packages", "auth", "bin", "infisical-exec");
const secretInjectingServices = services("prod").filter((service) => service.program.includes("--path"));

function allowedSecretPaths(): Set<string> {
  const text = fs.readFileSync(allowlist, "utf8");
  const block = text.slice(text.indexOf("my %allowed = ("), text.indexOf("my %managed_environment_name"));
  return new Set([...block.matchAll(/'([^']+)'\s*=>/g)].map((match) => match[1] as string));
}

test("no launch definition configures a service through a name Infisical drops", async () => {
  // infisical-exec rebuilds the child environment from a baseline that omits
  // anything credential-shaped, so a plist key like AUTOMATIONS_EVENT_SECRET_ENV
  // never reaches the service and the omission is silent.
  for (const service of secretInjectingServices) {
    for (const name of Object.keys(service.env)) {
      await execFileAsync("perl", [allowlist, "baseline-keeps-name", name]);
    }
  }
});

test("every wrapper that injects secrets points at the installed bootstrap", () => {
  // The bootstrap moved into packages/auth, and a wrapper naming the old
  // location fails only once it runs on the mini, with "No such file".
  const installed = `\${home}/${path.relative(root, wrapper)}`;
  for (const entry of fs.readdirSync(path.join(root, "bin"))) {
    const file = path.join(root, "bin", entry);
    if (!fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const [reference] of text.matchAll(/\$\{home\}\/\S*infisical-run/g)) {
      assert.equal(reference, installed.replaceAll('"', ""), `bin/${entry} runs ${reference}, which is not installed`);
    }
  }
});

test("nothing the deployer installs names one harness's home", () => {
  // The dev harness takes the same source as production, so a literal home in
  // installed code would have dev reading production's state, vault, ledger and
  // services. The only place a home may be written down is a host file.
  const roots = [
    "agent", "automations", "bin", "channels",
    "hooks", "memory", "packages", "skills",
    "subagents", "tools"
  ];
  const allowed = new Set(["deploy/hosts/prod.json"]);
  const commented = (line: string) => /^\s*(\/\/|#|\*|<!--)/.test(line);
  const offenders: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      if (entry.isDirectory()) {
        if (["node_modules", "dist", "test", "payloads"].includes(entry.name)) continue;
        walk(file);
        continue;
      }
      if (!entry.isFile() || allowed.has(relative) || relative.endsWith(".md")) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (line.includes("/Users/ai") && !commented(line)) {
          offenders.push(`${relative}:${index + 1}`);
        }
      }
    }
  };
  for (const name of roots) walk(path.join(root, name));
  assert.deepEqual(offenders, []);
});

test("Infisical runtime bootstrap uses only a local machine identity and short-lived token", () => {
  const text = fs.readFileSync(wrapper, "utf8");
  const allowed = fs.readFileSync(allowlist, "utf8");
  assert.ok((fs.statSync(wrapper).mode & 0o111) !== 0, "bootstrap wrapper must be executable");
  assert.match(text, /auth\/infisical\/machine-identity\.env/);
  assert.match(text, /bootstrap directory must be owned by the service user with mode 700/);
  assert.match(text, /file_mode\(\)/);
  assert.match(text, /file_owner\(\)/);
  assert.match(text, /stat -c '%a'/);
  assert.match(text, /stat -c '%u'/);
  assert.match(text, /auth_timeout_seconds=20/);
  assert.match(text, /--method=universal-auth/);
  assert.match(text, /retry_count=3/);
  assert.match(text, /--projectId=/);
  assert.match(text, /--env=/);
  assert.match(text, /--path="\$secret_path"/);
  assert.match(allowed, /\/services\/slack/);
  assert.match(allowed, /\/services\/email-channel/);
  assert.match(allowed, /\/services\/email-pubsub/);
  assert.match(allowed, /\/services\/phone/);
  assert.match(allowed, /\/services\/webhooks/);
  assert.match(text, /unset INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/);
  assert.match(text, /unset infisical_client_id infisical_client_secret infisical_access_token/);
  assert.doesNotMatch(text, /@infisical\/sdk/);
  assert.doesNotMatch(text, /\. "\$bootstrap_file"/);

  const smoke = fs.readFileSync(path.join(root, "tools", "smoke", "bin", "smoke.ts"), "utf8");
  assert.match(smoke, /fs\.lstatSync\(bootstrapDirectory\)/);
  assert.match(smoke, /must not be a symlink/);
  assert.match(smoke, /owned by the service user with mode 700/);
  assert.match(smoke, /owned by the service user with mode 600/);
});

test("a live harness's auth directory never lands in the source tree", () => {
  // $HOME/auth holds only the Machine Identity bootstrap and disposable
  // tool-owned auth state; the source tree carries no mirror of it.
  assert.equal(fs.existsSync(path.join(root, "auth")), false);
  const capabilities = fs.readFileSync(path.join(root, "packages", "capabilities", "bin", "capabilities.ts"), "utf8");
  assert.doesNotMatch(capabilities, /auth\/registry\.json/);
});

test("legacy auth cleanup requires deployed runtime injection before deleting files", () => {
  const cleanup = fs.readFileSync(path.join(root, "packages", "auth", "bin", "cleanup-legacy-infisical-secrets"), "utf8");
  assert.match(cleanup, /cleanup-legacy-infisical-secrets \[--apply\]/);
  assert.match(cleanup, /not deployed with Infisical runtime injection/);
  assert.match(cleanup, /still loaded from a legacy launch definition/);
  assert.match(cleanup, /PHONE_EXECUTOR_MCP_AUTHORIZATION/);
  assert.match(cleanup, /--path \/services\/slack/);
  assert.match(cleanup, /--path \/services\/email-pubsub/);
  assert.match(cleanup, /--path \/services\/phone/);
  assert.match(cleanup, /infisical-cleanup-backup/);
  assert.match(cleanup, /rollback_cleanup/);
  assert.match(cleanup, /infisical-run/);
  assert.match(cleanup, /rm -f/);
});

test("service declarations carry no injection scaffold of their own", () => {
  // A service declares `secretsPath` and only its own command; the breadcrumb
  // wrapper and infisical-run scaffold are derived in one place, the renderer.
  const declared = JSON.parse(fs.readFileSync(path.join(root, "deploy", "services.json"), "utf8")).services;
  const allowed = allowedSecretPaths();
  for (const service of declared) {
    for (const argument of service.entry) {
      assert.doesNotMatch(String(argument), /breadcrumb-service|infisical-run/, `${service.name} must not hand-write the scaffold`);
    }
    if (service.secretsPath !== undefined) {
      assert.ok(allowed.has(service.secretsPath), `${service.name} selects ${service.secretsPath}, which infisical-exec would refuse`);
    }
  }
});

test("every scoped Infisical path a service definition selects is one the allowlist knows", () => {
  const allowed = allowedSecretPaths();
  for (const host of ["prod", "dev"]) {
    for (const service of services(host)) {
      for (const [index, argument] of service.program.entries()) {
        if (argument !== "--path") continue;
        const secretPath = service.program[index + 1] as string;
        assert.ok(
          allowed.has(secretPath),
          `${service.label} selects ${secretPath}, which infisical-exec would refuse`
        );
      }
    }
  }
});

test("secret-consuming services run through Infisical before Node", () => {
  for (const service of secretInjectingServices) {
    const wrapperIndex = service.program.indexOf("/Users/ai/packages/auth/bin/infisical-run");
    const nodeIndex = service.program.indexOf("/Users/ai/homebrew/bin/node");
    assert.ok(wrapperIndex >= 0, `${service.label} must use the Infisical runtime bootstrap`);
    assert.ok(wrapperIndex < nodeIndex, `${service.label} must inject secrets before starting Node`);
  }

  const slack = fs.readFileSync(path.join(root, "channels", "slack", "src", "server.ts"), "utf8");
  const email = fs.readFileSync(path.join(root, "channels", "email", "src", "server.ts"), "utf8");
  const phone = fs.readFileSync(path.join(root, "channels", "phone", "src", "server.ts"), "utf8");
  const webhooks = fs.readFileSync(path.join(root, "channels", "webhooks", "src", "server.ts"), "utf8");
  assert.doesNotMatch(slack, /auth\/channels\/slack\/secrets\.env/);
  assert.doesNotMatch(webhooks, /webhooks\.env/);
  // Every channel declares its Infisical-only keys and hands them to the shared
  // loader, which is the single place that refuses them from a local env file.
  const channelEnv = fs.readFileSync(path.join(root, "packages", "conversations", "src", "channel-env.ts"), "utf8");
  assert.match(channelEnv, /blocked\.has\(key\)/);
  assert.match(slack, /loadEnvFileInto\(envPath, \{ localSecretKeys \}\)/);
  assert.match(email, /loadChannelEnv\("email", \{ localSecretKeys:/);
  assert.match(phone, /loadChannelEnv\("phone", \{\s*localSecretKeys:/);
  assert.match(slack, /SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_SIGNING_SECRET/);
  assert.match(email, /EMAIL_WEBHOOK_SECRET/);
  assert.match(phone, /PHONE_EXECUTOR_MCP_AUTHORIZATION", "PHONE_WEBHOOK_SECRET/);
});

test("every launchd service selects a path the allowlist approves", async () => {
  // An unapproved path makes infisical-run print usage and exit 64, so launchd
  // restarts the service forever instead of reporting a credential problem.
  for (const service of secretInjectingServices) {
    const secretPath = service.program[service.program.indexOf("--path") + 1] as string;
    await execFileAsync("perl", [allowlist, "validate-path", secretPath]);
  }
});

test("Phone requires the Infisical authorization and has no Codex credential fallback", () => {
  const implementation = fs.readFileSync(path.join(root, "channels", "phone", "src", "executor-mcp-client.ts"), "utf8");
  const phone = serviceNamed("prod", "phone");
  assert.match(implementation, /env\.PHONE_EXECUTOR_MCP_AUTHORIZATION/);
  assert.match(implementation, /PHONE_EXECUTOR_MCP_AUTHORIZATION is required/);
  assert.doesNotMatch(implementation, /\.codex/);
  assert.doesNotMatch(implementation, /PHONE_EXECUTOR_MCP_BEARER_TOKEN/);
  assert.ok(phone.env.PHONE_EXECUTOR_MCP_URL);
  assert.equal(phone.env.PHONE_EXECUTOR_MCP_AUTHORIZATION, undefined);
});

test("the phone health and capability wrappers derive the Executor MCP url from the host declaration", () => {
  const shared = fs.readFileSync(path.join(root, "channels", "phone", "executor-mcp-url.sh"), "utf8");
  assert.match(shared, /deploy\/lib\/host\.mjs/, "executor-mcp-url.sh should derive the url from the host declaration");
  assert.doesNotMatch(shared, /PHONE_EXECUTOR_MCP_URL=https?:/, "the url must live only in deploy/hosts");
  assert.match(String(serviceNamed("prod", "phone").env.PHONE_EXECUTOR_MCP_URL), /^https:\/\//);
  for (const name of ["health", "capability"]) {
    const wrapper = fs.readFileSync(path.join(root, "channels", "phone", name), "utf8");
    assert.match(wrapper, /\. "\$\{home\}\/channels\/phone\/executor-mcp-url\.sh"/);
    assert.match(wrapper, /export PHONE_EXECUTOR_MCP_URL/);
  }
});

test("credentialed callable tools declare their Infisical path in the manifest, nowhere else", () => {
  // The manifest is the single place a callable tool's credential path is
  // written down; with-tool-secrets reads it and hands off to infisical-run.
  // A wrapper carrying its own --path would be a second copy of the fact.
  const allowed = allowedSecretPaths();
  const manifestDirectory = path.join(root, "tools", "mcp", "manifests");
  const credentialed: Record<string, string> = {};
  for (const entry of fs.readdirSync(manifestDirectory)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(manifestDirectory, entry), "utf8"));
    if (manifest.secrets === undefined) continue;
    assert.ok(
      allowed.has(manifest.secrets.path),
      `${entry} declares ${manifest.secrets.path}, which infisical-exec would refuse`
    );
    credentialed[manifest.name] = manifest.secrets.path;
  }
  assert.deepEqual(Object.keys(credentialed).sort(), ["gcloud", "gh", "gws", "vercel"]);
  for (const name of Object.keys(credentialed)) {
    const text = fs.readFileSync(path.join(root, "bin", name), "utf8");
    assert.match(
      text,
      new RegExp(`\\$\\{home\\}/packages/auth/bin/with-tool-secrets" ${name} -- `),
      `bin/${name} must resolve its secrets through with-tool-secrets`
    );
    assert.doesNotMatch(text, /infisical-run/, `bin/${name} must not carry its own injection call`);
    assert.doesNotMatch(text, /--path/, `bin/${name} must not carry its own secret path`);
  }
});

test("with-tool-secrets validates the manifest path and fails closed", () => {
  const helper = fs.readFileSync(path.join(root, "packages", "auth", "bin", "with-tool-secrets"), "utf8");
  assert.match(helper, /tools\/mcp\/manifests/);
  assert.match(helper, /\$\{home\}\/packages\/auth\/bin\/infisical-run/);
  assert.match(helper, /process\.exit\(78\)/);
});

test("slack-send receives its token through the Infisical runtime bootstrap", () => {
  const wrapper = fs.readFileSync(path.join(root, "bin", "slack-send"), "utf8");
  const implementation = fs.readFileSync(path.join(root, "tools", "slack-send", "bin", "slack-send.ts"), "utf8");
  assert.match(wrapper, /\$\{home\}\/packages\/auth\/bin\/infisical-run/);
  assert.match(wrapper, /--path \/services\/slack-send/);
  assert.match(implementation, /process\.env\.SLACK_BOT_TOKEN/);
  assert.doesNotMatch(implementation, /auth\/channels\/slack\/secrets\.env/);
});

test("webhook management receives provider secrets through the Infisical runtime bootstrap", () => {
  const wrapper = fs.readFileSync(path.join(root, "bin", "webhooks"), "utf8");
  const implementation = fs.readFileSync(path.join(root, "channels", "webhooks", "bin", "webhooks.ts"), "utf8");
  assert.match(wrapper, /\$\{home\}\/packages\/auth\/bin\/infisical-run/);
  assert.match(wrapper, /start\|restart\)/);
  assert.match(wrapper, /--path \/services\/webhooks /);
  assert.doesNotMatch(wrapper, /webhooks-server|webhooks-trigger/);
  assert.doesNotMatch(implementation, /loadEnvFile/);
  assert.doesNotMatch(implementation, /auth\/providers\/webhooks\/webhooks\.env/);
  assert.match(implementation, /webhook launchd service is not installed/);
  assert.doesNotMatch(implementation, /detached:\s*true/);
  assert.doesNotMatch(implementation, /path\.join\(ROOT, "src", "server\.ts"\)/);
});

test("direct service shims and package starts retain scoped runtime injection", () => {
  const shims = [
    ["bin/email-channel", "/services/email-channel"],
    ["bin/phone-channel", "/services/phone"],
    ["channels/phone/capability", "/services/phone-executor"],
    ["channels/phone/health", "/services/phone-executor"]
  ];
  for (const [relativePath, secretPath] of shims) {
    const text = fs.readFileSync(path.join(root, relativePath), "utf8");
    assert.match(text, /\$\{home\}\/packages\/auth\/bin\/infisical-run/);
    assert.ok(text.includes(`--path ${secretPath}`), `${relativePath} must select ${secretPath}`);
  }

  const starts = [
    ["channels/slack/package.json", "/services/slack"],
    ["channels/email/package.json", "/services/email-channel"],
    ["channels/phone/package.json", "/services/phone"],
    ["channels/webhooks/package.json", "/services/webhooks"]
  ];
  for (const [relativePath, secretPath] of starts) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
    assert.match(String(pkg.scripts.start), /\$HOME\/packages\/auth\/bin\/infisical-run/);
    assert.ok(String(pkg.scripts.start).includes(`--path ${secretPath}`), `${relativePath} start must select ${secretPath}`);
  }
});

test("every Infisical path a release declares is documented as one that must be provisioned", () => {
  // The vault is the one thing ci cannot reach, so the offline half of the
  // contract is what it can check: a path a release introduces is a folder
  // somebody has to create, and the reference that says so is INFISICAL.md.
  // The deploy proves the folder exists; this proves it was written down.
  const guide = fs.readFileSync(path.join(root, "packages", "auth", "INFISICAL.md"), "utf8");
  const declared = JSON.parse(fs.readFileSync(path.join(root, "deploy", "services.json"), "utf8")).services;
  for (const service of declared) {
    if (service.secretsPath === undefined) continue;
    assert.ok(
      guide.includes(`\`${service.secretsPath}\``),
      `${service.name} declares ${service.secretsPath}, which INFISICAL.md does not list as a path to provision`
    );
  }
});

test("a deploy proves every declared Infisical path resolves before it starts the services", () => {
  // The gate the chat console's crash loop bought: without it, a release that
  // names an unprovisioned path installs cleanly, launchd restarts the job
  // forever, and every check that asks whether a job is running finds one.
  const deployer = fs.readFileSync(path.join(root, "bin", "deploy-main"), "utf8");
  const preflight = deployer.indexOf("if ! preflight_secret_paths");
  const start = deployer.indexOf("if ! start_services; then\n  rollback restart_failed");
  assert.ok(preflight > 0, "the deployer must preflight the paths the release declares");
  assert.ok(preflight < start, "the preflight must run before the candidate's services are started");
  assert.match(deployer, /rollback secrets_unprovisioned/);
  // The proof runs a program that produces no output, so an injected value
  // cannot reach a log or a receipt.
  assert.match(deployer, /--path "\$secret_path" \/usr\/bin\/true/);
});
