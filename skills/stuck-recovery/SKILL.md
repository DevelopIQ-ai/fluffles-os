---
name: stuck-recovery
description: Use when a task, run, tool, service, browser, auth flow, model call, process, integration, or deployment appears stuck, blocked, failed, wedged, or unclear.
---

# Stuck Recovery

Blocked is a last-resort state, not a normal outcome. A failed path means try another route.

## Core Principle

Fluffles should almost never get stuck. It has many surfaces: CLI, source code, logs, Stash, memory, docs, browser, Computer Use, MCPs, local files, launchd, Amalgm, direct HTTP, alternate profiles, rebuilds, service restarts, smaller subproblems, and bounded repairs.

Use them.

## Standard Workflow

1. Restate the desired end state in one sentence.
2. Check live state: process, ledger, health command, service status, logs, and current user-visible behavior.
3. Identify the current failure mode precisely. Do not collapse all failures into "blocked".
4. Try at least two reasonable alternate routes when safe:
   - tool CLI vs source inspection
   - API/MCP vs browser UI
   - agent-browser vs Computer Use
   - running service vs direct script
   - existing profile vs clean profile
   - logs vs database/ledger
   - local repair vs rebuild/restart
5. Decompose the task if the whole thing is stuck. Prove or fix one smaller piece at a time.
6. Prefer reversible or bounded repairs first.
7. Leave receipts: what changed, what was verified, and where the state lives.
8. Only call the task done after direct verification of the requested end state.

## Common Pitfalls

- Reporting a task as blocked after the first failed tool call.
- Treating browser automation failure as website failure.
- Treating one green check as durable success without checking the downstream service.
- Killing active callbacks or processes without understanding what they are waiting for.
- Confusing source mirror state with live runtime state.
- Reading recent Slack chatter instead of the SQLite task ledger and service status.
- Asking Kush for permission when the real need is missing facts, credentials, or a different tool path.

## Escalation Threshold

Escalate only for a true hard boundary: an unsolved CAPTCHA, a macOS System Settings/TCC permission Fluffles literally cannot grant itself, a physical device requirement, destructive work beyond scope, legal/financial commitment beyond scope, secrets exposure risk, or information only Kush can provide. For Fluffles-owned accounts, passkeys, 2FA, OAuth consent, account setup, and account recovery are repairable work, not permission blockers.

Before escalating, write down the routes already tried and the smallest exact action needed from a human.
