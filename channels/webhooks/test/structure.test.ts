import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");

test("event triggers moved to the automations registry", () => {
  assert.equal(fs.existsSync(path.join(root, "triggers")), false);
  assert.equal(fs.existsSync(path.join(root, "lib", "amalgm-events.ts")), false);
  assert.equal(fs.existsSync(path.resolve(root, "..", "..", "automations")), true);
});

test("webhooks manager no longer has first-party js source", () => {
  const jsFiles: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".git"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) jsFiles.push(path.relative(root, full));
    }
  }
  walk(root);
  assert.deepEqual(jsFiles, []);
});
