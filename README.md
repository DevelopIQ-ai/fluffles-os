# fluffles

Fluffles: an autonomous agent harness and execution environment for macOS — multi-channel communication (Slack, Email, Phone), a durable task ledger, and a self-healing deployment pipeline.

**Deprecated.** This is a public snapshot of the Fluffles harness as it ran on a Mac mini. Active development moved to [DevelopIQ-ai/puffle-app](https://github.com/DevelopIQ-ai/puffle-app), a pure-eve rewrite that shares no code with this repo. Kept here for reference.

Secrets, live runtime state, and credentials were never part of this repository; environment-specific identifiers have been replaced with placeholders.

## included

- `AGENTS.md`: standing operating contract and identity rules.
- `agent/`: the composition layer whose slot files (`channels/`, `executors/`) wire the packages into the fluffles agent; see `agent/agent.md`.
- `automations/`: one registry for schedules, events, http triggers, and manual runs, executed by `@fluffles/automations`.
- `bin/`: thin command wrappers that define the harness cli surface.
- `channels/`: every listener - Slack, email, and phone adapters, the webhook ingress service (`channels/webhooks/`), and the local chat console (`channels/chat-console/`).
- `config/`: harness configuration such as `config/context-limits.json`.
- `deploy/`: everything about running and proving the system - launchd service definitions, host files, the pinned Executor (`deploy/executor/`), and verification scripts (`deploy/scripts/`, including `deploy/scripts/verify-source.sh`).
- `hooks/`: Codex hook entrypoints.
- `memory/`: memory protocol docs, durable memory files, and daily notes.
- `packages/`: self-contained capability packages (`@fluffles/*`); see `packages/README.md`.
- `skills/`: user-authored operational skills.
- `subagents/`: folder-shaped specialist agents with scoped instructions and entrypoints.
- `state/`: the structural skeleton of runtime state directories (including `state/browser/`, see `state/browser/README.md`); live contents stay on the machine.
- `test/`: harness-level tests.
- `tools/`: the callable-tool surface - MCP manifests (`tools/mcp/manifests/`), the harness charter (`tools/capabilities/harness.json`), and one directory per tool with its docs and implementation (smoke lives at `tools/smoke/`, communication helpers at `tools/communications/`).
- `projects/`: one directory per project Fluffles owns, starting with `projects/fluffles-site/` (personal site source). Installed to `~/projects/`, alongside the runtime-owned checkout the deployer keeps there.

Conversation turns run with `~/work` as their working directory, created by the harness and not source-managed. Codex confines model-generated shell writes to the working directory plus the declared writable roots, which are `~/projects` and the temporary directories, so a turn reaches the ledger, the markdown memory, `~/auth`, and the installed harness only through the MCP tools the executor daemon runs outside the sandbox.

## excluded

- `$HOME/auth`
- `$HOME/state` contents (only the directory skeleton is tracked)
- `$HOME/Library`
- `$HOME/.codex`
- `$HOME/.amalgm`
- raw transcripts, logs, caches, cookies, browser profiles, and OAuth state
- the derived memory index (`state/memory/index.sqlite`) and quarantined memory writes
- `node_modules`, virtualenvs, external source payloads, generated app bundles
- raw private communication contents

the excluded `$HOME/auth` and `$HOME/state` contents are runtime state on the machine. `$HOME/auth` has no tracked mirror: it holds only the Machine Identity bootstrap and disposable tool-owned auth state, documented in `packages/auth/INFISICAL.md`. the tracked `state/` tree is structure only: directories, docs, and non-secret automation config.

## delivery

All work happens on a branch and enters `main` through a pull request. GitHub source checks run on every pull request. Only a merged `main` commit is eligible for deployment.

The Mac mini polls `origin/main` once a minute through the local `com.puffle.harness.deploy-main` launchd service. A new commit is verified, copied without touching secrets or runtime state, restarted, and smoke-tested. A failed smoke test restores the prior source-managed files. The legacy `deploy-main` automation stays disabled so there is only one deployment trigger.

Useful commands on the Mac mini:

```sh
/Users/ai/bin/deploy-main --dry-run
/Users/ai/bin/deploy-main
cat /Users/ai/state/deploy-main/last-run.json
```

Merged `origin/main` is the only deployable source of truth. The deployer converges the source checkout back onto `origin/main` on every run, preserving any local commits or uncommitted edits under `state/deploy-main/quarantine/` and on `quarantine/<timestamp>` branches. Local edits to source-managed runtime files are likewise preserved in the quarantine and then overwritten by the deployed source; anything worth keeping returns through a pull request.

During a deployment the task ledger drains: no new runs start, incoming messages stay durable, and active runs checkpoint themselves at their next safe turn boundary. After the restart, checkpointed and interrupted runs are recovered and continue with their persisted task progress, next action, Codex session, and a deployment update notice.

Before pushing a branch, run:

```sh
deploy/scripts/verify-source.sh
```

## rule

source belongs here. durable secrets belong in Infisical. `$HOME/auth`, provider caches, and browser profiles contain only bootstrap or explicitly tracked migration state. yes, obvious. also yes, worth writing down.
