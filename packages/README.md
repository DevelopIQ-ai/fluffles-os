# packages

Every major fluffles capability is a self-contained package another agent can
adopt on its own. Each package owns its types, its tables (via an injectable
schema), its public entrypoint, and its tests. CI enforces the dependency
direction below with import-boundary tests (`packages/tasks/test/module-boundaries.test.ts`).

## The map

```
channels -> conversations -> storage -> node
scheduler -> conversations + storage
task-registry -> conversations + storage
repair-ledger -> storage
memory -> storage
automations -> storage
mcp -> (none)
capabilities -> (none)
agent glue (packages/tasks) -> any package
```

Forbidden, and test-enforced:

- packages never import fluffles app code (`packages/tasks/`, `channels/`, ...)
- no sibling package imports beyond the declared ones above
- `storage` imports nothing but node builtins

## The packages

- `storage` (`@fluffles/storage`): the durable SQLite foundation. WAL +
  synchronous=FULL contract, one serialized write chain, transaction retries,
  a migration runner, and generic row/field parsing. The embedder injects its
  schema and migrations.
- `conversations` (`@fluffles/conversations`): the conversation bridge.
  Chats/messages/runs, inbound admission and dedup, one-run-per-chat leases
  and crash recovery, steering, stop, compaction, the idempotent outbound
  delivery state machine, and the `Executor` boundary a model implementation
  plugs into. Embedder concerns (deployment gating, stop side effects,
  conversation-key migration) arrive as injected `BridgeStoreHooks`; the
  package also exports the shared channel-service scaffolding (env precedence,
  route table, webhook verification, single-flight ticks, and lease recovery).
- `scheduler` (`@fluffles/scheduler`): durable one-time reminders. A reminder
  is only a scheduled message; when it comes due the instruction is admitted
  into its conversation and the ordinary inbound path runs it.
- `task-registry` (`@fluffles/task-registry`): the passive persistent task
  registry. One durable record per unit of conversation work
  (objective/status/progress/next_action/result), resumable from
  `next_action` after a restart, cancelled inside the same transaction that
  stops a conversation.
- `repair-ledger` (`@fluffles/repair-ledger`): the repair ledger. Durable
  watch/diagnose/repair task lifecycle keyed by the tool that needs
  attention.
- `memory` (`@fluffles/memory`): the markdown memory engine. Always-loaded
  context, daily notes, backlinked wiki, and a derived FTS5 index; files are
  the source of truth and the index is disposable.
- `auth` (`@fluffles/auth`): Infisical-backed auth. The per-path secret
  allowlist (`bin/infisical-exec`), runtime injection (`bin/infisical-run`),
  the one file-credential materializer (`bin/materialize` +
  `bin/materialize.d/<tool>` specs), and the one vault writer
  (`bin/auth-push`). Executables, not a library: consumers exec into
  `packages/auth/bin/*`; the thin provider commands in the harness `bin/`
  stay as one-line wrappers.
- `capabilities` (`@fluffles/capabilities`): the tools and capabilities
  registry. Derives the callable-tool inventory from the MCP manifests in
  `tools/mcp/manifests`, runs each manifest's canonical health probe, keeps
  durable SQLite tool health with definition fingerprints, and hands repair
  tasks into the task ledger. The CLI (`bin/capabilities` wrapper) execs into
  `packages/capabilities/bin/*`; the harness charter stays at
  `tools/capabilities/harness.json`.
- `automations` (`@fluffles/automations`): the schedule/event/http/manual
  automation engine. Daemon on `127.0.0.1:8788` with a durable clock and
  run ledger.
- `mcp` (`@fluffles/mcp`): a generic stdio MCP server that fronts one local
  CLI per data manifest, making shell/CLI tools callable as MCP tools.
- `tasks` (`@fluffles/tasks`): the production composition root. Wires the
  storage, conversations, scheduler, task-registry, repair-ledger, memory,
  codex sessions, and control stores into `SQLiteTaskLedger`; owns the
  production schema/migrations and re-exports the lower packages through
  legacy paths so existing consumers are untouched.

Compose them by opening one `LedgerDb` and handing it to the stores you want:

```ts
import { LedgerDb } from "@fluffles/storage";
import { BridgeStore, CONVERSATIONS_SCHEMA } from "@fluffles/conversations";
import { SCHEDULER_SCHEMA, SchedulerStore } from "@fluffles/scheduler";

const db = new LedgerDb({
  filePath: "agent.sqlite",
  schema: CONVERSATIONS_SCHEMA + SCHEDULER_SCHEMA,
  migrations: []
});
const bridge = new BridgeStore(db);
const scheduler = new SchedulerStore(db, bridge);
```

Fluffles' own composition root is `packages/tasks/src/ledger/sqlite-task-ledger.ts`: it
owns the production schema/migrations, wires the bridge hooks, and re-exports
everything through the legacy `packages/tasks/` paths so existing consumers are
untouched.

## Directory capabilities

Three capabilities are portable directories rather than npm packages, because
they contain conventions and operational scripts rather than library code.
Adopt them by copying the directory:

- `memory/`: the markdown memory contract (`AGENTS.md`, `memory/MEMORY.md`,
  `memory/people.md`, daily notes, and the wiki). The engine is the
  `@fluffles/memory` package (`packages/memory`), which depends only on
  `@fluffles/storage` (test-enforced).
- `skills/`: reusable cross-tool workflow instructions, maintained through the
  `skill-maintenance` skill.
- the deployer: `bin/deploy-main` plus `deploy/scripts/verify-source.sh`. PR-gated
  source updates with drain, checkpoint, staged apply, health/smoke checks,
  resume, and rollback.
