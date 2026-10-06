import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(__dirname, "..");
const materialize = path.join(root, "bin", "materialize");
const binDirectory = path.join(root, "bin");

type Run = { status: number | null; stdout: string; stderr: string; state: string; observed: string };

// The runner is exercised against a spec of its own so the assertions describe
// behavior rather than the text of any one tool's spec.
function runSpec(spec: string, args: string[], environment: Record<string, string>): Run {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-test-"));
  const specDirectory = path.join(workspace, "specs");
  const state = path.join(workspace, "state");
  fs.mkdirSync(specDirectory);
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(specDirectory, "sample"), spec);
  const result = spawnSync(materialize, ["sample", ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: workspace,
      TMPDIR: state,
      MATERIALIZE_BIN_DIR: binDirectory,
      MATERIALIZE_SPEC_DIR: specDirectory,
      SAMPLE_OUTPUT: path.join(workspace, "observed.json"),
      ...environment
    }
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    state,
    observed: path.join(workspace, "observed.json")
  };
}

// Records everything the provider can see, which is what the runner's contract
// is actually about: the files it was given and the variables it inherited.
const recorder = `#!/bin/sh
{
  echo "arguments: $*"
  echo "codex_home: \${CODEX_HOME:-unset}"
  echo "sample_flag: \${SAMPLE_FLAG:-unset}"
  echo "injected: \${SAMPLE_SECRET:-unset}"
  echo "second: \${SAMPLE_OTHER:-unset}"
  for file in "\${SAMPLE_HOME}"/*; do
    [ -f "$file" ] || continue
    echo "file: \${file##*/} $(stat -c '%a' "$file" 2>/dev/null || stat -f '%Lp' "$file") $(cat "$file")"
  done
} >"$SAMPLE_OUTPUT"
`;

function recorderPath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-recorder-"));
  const file = path.join(directory, "provider");
  fs.writeFileSync(file, recorder, { mode: 0o755 });
  return file;
}

test("the runner writes every declared credential privately and hands the provider only its files", () => {
  const provider = recorderPath();
  const spec = `
spec_state_prefix="codex-auth"
spec_component="sample"
spec_require="SAMPLE_SECRET SAMPLE_OTHER"
spec_files="SAMPLE_SECRET:auth.json SAMPLE_OTHER:blob.bin:base64"
spec_exec="${provider}"
spec_prepare() {
  SAMPLE_HOME="$temporary_dir"
  export SAMPLE_HOME
  export SAMPLE_FLAG="prepared"
}
`;
  const run = runSpec(spec, ["run", "--now"], {
    SAMPLE_SECRET: '{"token":"live"}',
    SAMPLE_OTHER: Buffer.from("decoded-blob").toString("base64")
  });
  assert.equal(run.status, 0, run.stderr);
  const observed = fs.readFileSync(run.observed, "utf8");
  assert.match(observed, /arguments: run --now/);
  assert.match(observed, /sample_flag: prepared/);
  // The provider must never inherit the raw injected credential.
  assert.match(observed, /injected: unset/);
  assert.match(observed, /second: unset/);
  assert.match(observed, /file: auth\.json 600 \{"token":"live"\}/);
  assert.match(observed, /file: blob\.bin 600 decoded-blob/);
});

test("the runner refuses to start a provider whose credential was not injected", () => {
  const run = runSpec(
    `
spec_state_prefix="codex-auth"
spec_component="sample"
spec_require="SAMPLE_SECRET"
spec_exec="/usr/bin/true"
`,
    [],
    {}
  );
  assert.equal(run.status, 78);
  assert.match(run.stderr, /sample: SAMPLE_SECRET was not injected/);
});

test("the runner removes the private credential directory once the provider exits", () => {
  const run = runSpec(
    `
spec_state_prefix="codex-auth"
spec_component="sample"
spec_require="SAMPLE_SECRET"
spec_files="SAMPLE_SECRET:auth.json"
spec_exec="/usr/bin/true"
`,
    [],
    { SAMPLE_SECRET: "value" }
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(run.state), []);
});

test("a descendant the provider left running is drained before the credentials are removed", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-drain-test-"));
  const descendant = path.join(workspace, "descendant.pid");
  const run = runSpec(
    `
spec_state_prefix="codex-auth"
spec_component="sample"
spec_require="SAMPLE_SECRET"
spec_files="SAMPLE_SECRET:auth.json"
spec_exec="/bin/sh"
spec_exec_arguments="-c"
`,
    [`/bin/sleep 30 & echo $! >"${descendant}"`],
    { SAMPLE_SECRET: "value" }
  );
  assert.equal(run.status, 0, run.stderr);
  const pid = Number.parseInt(fs.readFileSync(descendant, "utf8"), 10);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(fs.readdirSync(run.state), []);
});

test("the runner propagates the provider's exit status", () => {
  const run = runSpec(
    `
spec_state_prefix="codex-auth"
spec_component="sample"
spec_exec="/bin/sh"
spec_exec_arguments="-c"
`,
    ["exit 17"],
    {}
  );
  assert.equal(run.status, 17);
});

test("a credential is pushed back only when the provider actually refreshed it", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-push-test-"));
  const bin = path.join(workspace, "bin");
  fs.mkdirSync(bin);
  // A recording stub stands in for auth-push, so the assertion is about which
  // credentials the runner decides to push rather than about Infisical.
  for (const helper of ["auth-temp-state", "auth-run-child", "auth-process-group", "auth-lock-holder"]) {
    fs.symlinkSync(path.join(binDirectory, helper), path.join(bin, helper));
  }
  fs.writeFileSync(path.join(bin, "auth-push"), `#!/bin/sh\necho "$*" >>"${workspace}/pushed"\n`, { mode: 0o755 });

  const specDirectory = path.join(workspace, "specs");
  fs.mkdirSync(specDirectory);
  fs.writeFileSync(
    path.join(specDirectory, "sample"),
    `
spec_state_prefix="codex-auth"
spec_component="sample"
spec_require="ROTATING STATIC"
spec_files="ROTATING:rotating.json STATIC:static.json"
spec_push="/services/sample:ROTATING:rotating.json /services/sample:STATIC:static.json"
spec_exec="/bin/sh"
spec_exec_arguments="-c"
spec_prepare() {
  export SAMPLE_HOME="$temporary_dir"
}
`
  );
  const state = path.join(workspace, "state");
  fs.mkdirSync(state);
  const refresh = 'printf \'{"token":"rotated"}\' >"$SAMPLE_HOME/rotating.json"';
  const result = spawnSync(materialize, ["sample", refresh], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: workspace,
      TMPDIR: state,
      MATERIALIZE_BIN_DIR: bin,
      MATERIALIZE_SPEC_DIR: specDirectory,
      ROTATING: '{"token":"original"}',
      STATIC: '{"token":"unchanged"}'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  const pushed = fs.readFileSync(path.join(workspace, "pushed"), "utf8");
  assert.match(pushed, /\/services\/sample ROTATING /);
  assert.doesNotMatch(pushed, /STATIC/);
});

test("github-ssh refuses to use the deploy key for any host but GitHub", () => {
  const result = spawnSync(materialize, ["github-ssh", "evil.example.com"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", MATERIALIZE_SPEC_DIR: path.join(binDirectory, "materialize.d") }
  });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /refusing to use GitHub deploy keys for a non-GitHub host/);
});

test("every tool spec is loadable and declares a credential contract the vault allows", () => {
  const specDirectory = path.join(binDirectory, "materialize.d");
  const allowlist = fs.readFileSync(path.join(binDirectory, "infisical-exec"), "utf8");
  const temporaryState = fs.readFileSync(path.join(binDirectory, "auth-temp-state"), "utf8");
  const specs = fs.readdirSync(specDirectory);
  assert.deepEqual(specs.sort(), ["amalgm", "codex", "gcloud", "github-ssh", "gws"]);

  for (const name of specs) {
    const file = path.join(specDirectory, name);
    execFileSync("/bin/sh", ["-n", file]);
    const contents = fs.readFileSync(file, "utf8");
    const prefix = contents.match(/^spec_state_prefix="([^"]+)"$/m)?.[1];
    assert.ok(prefix, `${name} declares no state prefix`);
    assert.ok(temporaryState.includes(prefix), `${name} uses a prefix auth-temp-state rejects`);
    for (const [, secretPath, secret] of contents.matchAll(/(\/services\/[\w-]+):([A-Z0-9_]+):/g)) {
      assert.ok(allowlist.includes(secretPath), `${name} pushes to an unapproved path`);
      assert.ok(allowlist.includes(secret), `${name} pushes an unapproved secret`);
    }
  }
});
