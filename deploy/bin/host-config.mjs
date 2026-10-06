#!/usr/bin/env node
// Answer host-shaped questions for whichever harness this is.
//
//   host-config.mjs                     print the resolved host as JSON
//   host-config.mjs --field home        print one field
//   host-config.mjs --shell             print shell assignments to eval
//   host-config.mjs --labels            print the host's service labels
//   host-config.mjs --service <name>    print one rendered service as JSON
//   host-config.mjs --services          print every rendered service as JSON
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fail, hostServices, resolveHost } from "../lib/host.mjs";

function main(argv) {
  const args = [...argv];
  let name = process.env.FLUFFLES_HOST ?? "";
  let mode = "json";
  let field = "";
  let serviceName = "";
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--host") {
      name = args.shift() ?? "";
    } else if (argument === "--field") {
      mode = "field";
      field = args.shift() ?? "";
    } else if (argument === "--shell") {
      mode = "shell";
    } else if (argument === "--labels") {
      mode = "labels";
    } else if (argument === "--services") {
      mode = "services";
    } else if (argument === "--service") {
      mode = "service";
      serviceName = args.shift() ?? "";
    } else {
      fail(`unknown argument ${argument}`);
    }
  }
  const host = resolveHost({ name, home: process.env.HOME ?? "" });
  if (mode === "json") {
    process.stdout.write(`${JSON.stringify(host, null, 2)}\n`);
    return;
  }
  if (mode === "field") {
    const value = host[field];
    if (value === undefined) {
      fail(`host ${host.name} has no field ${field}`);
    }
    process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
    return;
  }
  if (mode === "shell") {
    const services = hostServices(host);
    const assignments = [
      `host_name=${JSON.stringify(host.name)}`,
      `home=${JSON.stringify(host.home)}`,
      `service_user=${JSON.stringify(host.user)}`,
      `service_group=${JSON.stringify(host.group)}`,
      `repo=${JSON.stringify(host.repo)}`,
      `deploy_ref=${JSON.stringify(host.ref)}`,
      `deploy_remote=${JSON.stringify(host.ref.split("/")[0])}`,
      `deploy_branch=${JSON.stringify(host.ref.split("/").slice(1).join("/"))}`,
      // A host without GitHub credentials deploys from a local mirror, and
      // mirrorUpstream is where the deployer fast-forwards that mirror from
      // before each poll. Empty for a host that fetches its remote directly.
      `mirror_upstream=${JSON.stringify(host.mirrorUpstream ?? "")}`,
      `label_prefix=${JSON.stringify(host.labelPrefix)}`,
      `alert_channel=${JSON.stringify(host.alertChannel)}`,
      `supervisor=${JSON.stringify(host.supervisor)}`,
      `supervisor_domain=${JSON.stringify(host.domain)}`,
      `system_daemon_root=${JSON.stringify(host.systemDaemonRoot)}`,
      // The poller is excluded: a deploy must never bootout the job it is
      // running inside.
      `service_labels=(${services
        .filter((service) => service.name !== "deploy-main")
        .map((service) => JSON.stringify(service.label))
        .join(" ")})`
    ];
    process.stdout.write(`${assignments.join("\n")}\n`);
    return;
  }
  if (mode === "labels") {
    process.stdout.write(`${hostServices(host)
      .map((service) => service.label)
      .join("\n")}\n`);
    return;
  }
  if (mode === "services") {
    process.stdout.write(`${JSON.stringify(hostServices(host), null, 2)}\n`);
    return;
  }
  const service = hostServices(host).find((candidate) => candidate.name === serviceName);
  if (!service) {
    fail(`host ${host.name} does not run ${serviceName}`);
  }
  process.stdout.write(`${JSON.stringify(service, null, 2)}\n`);
}

// Compare real paths: a temporary directory reached through a symlink (macOS
// /var -> /private/var) would otherwise make this file import-only and print
// nothing, and every caller reads its stdout.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  const real = (file) => {
    try {
      return fs.realpathSync(file);
    } catch {
      return path.resolve(file);
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(process.argv[1]);
}

if (invokedDirectly()) {
  main(process.argv.slice(2));
}
