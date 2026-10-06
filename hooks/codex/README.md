# codex hooks

Codex hook source of truth.

Codex discovers user hooks at `/Users/ai/.codex/hooks.json`. That host-owned
entrypoint points to:

```text
/Users/ai/hooks/codex/hooks.json
```

Current stable hook entrypoints:

```text
/Users/ai/hooks/codex/bin/breadcrumb-hook
/Users/ai/hooks/codex/bin/session-time
/Users/ai/hooks/codex/bin/memory-context
```

Current events:

- `SessionStart`: record a breadcrumb, inject the local session start time,
  and inject the memory context block (`memory/MEMORY.md`, `memory/people.md`,
  today's and yesterday's daily notes) via `/Users/ai/bin/memory context`.
  Older history is never loaded automatically; retrieve it with
  `memory search` and `memory get`.
- `UserPromptSubmit`: record generic lifecycle telemetry.
- `PostToolUse`: record tool name and outcome telemetry.
- `Stop`: record a generic lifecycle completion.

Today's daily note is working memory. Append what happened as it happens with
`/Users/ai/bin/memory note`; the nightly sweep promotes durable facts later.

Smoke test:

```sh
/Users/ai/hooks/codex/bin/smoke-test
```
