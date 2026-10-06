import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Tests read host facts the way the deployer does, by asking the resolver in
// deploy/, so a test cannot drift from what a real deploy would install.
const root = path.resolve(__dirname, "..", "..");

export interface RenderedService {
  name: string;
  label: string;
  program: string[];
  workingDirectory: string;
  keepAlive: boolean;
  throttleInterval?: number;
  startInterval?: number;
  processType?: string;
  env: Record<string, string>;
  stdout: string;
  stderr: string;
}

export interface HostDefinition {
  name: string;
  home: string;
  user: string;
  group: string;
  repo: string;
  ref: string;
  mirrorUpstream?: string;
  labelPrefix: string;
  supervisor: string;
  domain: "system" | "user";
  systemDaemonRoot: string;
  alertChannel: string;
  services: string[];
  env?: Record<string, Record<string, string>>;
}

function hostConfig(args: string[], options: { hostFile?: string; sourceRoot?: string } = {}): string {
  const source = options.sourceRoot ?? root;
  return childProcess.execFileSync(process.execPath, [path.join(source, "deploy", "bin", "host-config.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...(options.hostFile ? { FLUFFLES_HOST_FILE: options.hostFile } : {}) }
  });
}

export function host(name: string): HostDefinition {
  return JSON.parse(hostConfig(["--host", name])) as HostDefinition;
}

export function services(name: string): RenderedService[] {
  return JSON.parse(hostConfig(["--host", name, "--services"])) as RenderedService[];
}

export function serviceNamed(hostName: string, serviceName: string): RenderedService {
  const found = services(hostName).find((service) => service.name === serviceName);
  if (!found) throw new Error(`host ${hostName} does not run ${serviceName}`);
  return found;
}

// The shell variables the deployer eval's, parsed back out. The deploy reads
// its labels from here, so a test that asserts on them asserts on the same
// text bash sees.
export function shellVariables(name: string): Record<string, string> {
  const shell = hostConfig(["--host", name, "--shell"]);
  const variables: Record<string, string> = {};
  for (const line of shell.split("\n")) {
    const match = /^([a-z_]+)="(.*)"$/.exec(line);
    if (match) variables[match[1] as string] = match[2] as string;
  }
  return variables;
}

export function shellLabels(name: string): string[] {
  const shell = hostConfig(["--host", name, "--shell"]);
  const array = /^service_labels=\((.*)\)$/m.exec(shell);
  if (!array) throw new Error(`host ${name} shell output has no service_labels`);
  return [...(array[1] as string).matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
}

// A throwaway harness is a directory with the release's deploy/ inside it and a
// host file pointing every path at the fixture. The deployer reads the resolver
// beside itself, so a test drives a real deploy by installing these two things
// rather than by rewriting constants in the script.
export function installDeploySource(destination: string): void {
  for (const relative of [
    path.join("deploy", "lib", "host.mjs"),
    path.join("deploy", "bin", "host-config.mjs"),
    path.join("deploy", "bin", "render-services.mjs"),
    path.join("deploy", "services.json")
  ]) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
  }
}

export function writeHostFile(file: string, overrides: Partial<HostDefinition> & { home: string }): string {
  const host: HostDefinition = {
    name: "test",
    user: os.userInfo().username,
    group: "staff",
    repo: path.join(overrides.home, "projects", "source-code"),
    ref: "origin/main",
    labelPrefix: "com.puffle.test",
    supervisor: "launchd",
    domain: "system",
    systemDaemonRoot: path.join(overrides.home, "LaunchDaemons"),
    alertChannel: "#deploy-test",
    services: ["slack", "chat-console", "webhooks", "automations", "deploy-main"],
    env: {},
    ...overrides
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(host, null, 2)}\n`);
  return file;
}

export function renderServices(options: { hostFile: string; out: string; sourceRoot?: string }): void {
  const source = options.sourceRoot ?? root;
  childProcess.execFileSync(process.execPath, [path.join(source, "deploy", "bin", "render-services.mjs"), "--out", options.out], {
    encoding: "utf8",
    env: { ...process.env, FLUFFLES_HOST_FILE: options.hostFile }
  });
}
