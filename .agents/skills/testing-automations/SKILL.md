---
name: testing-automations
description: How to exercise the @fluffles/automations daemon and CLI end to end on a non-Mac box (throwaway registry, stub channels, HMAC signing, clock and concurrency checks).
---

# Testing the automations primitive

The engine lives in `packages/automations` (`@fluffles/automations`); definitions live in
`automations/<id>/automation.json`. There is no UI, so all testing is CLI + HTTP.

## Build first

```sh
npm run build --prefix packages/storage && npm run build --prefix packages/automations
CLI=packages/automations/dist/src/cli.js   # commands: init list validate sync run fire runs doctor serve
```

`node:sqlite` needs Node >= 22.13 and prints an ExperimentalWarning on every CLI invocation; filter it
out of assertions rather than treating it as an error.

## Never test against the repo registry directly

The migrated specs' `command` steps point at `/Users/ai/...`, which does not exist off the Mac mini, so
`run <id>` for those will always fail on Linux. Copy the registry into a temp dir and add throwaway
specs whose steps are `/bin/echo`, `/bin/sleep`, or an http step aimed at a local stub. Copying
`email-inbound` and `agentphone-inbound` verbatim is worthwhile: their steps are http, so they do run.

Point the CLI at the lab with an `automations.config.json` in the working directory
(`root`, `stateDir`, `ingress.host/port`, `eventPath`, `eventSecretEnv`, `tickMs`) or with
`AUTOMATIONS_ROOT` / `AUTOMATIONS_STATE_DIR` / `AUTOMATIONS_PORT` / `AUTOMATIONS_EVENT_SECRET_ENV` /
`AUTOMATIONS_TICK_MS`. Set `tickMs` to ~2000 so schedule tests take a minute instead of fifteen.

## Signing requests

Both `/events/inbound` and per-spec `http` triggers verify `sha256=<hex hmac of the raw body>`:

```sh
sig() { printf '%s' "$2" | openssl dgst -sha256 -hmac "$1" | awk '{print "sha256="$2}'; }
curl -X POST "$BASE/events/inbound" -H "x-webhook-signature: $(sig "$SECRET" "$BODY")" --data-binary "$BODY"
```

The header name for `/events/inbound` is always `x-webhook-signature`; a per-spec http trigger uses the
header named in its own `verify.header`. Expect 401 for a bad/missing signature, 400 for malformed JSON,
503 when the secret env var is unset or the automation is disabled, 404 when no spec serves method+path.

## Watch out: killing the daemon

Launching with `setsid node $CLI serve &` makes `$!` the wrapper pid, so `kill $!` leaves the daemon
running and a later "restart" dies with `EADDRINUSE` while the old daemon keeps serving. Any test about
downtime (catch-up, restart behaviour) is then meaningless. Kill with a self-non-matching pattern and
prove it is down before continuing:

```sh
pkill -f 'cli[.]js serve'      # brackets stop pkill from matching the invoking shell itself
ss -ltn | grep -q ':8899' && echo "still up"
curl -s -m 2 "$BASE/healthz"   # must fail
```

Note the same trap in your own tooling: `pkill -f 'cli.js serve'` run from a one-shot shell kills that
shell, which shows up as a mysterious exit code -1.

## Inspecting durable state

State is a `LedgerDb` sqlite file plus per-automation receipts:

```
<stateDir>/automations.sqlite                      tables: automation_trigger_state, automation_active_runs, automation_runs
<stateDir>/automations/<id>/runs.jsonl             append-only receipt of every run record
```

There is no `sqlite3` binary on the Devin box; read and edit with `node:sqlite`
(`const { DatabaseSync } = require("node:sqlite")`). Forcing `automation_trigger_state.next_run_at` into
the past is the fast way to test catch-up and `doctor`'s overdue reporting without waiting real hours.

## Useful scenario recipes

- schedule really fires: a `* * * * *` spec should produce exactly one run per wall-clock minute, never
  one per tick; assert on the count in `automation_runs`, not just on a log line existing.
- hot add: write a new spec directory while `serve` is running; `prime()` runs every tick so it should
  get a `nextRunAt` within one tick and fire on the next boundary.
- concurrency: a spec with `maxConcurrentRuns: 1` and a `/bin/sleep 6` step plus an `http` trigger lets
  you fire N concurrent curls; expect one 202 completed and N-1 HTTP 500 with `status: rejected`, and
  check BOTH sqlite and `runs.jsonl`.
- cron correctness: differential-test `nextCronRun` from `dist/src/cron.js` against a brute-force
  minute-by-minute walk built from the package's own `parseCron`/`matchesCron`; cover DST transitions and
  leap-day expressions. Remember the engine's horizon is four years, so a cheap reference limited to a
  few hundred days will report false "null" mismatches.
- portability: `init` in an empty directory, then add a spec and `fire` it there; grep the result for
  `/Users/ai` and `amalgm` to confirm nothing fluffles-specific leaked in.

## Devin Secrets Needed

None. Everything above runs locally with throwaway secrets you export yourself
(e.g. `LAB_EVENT_SECRET`, and whatever env var name a spec's `verify.secretEnv` references).
