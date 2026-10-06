---
name: browser-control
description: Use when Fluffles needs to use Chrome, agent-browser, Computer Use, browser login state, Slack web, website auth, passkeys, 2FA, screenshots, scraping, QA, or any browser automation task where the right choice between visual desktop control and CLI browser automation matters.
---

# Browser Control

Use both browser control layers.

## Routing

Use Computer Use when the task needs the real desktop: existing Chrome windows, visible UI, account switching, auth prompts, passkeys, 2FA, downloads, dialogs, or messy app state.

Use `agent-browser` when the task benefits from repeatability: snapshots, element refs, scripted clicks, screenshots, scraping, QA, or web workflows after auth is available.

For auth, OAuth, login, consent, account setup, or recovery tasks, also load `/Users/ai/skills/auth-recovery/SKILL.md`.

Prefer MCP connectors for structured private services like Slack when authorized. Use browser or CLI paths when MCP is unavailable or too narrow.

## Auth Bootstrap

If `agent-browser` needs a login:

1. Launch the site with `agent-browser open <url>`.
2. Use Computer Use on the visible Chrome window to complete login as `fluffles@puffle.ai`.
3. Continue with `agent-browser snapshot -i`, `agent-browser click`, `agent-browser fill`, and related commands.

The canonical Fluffles browser profile is:

```text
/Users/ai/state/browser/profiles/fluffles
```

The controllable agent-browser profile may be separate when the task needs a clean automation profile. Do not assume it is equivalent to the real headed profile.

Agent-browser config lives at:

```text
/Users/ai/.agent-browser/config.json
```

Do not rely on agent-browser controlling Chrome's default profile directory directly. Use Computer Use for that case.
