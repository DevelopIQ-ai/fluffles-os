import fs from "node:fs";
import path from "node:path";

// A stand-in for the parts of macOS the deployer talks to, faithful in the one
// way that matters: launchd runs the job definition it was bootstrapped with,
// not whatever the plist file says now. A deploy that rewrites a manifest
// without reloading the job keeps running the old command, which is exactly
// how a moved wrapper took production down.
const LAUNCHCTL = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const childProcess = require("node:child_process");

const statePath = process.env.FAKE_LAUNCHD_STATE;
const guiSession = process.env.FAKE_LAUNCHD_GUI === "1";
const [command, ...rest] = process.argv.slice(2);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch {
    return { jobs: {} };
  }
}

function writeState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function readPlist(file) {
  const contents = fs.readFileSync(file, "utf8");
  const label = contents.match(/<key>Label<\/key>\s*<string>([^<]*)<\/string>/);
  const block = contents.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  if (!label || !block) throw new Error("plist is missing Label or ProgramArguments: " + file);
  const argv = [...block[1].matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  return { label: label[1], argv };
}

// launchd keeps a job loaded only while its program stays alive. These fakes
// stand in for daemons, so a program that exits zero counts as started and
// anything missing or failing counts as a job that could not run.
function programStarts(argv) {
  const result = childProcess.spawnSync(argv[0], argv.slice(1), { timeout: 10000 });
  return result.error === undefined && result.status === 0;
}

function fail(message) {
  process.stderr.write(message + "\n");
  process.exit(3);
}

const state = readState();

if (command === "print") {
  const target = rest[0];
  if (target === "system") process.exit(0);
  if (/^gui\/\d+$/.test(target)) process.exit(guiSession ? 0 : 1);
  if (/^user\/\d+$/.test(target)) process.exit(0);
  const job = state.jobs[target];
  if (!job) fail("Could not find service " + target);
  process.stdout.write("\tstate = " + (job.running ? "running" : "not running") + "\n");
  process.exit(0);
}

if (command === "bootout") {
  const target = rest[0];
  if (!state.jobs[target]) fail("Could not find service " + target);
  delete state.jobs[target];
  writeState(state);
  process.exit(0);
}

if (command === "enable") process.exit(0);

if (command === "bootstrap") {
  const [domain, plist] = rest;
  const { label, argv } = readPlist(plist);
  const target = domain + "/" + label;
  if (state.jobs[target]) fail("Service is already loaded: " + target);
  state.jobs[target] = { argv, running: programStarts(argv) };
  writeState(state);
  process.exit(0);
}

if (command === "kickstart") {
  const target = rest[rest.length - 1];
  const job = state.jobs[target];
  if (!job) fail("Could not find service " + target);
  // The cached definition, not the file on disk. This is the whole point.
  job.running = programStarts(job.argv);
  writeState(state);
  process.exit(0);
}

fail("unsupported launchctl command: " + command);
`;

const PLIST_BUDDY = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const [flag, script, file] = process.argv.slice(2);
if (flag !== "-c") { process.stderr.write("unsupported PlistBuddy invocation\n"); process.exit(1); }
const contents = fs.readFileSync(file, "utf8");
const print = script.match(/^Print :(\w+)$/);
if (print) {
  const match = contents.match(new RegExp("<key>" + print[1] + "</key>\\s*<string>([^<]*)</string>"));
  if (!match) { process.stderr.write("Does Not Exist\n"); process.exit(1); }
  process.stdout.write(match[1] + "\n");
  process.exit(0);
}
const remove = script.match(/^Delete :(\w+)$/);
if (remove) {
  const expression = new RegExp("\\s*<key>" + remove[1] + "</key>\\s*<string>[^<]*</string>");
  if (!expression.test(contents)) { process.stderr.write("Does Not Exist\n"); process.exit(1); }
  fs.writeFileSync(file, contents.replace(expression, ""));
  process.exit(0);
}
const add = script.match(/^Add :(\w+) string (.*)$/);
if (add) {
  fs.writeFileSync(file, contents.replace("</dict>", "\t<key>" + add[1] + "</key>\n\t<string>" + add[2] + "</string>\n</dict>"));
  process.exit(0);
}
process.stderr.write("unsupported PlistBuddy command: " + script + "\n");
process.exit(1);
`;

const PLUTIL = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const file = process.argv[process.argv.length - 1];
const contents = fs.readFileSync(file, "utf8");
if (!contents.includes("<plist") || !contents.includes("</plist>")) {
  process.stderr.write(file + ": invalid\n");
  process.exit(1);
}
process.stdout.write(file + ": OK\n");
`;

const SUDO = String.raw`#!/usr/bin/env bash
# The deploy account's passwordless launchctl and installer rights, minus the
# privilege: a throwaway tree needs none.
while [ $# -gt 0 ]; do
  case "$1" in
    -*) shift ;;
    *) break ;;
  esac
done
exec "$@"
`;

export interface FakeLaunchd {
  binDir: string;
  statePath: string;
  jobs(): Record<string, { argv: string[]; running: boolean }>;
}

export function installFakeLaunchd(fixture: string): FakeLaunchd {
  const binDir = path.join(fixture, "fake-bin");
  const statePath = path.join(fixture, "launchd-state.json");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ jobs: {} }, null, 2));
  for (const [name, contents] of Object.entries({
    launchctl: LAUNCHCTL,
    PlistBuddy: PLIST_BUDDY,
    plutil: PLUTIL,
    sudo: SUDO
  })) {
    fs.writeFileSync(path.join(binDir, name), contents, { mode: 0o755 });
  }
  return {
    binDir,
    statePath,
    jobs: () => JSON.parse(fs.readFileSync(statePath, "utf8")).jobs
  };
}

export function servicePlist(label: string, argv: string[]): string {
  const args = argv.map((value) => `\t\t<string>${value}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${label}</string>
\t<key>ProgramArguments</key>
\t<array>
${args}
\t</array>
\t<key>KeepAlive</key>
\t<true/>
</dict>
</plist>
`;
}
