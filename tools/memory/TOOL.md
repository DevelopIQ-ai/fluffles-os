# memory

Markdown memory with a derived FTS5 index. Files under `$HOME/memory` are the
memory; `$HOME/state/memory/index.sqlite` is disposable and rebuilt by
`memory index`.

Wrapper: `$HOME/bin/memory`, backed by `packages/memory`.

```sh
memory context                      # the always-loaded block (MEMORY.md, people.md, today + yesterday)
memory note "text"                  # append to today's daily note
memory write MEMORY.md < file.md    # rewrite a durable file (MEMORY.md or people.md)
memory search "query" [--tag k=v] [--kind note|wiki|durable] [--from DATE] [--to DATE] [--limit N]
memory get <path-or-title> [start] [end]
memory index                        # reindex changed files, regenerate wiki/index.md
memory promote                      # nightly sweep: file facts into the wiki, promote to MEMORY.md
memory migrate <dir>                # copy legacy daily summaries into daily notes
memory doctor                       # durability, document count, unresolved links
```

`--tag k=v` matches top-level front matter keys (`--tag kind=person` for
`kind: person`; list entries match too, e.g. `--tag tags=auto`).

Every write passes the secret boundary and a prompt-injection scan; blocked
content is quarantined under `memory/quarantine/` with secrets redacted
first. See `memory/PROTOCOL.md` for the operating rules.
