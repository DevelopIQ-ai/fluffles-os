# breadcrumbs

Bounded operational telemetry ledger for Fluffles. It is not a memory layer,
transcript store, or default session context. Records expire after 45 days.

Source of truth:

```text
/Users/ai/state/tasks/tasks.sqlite table breadcrumbs
```

Primary commands:

```sh
breadcrumb emit --scope fluffles --component service --kind service.observed --summary "..."
breadcrumb hook UserPromptSubmit < hook-payload.json
breadcrumb run --scope fluffles --component cron --kind cron.job --subject nightly-memory-sweep -- /Users/ai/bin/automations run nightly-memory-sweep
breadcrumb tail --scope fluffles --from 2026-07-28T07:00:00.000Z --until 2026-07-29T07:00:00.000Z --limit 40
breadcrumb health
```

Contract:

- Hooks must be best-effort. A breadcrumb failure must not block a model turn or service.
- Store only short lifecycle summaries and bounded metadata. Never store prompt
  text, assistant text, command arguments, command output,
  authorization headers, raw secrets, or transcript payloads.
- `breadcrumb hook` records generic start, tool, and stop lifecycle events.
  `breadcrumb run` records only the executable name, argument count, exit
  result, and signal. Exact evidence and daily-summary source material belong
  in sanitized Stash transcripts.
- Use the same schema for all harness traces.
