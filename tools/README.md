# tools

This directory is the capability registry for the harness.

Rules:

- `~/bin` contains only executable shims that are safe to put on `PATH`.
- `~/tools/<name>` records each tool and links to its wrapper, install payload, source, auth, and state as applicable.
- the callable-tool inventory is `~/tools/mcp/manifests/*.json`: one MCP manifest per tool, and each manifest's optional `health` command is the canonical per-tool probe (a manifest without one falls back to a wrapper-is-executable check).
- every other executable surface is charted in `~/tools/capabilities/harness.json`; an executable in neither place fails the classification tests.
- smoke runs the `capabilities register` pass, which checks tools with
  bounded concurrency and persists registry-owned health.
- `/Users/ai/bin/capabilities` compiles this registry and cached health receipts into `/Users/ai/state/capabilities/current.json`.
- `~/tools/payloads/npm` contains npm-installed CLI payloads.
- `~/tools/payloads/source` contains cloned source repositories used as references or install payloads.
- `~/auth` contains credentials, OAuth state, token caches, and secret references.
- `~/state` contains runtime state, sessions, logs, caches, queues, and service data.
- `~/browser` contains browser profiles, screenshots, downloads, and browser automation config.
- aliases and fallback wrappers are not part of the registry. every callable tool should have one canonical command and one canonical `~/tools/<name>` entry.

Health command contract (each manifest's `health` argv):

The command exits `0` when healthy, nonzero when broken, and may print short JSON:

```json
{
  "ok": true,
  "tool": "gws",
  "component": "auth",
  "detail": "Gmail auth valid for fluffles@puffle.ai"
}
```

Auth-backed tools must include a low-risk live probe, not only a file existence
check. For example, `gws` checks token validity and Gmail profile access.

Current tools:

| tool | command | registry | auth | state |
| --- | --- | --- | --- | --- |
| agent-browser | `agent-browser` | `~/tools/agent-browser` | browser profile in `~/browser` | `~/browser` |
| amalgm | `amalgm` | `~/tools/amalgm` | Infisical `/services/amalgm`, materialized per CLI invocation | `~/.amalgm` |
| breadcrumbs | `breadcrumb` | `~/tools/breadcrumbs` | none | `~/state/tasks/tasks.sqlite` |
| brew | `brew` | `~/tools/brew` | none | `~/homebrew` |
| browser-control | none | `~/tools/browser-control` | browser profile in `~/browser` | `~/browser` |
| codex | `codex` | `~/tools/codex` | Infisical `/services/codex`, materialized per invocation | `~/.codex` |
| capabilities | `capabilities` | `~/tools/capabilities` | none | `~/state/capabilities` |
| communications | `communications` | `~/tools/communications` | none | `~/state/communications` |
| logs | `logs` | `~/tools/logs` | none | `~/state`, `~/Library/LaunchAgents`, selected `/var/log` |
| resources | `resources` | `~/tools/resources` | none | `~/state/resources` |
| fluffles-site | `deploy-fluffles-site` | `~/tools/fluffles-site` | Vercel via Infisical `/services/vercel` | `~/projects/fluffles-site` (source at `projects/fluffles-site/`) |
| webhooks | `webhooks` | `~/tools/webhooks` | Infisical `/services/webhooks` and `/services/webhooks` | `~/state/webhooks` |
| gh | `gh` | `~/tools/gh` | Infisical `/services/github-gh` | none |
| gcloud | `gcloud` | `~/tools/gcloud` | Infisical `/services/gcloud` | ephemeral per invocation |
| gws | `gws` | `~/tools/gws` | Infisical `/services/google-workspace` | `~/state/tools/gws` |
| imsg-mcp | `imsg` | `~/tools/imsg-mcp` | macOS Messages identity | `~/state/tools/imsg-mcp` |
| memory | `memory` | `~/tools/memory` | none | `~/memory`, `~/state/memory` |
| rg | `rg` | `~/tools/rg` | none | none |
| slack-send | `slack-send` | `~/tools/slack-send` | Infisical `/services/slack-send` | `~/state/channels/slack` |
| smoke | `smoke` | `~/tools/smoke` | none | `~/state/smoke` |
| tailscale | `tailscale` | `~/tools/tailscale` | Tailscale local node auth | Tailscale system state |
| vercel | `vercel` | `~/tools/vercel` | Infisical `/services/vercel` | `~/state/tools/vercel` |

`logs` can read harness log files, launchd state, selected `/var/log` files, and smoke receipts. macOS unified logs via `/usr/bin/log show` require Full Disk Access for the process running the harness; without it, the tool reports `macOS unified log denied`.
