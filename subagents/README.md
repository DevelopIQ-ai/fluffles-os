# subagents

Subagents are folder-shaped specialist agents with an enforced MVP structure.

A subagent lives at `$HOME/subagents/<name>`. The folder name is the call name.

Create and validate them with:

- `create-subagent <name> [--mission "..."] [--domain "..."]`
- `create-subagent validate [<name>]`
- `create-subagent list`

The scaffolder rejects unsafe mission or domain text before creating anything.
All generated files pass the shared memory-safety boundary and shared atomic
writer.

Required structure:

```text
$HOME/subagents/<name>/
  AGENTS.md
  bin/
    <name>
  memory/
    working.md
    summaries/
      daily/
  cron/
  webhooks/
  state/
```

Every subagent also has central runtime receipts under `$HOME/state/subagents/<name>`.
Those receipts are operational metadata only. No receipt is injected as memory.

The source mirror lives at `$HOME/projects/source-code/subagents/<name>` and must keep the same skeleton. Empty mirror directories use tracked placeholders when needed.

Names must be lowercase kebab-case, start with a letter, and contain only `a-z`, `0-9`, and hyphens.

Each `bin/<name>` entrypoint must minimally support `status`, `run <task>`, and
`remember <text>`. `run <task>` delegates through
`$HOME/subagents/bin/run-subagent`, which injects only the subagent's
`AGENTS.md` and `memory/working.md` before calling `codex exec`. Completed runs
do not enter working memory. The runner validates its active-state sections and
removes the legacy managed last-run block when encountered. It records concise
work, explicit decisions, outcomes, failures, and recoveries in one bounded
daily summary using the root memory renderer. When evidence exceeds the bound,
the newest failure, decision, and ordinary continuity remain represented and
the daily file carries the cumulative omitted-evidence count. Working-memory
updates, including `remember`, and daily summaries use the shared
owner-verified lock and atomic writer. Operational receipts contain only
status, timestamps, paths, and counts; `remember` receipts contain the working
file path, never the note.
Each run owns a private temporary response directory, removes it in `finally`,
and reclaims directories whose PID and process-start identity no longer match a
live owner.
