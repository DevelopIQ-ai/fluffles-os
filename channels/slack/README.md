# slack channel

Slack communication channel for Fluffles.

## paths

- code: `/Users/ai/channels/slack`
- auth: runtime injection from Infisical
- runtime: `/Users/ai/state/channels/slack`

## flow

Slack sends events over Socket Mode to this Node process. The process filters events, maps Slack threads to Codex sessions, runs Codex, and posts replies back to Slack.

The runtime source is TypeScript:

```text
src/server.ts
src/thread-request-store.ts
```

Run the Slack channel with `npm run start`, which uses the scoped Infisical runtime wrapper; edit `src/server.ts` and run `npm run check`.

`#agent-feed` is configured as an ambient channel through `SLACK_AMBIENT_CHANNELS`. Plain top-level human messages there are routed to Fluffles without an @ mention, and the default assumption is that most of them are for Fluffles. Ambient replies still post in threads, and the spawned Codex session can return `FLUFFLES_NO_REPLY` to stay quiet when the message is clearly not for Fluffles.

## thread requests

Slack communication uses one simple product rule:

```text
channel = intake board
thread = one request timeline
thread replies = updates to that same request
```

Before a Slack message starts Codex work, the bridge records accepted work in
the central task ledger:

```text
/Users/ai/state/tasks/tasks.sqlite
```

The typed request store lives in `src/thread-request-store.ts`. It wraps the
central task ledger for accepted messages and runs, while Slack-specific
receipts and Codex session metadata stay in the Slack transport database:

```text
/Users/ai/state/channels/slack/slack-transport.sqlite
```

Together they record each thread request, deduplicate Slack retries, track runs
as `queued`, `running`, `done`, `failed`, or `stopped`, recover
queued/interrupted work on bridge restart, and write outbound Slack replies into
the ledger `communication_events` timeline. While one run is active for a
thread, newer messages in that thread are stored as pending updates and
processed after the current run reaches the next safe point.

The intake invariant is:

```text
durable SQLite write first, Slack ACK second, Codex work third
```

If the bridge restarts with a run marked `running`, that run is marked
`interrupted`, its messages are put back into the pending set, and the request is
queued again. `stop`, `cancel`, and `abort` are explicit stopped states and do
not produce generic error replies.

Slack-to-Codex sessions and request transport state are stored in the transport SQLite database. Each mutating ledger operation uses
a SQLite transaction so request, message, run, and visible communication state
move together.

Run the focused test suite with:

```sh
npm test
```

## service

The TypeScript channel is supervised by launchd:

```text
/Users/ai/Library/LaunchAgents/com.puffle.fluffles.channel.slack.plist
```

Logs:

```text
/Users/ai/state/channels/slack/logs/stdout.log
/Users/ai/state/channels/slack/logs/stderr.log
```

Health:

```sh
curl http://127.0.0.1:3000/healthz
launchctl print gui/$(id -u)/com.puffle.fluffles.channel.slack
```
