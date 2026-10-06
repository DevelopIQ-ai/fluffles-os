import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const sourceWrapper = path.join(root, "bin", "infisical-run");

type Harness = {
  root: string;
  wrapper: string;
  bootstrap: string;
  tmp: string;
};

function createHarness(options: { bootstrap?: string; authTimeoutSeconds?: number } = {}): Harness {
  // The harness is a throwaway home, because the wrapper takes every path from
  // the account it runs as: FLUFFLES_HOME is the only thing the test sets.
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), "infisical-run-test-"));
  const bootstrapDir = path.join(harnessRoot, "auth", "infisical");
  const binDir = path.join(harnessRoot, "homebrew", "bin");
  const packageBinDir = path.join(harnessRoot, "packages", "auth", "bin");
  const tmp = path.join(harnessRoot, "tmp");
  fs.mkdirSync(packageBinDir, { recursive: true });
  fs.mkdirSync(bootstrapDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  fs.chmodSync(bootstrapDir, 0o700);

  const bootstrap = path.join(bootstrapDir, "machine-identity.env");
  fs.writeFileSync(
    bootstrap,
    options.bootstrap
      ?? "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=test-client-id\nINFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=test-client-secret\n",
    { mode: 0o600 }
  );
  fs.chmodSync(bootstrap, 0o600);

  const fakeCli = path.join(binDir, "infisical");
  fs.writeFileSync(fakeCli, `#!/bin/sh
set -eu
case "\${1:-}" in
  login)
    if [ "\${TEST_EXPECT_SANITIZED:-0}" = "1" ]; then
      test -z "\${AWS_SESSION_TOKEN:-}"
      test -z "\${AWS_ACCESS_KEY_ID:-}"
      test -z "\${OPENAI_API_KEY:-}"
      test -z "\${SSH_AUTH_SOCK:-}"
    fi
    test -n "\${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}"
    test -n "\${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:-}"
    case "\${FAKE_LOGIN_MODE:-ok}" in
      fail) exit 9 ;;
      hang) exec /bin/sleep 30 ;;
      hang-ignore-term)
        trap '' HUP INT TERM
        printf '%s\\n' "$$" >"\${FAKE_LOGIN_PID_FILE:?}"
        while :; do /bin/sleep 1; done
        ;;
    esac
    printf 'fake-access-token\\n'
    ;;
  run)
    if [ "\${TEST_EXPECT_SANITIZED:-0}" = "1" ]; then
      test -z "\${AWS_SESSION_TOKEN:-}"
      test -z "\${AWS_ACCESS_KEY_ID:-}"
      test -z "\${OPENAI_API_KEY:-}"
      test -z "\${SSH_AUTH_SOCK:-}"
    fi
    test -z "\${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}"
    test -z "\${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:-}"
    test -z "\${INFISICAL_TOKEN:-}"
    test "\${INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN:-}" = fake-access-token
    path_seen=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --token=*) exit 89 ;;
        --path=*) path_seen="\${1#--path=}" ;;
        --) shift; break ;;
      esac
      shift
    done
    test "$path_seen" = "\${FAKE_EXPECT_PATH:-/services/phone}"
    if [ "\${FAKE_RUN_FAIL:-0}" = "1" ]; then exit 74; fi
    case "$path_seen" in
      /services/phone)
        if [ "\${TEST_OMIT_PHONE_VALUE:-0}" != "1" ]; then
          PHONE_EXECUTOR_MCP_AUTHORIZATION="\${TEST_PHONE_VALUE:-injected-phone-secret}"
          export PHONE_EXECUTOR_MCP_AUTHORIZATION
        fi
        ;;
      /services/github-gh)
        if [ "\${TEST_OMIT_GITHUB_VALUE:-0}" != "1" ]; then
          GITHUB_TOKEN="\${TEST_GITHUB_VALUE:-injected-github-token}"
          export GITHUB_TOKEN
        fi
        ;;
    esac
    UNRELATED_VAULT_SECRET="future-secret-not-allowlisted"
    export UNRELATED_VAULT_SECRET
    exec "$@"
    ;;
  *)
    exit 64
    ;;
esac
`, { mode: 0o700 });
  fs.chmodSync(fakeCli, 0o700);

  const projectFile = path.join(bootstrapDir, "project-id");
  fs.writeFileSync(projectFile, "00000000-0000-4000-8000-000000000000\n", { mode: 0o600 });

  const wrapper = path.join(packageBinDir, "infisical-run");
  const infisicalExec = path.join(packageBinDir, "infisical-exec");
  const tempState = path.join(packageBinDir, "auth-temp-state");
  const processIdentity = path.join(packageBinDir, "auth-process-identity");
  fs.copyFileSync(path.join(root, "bin", "infisical-exec"), infisicalExec);
  fs.copyFileSync(path.join(root, "bin", "auth-temp-state"), tempState);
  fs.copyFileSync(path.join(root, "bin", "auth-process-identity"), processIdentity);
  fs.chmodSync(infisicalExec, 0o700);
  fs.chmodSync(tempState, 0o700);
  fs.chmodSync(processIdentity, 0o700);
  let wrapperText = fs.readFileSync(sourceWrapper, "utf8");
  if (options.authTimeoutSeconds != null) {
    wrapperText = wrapperText.replace("auth_timeout_seconds=20", `auth_timeout_seconds=${options.authTimeoutSeconds}`);
  }
  fs.writeFileSync(wrapper, wrapperText, { mode: 0o700 });
  fs.chmodSync(wrapper, 0o700);
  return { root: harnessRoot, wrapper, bootstrap, tmp };
}

function envFor(harness: Harness, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FLUFFLES_HOME: harness.root,
    TMPDIR: harness.tmp,
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "inherited-client-id",
    INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "inherited-client-secret",
    INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN: "inherited-explicit-access-token",
    INFISICAL_TOKEN: "inherited-access-token",
    infisical_client_secret: "inherited-shell-secret",
    infisical_access_token: "inherited-shell-token",
    ...extra
  };
}

const phonePathArgs = ["--path", "/services/phone", "--"];
const githubPathArgs = ["--path", "/services/github-gh", "--"];

test("runtime injection overrides stale values and isolates bootstrap credentials", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  await execFileAsync(harness.wrapper, [
    ...phonePathArgs,
    "/bin/sh",
    "-c",
    [
      'test "$PHONE_EXECUTOR_MCP_AUTHORIZATION" = rotated-phone-secret',
      'test -z "${SLACK_BOT_TOKEN:-}"',
      'test -z "${INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:-}"',
      'test -z "${INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:-}"',
      'test -z "${INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN:-}"',
      'test -z "${INFISICAL_TOKEN:-}"',
      'test -z "${infisical_client_secret:-}"',
      'test -z "${infisical_access_token:-}"',
      'test -z "${AWS_SESSION_TOKEN:-}"',
      'test -z "${AWS_ACCESS_KEY_ID:-}"',
      'test -z "${OPENAI_API_KEY:-}"',
      'test -z "${SSH_AUTH_SOCK:-}"'
    ].join(" && ")
  ], {
    env: envFor(harness, {
      PHONE_EXECUTOR_MCP_AUTHORIZATION: "stale-phone-secret",
      SLACK_BOT_TOKEN: "stale-slack-secret",
      TEST_PHONE_VALUE: "rotated-phone-secret",
      AWS_SESSION_TOKEN: "inherited-aws-session",
      AWS_ACCESS_KEY_ID: "inherited-aws-access-key",
      OPENAI_API_KEY: "inherited-openai-key",
      SSH_AUTH_SOCK: "/tmp/inherited-agent.sock",
      TEST_EXPECT_SANITIZED: "1"
    })
  });

  assert.deepEqual(
    fs.readdirSync(harness.tmp).filter((name) => name.startsWith("infisical-runtime.")),
    []
  );
});

test("the runtime shell derives managed environment cleanup from the allowlist", () => {
  const wrapper = fs.readFileSync(sourceWrapper, "utf8");
  assert.match(wrapper, /managed-environment-names/);
  assert.doesNotMatch(wrapper, /SLACK_BOT_TOKEN/);
  assert.doesNotMatch(wrapper, /GCLOUD_CREDENTIALS_DB_BASE64/);
});

test("account passwords are an allowlisted Infisical path rather than Keychain items", async () => {
  const allowlist = path.join(root, "bin", "infisical-exec");
  await execFileAsync("perl", [allowlist, "validate-path", "/accounts"]);

  const { stdout } = await execFileAsync("perl", [allowlist, "managed-environment-names"]);
  const names = stdout.trim().split("\n");
  for (const name of [
    "GOOGLE_ACCOUNT_EMAIL",
    "GOOGLE_ACCOUNT_PASSWORD",
    "GITHUB_ACCOUNT_EMAIL",
    "GITHUB_ACCOUNT_PASSWORD",
    "MACOS_ACCOUNT_USER",
    "MACOS_ACCOUNT_PASSWORD"
  ]) {
    assert.ok(names.includes(name), `${name} must be a managed runtime value`);
  }

  const agents = fs.readFileSync(path.resolve(root, "..", "..", "AGENTS.md"), "utf8");
  assert.doesNotMatch(agents, /passwords\s+belong only in macOS Keychain/);
});

test("runtime injection filters newly added vault variables through the explicit path allowlist", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  await execFileAsync(harness.wrapper, [
    ...phonePathArgs,
    "/bin/sh",
    "-c",
    'test "$PHONE_EXECUTOR_MCP_AUTHORIZATION" = scoped-phone-secret && test "$PRESERVED_BASELINE" = normal-runtime-value && test -z "${UNRELATED_VAULT_SECRET:-}"'
  ], {
    env: envFor(harness, {
      TEST_PHONE_VALUE: "scoped-phone-secret",
      PRESERVED_BASELINE: "normal-runtime-value"
    })
  });
});

test("a new invocation receives a rotated secret", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  for (const expected of ["first-version", "second-version"]) {
    await execFileAsync(harness.wrapper, [
      ...phonePathArgs,
      "/bin/sh",
      "-c",
      `test "$PHONE_EXECUTOR_MCP_AUTHORIZATION" = ${expected}`
    ], { env: envFor(harness, { TEST_PHONE_VALUE: expected }) });
  }
});

test("login timeout uses a reaping parent instead of a detached PID watchdog", () => {
  const wrapper = fs.readFileSync(sourceWrapper, "utf8");
  assert.match(wrapper, /\$pid = fork\(\)/);
  assert.match(wrapper, /waitpid\(\$pid, WNOHANG\)/);
  assert.match(wrapper, /kill\("KILL", -\$pid\)/);
  assert.doesNotMatch(wrapper, /infisical_watchdog_pid/);
});

test("interrupting authentication drains and reaps a TERM-resistant login process", { timeout: 15_000 }, async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
  const loginPidFile = path.join(harness.root, "login.pid");
  const wrapper = spawn(harness.wrapper, [...phonePathArgs, "/usr/bin/true"], {
    env: envFor(harness, {
      FAKE_LOGIN_MODE: "hang-ignore-term",
      FAKE_LOGIN_PID_FILE: loginPidFile
    }),
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  wrapper.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
  wrapper.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  t.after(() => {
    try { wrapper.kill("SIGKILL"); } catch {}
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const watcher = fs.watch(harness.root, () => {
      if (fs.existsSync(loginPidFile)) finish(resolve);
    });
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      watcher.close();
      wrapper.off("exit", exitedBeforeLogin);
      complete();
    };
    const exitedBeforeLogin = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => reject(new Error(
        `wrapper exited before login process started: code=${code}, signal=${signal}, stdout=${JSON.stringify(Buffer.concat(stdout).toString("utf8"))}, stderr=${JSON.stringify(Buffer.concat(stderr).toString("utf8"))}`
      )));
    };
    wrapper.once("exit", exitedBeforeLogin);
    if (fs.existsSync(loginPidFile)) finish(resolve);
    if (wrapper.exitCode !== null || wrapper.signalCode !== null) {
      exitedBeforeLogin(wrapper.exitCode, wrapper.signalCode);
    }
  });
  const loginPid = Number.parseInt(fs.readFileSync(loginPidFile, "utf8"), 10);
  assert.ok(Number.isInteger(loginPid) && loginPid > 0);

  wrapper.kill("SIGTERM");
  const [code] = await once(wrapper, "exit");
  assert.equal(code, 143);
  assert.throws(() => process.kill(loginPid, 0), { code: "ESRCH" });
});

test("provider process groups are terminated before materializer cleanup", async (t) => {
  const harnessRoot = fs.mkdtempSync(path.join(os.tmpdir(), "auth-run-child-test-"));
  t.after(() => fs.rmSync(harnessRoot, { recursive: true, force: true }));
  const descendantFile = path.join(harnessRoot, "descendant.pid");
  const helper = path.join(root, "bin", "auth-run-child");
  const child = spawn(helper, ["/bin/sh", "-c", `/bin/sleep 30 & echo $! > ${descendantFile}; wait`]);
  for (let attempts = 0; !fs.existsSync(descendantFile) && attempts < 50; attempts += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(fs.existsSync(descendantFile));
  const descendantPid = Number.parseInt(fs.readFileSync(descendantFile, "utf8"), 10);
  assert.ok(Number.isInteger(descendantPid));
  process.kill(-child.pid!, "SIGTERM");
  await once(child, "exit");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
});

test("GitHub receives a rotated token without inherited credential state", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  await execFileAsync(harness.wrapper, [
    ...githubPathArgs,
    "/bin/sh",
    "-c",
    'test "$GITHUB_TOKEN" = rotated-github-token && test -z "${PHONE_EXECUTOR_MCP_AUTHORIZATION:-}"'
  ], {
    env: envFor(harness, {
      FAKE_EXPECT_PATH: "/services/github-gh",
      GITHUB_TOKEN: "stale-github-token",
      TEST_GITHUB_VALUE: "rotated-github-token",
      PHONE_EXECUTOR_MCP_AUTHORIZATION: "stale-phone-secret"
    })
  });
});

test("malformed and duplicate bootstrap entries fail closed", async (t) => {
  const fixtures = [
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=test-client-id\n",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=one\nINFISICAL_UNIVERSAL_AUTH_CLIENT_ID=two\nINFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=secret\n",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID=id\nINFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET=secret\nUNEXPECTED_KEY=value\n"
  ];

  for (const bootstrap of fixtures) {
    const harness = createHarness({ bootstrap });
    t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));
    await assert.rejects(
      execFileAsync(harness.wrapper, [...phonePathArgs, "/usr/bin/true"], { env: envFor(harness) }),
      (error: NodeJS.ErrnoException & { code?: number }) => error.code === 78
    );
  }
});

test("bootstrap permission and symlink violations fail closed", async (t) => {
  const permissionHarness = createHarness();
  t.after(() => fs.rmSync(permissionHarness.root, { recursive: true, force: true }));
  fs.chmodSync(permissionHarness.bootstrap, 0o640);
  await assert.rejects(
    execFileAsync(permissionHarness.wrapper, [...phonePathArgs, "/usr/bin/true"], { env: envFor(permissionHarness) }),
    (error: NodeJS.ErrnoException & { code?: number }) => error.code === 78
  );

  const symlinkHarness = createHarness();
  t.after(() => fs.rmSync(symlinkHarness.root, { recursive: true, force: true }));
  const target = `${symlinkHarness.bootstrap}.target`;
  fs.renameSync(symlinkHarness.bootstrap, target);
  fs.symlinkSync(target, symlinkHarness.bootstrap);
  await assert.rejects(
    execFileAsync(symlinkHarness.wrapper, [...phonePathArgs, "/usr/bin/true"], { env: envFor(symlinkHarness) }),
    (error: NodeJS.ErrnoException & { code?: number }) => error.code === 78
  );
});

test("authentication failure, timeout, run failure, and missing secrets propagate", async (t) => {
  const authFailure = createHarness();
  t.after(() => fs.rmSync(authFailure.root, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(authFailure.wrapper, [...phonePathArgs, "/usr/bin/true"], {
      env: envFor(authFailure, { FAKE_LOGIN_MODE: "fail" })
    }),
    (error: NodeJS.ErrnoException & { code?: number }) => error.code === 77
  );

  const authTimeout = createHarness({ authTimeoutSeconds: 1 });
  t.after(() => fs.rmSync(authTimeout.root, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(authTimeout.wrapper, [...phonePathArgs, "/usr/bin/true"], {
      // The wrapper's own one-second auth timeout is what is under test, so the
      // patience here only has to outlast a loaded machine: a test harness that
      // gives up first kills the child and reports no exit code at all.
      env: envFor(authTimeout, { FAKE_LOGIN_MODE: "hang" }),
      timeout: 60000
    }),
    (error: NodeJS.ErrnoException & { code?: number }) => error.code === 77
  );

  const runFailure = createHarness();
  t.after(() => fs.rmSync(runFailure.root, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(runFailure.wrapper, [...phonePathArgs, "/usr/bin/true"], {
      env: envFor(runFailure, { FAKE_RUN_FAIL: "1" })
    }),
    (error: NodeJS.ErrnoException & { code?: number }) => error.code === 74
  );

  const missingSecret = createHarness();
  t.after(() => fs.rmSync(missingSecret.root, { recursive: true, force: true }));
  await assert.rejects(
    execFileAsync(missingSecret.wrapper, [
      ...phonePathArgs,
      "/bin/sh",
      "-c",
      'test -n "${PHONE_EXECUTOR_MCP_AUTHORIZATION:-}"'
    ], {
      env: envFor(missingSecret, {
        TEST_OMIT_PHONE_VALUE: "1",
        PHONE_EXECUTOR_MCP_AUTHORIZATION: ""
      })
    }),
    (error: NodeJS.ErrnoException & { code?: number }) => error.code === 1
  );
});

test("concurrent bootstrap invocations use independent temporary tokens", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  await Promise.all([
    execFileAsync(harness.wrapper, [...phonePathArgs, "/bin/sh", "-c", 'test -n "$PHONE_EXECUTOR_MCP_AUTHORIZATION"'], {
      env: envFor(harness, { TEST_PHONE_VALUE: "one" })
    }),
    execFileAsync(harness.wrapper, [...phonePathArgs, "/bin/sh", "-c", 'test -n "$PHONE_EXECUTOR_MCP_AUTHORIZATION"'], {
      env: envFor(harness, { TEST_PHONE_VALUE: "two" })
    })
  ]);

  assert.deepEqual(
    fs.readdirSync(harness.tmp).filter((name) => name.startsWith("infisical-token.")),
    []
  );
});

test("an invocation must select one approved service scope", async (t) => {
  const harness = createHarness();
  t.after(() => fs.rmSync(harness.root, { recursive: true, force: true }));

  await assert.rejects(
    execFileAsync(harness.wrapper, ["/usr/bin/true"], { env: envFor(harness) }),
    (error: NodeJS.ErrnoException & { code?: number }) => error.code === 64
  );
  await assert.rejects(
    execFileAsync(harness.wrapper, ["--path", "/", "--", "/usr/bin/true"], { env: envFor(harness) }),
    (error: NodeJS.ErrnoException & { code?: number }) => error.code === 64
  );
});

test("the access token stays out of CLI arguments and is removed before the target executes", () => {
  const source = fs.readFileSync(sourceWrapper, "utf8");
  const targetBoundary = fs.readFileSync(path.join(root, "bin", "infisical-exec"), "utf8");
  assert.match(source, /INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN="\$infisical_access_token"/);
  assert.match(source, /unset INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN/);
  assert.match(targetBoundary, /excluded_baseline_environment_name/);
  assert.match(targetBoundary, /INFISICAL_TOKEN/);
  assert.match(targetBoundary, /INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN/);
  assert.match(targetBoundary, /%ENV = %environment/);
  assert.doesNotMatch(source, /--token="\$infisical_access_token"/);
});
