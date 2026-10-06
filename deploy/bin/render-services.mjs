#!/usr/bin/env node
// Write a launchd manifest per service for one host.
//
// The manifests used to be seven hand-written plists with /Users/ai baked into
// every path, which is why a second harness was impossible and why the test
// suite had to rewrite them to exercise a deploy. They are now generated from
// deploy/services.json plus the host file, so a label, a port or a program path
// exists in exactly one place.
//
//   render-services --out <dir> [--host <name>]   write <label>.plist per service
//   render-services --check --out <dir>           exit 3 if any file differs
//
// Plain ESM with no dependencies: this runs before the deploy installs or
// builds anything.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { hostServices, resolveHost } from "../lib/host.mjs";

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function plistFor(service) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${escapeXml(service.label)}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>"
  ];
  for (const argument of service.program) {
    lines.push(`\t\t<string>${escapeXml(argument)}</string>`);
  }
  lines.push("\t</array>");
  lines.push("\t<key>WorkingDirectory</key>");
  lines.push(`\t<string>${escapeXml(service.workingDirectory)}</string>`);
  lines.push("\t<key>RunAtLoad</key>");
  lines.push("\t<true/>");
  if (service.keepAlive) {
    lines.push("\t<key>KeepAlive</key>");
    lines.push("\t<true/>");
  }
  if (service.throttleInterval !== undefined) {
    lines.push("\t<key>ThrottleInterval</key>");
    lines.push(`\t<integer>${service.throttleInterval}</integer>`);
  }
  if (service.startInterval !== undefined) {
    lines.push("\t<key>StartInterval</key>");
    lines.push(`\t<integer>${service.startInterval}</integer>`);
  }
  if (service.processType !== undefined) {
    lines.push("\t<key>ProcessType</key>");
    lines.push(`\t<string>${escapeXml(service.processType)}</string>`);
  }
  lines.push("\t<key>EnvironmentVariables</key>");
  lines.push("\t<dict>");
  for (const [key, value] of Object.entries(service.env)) {
    lines.push(`\t\t<key>${escapeXml(key)}</key>`);
    lines.push(`\t\t<string>${escapeXml(value)}</string>`);
  }
  lines.push("\t</dict>");
  lines.push("\t<key>StandardOutPath</key>");
  lines.push(`\t<string>${escapeXml(service.stdout)}</string>`);
  lines.push("\t<key>StandardErrorPath</key>");
  lines.push(`\t<string>${escapeXml(service.stderr)}</string>`);
  lines.push("</dict>");
  lines.push("</plist>");
  return `${lines.join("\n")}\n`;
}

function main(argv) {
  const args = [...argv];
  let out = "";
  let name = process.env.FLUFFLES_HOST ?? "";
  let check = false;
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--out") {
      out = args.shift() ?? "";
    } else if (argument === "--host") {
      name = args.shift() ?? "";
    } else if (argument === "--check") {
      check = true;
    } else {
      process.stderr.write(`render-services: unknown argument ${argument}\n`);
      process.exit(64);
    }
  }
  if (!out) {
    process.stderr.write("render-services: --out is required\n");
    process.exit(64);
  }
  const host = resolveHost({ name, home: process.env.HOME ?? "" });
  const services = hostServices(host);
  let changed = 0;
  if (!check) {
    fs.mkdirSync(out, { recursive: true });
  }
  for (const service of services) {
    const target = path.join(out, `${service.label}.plist`);
    const contents = plistFor(service);
    if (check) {
      const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
      if (existing !== contents) {
        process.stdout.write(`${service.label}: pending\n`);
        changed += 1;
      }
      continue;
    }
    fs.writeFileSync(target, contents, { mode: 0o644 });
    process.stdout.write(`${service.label}: rendered\n`);
  }
  if (check && changed > 0) {
    process.exit(3);
  }
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
