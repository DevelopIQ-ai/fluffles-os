# tasks

central task ledger for work accepted from human communication channels.

`@fluffles/tasks` is a TypeScript package that stores channel-agnostic task state in SQLite. It is the operational queue for accepted human work across Slack, email, phone, and future adapters.

## runtime

live state is stored at:

```sh
$HOME/state/tasks/tasks.sqlite
```

source code lives at:

```sh
$HOME/packages/tasks
```

## storage durability

`$HOME/state/tasks/tasks.sqlite` is the authoritative system of record for
conversation lifecycle, task state, delivery intent, and durable provider
acceptance. Every `SQLiteTaskLedger` connection configures and verifies
`journal_mode=WAL` and `synchronous=FULL` during startup. Startup fails rather
than accepting work if that contract cannot be established.

SQLite cannot use WAL for `:memory:` databases. That compatibility mode remains
available only for tests and local ephemeral fixtures; it is never an
authoritative production ledger.

The Slack, Email, and Phone transport databases are non-authoritative receipt
and provider-metadata stores. They may use `synchronous=NORMAL`; they must
never be used to infer that work completed or that a provider accepted a reply.
Those decisions always come from `tasks.sqlite`.

## model

- one `conversation` is one durable work lane, keyed by channel and conversation key.
- one `message` is an inbound channel event accepted into that lane.
- one `run` is an agent execution over pending messages in that lane.
- one `task` is the latest durable state for a meaningful unit of work linked to
  its conversation. Tasks retain an objective, progress, next action, terminal
  result, and timestamps. They do not copy conversation messages or execute work.
- one `communication_event` is the visible chat timeline for that lane. Inbound events are backfilled from accepted messages; outbound replies, skipped replies, and channel errors are written by the channel adapters.
- the central ledger owns accepted messages, visible communication history, pending work, runs, restart recovery, and status: queued, running, done, failed, or stopped.
- channel adapters own only transport-specific receipts and behavior: auth, event dedupe keys, acknowledgement, reply identity, and channel metadata.

## conversation lifecycle contract

The ledger is the authoritative lifecycle record. Admission, duplicate detection,
run ownership, steering claims, checkpoints, stop, completion, failure,
interrupted-run recovery, delivery intent, and delivery confirmation are each
committed with the related durable state change. `lifecycle_events` is the
append-only engine audit trail for those transitions; adapters are not the
source of truth for lifecycle state.

Each running row records the worker identity and process identity that claimed
it. Startup recovery only interrupts runs whose recorded owner is no longer
alive. Process creation identity is resolved portably where available; when a
platform cannot provide it, a live PID is conservatively treated as a recovery
fence rather than replaying work it may still own. Lease/heartbeat recovery for
an alive-but-hung worker remains a future runtime capability.

Stop has one channel-independent policy: it is a full cancellation boundary.
The active run is stopped, unfinished conversation tasks are cancelled, all
unclaimed pending user messages are marked non-actionable, and provider intents
that have not yet crossed the durable dispatch boundary are terminally
cancelled. Conversation history is retained. A later inbound message reopens
the lane and starts fresh work; cancelled work and cancelled delivery intents
are never replayed. A dispatch already admitted before stop may complete only
to record the provider effect consistently; it never reopens the conversation.

Before each model turn, `buildBoundedContext` builds one deterministic slice:
checkpoint summary, retained pre-checkpoint user messages, retained prior
messages, and the active run's current request. The budget also reserves the
runtime-owned task, resume, and deployment inputs supplied to model execution.
The current request is never truncated. If it alone cannot fit the remaining
hard token budget, execution fails before the provider call rather than silently
dropping user input. Provider-specific prompt and memory composition remain
outside this Phase 1 boundary.

## persistent task registry

The `tasks` SQLite table is a passive registry used by `ConversationRuntime`.
The runtime creates a task before execution, records checkpoint progress and
`next_action`, and records completed, failed, or cancelled terminal state.
`SQLiteTaskLedger` commits each transition transactionally. On startup the
runtime loads unfinished tasks and supplies a persisted `next_action` as resume
context when the conversation runs again. The registry does not schedule,
execute, retry, or poll work.

## scheduled reminders

One-time scheduled reminders are stored in the same SQLite task ledger by
`@fluffles/scheduler`. When a reminder comes due, each channel service admits the
reminder instruction as an inbound message into its own conversation through
`taskLedger.admitDueReminders`, so the reminder runs through the normal inbound
path with no separate dispatcher or execution lifecycle. Reminder rows persist
the nullable `company_id`, instruction, UTC scheduled time, display timezone,
channel, conversation key, and lifecycle state.

The repository does not currently define a company or tenancy model. Reminders
therefore accept and persist a nullable `company_id` without deriving or
interpreting it.

## conversation keys

Communication channels map transport-specific thread identity into one common
ledger shape:

```text
slack thread/ambient/mention  slack:<team_id>:<channel_id>:<root_ts>
email provider thread         email:<account_id>:<thread_id>
phone provider identity       phone:<providerConversationId>
```

## legacy key handling

- Slack `thread:<channel_id>:<root_ts>` rows migrate to their canonical Slack
  key when that thread is next received. Historical `dm:<channel_id>` rows are
  retained for recovery, but no new inbound message resolves to that unsplittable
  pre-Step-1 lane.
- Email `<provider>-thread:<id>` and `<provider>-message:<id>` rows migrate to
  `email:<account_id>:<thread_id>` when the matching email is next received.
- Historical phone-number keyed conversations are retained for recovery, but are
  never reused for new inbound traffic. New phone ingress requires AgentPhone's
  provider conversation id and resolves `phone:<providerConversationId>`.

## visible timeline

The `communication_events` table is the read model for chat visibility:

```text
direction: inbound | outbound | system
kind:      message | reply | ack | skip | error | status
```

`messages` remains the work queue for inbound human requests. The console and
future communication UI should read `communication_events` so the user can see
what Fluffles received, what it sent, and why it skipped or failed.

## slack integration

Slack uses a transport database at:

```sh
$HOME/state/channels/slack/slack-transport.sqlite
```

That database is not the task queue. It stores Slack receipts and Codex session metadata only. Accepted Slack work is written directly into `$HOME/state/tasks/tasks.sqlite`, and Slack execution reads runnable work back from that central ledger.

Slack outbound `chat.postMessage` replies are recorded into
`communication_events` with the Slack message `ts` as the provider event id when
the reply belongs to a ledger conversation.

The old Slack request database, `$HOME/state/channels/slack/thread-requests.sqlite`, is not part of the active system.

## email integration

Email is a channel under `$HOME/channels/email`. The channel polls Gmail through
`$HOME/bin/gws`, filters no-reply, marketing, mailing list, spam, promotions,
and unclear FYI mail, writes accepted work to this central ledger with channel
`email`, processes queued runs, and creates Gmail replies.

Email also has a transport database at:

```sh
$HOME/state/channels/email/email-transport.sqlite
```

That database is not the task queue. It stores seen/skipped inbound Gmail
messages and outbound draft/send receipts. The webhook path
through `$HOME/channels/webhooks` remains optional event ingress into the same ledger, but
the first-class email body is `$HOME/channels/email`.

Email draft/send bodies, no-reply decisions, disabled-send skips, and Gmail
send failures are recorded into `communication_events`.

Gmail poll/send remains gated on Google Workspace reauth. The channel is wired
and supervised, but live Gmail API access still requires
`$HOME/bin/gws auth login` to clear the current `invalid_rapt` state.

## phone integration

Phone is a channel under `$HOME/channels/phone`. The channel uses the scoped
AgentPhone tools for `+14155550000`, dedupes inbound messages and call records,
writes accepted work to this central ledger with channel `phone`, and sends
replies from the same number.

Phone also has a transport database at:

```sh
$HOME/state/channels/phone/phone-transport.sqlite
```

That database is not the task queue. It stores seen/skipped inbound phone events
and outbound send receipts.

Phone send bodies, no-reply decisions, disabled-send skips, and AgentPhone send
failures are recorded into `communication_events`.

## checks

```sh
cd $HOME/packages/tasks
npm test

cd $HOME/channels/email
npm test

cd $HOME/channels/phone
npm test

cd $HOME/channels/slack
npm test

cd $HOME/channels/webhooks
npm test
```
