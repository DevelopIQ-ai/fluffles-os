# memory

`$HOME/memory` is the file-backed memory area for the harness. Plain markdown
plus a derived FTS5 index; the files are the memory, the index is disposable.

| layer | purpose | canonical place |
| --- | --- | --- |
| long-term rules | identity, standing rules, durable constraints | `$HOME/AGENTS.md` |
| durable facts | standing decisions needed in most sessions | `$HOME/memory/MEMORY.md` |
| people | people, contact conventions, preferences | `$HOME/memory/people.md` |
| daily notes | working memory, one file per day | `$HOME/memory/YYYY-MM-DD.md` |
| wiki | one page per durable topic, aliases + backlinks | `$HOME/memory/wiki/` |
| sweep ledger | every promotion the nightly sweep made | `$HOME/memory/PROMOTIONS.md` |
| index | derived, disposable FTS5 search index | `$HOME/state/memory/index.sqlite` |

The tool surface is `$HOME/bin/memory` (`context`, `note`, `write`, `search`,
`get`, `index`, `promote`, `doctor`), backed by `packages/memory`. See
`PROTOCOL.md` for the operating rules.

Never store raw secrets or account recovery material in any memory file.
Writes pass the shared secret boundary and a prompt-injection scan; blocked
content is quarantined under `memory/quarantine/` with secrets redacted
first. Use Infisical for durable secrets.

Everything under `memory/` except `PROTOCOL.md` and `README.md` is runtime
owned: the deployer never overwrites or deletes it, and a fresh install
starts empty (the memory tool seeds `MEMORY.md` and `people.md` stubs).
