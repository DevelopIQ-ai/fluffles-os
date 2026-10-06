# resources

Resource awareness and bounded cleanup for agent-owned local processes, browser/control helpers, and Chrome profile markers.

## wrapper

```sh
/Users/ai/bin/resources
```

## state

```text
/Users/ai/state/resources
```

## commands

```sh
/Users/ai/bin/resources status --json
/Users/ai/bin/resources health
/Users/ai/bin/resources cleanup --json
/Users/ai/bin/resources cleanup --dry-run --json
```

## cleanup policy

The cleanup target is intentionally narrow. It only considers processes owned by
user `ai` that belong to the dedicated browser automation profile:

```text
/Users/ai/state/browser/profiles/fluffles
```

A resource failure is reported when the harness has runaway browser CPU, stale completed Computer Use clients, old agent-browser/Chrome-for-Testing processes, stale headed Chrome after auth work is idle, or orphaned Chrome profile markers. Active `gws auth login`, active Computer Use MCP sidecars, and live Chrome profile owners are preserved.

Cleanup sends `SIGTERM`, waits briefly, then sends `SIGKILL` only to remaining cleanup-eligible owned processes. Orphaned profile markers are moved into a receipt folder instead of being deleted in place. It does not touch arbitrary Chrome sessions, active auth sessions, cookies, login databases, password stores, or other users' apps.
