# @fluffles/auth

Infisical-backed auth. Infisical is the single source of truth for every
durable secret; the machine keeps exactly one local credential (the scoped
machine-identity bootstrap at `$HOME/auth/infisical/machine-identity.env`)
and everything else is fetched at runtime. This package owns the whole auth
contract; provisioning, rotation, recovery, and migration procedures live in
[INFISICAL.md](INFISICAL.md).

## Layout

```
bin/
  infisical-exec            the executable allowlist: which secret names each
                            /services/<name> path may receive (single authority)
  infisical-run             runtime injection wrapper: exchange the machine
                            identity for a short-lived token, inject only the
                            allowed secrets, run the command
  materialize               one credential materializer for every tool that
                            needs its secrets as files: private state, process
                            group, drain, deferred cleanup, post-exit push
  materialize.d/<tool>      per-tool spec: required variables, files to write,
                            binary to exec, credentials eligible for push
  auth-push                 pushes a locally refreshed credential back to
                            Infisical (a cache refresh, single writer via lock)
  auth-*                    process-group, locking, temp-state, and run-child
                            helpers used by materialize
  vercel-materialize        vercel CLI wrapper with token injection
  with-tool-secrets         resolves a callable tool's Infisical path from its
                            MCP manifest (tools/mcp/manifests/<tool>.json,
                            `secrets.path`) and delegates to infisical-run
  cleanup-legacy-infisical-secrets
test/                       standalone suite (npm test)
```

## Contract

- The allowlist in `bin/infisical-exec` is the one authority for which secret
  names exist at which paths; nothing keeps a second copy.
- `bin/materialize` owns the whole shared file-credential flow; a provider
  contributes only a spec in `bin/materialize.d/<tool>`. A tool that needs no
  file needs no spec.
- `bin/auth-push` is the only writer back to the vault. It refuses unparsable
  or empty refreshes, serializes the value through a mode-600 env file
  (`secrets set --file`, never `name=@file`, which some CLI versions store as
  the literal path), and takes a lock so there is one writer at a time.
- Consumers call the executables; there is no library import surface. Thin
  provider commands (`bin/gh`, `bin/gws`, `bin/codex`, ...) in the harness
  `bin/` exec into this package.
- A callable tool declares its Infisical path once, in its MCP manifest
  (`secrets.path`); its wrapper execs `bin/with-tool-secrets <tool> -- ...`
  and carries no credential plumbing of its own. Harness services (channels,
  webhooks, automations) keep their direct `infisical-run --path` calls in
  `deploy/services.json`; they are not manifest-backed tools.

## Composing it elsewhere

Copy `packages/auth/`, override the non-secret defaults (home, node, Infisical
project/environment are env-overridable in each script), provision a machine
identity bootstrap, and point your service launchers at
`packages/auth/bin/infisical-run --path /services/<name>`. The package depends
only on POSIX sh, perl, node, and the Infisical CLI.
