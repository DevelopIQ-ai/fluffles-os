---
name: skill-maintenance
description: Use after finishing a task when a repeated workflow, fallback ladder, common pitfall, verification checklist, or reusable operating lesson emerged and should be turned into or added to a Fluffles skill.
---

# Skill Maintenance

Fluffles should keep building its skill library from experience. When a task teaches a repeatable workflow or common failure mode, skillify it.

## When To Skillify

Create or update a skill when any of these are true:

- The same workflow will likely happen again.
- A task exposed a common pitfall or bad default behavior.
- A tool-specific runbook contains logic useful across other tools.
- A repair required a fallback ladder across CLI, browser, Computer Use, logs, services, or source code.
- Verification requires a non-obvious checklist.
- Fluffles got stuck, almost escalated incorrectly, or needed supervisor correction.
- A subagent or channel needs to reuse the same procedure.

Do not skillify one-off facts, raw transcripts, secrets, or temporary task state. Put those in working memory, summaries, Stash, or auth state as appropriate.

## Skill Shape

Each reusable skill lives at:

```text
/Users/ai/skills/<skill-name>/SKILL.md
```

Mirror it in source:

```text
/Users/ai/projects/source-code/skills/<skill-name>/SKILL.md
```

Use this structure:

```markdown
---
name: short-kebab-name
description: Use when ...
---

# Human Title

One sentence saying what this skill is for.

## When To Use

Trigger conditions.

## Workflow

The default path.

## Fallback Ladder

What to try when the default path fails.

## Common Pitfalls

Specific mistakes to avoid.

## Verification

Commands or evidence required before claiming done.

## Escalation Threshold

What is a true hard blocker.
```

## Maintenance Workflow

1. Finish and verify the task first.
2. Identify the reusable lesson in one sentence.
3. Decide whether to create a new skill or update an existing one.
4. Keep the skill procedural: triggers, workflow, pitfalls, verification, escalation threshold.
5. Link from relevant `tools/<name>/TOOL.md`, `subagents/<name>/README.md`, or `AGENTS.md` to the skill.
6. Update `/Users/ai/skills/README.md` when creating a new skill.
7. Mirror live and source copies.
8. Run validation:

```sh
cd /Users/ai/projects/source-code
git diff --check -- AGENTS.md skills tools subagents
deploy/scripts/check-secrets.sh
```

9. If the skill affects a live capability, run that capability's health check too.

## Common Pitfalls

- Do not bury reusable procedures only in `tools/<name>/TOOL.md` if multiple tools can use them.
- Do not duplicate the same fallback ladder in several docs; link to the skill.
- Do not put secrets, token values, cookies, recovery codes, or raw account state in skills.
- Do not over-skillify tiny one-off facts.
- Do not leave source mirror stale.

## Current Priority Skills

- `auth-recovery`: auth, OAuth, login, consent, token, cookie, session, and credential repair.
- `stuck-recovery`: blocked/stuck tasks and fallback ladders.
- `browser-control`: choosing between Computer Use and agent-browser.
