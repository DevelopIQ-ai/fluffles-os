---
name: testing-deploy-hosts
description: How to test the host-driven deployer (bin/deploy-main, deploy/hosts/*.json, render-services, install-system-services) end to end on a Linux box, including real deploys against throwaway trees with a fake launchd and proving dev/prod isolation.
---

# Testing the deployer and the host boundary

Everything here runs on a plain Linux Devin box. **Do not ssh to the Mac mini to test a deploy
change** — the whole point of the host indirection is that a deploy can be exercised against a
throwaway tree. The mini is only needed for a genuine prod/dev runtime check.

No secrets are required for any of this.

## Devin Secrets Needed

None. (`FLUFFLES_MINI_SSH_PRIVATE_KEY` / `TAILSCALE_AUTHKEY` are only for reaching the Mac mini,
which deployer testing does not need.)

## The shape of the system

- `deploy/hosts/{prod,dev}.json` declare hosts; `deploy/services.json` declares every launchd job
  once with `{{HOME}}` / `{{LABEL}}` / `{{PREFIX}}` placeholders and per-host `env` overrides.
- `deploy/lib/host.mjs` resolves + validates; `deploy/bin/host-config.mjs` is the CLI
  (`--host`, `--field`, `--shell`, `--labels`, `--service`, `--services`);
  `deploy/bin/render-services.mjs --out <dir>` writes one plist per service, `--check` exits 3 on drift.
- `bin/deploy-main` line ~25 does `eval "$(host-config --shell)"`. There are **no** checked-in plists.
- `FLUFFLES_HOST_FILE=<path>` points the resolver at a throwaway host file and takes precedence over
  `--host` / `FLUFFLES_HOST`. This is the hook for all isolated testing.

## Quick checks

```sh
npm test                                    # ~30s suite + tsc build; 2 macOS-only /Users/ai probes SKIP
node deploy/bin/host-config.mjs --host dev --shell
node deploy/bin/render-services.mjs --host dev --out /tmp/render-dev
bash -n bin/deploy-main
```

Isolation is worth asserting mechanically over the concatenated dev render: zero `/Users/ai`,
zero `com.puffle.` not followed by `dev.` (use `grep -oP 'com\.puffle\.(?!dev\.)'`), zero
`/Library/LaunchDaemons`, zero prod ports, and zero leftover `{{` placeholders.

To prove a refactor did not change prod's manifests, fetch the old plists with
`git show <base>:<path>` and compare **semantically**, not byte-wise: the renderer may order
`EnvironmentVariables` keys differently, which is meaningless in a plist `<dict>`. Parse Label,
ProgramArguments (order matters), the scalar keys, and the env key/value set.

## Real deploys against a throwaway tree

`test/support/fake-launchd.ts` provides fake `launchctl`, `PlistBuddy`, `plutil` and `sudo` on a
temp PATH. The fake is faithful in the one way that matters: **a bootstrapped job keeps running the
argv it was bootstrapped with**, so a deploy that rewrites a plist without reloading is caught.
`test/support/host.ts` has `writeHostFile`, `installDeploySource`, `renderServices`.

The cheapest way to write a new deploy scenario is to copy the head of
`test/deploy-service-restart.test.ts` up to its first `test(` (that is the whole harness: repo
builder, fake launchd, host file, `setUp()` returning `deploy()` / `receipt()` / `jobs()` /
`moveWrapper()` / `commit()`) and append your own tests. Drop the file in `test/`, run it with
`node --import tsx --test test/<file>.test.ts`, then delete it. Note the harness stubs only
`task_control` and `install_dependencies`; every other stage runs for real.

Useful knobs the harness sets: `DEPLOY_SYSTEM_DAEMON_ROOT`, `DEPLOY_PLISTBUDDY`,
`DEPLOY_RESTART_WAIT_ATTEMPTS=2`, `DEPLOY_SMOKE_ATTEMPTS=1`, `FAKE_LAUNCHD_STATE`,
`FAKE_LAUNCHD_GUI=1`, and the `INSTALL_SYSTEM_SERVICES_*` overrides.

### Testing a user-domain (dev-shaped) host

Set the throwaway host's `domain: "user"` and its `systemDaemonRoot` to
`<home>/Library/LaunchAgents` — `start_services` reads user-domain manifests from that hard-coded
path, so a mismatch makes the deploy fail for the wrong reason. Bootstrap the pre-existing runtime
into `gui/<uid>` rather than `system`, and make the fake `bin/smoke` probe
`launchctl print "gui/<uid>/<label>"`.

### Proving dev never touches prod

The high-value test: seed production's real labels as running `system/<label>` jobs directly into
the fake launchd state JSON, run a full dev-shaped (user-domain) deploy, then assert those seven
entries are byte-identical before and after. Also assert no dev label appears under `system/`.

**Always pair such a test with a negative control**, or it proves nothing. Run the identical
before/after state comparison against a *system*-domain deploy whose labels are the seeded jobs and
confirm it fails. Same for "the live tree was untouched" assertions: re-run with the failure removed
(e.g. let `verify-source.sh` pass) and confirm the assertion fires. Compare a full sha256 manifest of
the harness home, excluding `state/`, which the deploy legitimately rewrites.

## Testing the local Executor gateway on Linux

The executor npm package (pinned in `executor/package.json`) runs fine on Linux, so
`bin/executor-daemon` and `bin/executor-register` can be exercised locally without the Mac:

- Build a temp harness home containing `executor/node_modules` (`npm install --prefix executor`
  first), `tools/mcp/manifests/`, `bin/mcp-serve`, and `packages/mcp` with its deps.
- Point `HOME`/`FLUFFLES_HOME` at it and pick a free `EXECUTOR_PORT`; the daemon auto-creates its
  token at `$HOME/.executor/server-control/auth.json`.
- `executor-register` should report every manifest `added` on the first run, all `unchanged` on the
  second, and exactly one `replaced` after touching a single manifest (fingerprint re-discovery).
- Cleanup trap: `pkill -f 'executor-daemon'` kills the shell running it; use a bracketed pattern
  like `pkill -f '[e]xecutor-daemon'`.

## Adversarial resolver checks

Feed each bad host file to **both** `render-services.mjs --out <dir>` and `host-config.mjs --shell`,
and require exit **64**, a `host-config: ` prefixed message on stderr, empty stdout, and that the
`--out` directory was never created. Cases that should all be rejected: a missing required field,
`supervisor: systemd`, an unknown `domain`, a `ref` with no remote, invalid JSON, a host listing a
service name that `services.json` does not declare, and a nonexistent `--host` name.

## Known rough edges to re-check after any deployer change

- A bad host file exits 78 with a receipt and a Slack alert. If that regresses to
  `home: unbound variable` and exit 1, the failure is silent under the poller.
- `deploy/scripts/install-system-services` takes its destination from the host's
  `systemDaemonRoot`, refuses a user-domain destination outside the host's home, and refuses to run
  from an account that is not the host's user. Production and the dev harness share one machine and
  root can install either, so that last guard is what stops a dev tree from reinstalling
  production's daemons.
- `sync_launchd_files` and `start_services` hard-code `${home}/Library/LaunchAgents` while the
  installer uses the host's `systemDaemonRoot`. These coincide for `dev` today; a future user-domain
  host that sets `systemDaemonRoot` elsewhere would render and bootstrap from different directories.
- `host-config --shell` does not emit `state_dir`, so any test reading `shellVariables(x).state_dir`
  is silently concatenating `undefined`. Check `--shell` output before asserting on a variable name.
- `service_labels` from `--shell` deliberately excludes `deploy-main` so a deploy cannot bootout the
  poller it runs inside. Assert that stays true.

## What only the real Mac finds

The Linux suites cannot see these, and each one broke a real dev deploy:

- launchd refuses a job with `EX_CONFIG` when it cannot write the log file, which includes a log
  file left owned by root by an earlier privileged run. Check `ls -l` on the log directory before
  believing the service is at fault.
- `state = spawn scheduled` with `last exit code = 78` means the wrapper refused, not that launchd
  is confused; read the service's own stderr log.
- A fresh harness has no Infisical folder for a service the deploy smoke-tests. Create the folder
  first (`infisical secrets folders create`), then push the secret; `secrets set` into a path that
  does not exist fails.
- A deploy lock directory left without its owner file, by a poller killed mid-run, reads as live and
  needs `rmdir ~/state/deploy-main/lock`.
- Tests that budget a second or two of wall clock pass on a quiet Linux box and fail candidate
  verification on a machine that is also running the harness.

## Rehearsing an upgrade across a deployer change

When a change alters `bin/deploy-main` itself (managed paths, cleanup, ordering), rehearse the
upgrade in two stages against a fake launchd and throwaway repo/home:

1. Build the fixture twice: extract the old release with `git show <old-rev>:<path>` into the
   home, then run deploy 1 with the old deployer, and deploy 2 from a repo checked out at the new
   revision.
2. The harness-patched runner scripts must live under `<home>/bin`, because deploy-main derives
   the home directory from its own path.
3. Assert both directions: a successful deploy 2 converges the home (including shedding anything
   the new deployer is supposed to remove), and a forced smoke failure on deploy 2 leaves the old
   tree byte-identical with services still running.

## Release harness notes (test/support/deploy-release.ts)

- With the release-installs-itself model, deploy 1's exact sync removes the throwaway launcher
  (`bin/deploy-main-under-test`); a second deploy in the same fixture needs `h.installLauncher()`
  first.
- Service fixtures declare `entry` (and `secretsPath` when secrets are needed): the
  breadcrumb/infisical scaffold is derived by `renderService`, so never hand-write it in a fixture.

## Flakiness

The deploy suites shell out to git and spawn processes. Run
`node --import tsx --test test/deploy-main.test.ts` and `test/deploy-service-restart.test.ts` five
times each before calling a deploy change stable; they were 10/10 clean at the time of writing.
