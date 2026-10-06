import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(__dirname, "..");
const runSubagent = path.join(root, "subagents", "bin", "run-subagent");

/**
 * The guardian is a bash program embedded in run-subagent as an array of string
 * literals. Reading it back is what makes the identity comparison testable.
 */
function guardianScript(): string {
  const source = fs.readFileSync(runSubagent, "utf8");
  const start = source.indexOf("const guardian = [");
  const end = source.indexOf('].join("\\n");', start);
  assert.ok(start >= 0 && end > start, "run-subagent must build its guardian from a string array");
  const literal = source.slice(source.indexOf("[", start), end + 1);
  const lines = new Function(`return ${literal};`)() as string[];
  return lines.join("\n");
}

function ownerStartedAt(pid: number): string {
  return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trimEnd();
}

test("subagent responses go somewhere the other harness on this machine cannot own", () => {
  const source = fs.readFileSync(runSubagent, "utf8");
  const literal = source.match(/const OUTPUT_ROOT =[\s\S]*?;\n/)?.[0] ?? "";
  assert.match(literal, /SUBAGENT_OUTPUT_ROOT/);
  assert.match(literal, /basename\(HOME\)/);
  assert.doesNotMatch(literal, /"fluffles-subagent-responses"/);
});

test("the guardian reads every process start time through one normalizer", () => {
  const script = guardianScript();
  const rawReads = script.split("\n").filter((line) => line.includes("ps -o lstart="));
  assert.equal(rawReads.length, 1, `only process_started_at may call ps -o lstart=, found:\n${rawReads.join("\n")}`);
  assert.match(rawReads[0], /process_started_at|value=/);
});

test("the guardian sees a live owner even when ps pads its output", () => {
  const script = guardianScript();
  const helper = script.slice(script.indexOf("process_started_at() {"), script.indexOf("remember_process() {"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "guardian-identity-"));
  try {
    // macOS pads `ps -o lstart=` to the column width, so the shell keeps trailing
    // spaces that the owner's own trimEnd() has already removed.
    const fakePs = path.join(dir, "ps");
    fs.writeFileSync(fakePs, `#!/bin/sh\nprintf '%s    \\n' "Tue Aug  4 14:46:40 2026"\n`, { mode: 0o755 });
    const compare = [
      helper,
      'expected="$1"',
      'actual="$(process_started_at 1)"',
      '[ "$actual" = "$expected" ] && echo match || echo "mismatch: [$actual] != [$expected]"'
    ].join("\n");
    const padded = execFileSync(fakePs, [], { encoding: "utf8" }).trimEnd();
    const result = execFileSync("/bin/bash", ["-c", compare, "--", padded], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` }
    }).trim();
    assert.equal(result, "match");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the owner identity the guardian is handed matches the normalizer", () => {
  const script = guardianScript();
  const helper = script.slice(script.indexOf("process_started_at() {"), script.indexOf("remember_process() {"));
  const compare = [
    helper,
    'expected="$1"',
    'actual="$(process_started_at "$2")"',
    '[ "$actual" = "$expected" ] && echo match || echo "mismatch: [$actual] != [$expected]"'
  ].join("\n");
  const result = execFileSync("/bin/bash", ["-c", compare, "--", ownerStartedAt(process.pid), String(process.pid)], {
    encoding: "utf8"
  }).trim();
  assert.equal(result, "match");
});
