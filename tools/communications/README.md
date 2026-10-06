# communications

Current communications awareness for the harness.

`communications` answers what communication surfaces are active right now,
without turning raw transcripts into another memory store. The durable
conversation transcript belongs to the central task ledger table
`communication_events`.

## commands

```sh
$HOME/bin/communications current
$HOME/bin/communications current --json
$HOME/bin/communications sessions
$HOME/bin/communications surfaces
$HOME/bin/communications health
```

## current coverage

- Codex sessions: live open file handles under `$HOME/.codex/sessions`.
- Slack: adapter status and thread sessions under `$HOME/state/channels/slack`.
- Email: adapter status under `$HOME/state/channels/email`.
- Phone: adapter status under `$HOME/state/channels/phone`.

## transcript source

Use `$HOME/state/tasks/tasks.sqlite` for the actual chat timeline:

```text
conversations         durable lanes by channel and conversation key
messages              inbound accepted work
runs                  agent executions over pending inbound work
communication_events  visible inbound, outbound, and system timeline
```

## state

The latest snapshot is written to:

```text
$HOME/state/communications/current.json
```

iMessage is tracked as explicit-use only through the local Messages bridge.
