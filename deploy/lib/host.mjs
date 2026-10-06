// Resolve which harness host this is and answer questions about it.
//
// Every consumer of host-shaped facts (the deployer, the system service
// installer, smoke) reads them from here instead of hard-coding /Users/ai,
// launchd labels and ports. Plain ESM with no dependencies, because the
// deployer runs this before any package is built.
//
// The host is chosen by, in order: an explicit name (--host/FLUFFLES_HOST),
// then the host whose `home` matches $HOME. Anything else is an error: a
// harness that cannot say which host it is must not deploy.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const deployRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fail(message) {
  process.stderr.write(`host-config: ${message}\n`);
  process.exit(64);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`could not read ${file}: ${error.message}`);
  }
}

export function hostFiles(root = deployRoot) {
  const directory = path.join(root, "hosts");
  // A throwaway tree can carry the library without the declarations, and it
  // names its host by file.
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .map((entry) => path.join(directory, entry));
}

// A host file that is missing a field would otherwise become an empty shell
// variable, and a deploy would install services with an empty label or bootout
// a job in the wrong domain. Nothing about a host is optional except env.
const requiredFields = [
  "name",
  "home",
  "user",
  "group",
  "repo",
  "ref",
  "labelPrefix",
  "supervisor",
  "domain",
  "systemDaemonRoot",
  "alertChannel",
  "services"
];

function validateHost(host, source) {
  for (const field of requiredFields) {
    if (host[field] === undefined || host[field] === "") {
      fail(`${source} is missing ${field}`);
    }
  }
  if (host.supervisor !== "launchd") {
    fail(`${source} wants supervisor ${host.supervisor}, and only launchd is implemented`);
  }
  if (host.domain !== "system" && host.domain !== "user") {
    fail(`${source} wants domain ${host.domain}, and only system or user exist`);
  }
  if (!host.ref.includes("/")) {
    fail(`${source} ref ${host.ref} must name a remote and a branch, like origin/main`);
  }
  return host;
}

export function resolveHost({ root = deployRoot, name = "", home = "", file = process.env.FLUFFLES_HOST_FILE ?? "" } = {}) {
  // A host file given by path is how a deploy is exercised against a throwaway
  // tree: the test writes a host whose home is a temporary directory, and every
  // path, label and port follows from it. It answers "which host am I", not
  // "which host is called prod", so a named lookup still reads the declarations.
  const hosts = hostFiles(root).map(readJson);
  if (name) {
    const named = (file ? [readJson(file), ...hosts] : hosts).find((host) => host.name === name);
    if (!named) {
      fail(`no host named ${name}; known hosts: ${hosts.map((host) => host.name).join(", ")}`);
    }
    return validateHost(named, `host ${name}`);
  }
  if (file) {
    return validateHost(readJson(file), file);
  }
  const matched = hosts.find((host) => host.home === home);
  if (!matched) {
    fail(`no host has home ${home || "(unset)"}; pass --host or set FLUFFLES_HOST`);
  }
  return validateHost(matched, `host ${matched.name}`);
}

// A service is the declaration in services.json with the host's placeholders
// filled in and the host's env overrides applied. Rendering is one function so
// the plist writer, the deployer and smoke cannot disagree about a label or a
// port.
export function renderService(service, host) {
  const label = service.label.replaceAll("{{PREFIX}}", host.labelPrefix);
  const substitute = (value) =>
    value
      .replaceAll("{{HOME}}", host.home)
      .replaceAll("{{LABEL}}", label)
      .replaceAll("{{PREFIX}}", host.labelPrefix)
      .replaceAll("{{ALERT_CHANNEL}}", host.alertChannel);
  const overrides = (host.env ?? {})[service.name] ?? {};
  // Every service runs under the breadcrumb wrapper, and a service that
  // declares secretsPath gets its secrets injected host-side by infisical-run.
  // The scaffold is derived here so services.json declares only the entry
  // command that is actually the service.
  if (service.secretsPath !== undefined && !/^\/[a-z0-9][a-z0-9/-]*$/.test(service.secretsPath)) {
    fail(`service ${service.name} has a malformed secretsPath: ${service.secretsPath}`);
  }
  const program = [
    `${host.home}/bin/breadcrumb-service`,
    label,
    "--",
    ...(service.secretsPath ? [`${host.home}/packages/auth/bin/infisical-run`, "--path", service.secretsPath] : []),
    ...service.entry.map(substitute)
  ];
  const certificates = `${host.home}/homebrew/etc/ca-certificates/cert.pem`;
  const env = {
    HOME: host.home,
    PATH: `${host.home}/bin:${host.home}/homebrew/bin:${host.home}/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    // Node resolves TLS roots from Homebrew's bundle, not the system
    // keychain. The bash-only poller has no use for them.
    ...(service.node === true ? { NODE_EXTRA_CA_CERTS: certificates, SSL_CERT_FILE: certificates } : {}),
    ...Object.fromEntries(Object.entries(service.env ?? {}).map(([key, value]) => [key, substitute(value)])),
    ...overrides
  };
  return {
    name: service.name,
    label,
    program,
    workingDirectory: substitute(service.workingDirectory),
    keepAlive: service.keepAlive === true,
    throttleInterval: service.throttleInterval,
    startInterval: service.startInterval,
    processType: service.processType,
    env,
    stdout: substitute(service.stdout),
    stderr: substitute(service.stderr)
  };
}

export function hostServices(host, root = deployRoot) {
  const declared = readJson(path.join(root, "services.json")).services;
  const byName = new Map(declared.map((service) => [service.name, service]));
  return host.services.map((name) => {
    const service = byName.get(name);
    if (!service) {
      fail(`host ${host.name} lists unknown service ${name}`);
    }
    return renderService(service, host);
  });
}

export { fail };
