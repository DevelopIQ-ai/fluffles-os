import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");

/**
 * A wrapper may exec something the machine owns rather than the release.
 * Everything else it execs has to exist in the tree, because a wrapper pointing
 * at a directory that moved is a tool that silently stops working after a
 * deploy, which is how bin/executor-mcp kept naming $HOME/executor after the
 * package moved under deploy/.
 */
const runtimeOwnedPrefixes = ["homebrew/", "state/", "auth/", "browser/", "tools/payloads/", "projects/", "Applications", "Library/"];

/** A dependency directory is installed by the deploy, so judge its package instead. */
function releasePath(reference: string): string {
  const index = reference.indexOf("/node_modules/");
  return index === -1 ? reference : reference.slice(0, index);
}

function execTargets(script: string): string[] {
  const targets = script
    .split("\n")
    .filter((line) => /^\s*exec\s+"\$\{home\}\//.test(line))
    .map((line) => line.match(/\$\{home\}\/([A-Za-z0-9._/-]+)/)?.[1] ?? "");
  return [...new Set(targets.filter(Boolean))];
}

test("every wrapper execs something this release actually ships", () => {
  const binDir = path.join(root, "bin");
  const missing: string[] = [];
  let checked = 0;
  for (const name of fs.readdirSync(binDir)) {
    const file = path.join(binDir, name);
    if (!fs.statSync(file).isFile()) continue;
    const script = fs.readFileSync(file, "utf8");
    if (!script.startsWith("#!")) continue;
    for (const target of execTargets(script)) {
      if (runtimeOwnedPrefixes.some((prefix) => target.startsWith(prefix))) continue;
      checked += 1;
      if (!fs.existsSync(path.join(root, releasePath(target)))) missing.push(`bin/${name} -> ${target}`);
    }
  }
  assert.ok(checked > 10, `expected to judge most wrappers, judged ${checked}`);
  assert.deepEqual(missing, [], `wrappers exec paths this release does not have:\n${missing.join("\n")}`);
});
