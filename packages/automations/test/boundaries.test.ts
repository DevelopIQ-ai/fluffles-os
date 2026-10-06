import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";

// Tests run from dist, so the boundary is checked against the real sources.
const packageDir = path.basename(path.resolve(__dirname, "..")) === "dist"
  ? path.resolve(__dirname, "..", "..")
  : path.resolve(__dirname, "..");
const srcDir = path.join(packageDir, "src");
const allowedPackages = new Set(["@fluffles/storage"]);
const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  // Experimental builtins are absent from `builtinModules`.
  "node:sqlite"
]);

function sources(): string[] {
  return fs.readdirSync(srcDir).filter((name) => name.endsWith(".ts")).sort();
}

function imports(file: string): string[] {
  const text = fs.readFileSync(path.join(srcDir, file), "utf8");
  return [...text.matchAll(/(?:from|require\()\s*"([^"]+)"/g)].map((match) => match[1] as string);
}

test("the engine depends only on node builtins, its own modules, and @fluffles/storage", () => {
  for (const file of sources()) {
    for (const specifier of imports(file)) {
      if (specifier.startsWith(".")) {
        assert.ok(
          fs.existsSync(path.join(srcDir, `${specifier.replace(/^\.\//, "")}.ts`)),
          `${file} imports ${specifier}, which is not a module of this package`
        );
        continue;
      }
      assert.ok(
        builtins.has(specifier) || allowedPackages.has(specifier),
        `${file} imports ${specifier}; the engine must stay portable`
      );
    }
  }
});

test("the engine hard-codes no host paths and no transport provider", () => {
  for (const file of sources()) {
    const text = fs.readFileSync(path.join(srcDir, file), "utf8");
    assert.doesNotMatch(text, /\/Users\/ai/, `${file} must not hard-code the fluffles home`);
    assert.doesNotMatch(text, /amalgm/i, `${file} must not know about the transport provider`);
  }
});

test("every module keeps one job, so nothing imports the composition root", () => {
  for (const file of sources()) {
    if (file === "cli.ts" || file === "index.ts" || file === "service.ts") continue;
    assert.ok(!imports(file).includes("./service"), `${file} must not depend on the composition root`);
  }
});
