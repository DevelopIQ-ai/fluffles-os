# email channel

Email communication channel for Fluffles.

## paths

- code: `/Users/ai/channels/email`
- Google Workspace auth: temporary native materialization from Infisical path `/services/google-workspace`
- runtime: `/Users/ai/state/channels/email`
- central task ledger: `/Users/ai/state/tasks/tasks.sqlite`

## flow

The email channel is a supervised Node process. It polls Gmail through
`/Users/ai/bin/gws`, filters inbound messages, writes accepted human requests to
the central task ledger, processes queued email runs, and replies through Gmail.

```text
Gmail polling
-> /Users/ai/channels/email
-> filter and dedupe in email transport DB
-> central task ledger channel=email
-> Codex reply decision
-> gws gmail +reply (--draft by default)
-> central ledger communication_events outbound/system record
-> mark central run done/failed
```

The channel-specific transport database is:

```text
/Users/ai/state/channels/email/email-transport.sqlite
```

That database is not the task queue. It stores seen/skipped inbound Gmail
messages and outbound draft/send receipts. Accepted task state and visible chat
history belong to:

```text
/Users/ai/state/tasks/tasks.sqlite
```

## commands

```sh
npm test
npm run check
/Users/ai/bin/email-channel --once
/Users/ai/bin/email-channel --poll-once
/Users/ai/bin/email-channel --process-once
/Users/ai/bin/email-channel --status
```

## outbound mode

`EMAIL_OUTBOUND_MODE` controls whether the channel sends or drafts replies:

```text
draft     save Gmail drafts only; default
send      send replies through Gmail
disabled  process runs without creating Gmail output
```

The live Mac mini service is currently set to `send` in `channel.env` after a
successful live Gmail smoke test from `kush@puffle.ai` to `fluffles@puffle.ai`.
Use `draft` for local/sandbox testing when a real outbound email should not be
sent.

## context limits

The live editable context-pack limits are in:

```text
/Users/ai/config/context-limits.json
```

For email, `recentMessagesLimit` bounds how many recent thread messages are
eligible for a reply prompt and `maxContextChars` bounds the prompt payload for
those messages. Environment overrides are:

```text
EMAIL_CONTEXT_LIMIT
EMAIL_CONTEXT_MAX_CHARS
EMAIL_RECENT_USER_MESSAGE_TOKEN_LIMIT
EMAIL_SUMMARY_MAX_CHARS
EMAIL_OPEN_LOOPS_MAX_CHARS
FLUFFLES_CONTEXT_LIMITS_PATH
```

`EMAIL_RECENT_USER_MESSAGE_TOKEN_LIMIT` retains recent raw user messages beside
a checkpoint summary. Runtime uses a configured model tokenizer when supplied,
or a conservative UTF-8 byte upper bound when one is unavailable.
`maxContextTokens` must therefore be configured in the active counter's units.

## reply schema

Codex reply decisions use the JSON schema at:

```text
/Users/ai/channels/email/reply-schema.json
```

## webhook ingress

The preferred ingress is event-driven. The email channel exposes:

```text
POST http://127.0.0.1:3001/webhook/email
```

The `email-inbound` automation under `/Users/ai/automations/email-inbound` forwards inbound email events to that endpoint. Payloads should include a Gmail `providerMessageId` or `id` when a threaded Gmail reply is expected. Periodic Gmail polling is disabled in live config and remains a fallback only.

Gmail-native push uses Pub/Sub. Gmail sends only `{ emailAddress, historyId }`
notifications, not message bodies, so the webhook path treats a Pub/Sub push as
a trigger to fetch the latest matching Gmail messages once through GWS. This is
event-driven and does not require the periodic poller; duplicate protection
still comes from the email transport store.

## service

The channel is supervised by launchd:

```text
/Users/ai/Library/LaunchAgents/com.puffle.fluffles.channel.email.plist
```

Logs:

```text
/Users/ai/state/channels/email/logs/stdout.log
/Users/ai/state/channels/email/logs/stderr.log
```

Health:

```sh
curl http://127.0.0.1:3001/healthz
launchctl print gui/$(id -u)/com.puffle.fluffles.channel.email
```
