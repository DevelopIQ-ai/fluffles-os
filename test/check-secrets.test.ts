import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");

function createHarness(): { directory: string; scanner: string; script: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "secret-scan-test-"));
  const scripts = path.join(directory, "deploy", "scripts");
  fs.mkdirSync(scripts, { recursive: true });
  const script = path.join(scripts, "check-secrets.sh");
  fs.copyFileSync(path.join(root, "deploy", "scripts", "check-secrets.sh"), script);
  fs.chmodSync(script, 0o700);
  const scanner = path.join(directory, "real-ripgrep");
  fs.writeFileSync(scanner, `#!/bin/sh
set -eu
if [ "\${1:-}" = "--version" ]; then
  if [ "\${FAKE_RG_MODE:-none}" = wrapper ]; then echo "usage: rg --pattern"; exit 64; fi
  if [ -n "\${FAKE_RG_LOG:-}" ]; then printf '%s\\n' "$0 --version" >>"$FAKE_RG_LOG"; fi
  echo "ripgrep 14.1.0"
  exit 0
fi
for argument in "$@"; do
  case "$argument" in
    *secret-scan-probe.*)
      if [ "\${FAKE_RG_MODE:-none}" = flags ]; then exit 64; fi
      exit 1
      ;;
  esac
done
case "\${FAKE_RG_MODE:-none}" in
  none)
    if [ -n "\${FAKE_RG_LOG:-}" ]; then printf '%s\\n' "$0 scan" >>"$FAKE_RG_LOG"; fi
    exit 1
    ;;
  match) echo "./fixture.txt"; exit 0 ;;
  error) echo "simulated scan failure" >&2; exit 2 ;;
  flags) exit 64 ;;
  *) exit 64 ;;
esac
`, { mode: 0o700 });
  fs.chmodSync(scanner, 0o700);
  return { directory, scanner, script };
}

test("secret scanning distinguishes no matches, findings, scanner errors, and incompatible wrappers", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const run = (mode: string) => execFileAsync(harness.script, [], {
    cwd: harness.directory,
    env: { ...process.env, SECRET_SCAN_RIPGREP: harness.scanner, FAKE_RG_MODE: mode }
  });

  const clean = await run("none");
  assert.match(clean.stdout, /no high-confidence secrets found/);

  await assert.rejects(run("match"), (error: NodeJS.ErrnoException & { stderr?: string }) => {
    assert.equal(error.code, 1);
    assert.match(String(error.stderr), /possible secret matched in: fixture\.txt/);
    return true;
  });

  await assert.rejects(run("error"), (error: NodeJS.ErrnoException & { stderr?: string }) => {
    assert.equal(error.code, 70);
    assert.match(String(error.stderr), /secret scanner failure: ripgrep exited 2/);
    return true;
  });

  await assert.rejects(run("wrapper"), (error: NodeJS.ErrnoException & { stderr?: string }) => {
    assert.equal(error.code, 69);
    assert.match(String(error.stderr), /secret scanner wrapper failure/);
    return true;
  });

  await assert.rejects(run("flags"), (error: NodeJS.ErrnoException & { stderr?: string }) => {
    assert.equal(error.code, 69);
    assert.match(String(error.stderr), /ripgrep option contract is incompatible/);
    return true;
  });
});

test("secret scanning prefers a compatible system rg on PATH over bundled fallbacks", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.directory, { recursive: true, force: true }));
  const systemBin = path.join(harness.directory, "system-bin");
  fs.mkdirSync(systemBin);
  const systemRg = path.join(systemBin, "rg");
  fs.renameSync(harness.scanner, systemRg);
  const log = path.join(harness.directory, "rg.log");

  const result = await execFileAsync(harness.script, [], {
    cwd: harness.directory,
    env: {
      ...process.env,
      SECRET_SCAN_RIPGREP: "",
      FAKE_RG_MODE: "none",
      FAKE_RG_LOG: log,
      PATH: `${systemBin}${path.delimiter}${process.env.PATH || ""}`
    }
  });

  assert.match(result.stdout, /no high-confidence secrets found/);
  assert.match(fs.readFileSync(log, "utf8"), new RegExp(`${systemRg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} --version`));
});
