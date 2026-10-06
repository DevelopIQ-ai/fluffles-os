import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_EVENT_SECRET_ENV, resolveConfig } from "../src/config";

function withEnvironment(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a secret in the environment is verified against without being pointed at", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "automations-config-"));

  withEnvironment({ [DEFAULT_EVENT_SECRET_ENV]: undefined, AUTOMATIONS_EVENT_SECRET_ENV: undefined }, () => {
    assert.equal(resolveConfig(cwd).eventSecretEnv, null);
  });

  withEnvironment({ [DEFAULT_EVENT_SECRET_ENV]: "s3cret", AUTOMATIONS_EVENT_SECRET_ENV: undefined }, () => {
    assert.equal(resolveConfig(cwd).eventSecretEnv, DEFAULT_EVENT_SECRET_ENV);
  });

  withEnvironment({ [DEFAULT_EVENT_SECRET_ENV]: "s3cret", AUTOMATIONS_EVENT_SECRET_ENV: "OTHER_SECRET" }, () => {
    assert.equal(resolveConfig(cwd).eventSecretEnv, "OTHER_SECRET");
  });
});
