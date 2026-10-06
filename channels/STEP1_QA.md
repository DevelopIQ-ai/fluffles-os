# Step 1 Post-Deployment QA

Run this after `main` has deployed and `/Users/ai/state/deploy-main/last-run.json`
reports a successful smoke test. Use a disposable test conversation and do not
put secrets or customer content in the commands below.

## Common checks

```sh
cat /Users/ai/state/deploy-main/last-run.json
/Users/ai/bin/smoke
sqlite3 -header -column /Users/ai/state/tasks/tasks.sqlite \
  "select channel, conversation_key, status, active_run_id, compaction_seq, updated_at from conversations order by updated_at desc limit 20;"
```

The deployment receipt and smoke test must be successful. The ledger query must
show each test conversation with the expected channel and a durable status.

## Slack

1. Watch the service while testing:

   ```sh
   tail -F /Users/ai/state/channels/slack/logs/stdout.log /Users/ai/state/channels/slack/logs/stderr.log
   ```

2. Send a direct or actionable ambient top-level message. Reply in that Slack
   thread while the response is running with a clear correction, then send
   `stop` in the same thread during a separate slow request.
3. Inspect the durable record:

   ```sh
   sqlite3 -header -column /Users/ai/state/tasks/tasks.sqlite \
     "select seq, role, run_id, external_message_id, text from messages where channel = 'slack' and conversation_key = 'slack:<team_id>:<channel_id>:<root_ts>' order by seq;"
   sqlite3 -header -column /Users/ai/state/tasks/tasks.sqlite \
     "select id, status, last_consumed_seq, started_at, finished_at, error from runs where channel = 'slack' and conversation_key = 'slack:<team_id>:<channel_id>:<root_ts>' order by started_at;"
   ```

Expected: one conversation key, one active run while work is running, the
thread reply claimed by that run, and the final Slack reply reflects the
correction. A stopped run has no assistant message after the stop and retains
any unclaimed steering message in SQLite.

For a pre-Step-1 `thread:<channel_id>:<root_ts>` test lane, send a message in
the corresponding Slack thread and verify its history, runs, checkpoints, and
communication events move to `slack:<team_id>:<channel_id>:<root_ts>`. Later
messages must use the canonical key. A historical `dm:<channel_id>` lane cannot
be mapped to one Slack root thread safely; it must remain preserved and the
Slack service status must report the migration failure rather than silently
reusing that legacy key.

## Email

1. Confirm the service and use the configured safe outbound mode:

   ```sh
   cat /Users/ai/state/channels/email/status.json
   grep -E '^(EMAIL_OUTBOUND_MODE|EMAIL_POLLING_ENABLED)=' /Users/ai/channels/email/channel.env 2>/dev/null || true
   ```

2. Send two messages in one provider email thread. Wait for polling or invoke
   the configured webhook path, then inspect the ledger:

   ```sh
   sqlite3 -header -column /Users/ai/state/tasks/tasks.sqlite \
     "select seq, role, run_id, external_message_id, text from messages where channel = 'email' and conversation_key = 'email:<account_id>:<thread_id>' order by seq;"
   ```

Expected: both inbound messages share `email:<account_id>:<thread_id>`. Gmail
draft creation or delivery is confirmed before its assistant reply becomes
model-visible conversation history. Failed sends retain durable failed-delivery
records for debugging but never enter future model context. A restart leaves
incomplete work runnable from the central ledger.

## Phone

1. Confirm the service:

   ```sh
   cat /Users/ai/state/channels/phone/status.json
   ```

2. Send two test messages from the same caller number with different AgentPhone
   `conversationId` values. Inspect each key:

   ```sh
   sqlite3 -header -column /Users/ai/state/tasks/tasks.sqlite \
     "select conversation_key, status, updated_at from conversations where channel = 'phone' order by updated_at desc limit 20;"
   ```

Expected: each provider `conversationId` uses a distinct
`phone:<providerConversationId>` key, even when both messages have the same
caller number. Caller numbers are reply-routing metadata only.

3. Send a valid inbound message with a provider `conversationId` and confirm it
   creates or appends to its canonical `phone:<providerConversationId>` ledger
   conversation. Then send an otherwise valid inbound test event without a
   provider `conversationId`.

Expected: the valid event ingests successfully. The missing-id event is rejected
before `ConversationEngine.ingest()`, records an inbound transport receipt with
`action: "error"`, and creates no ledger conversation, message, run, or
model-visible history. Existing ambiguous historical phone-number keyed
conversations remain preserved, but are never reused for new inbound traffic.
Replies remain routed to the latest inbound provider message target within the
canonical provider conversation.

4. In a safe test environment, force one AgentPhone outbound send to fail and
   inspect the phone transport receipts and canonical ledger conversation.

Expected: the failed send has an outbound `failed` receipt for debugging, while
the conversation's next model context contains no assistant message for the
undelivered reply.

## Recovery and compaction

For any channel, interrupt a deliberately slow request by restarting only its
service, then inspect `runs`. The interrupted run must remain durable and its
conversation must be queued for a replacement run. For a non-production test
environment, set the channel context threshold low, send enough messages to
cross it, and verify `compaction_seq`, `compaction_summary`, and all raw
`messages` remain present in the ledger.
