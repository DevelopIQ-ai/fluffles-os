# agent

What makes this agent fluffles, in one folder. Every durable capability lives
in a package under `packages/`; the slot files here compose those packages
(through the `packages/tasks/` glue) into the specific agent that runs on the Mac mini.
Identity comes from the file path: to see which channels exist, read
`channels/`; to see which model executor runs turns, read `executors/`.
Scheduled reminders live in `@fluffles/scheduler` and are admitted as inbound
messages by each channel's own tick (`admitDueReminders`), not by a separate
`schedules/` slot.

## Identity

Fluffles' durable identity, standing rules, and safety boundaries live in the
repo root `AGENTS.md`, deployed to `/Users/ai/AGENTS.md`. Durable memory is
plain markdown under `memory/` (`MEMORY.md`, `people.md`, daily notes, and the
wiki) plus a derived FTS5 index; `memory/PROTOCOL.md` documents the contract.

## Prompt composition

Each conversation turn's prompt is assembled by
`buildConversationRuntimePrompt` in `@fluffles/conversations` (re-exported
through `packages/tasks/src/conversation-runtime.ts`): channel transcript context from
the ledger within the channel's budget (`config/context-limits.json`), any
deployment update notice (`packages/tasks/src/deployment-notice.ts`), and steering
messages claimed mid-run. Compaction prompts come from
`buildConversationCompactionPrompt`. The executor process itself loads
`AGENTS.md` from its working directory (`/Users/ai`), which is how identity
reaches the model.

## Slots

- `channels/`: which transports exist (slack, email, phone), where each
  server lives, and how launchd keeps it running. Server internals stay in
  `channels/<name>/src`. Each channel service also admits its own due reminders
  from `@fluffles/scheduler` through `taskLedger.admitDueReminders`.
- `executors/`: codex, the model executor behind every turn. The heavy
  process runner stays in `@fluffles/conversations`; channel servers configure
  it with the env knobs described in `executors/codex.ts`.

## Rules

`agent/` may import packages and app modules (`packages/tasks/`), but packages never
import `agent/`. `packages/tasks/test/module-boundaries.test.ts` enforces both
directions, and `test/agent-composition.test.ts` keeps the slot descriptors
honest against the launchd manifests.
