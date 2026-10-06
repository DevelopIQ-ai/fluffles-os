# phone channel

AgentPhone-backed phone channel for Fluffles.

## Step 4 Executor Locker

`executor:agentphone` is the capability-registry representation of this channel's
scoped Executor surface. `/Users/ai/channels/phone/health` performs a bounded,
read-only AgentPhone probe. `/Users/ai/channels/phone/capability` is the typed
bridge used by Step 4 and accepts only the documented AgentPhone operations.

## paths

- code: `/Users/ai/channels/phone`
- runtime: `/Users/ai/state/channels/phone`
- central task ledger: `/Users/ai/state/tasks/tasks.sqlite`
- scoped number: `+14155550000`

## flow

The phone channel is a supervised Node process. AgentPhone delivers inbound
messages and call events through the Amalgm webhook trigger into the local
channel endpoint. The channel dedupes inbound events in a phone transport
database, writes accepted human work to the central task ledger with channel
`phone`, processes queued runs, and sends replies from `+14155550000`.

```text
AgentPhone webhook
-> Amalgm webhooks.agentphone-inbound
-> /Users/ai/channels/phone
-> phone transport DB dedupe
-> central task ledger channel=phone
-> Codex reply decision
-> scoped AgentPhone send from +14155550000
-> central ledger communication_events outbound/system record
-> mark central run done/failed
```

The channel-specific transport database is:

```text
/Users/ai/state/channels/phone/phone-transport.sqlite
```

That database is not the task queue. It stores seen/skipped inbound phone events
and outbound send receipts. Accepted task state and visible chat history belong
to:

```text
/Users/ai/state/tasks/tasks.sqlite
```

## conversation identity

Each AgentPhone provider conversation is one durable phone conversation. Its
canonical ledger key is always:

```text
phone:<providerConversationId>
```

The caller phone number is reply-routing metadata only. It must never be used
as a conversation key, and `phone:main`, message ids, and call ids are not
identity fallbacks.

An inbound message or call without a non-empty AgentPhone provider
`conversationId` is rejected before `ConversationEngine.ingest()`. The channel
records an inbound transport receipt with `action: "error"`; it does not create
a ledger conversation, message, run, or model-visible history.

Historical caller-number keyed lanes are preserved for audit and recovery, but
ambiguous lanes are never reused for new inbound traffic. They are not migrated
unless ownership can be proven from persisted provider conversation-id metadata.

## commands

```sh
npm test
npm run check
/Users/ai/bin/phone-channel --once
/Users/ai/bin/phone-channel --poll-once
/Users/ai/bin/phone-channel --process-once
/Users/ai/bin/phone-channel --status
```

## outbound mode

`PHONE_OUTBOUND_MODE` controls whether the channel sends replies:

```text
send      send replies through AgentPhone; default
disabled  process runs without creating phone output
```

Use `disabled` for sandbox tests where a real SMS/iMessage should not be sent.

## context limits

The live editable context-pack limits are in:

```text
/Users/ai/config/context-limits.json
```

For phone, `recentMessagesLimit` bounds how many recent SMS ledger messages are
eligible for a reply prompt and `maxContextChars` bounds the prompt payload for
those messages. Environment overrides are:

```text
PHONE_CONTEXT_LIMIT
PHONE_CONTEXT_MAX_CHARS
PHONE_RECENT_USER_MESSAGE_TOKEN_LIMIT
PHONE_SUMMARY_MAX_CHARS
PHONE_OPEN_LOOPS_MAX_CHARS
FLUFFLES_CONTEXT_LIMITS_PATH
```

`PHONE_RECENT_USER_MESSAGE_TOKEN_LIMIT` retains recent raw user messages beside
a checkpoint summary. Runtime uses a configured model tokenizer when supplied,
or a conservative UTF-8 byte upper bound when one is unavailable.
`maxContextTokens` must therefore be configured in the active counter's units.

## scoped executor access

The channel does not store a raw AgentPhone API key. It reads the
`PHONE_EXECUTOR_MCP_AUTHORIZATION` credential injected by Infisical. The
non-secret `PHONE_EXECUTOR_MCP_URL` is supplied by launchd. No `.codex`
credential fallback is accepted. The channel calls only the scoped
`fluffles_agentphone_1555500000` tools, which are limited to `+14155550000`.

## webhook ingress

The channel exposes:

```text
POST http://127.0.0.1:3002/webhook/phone
```

Remote AgentPhone webhooks must carry the AgentPhone HMAC headers. Loopback
requests are accepted for local forwarding and tests. The launchd service sets
`PHONE_POLLING_ENABLED=0` and `PHONE_POLL_CALLS_ENABLED=0`; inbound delivery is
webhook-backed.

## service

The channel is supervised by launchd:

```text
/Users/ai/Library/LaunchAgents/com.puffle.fluffles.channel.phone.plist
```

Logs:

```text
/Users/ai/state/channels/phone/logs/stdout.log
/Users/ai/state/channels/phone/logs/stderr.log
```

Health:

```sh
curl http://127.0.0.1:3002/healthz
launchctl print gui/$(id -u)/com.puffle.fluffles.channel.phone
```
