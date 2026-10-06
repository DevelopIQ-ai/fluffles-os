# channels

communication surfaces where the agent can receive messages and reply.

- `slack/`: Slack channel over Socket Mode.
- `email/`: Gmail-backed email channel; polls inbound mail, dedupes transport
  events, writes accepted tasks to the central ledger, and drafts/sends replies
  through Google Workspace.
- `phone/`: AgentPhone-backed channel for `+14155550000`; polls scoped message
  and call history, accepts webhooks, dedupes transport events, writes accepted
  tasks to the central ledger, and sends replies through scoped AgentPhone tools.
- `chat-console/`: browser channel; serves the console UI, admits typed messages
  as `web` conversations in the central ledger, answers them with the shared
  Codex conversation runtime, and streams status back over SSE.

channels contain structure and code. migrated durable auth is injected from Infisical; local provider state remains under `/Users/ai/auth` only where `packages/auth/INFISICAL.md` explicitly tracks a migration boundary. runtime backing files live under `/Users/ai/state`.

## shared channel service

process plumbing is shared, not copied per channel. `@fluffles/tasks` re-exports
`loadChannelEnv`, `numberEnv`, `booleanEnv`, `defineChannelService`,
`startChannelService`, and `verifySignedWebhook` from
`packages/conversations/src/channel-service.ts`. the shared service owns env file
precedence (Infisical injection always wins over any local file), the
`/healthz`, `/`, `/status`, `/poll`, `/run` routes, internal-secret auth for
non-loopback callers, webhook body limits, rate limiting, replay windows,
single-flight poll and process ticks, periodic lease recovery, the `--status`,
`--poll-once`, `--process-once`, `--once` commands, and shutdown.

a channel supplies only what is platform specific: an adapter object
(`pollOnce`, `processQueued`, `runOnce`, `ingestWebhook`, `snapshotStatus`,
`writeStatus`, `recoverInterruptedRuns`, `close`), its webhook paths, and its
`verifyWebhook` implementation. `channels/email/src/server.ts` and
`channels/phone/src/server.ts` are complete examples.

## channels that cannot use the polling service

Slack keeps its own HTTP host because its contract differs from the polling
channels: a rich `/healthz` body the deploy smoke check reads, an unlisted `/`
status route guarded by the signing secret, and Slack's Events API handshake.
it still shares the plumbing rather than copying it. `createChannelRouter` and
`readChannelRequestBuffer` from `packages/conversations/src/channel-http.ts`
provide the method and path table and the bounded body read;
`timingSafeStringEqual` provides the constant-time compare; the strict env
parsers (`parseStringEnv`, `parseNumberEnv`, `parseBooleanEnv`, `parseCsvSet`)
live in `channel-env.ts` next to the clamping ones. `channels/slack/src/slack-http.ts`
is the whole Slack-specific ingress; `slack-http-security.ts` is only Slack's v0
signing scheme.

the chat console has no provider to poll and no webhook to verify: its inbound
is an authenticated browser POST and it also serves the console UI. it composes
the same lower layer instead. `channels/chat-console/src/server.ts` uses
`loadChannelEnv` and `defineChannel` for env precedence, hosted HTTP, startup
and periodic lease recovery, `--status`, and shutdown, and `createChannelRouter`
for its route table, with the unmatched path falling through the auth gate to
per-chat routes and the static export. it answers `/healthz` like the others.

channel adapters own transport-specific behavior such as auth, event dedupe keys, acknowledgement, and replies. accepted work and visible chat history belong in the central task ledger (`SQLiteTaskLedger` in `packages/tasks`), with runtime state at `/Users/ai/state/tasks/tasks.sqlite`.

## transport receipts

every channel writes the same two tables at its edge, defined once in
`packages/conversations/src/transport-store.ts`: `inbound_receipts`, keyed on
`(provider, provider_event_id)`, which is the dedupe record for a provider
event, and `outbound_receipts`, which is what was sent back. only the
channel-shaped metadata differs, so it lives in `details_json` rather than in
per-channel columns, and a delivery can now be traced across channels with one
query shape instead of three.

email and phone get this by extending `SQLiteTransportStore`, which owns the
sqlite file, the pragmas, the dedupe check, the writes, and the counters, and
asks the channel only for its extra tables through `channelSchema` (Gmail
history cursors, AgentPhone poll checkpoints and deferred transcripts). slack
keeps its own async store and composes the same table through
`TRANSPORT_INBOUND_SCHEMA` and `claimInboundReceiptInDb`; its outbound history
lives in the ledger, so it has no outbound receipt table.

deployed databases upgrade themselves on first open. this is a one-way schema
change: a rollback to a build older than this one would find `details_json`
where it expects `subject` or `kind`, so roll forward rather than back.

Post-deployment Step 1 verification is documented in [STEP1_QA.md](STEP1_QA.md).
