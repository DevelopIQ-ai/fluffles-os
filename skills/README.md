# skills

Reusable cross-tool workflow instructions for Fluffles.

Use this directory for patterns that apply across multiple tools, channels, subagents, and services. Keep tool-specific commands in `tools/<name>/TOOL.md`; link from those tool docs to skills when the failure mode or workflow is reusable.

Fluffles should maintain this library as it learns. After a task reveals a repeatable workflow, common pitfall, fallback ladder, or verification checklist, use `skill-maintenance` to create or update a skill.

## Current skills

- `auth-recovery`: login, OAuth, consent, token refresh, cookie, browser auth, and credential repair flows.
- `stuck-recovery`: how to respond when a task, tool, browser, service, model call, or integration appears blocked.
- `skill-maintenance`: when and how to turn repeated learnings into reusable skills.
- `browser-control`: choosing between Computer Use and agent-browser.
- `agent-browser`: installed agent-browser CLI guidance.

## Rule

Do not create a parallel runbook in memory for a reusable workflow. Put the common workflow here, then reference it from tool docs, subagent docs, and AGENTS.md.
