import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "..");
const repoRoot = path.resolve(__dirname, "..", "..", "..");

test("Vercel uses the injected personal token without local OAuth state", () => {
  const bootstrap = fs.readFileSync(path.join(root, "bin", "infisical-run"), "utf8");
  const allowlist = fs.readFileSync(path.join(root, "bin", "infisical-exec"), "utf8");
  const wrapper = fs.readFileSync(path.join(repoRoot, "bin", "vercel"), "utf8");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "tools", "mcp", "manifests", "vercel.json"), "utf8")
  );
  const materializer = fs.readFileSync(path.join(root, "bin", "vercel-materialize"), "utf8");

  assert.match(allowlist, /\/services\/vercel/);
  assert.match(allowlist, /VERCEL_TOKEN/);
  assert.equal(manifest.secrets.path, "/services/vercel");
  assert.match(wrapper, /with-tool-secrets" vercel -- /);
  assert.doesNotMatch(wrapper, /infisical-run/);
  assert.doesNotMatch(wrapper, /auth\/tools\/vercel/);
  assert.match(materializer, /VERCEL_TOKEN was not injected/);
  assert.match(materializer, /unset VERCEL_REFRESH_TOKEN/);
  assert.match(materializer, /state\/tools\/vercel\/config/);
  assert.doesNotMatch(materializer, /auth\/tools\/vercel/);
});
