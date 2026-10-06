import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(__dirname, "..");
const helper = path.join(root, "bin", "with-tool-secrets");

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "with-tool-secrets-"));
  fs.mkdirSync(path.join(home, "tools", "mcp", "manifests"), { recursive: true });
  fs.mkdirSync(path.join(home, "homebrew", "bin"), { recursive: true });
  fs.mkdirSync(path.join(home, "packages", "auth", "bin"), { recursive: true });
  fs.symlinkSync(process.execPath, path.join(home, "homebrew", "bin", "node"));
  fs.writeFileSync(
    path.join(home, "packages", "auth", "bin", "infisical-run"),
    "#!/bin/sh\nprintf 'injected %s\\n' \"$*\"\n",
    { mode: 0o755 }
  );
  return home;
}

function writeManifest(home: string, name: string, manifest: unknown): void {
  fs.writeFileSync(
    path.join(home, "tools", "mcp", "manifests", `${name}.json`),
    JSON.stringify(manifest)
  );
}

function run(home: string, args: string[]) {
  return spawnSync(helper, args, {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", FLUFFLES_HOME: home }
  });
}

test("a manifest secrets path routes the command through infisical-run", (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeManifest(home, "sample", { name: "sample", secrets: { path: "/services/sample" }, tools: [] });
  const result = run(home, ["sample", "--", "/bin/echo", "hello"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "injected --path /services/sample -- /bin/echo hello\n");
});

test("a manifest without secrets runs the command directly", (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeManifest(home, "plain", { name: "plain", tools: [] });
  const result = run(home, ["plain", "--", "/bin/echo", "direct"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "direct\n");
});

test("a corrupt or invalid secrets declaration fails closed", (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  writeManifest(home, "relative", { name: "relative", secrets: { path: "services/sample" }, tools: [] });
  const relative = run(home, ["relative", "--", "/bin/echo", "leak"]);
  assert.equal(relative.status, 78);
  assert.doesNotMatch(relative.stdout, /leak/);

  fs.writeFileSync(path.join(home, "tools", "mcp", "manifests", "broken.json"), "{not json");
  const broken = run(home, ["broken", "--", "/bin/echo", "leak"]);
  assert.equal(broken.status, 78);
  assert.doesNotMatch(broken.stdout, /leak/);
});

test("a missing manifest and malformed usage are refused", (t) => {
  const home = makeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const missing = run(home, ["absent", "--", "/bin/echo", "leak"]);
  assert.equal(missing.status, 78);

  const traversal = run(home, ["../evil", "--", "/bin/echo", "leak"]);
  assert.equal(traversal.status, 64);

  const noSeparator = run(home, ["sample", "/bin/echo"]);
  assert.equal(noSeparator.status, 64);

  const noCommand = run(home, ["sample", "--"]);
  assert.equal(noCommand.status, 64);
});
