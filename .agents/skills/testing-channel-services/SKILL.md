---
name: testing-channel-services
description: How to exercise the shared channel kit (channels/email, channels/phone, channels/slack) end to end on a non-Mac Linux box - throwaway HOME, route/auth/webhook matrices, per-channel HMAC signing, CLI one-shots, and a prev-vs-new differential harness for refactors.
---

# Testing channel services (email, phone, slack)

Channel processes share implementations in `packages/conversations`:
`channel-service.ts` (the polling-shaped service used by email and phone), `channel-http.ts`
(`createChannelRouter`, `readChannelRequestBuffer`), and `channel-env.ts` (env file loading plus the
strict `parse*Env` helpers). Everything is re-exported through `@fluffles/tasks`. Slack does not use
the polling service; it composes `createChannelRouter` in `channels/slack/src/slack-http.ts`. All of
this is testable over HTTP and the CLI on Linux with no Gmail/AgentPhone/Slack access.

## Build first (dependency order matters)

`@fluffles/tasks` is consumed from `dist`, so build in this order before starting any channel:

```
for p in packages/storage packages/task-registry packages/scheduler packages/repair-ledger \
         packages/conversations packages/tasks; do npm run build --prefix $p; done
```

If a channel start fails resolving `@fluffles/tasks`, a package in that chain is unbuilt or its
per-package `node_modules` was never installed.

## Starting a channel (the cwd trap)

`tsx` is resolved from the **current working directory**, not from the server file's package. Always
`cd` into the channel package before starting, or you get
`Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx'`:

```
( cd "$TREE/channels/slack" && exec env -i PATH="$PATH" HOME=/tmp/chan/slack PORT=3811 \
    HOST=127.0.0.1 SLACK_SIGNING_SECRET=signing-secret SLACK_POLLING_ENABLED=false \
    node --import tsx src/server.ts )
```

Email/phone equivalents need `<PREFIX>_POLLING_ENABLED=false` and
`<PREFIX>_PROCESSING_ENABLED=false`; phone additionally needs `PHONE_EXECUTOR_MCP_URL`,
`PHONE_EXECUTOR_MCP_AUTHORIZATION` and `PHONE_FROM_NUMBER` (dummy values fine). Slack with no
`SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` boots and reports the unconfigured state
(`ok:false`, `slackConfigured:false`, `lastError:"SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required."`);
that is expected, and the whole HTTP surface is still testable.

Useful knobs: `SLACK_WEBHOOK_MAX_BYTES`, `<PREFIX>_WEBHOOK_MAX_BODY_BYTES`,
`<PREFIX>_WEBHOOK_RATE_LIMIT_PER_MINUTE`, `<PREFIX>_WEBHOOK_ENABLED=false`,
`<PREFIX>_INTERNAL_API_SECRET`, `<PREFIX>_CHANNEL_STATUS_PATH`. Slack's webhook rate limit is
hardcoded (`FixedWindowRateLimiter(120)` in server.ts), so plan on 120 requests to trip it.

## Email/phone service surface

Routes `/healthz` (open), `/` and `/status`, `/poll`, `/run`, the channel's webhook paths, else 404
`not_found`; a non-GET/POST internal route gives 405 `method_not_allowed`.

Internal auth is open on loopback, so to test the secret you must bind to a real non-loopback
interface and call from it (`HOST=<eth0 ip>`; 127.0.0.2 is still loopback). Expect 401
`invalid_internal_api_secret`, 200 with `x-<channel>-internal-secret` or `authorization: Bearer`,
and 503 `internal_api_secret_not_configured` when unset.

Webhooks: unsigned loopback accepted; 413 `body_too_large`, 400 `invalid_json`, 429
`webhook_rate_limited` with `retry-after: 60`, 503 `webhook_disabled`. The limiter runs after
signature verification here, so rejected requests do not consume quota.

- email: `x-email-webhook-signature` (bare hex, optional `v1=`) + `x-email-webhook-timestamp` over
  `"<ts>.<body>"`. Rejections `invalid_webhook_signature`, `stale_webhook_signature`,
  `replayed_webhook` (409, replay window wired).
- phone: `x-webhook-signature` = `sha256=<hex>` over the same string + `x-webhook-timestamp`.
  Always `invalid_agentphone_signature` (including stale), and phone wires **no** replay window, so a
  correctly signed request can be replayed and accepted. Do not call that a regression without
  checking the previous commit.

CLI one-shots `--status`, `--poll-once`, `--process-once`, `--once` must each print JSON and exit 0.
`--status` reads the status file and falls back to a live snapshot; test both by planting a sentinel
JSON at `<PREFIX>_CHANNEL_STATUS_PATH`.

## Slack HTTP surface (channels/slack/src/slack-http.ts)

Only three routes, matched on exact method AND exact pathname; there is no 405 branch, so **every**
other method/path pair (including `HEAD /healthz`) returns 404 `not_found`.

- `GET /healthz` -> 200 JSON health body, newline terminated.
- `GET /` -> unlisted: 404 `not_found` unless `x-fluffles-internal-token` or `authorization: Bearer`
  equals `SLACK_SIGNING_SECRET`; then 200 with the much larger `publicStatus` (look for
  `taskLedgerPath`/`contextLimits` to prove you got the status body and not the health body). With no
  signing secret configured, **no** value authorizes it.
- `POST /slack/events` -> 429 `rate_limited` + `retry-after: 60`; 413 `payload_too_large` /
  400 `body_read_failed`; 401 `invalid_signature` or 503 `missing_signing_secret`; 400 `invalid_json`;
  `url_verification` -> 200 `text/plain` with the raw challenge; anything not `event_callback` ->
  200 `{"ok":true,"ignored":true}`; a handler throw -> 500 `event_processing_failed`.

Slack v0 signing:

```
sig="v0=$(printf 'v0:%s:%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$secret" | awk '{print $NF}')"
curl -X POST -H "x-slack-signature: $sig" -H "x-slack-request-timestamp: $ts" -d "$body" .../slack/events
```

Replay window is 300 s, so a timestamp older than that is rejected even with a correct signature.

## Edges worth testing on the shared HTTP kit

- Path handling comes from `new URL(req.url, "http://127.0.0.1").pathname`, so: query strings are
  stripped, `/healthz/` (trailing slash) does NOT match, `//healthz` collapses to `/`, `/../healthz`
  becomes `/healthz`, and `/slack/events/../slack/events` becomes `/slack/slack/events` (unrouted,
  404). Traversal cannot escape onto another route, but assert this rather than assuming it.
- Bounded reader rejects on `size > maxBytes`, so a body of **exactly** the limit must be accepted and
  limit+1 must 413. Also send an oversized body chunked (`transfer-encoding: chunked`, no
  content-length) and confirm a clean 413 plus a still-healthy server, not a hang or reset.
- Duplicate signature headers: Node joins repeated headers with `, `, so two copies of a valid
  `x-slack-signature` must fail the compare (401). A 200 here would be a signature-smuggling bug.
- Header names are matched case-insensitively by Node; verify the uppercase spellings still work.
- Signed empty body -> 400 `invalid_json`. Wrong `content-type` is irrelevant and must still be parsed.
- Unicode challenge (`héllo-世界-🐧`) must come back byte-for-byte; this is the cheapest way to catch a
  Buffer/utf8 mistake in the shared reader.
- `FixedWindowRateLimiter` keys on the remote address (`key || "unknown"`). To prove per-caller
  keying, exhaust the window from one address and confirm a second address still gets through. If
  binding `0.0.0.0` is not reachable on the box's external IP, use a second loopback address
  (`curl --interface 127.0.0.2`), which is still a distinct key.
- Fire 20 concurrent signed `url_verification` requests with distinct challenges and assert each
  response carries its own challenge, which catches response cross-talk through shared mutable status.

## Differential harness (best tool for refactors)

For a refactor that must preserve behavior, run one harness against two trees and diff. Either restore
the old file next to the new one:

```
git show HEAD~1:channels/email/src/server.ts > channels/email/src/server.prev.ts
```

or, better for multi-file refactors, make a worktree of the base branch:

```
git worktree add /home/ubuntu/main-src main
```

A fresh worktree has no `node_modules`. The per-package `@fluffles/*` links are repo-relative
symlinks, so `cp -a <pkg>/node_modules <worktree>/<pkg>/node_modules` resolves correctly against the
worktree's own packages. Copy them for every channel you will start (slack, email, phone) plus the six
`packages/*`, then build the packages there too. Expect `packages/task-registry` and
`packages/scheduler` to fail `tsc` in a worktree (their `node_modules/@fluffles` lacks a
`conversations` link); this does not block running servers under `tsx`, so do not rathole on it.

Normalize ports, pids, tree paths, `startedAt`, and the ingest `skipped`/`duplicates` counters (dedupe
state makes those vary) before diffing. An empty diff is strong proof no status code, error string or
header changed. Parameterize harnesses by tree from the start, and delete any `*.prev.ts` afterwards.

## Deploy smoke contract

`test/smoke-slack-health-contract.test.ts` asserts every field the deploy smoke check reads is served
by Slack `/healthz`, by parsing the `healthBody: () => ({...})` literal in `channels/slack/src/server.ts`.
When that literal or the test's parsing changes, prove the test is not vacuous: temporarily delete one
key from the literal, confirm the smoke test FAILS, then restore the file and confirm it passes.

## Harness pitfalls that will waste your time

- Never `pkill -f` a pattern that also appears in your own shell command (e.g. `pkill -f "src/server"`
  or `pkill -f "node --import tsx"`): it matches the shell running it and kills your own session. Put
  the cleanup in a script whose pattern is built by string concatenation and skip `$$`.
- A bare `wait` in a harness that started a server with `&` blocks forever on the server. Wait on the
  specific curl pids.
- Orphaned servers from an aborted run keep a port and silently answer the next run (`EADDRINUSE` in
  the new log while requests still succeed). Confirm zero leftovers and check each instance's startup
  log before trusting a transcript.
- Give each parallel run its own scratch dir for curl `-o`/`-D` files; sharing them corrupts
  transcripts and leaves stale bodies next to a `000` status.

## Suites

```
SOURCE_VERIFY_PORTABLE=1 npm test          # root
npm test --prefix <p>   # packages/tasks, packages/conversations, packages/automations,
                        # channels/slack, channels/email, channels/phone,
                        # channels/webhooks, channels/chat-console
node --test --import tsx test/smoke-slack-health-contract.test.ts   # single smoke test
```

## Devin Secrets Needed

None. Everything above runs with dummy values on a Linux box; no Infisical, Gmail, AgentPhone, Slack
or Tailscale access is required.
