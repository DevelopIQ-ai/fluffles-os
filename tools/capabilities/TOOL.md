# capabilities

Machine-readable capability registry for the harness.

- command: `/Users/ai/bin/capabilities`
- source: `/Users/ai/packages/capabilities`
- state: `/Users/ai/state/capabilities/current.json`
- durable tool health: `/Users/ai/state/capabilities/registry.sqlite`
- callable-tool inventory: `/Users/ai/tools/mcp/manifests/*.json` (the MCP manifests are the one source of truth)
- harness charter: `/Users/ai/tools/capabilities/harness.json` (executable surfaces that are deliberately not callable tools)
- inputs: `/Users/ai/tools`, `/Users/ai/state/smoke/last-run.json`

Use this to answer what Fluffles can operate, which auth/tool surfaces are healthy, where repair guidance lives, and what should escalate to a human-only blocker.

The registry is not a source of credentials. It compiles the existing tool registry and health receipts into one operational view.

## Commands

```sh
/Users/ai/bin/capabilities current --json
/Users/ai/bin/capabilities summary
/Users/ai/bin/capabilities list
/Users/ai/bin/capabilities show gws --json
/Users/ai/bin/capabilities register --json
/Users/ai/bin/capabilities check gws --json
/Users/ai/bin/capabilities write
/Users/ai/bin/capabilities refresh
/Users/ai/bin/capabilities health --json
```

`current`, `summary`, `list`, and `show` use cached health receipts and should be fast.
`current` is machine-readable and includes the complete manifest-derived tool inventory.
`list` prints the same tool inventory, and `show` accepts either a legacy tool ID or a manifest name.

Invocation goes through the local Executor gateway (MCP), not this command: the
registry only answers what exists, whether it is healthy, and what repair is open.
Each manifest's `health` command is the canonical per-tool probe; a manifest
without one falls back to a wrapper-is-executable check.

`write` writes the current cached view to `/Users/ai/state/capabilities/current.json`.

`refresh` runs `/Users/ai/bin/smoke --json --quiet`, then writes the updated capability view. Use it when current live health matters and a slower check is acceptable.

## Registry Fields

Each capability records:

- desired state
- current state
- health detail
- last verified time
- command
- registry path
- auth path
- state path
- owner
- repair path
- escalation boundary

Each callable tool is one MCP manifest in `tools/mcp/manifests`: name, description,
MCP tool declarations, the shared executable wrapper, an optional `health`
command, and an optional `required` flag. The registry derives its inventory from
those manifests; nothing about a callable tool is declared twice. Every other
executable surface (harness organs, plumbing, hooks, deploy scripts) is listed in
the harness charter, `tools/capabilities/harness.json`; an executable in neither
place fails the classification tests.

`register` runs every manifest's canonical health probe and persists the result.
`check` does the same for one tool.
Failed checks create or update one tool-keyed repair task in the Step 2 ledger.
Only a later successful registry check completes that repair task.
Each health result records a fingerprint of the tool definition it was checked
against; when the manifest changes, the cached health is treated as stale
until a fresh check passes.
Manifests marked `required: true` gate deployment: `smoke --deploy`
runs a registry pass and fails when any required tool is unhealthy.

Invocation policy lives at two clearly separated layers: each manifest may
declare per-tool `deny` argument prefixes (refused before any process spawns,
guarding credential-printing subcommands), and the local Executor gateway owns
approval and access policy for every call. The registry itself never invokes tools.

## Health

Health and repair-task reconciliation is serialized per tool across both
observation and persistence, so an older worker cannot overwrite a newer
observation. A durable reconciliation row survives process interruption and is
completed on the next check. The scheduler isolates a failed tool persistence
and continues the remaining bounded batch.
