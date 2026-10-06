# memory protocol

Memory is plain markdown plus a derived full-text index. The files are the
memory; the index is disposable. No embeddings, no vector store, no GUI, no
extra service.

## always loaded

Every session starts with a small, fixed context:

- `$HOME/AGENTS.md`: identity, durable rules, safety boundaries.
- `$HOME/memory/MEMORY.md`: durable facts and standing decisions.
- `$HOME/memory/people.md`: people, contact conventions, preferences.
- `$HOME/memory/YYYY-MM-DD.md` for today and yesterday.

The block is bounded. If a file outgrows its budget only the injected copy is
truncated; the file on disk is never touched. Print it with:

```sh
$HOME/bin/memory context
```

## daily notes

One `memory/YYYY-MM-DD.md` per local day. Today's note is working memory:
append what happened as it happens. Optional front matter carries date,
people, channel, thread key, task id, and tags. Notes are append-only through
the tool:

```sh
$HOME/bin/memory note "met with [[kush]] about the deploy"
```

## wiki

`memory/wiki/` holds one markdown page per durable topic. Pages use front
matter for `title`, `aliases`, and `tags`, and link each other with
`[[double brackets]]`. Backlinks are derived by the index. `memory/wiki/index.md`
is generated; do not edit it by hand.

## search and retrieval

The index lives at `$HOME/state/memory/index.sqlite` (FTS5, porter tokenizer).
It is derived and disposable: delete it and `memory index` rebuilds identical
results. It covers daily notes, wiki pages, and the durable files (`MEMORY.md`,
`people.md`), so anything beyond the injected context stays findable. The
index and its WAL sidecars stay mode 600 and never leave the machine.

```sh
$HOME/bin/memory search "<query>" [--tag people=kush] [--kind note|wiki|durable] [--from DATE] [--to DATE]
$HOME/bin/memory get <path-or-title> [line_start] [line_end]
$HOME/bin/memory index
$HOME/bin/memory doctor
```

Every search hit resolves to an exact file and line range.

## nightly sweep

`memory promote` runs nightly (the `nightly-memory-sweep` automation). For each
unswept past date it extracts candidate durable facts (lines that link a
`[[page]]`, and lines marked `promote:`), drops duplicates, supersedes
contradictions in place, files survivors into wiki pages, promotes
always-needed facts into `MEMORY.md`, and appends every action to
`PROMOTIONS.md`. It is idempotent per date and fails closed.

## promotion rules

- Promote to `AGENTS.md` only if the fact is stable, broad, and durable.
- Promote to `MEMORY.md` only if it is needed in most sessions.
- File topic facts into the wiki; keep events in the daily note.
- Everything else stays in daily notes and remains reachable through search.

## secret rule

Never store raw secrets, passwords, OAuth tokens, API keys, private cookies, or
account recovery material in any memory file. Every write through the memory
tool passes the shared secret boundary and a prompt-injection scan; blocked
content is diverted to `memory/quarantine/` and never reaches memory files or
the index. Secret-bearing content is redacted before it is quarantined, so no
raw credential is retained anywhere in the memory tree.

`--tag k=v` filters on top-level front matter keys: `--tag kind=person`
matches a page whose front matter says `kind: person`, and `--tag tags=auto`
matches an entry in a `tags: [...]` list.
