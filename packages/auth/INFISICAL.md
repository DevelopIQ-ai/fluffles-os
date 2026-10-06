# Infisical runtime authentication

## Current status

Infisical is the intended canonical store for durable Fluffles secrets. The Mac mini has one read-scoped Machine Identity and the source tree starts migrated secret-consuming processes through `/Users/ai/packages/auth/bin/infisical-run`.

The migration is not complete while the items in [Manual credential migration tasks](#manual-credential-migration-tasks) remain authoritative. Do not delete those items merely because the runtime wrapper is present.

## Runtime architecture

```text
/Users/ai/auth/infisical/machine-identity.env
  -> Universal Auth exchange
  -> short-lived Infisical access token
  -> infisical run
  -> process.env
  -> service
```

The bootstrap contains only:

- `INFISICAL_UNIVERSAL_AUTH_CLIENT_ID`
- `INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET`

The project a harness reads is host state, not source: `infisical-run` requires
`$HOME/auth/infisical/project-id` beside the identity and refuses to run without
it, so production and the dev harness cannot read each other's vault. The
environment `dev` is non-secret configuration in `packages/auth/bin/infisical-run`.

`infisical-run`:

- requires the bootstrap directory to be owned by the service user with mode `700`;
- requires a regular, non-symlink bootstrap file owned by the service user with mode `600`;
- accepts exactly one valid client ID and one valid client secret;
- removes inherited Machine Identity and access-token variables;
- removes inherited managed runtime secrets before injection;
- requires one approved service path and never injects the project root;
- retries authentication three times with a 20-second timeout per attempt;
- passes the short-lived token to the Infisical CLI only through its documented `INFISICAL_TOKEN` environment variable, never a command-line argument;
- clears `INFISICAL_TOKEN` in the fixed exec boundary before starting the target;
- reconstructs the target environment from a pre-injection baseline and the exact per-path allowlist in `packages/auth/bin/infisical-exec`; a new value added to an Infisical path is not exposed until its consuming wrapper explicitly allows it;
- fails before starting the target when authentication or secret injection fails.

### Account passwords

A sign-in that Fluffles performs as itself, in a browser or at a macOS prompt, needs the account password. Those live in Infisical under `/accounts` like any other secret and are injected the same way:

```text
infisical-run --path /accounts -- <command that needs the password>
```

Nothing belongs in the macOS Keychain. The Keychain unlocks only inside a GUI session, so a Keychain-backed credential silently becomes unavailable whenever nobody is logged in, and it cannot be read, rotated, or audited from anywhere but the machine itself.

One value is unavoidably also on disk: macOS reads the obfuscated login password from `/etc/kcpassword` to auto-log-in at boot, before anything can reach the network. Infisical holds the canonical copy as `MACOS_ACCOUNT_PASSWORD`; `/etc/kcpassword` is a boot-time derivative of it, and rotating the password means rewriting both.

### Tools that demand a credential file

Most targets read their credential from `process.env` and nothing touches the disk. A few providers only read a file, and those go through `packages/auth/bin/materialize`:

```text
infisical-run --path /services/codex -- materialize codex [args...]
```

`materialize` owns the whole shared flow: private mode-`700` state, mode-`600` credential files, a process group for the provider, a bounded drain, deferred cleanup while a provider descendant is still live, and the post-exit push. Each provider contributes only what is specific to it as a spec in `packages/auth/bin/materialize.d/<tool>`: the variables it requires, the files to write, the binary to exec, and which credentials may be pushed back. A tool that needs no file needs no spec.

`github-ssh` deliberately has no credential file. The deploy key is loaded into a private `ssh-agent` over its socket and ssh is pointed at that agent, so the private key never reaches the filesystem.

The target receives only its explicit per-path environment allowlist through `process.env`. Existing local env loaders only fill missing values, and the wrapper removes managed inherited values before injection, so a stale parent environment cannot bypass the selected path. The allowlist is executable source in `packages/auth/bin/infisical-exec`, with this table as its operational inventory.

## Verified Infisical inventory

The following service-path entries were verified by name on 2026-07-23 without printing values. This is not a claim that every provider migration is complete: provider entries listed under [Manual credential migration tasks](#manual-credential-migration-tasks) still require import and deployed-runtime verification.

| Name | Classification | Consumer | Status |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | Durable secret | Slack and `slack-send` | Verified in Infisical |
| `SLACK_APP_TOKEN` | Durable secret | Slack Socket Mode | Verified in Infisical |
| `EMAIL_PUBSUB_PUSH_TOKEN` | Durable secret | Vercel email Pub/Sub adapter | Verified in Infisical |
| `AMALGM_EMAIL_INBOUND_SECRET` | Durable secret | Vercel email Pub/Sub adapter | Verified in Infisical |
| `PHONE_EXECUTOR_MCP_AUTHORIZATION` | Durable secret | Phone executor MCP client | Verified in Infisical |
| `AMALGM_EVENTS_URL` | Non-secret configuration | Vercel email Pub/Sub adapter | Present in Infisical |
| `SLACK_ALLOWED_CHANNELS` | Non-secret configuration | Slack | Present in Infisical |
| `SLACK_AMBIENT_CHANNELS` | Non-secret configuration | Slack | Present in Infisical |

## Required service paths

The source permits only these Infisical paths. Each secret-consuming launch surface selects exactly one path; an unscoped `/` invocation fails before authentication.

| Path | Consumers | Values required there |
|---|---|---|
| `/services/slack` | Slack channel | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, and optional `SLACK_SIGNING_SECRET` |
| `/services/slack-send` | `slack-send` | `SLACK_BOT_TOKEN` |
| `/services/email-channel` | Email channel | optional `EMAIL_WEBHOOK_SECRET` |
| `/services/email-pubsub` | Vercel email deployment sync | `EMAIL_PUBSUB_PUSH_TOKEN`, `AMALGM_EMAIL_INBOUND_SECRET`, and its current `AMALGM_EVENTS_URL` configuration |
| `/services/github-gh` | GitHub CLI | `GITHUB_TOKEN` |
| `/services/github` | GitHub deployment SSH | `GITHUB_DEPLOY_SSH_PRIVATE_KEY_FLUFFLES_SOURCE_WRITE` |
| `/services/google-workspace` | `gws` | `GOOGLE_WORKSPACE_OAUTH_CREDENTIALS_JSON`, the exact document emitted by `gws auth export` |
| `/services/gcloud` | `gcloud` | `GCLOUD_APPLICATION_DEFAULT_CREDENTIALS_JSON`, `GCLOUD_CREDENTIALS_DB_BASE64` |
| `/services/vercel` | Vercel CLI | `VERCEL_TOKEN`; `VERCEL_REFRESH_TOKEN` is legacy state and is deliberately not passed to the CLI |
| `/services/codex` | Codex CLI | `CODEX_AUTH_JSON`, the native Codex `auth.json` document |
| `/services/amalgm` | Amalgm CLI | `AMALGM_AUTH_JSON`, the native scoped Amalgm `auth.json` document |
| `/services/phone` | Phone channel | `PHONE_EXECUTOR_MCP_AUTHORIZATION` and optional `PHONE_WEBHOOK_SECRET` |
| `/services/phone-executor` | Phone capability and health command | `PHONE_EXECUTOR_MCP_AUTHORIZATION` |
| `/services/chat-console` | Chat console | `CHAT_CONSOLE_PASSWORD`, the shared password every client signs in with |
| `/services/webhooks` | Webhooks service | optional `HARNESS_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_SECRET` |
| `/services/webhooks` | `webhooks set-secret` | optional `WEBHOOK_TRIGGER_SECRET` |
| `/services/automations` | Automations daemon | `AUTOMATIONS_EVENT_SECRET`, the shared secret the relay signs forwarded events with |
| `/accounts` | Interactive sign-in performed by Fluffles | `GOOGLE_ACCOUNT_EMAIL`, `GOOGLE_ACCOUNT_PASSWORD`, `GITHUB_ACCOUNT_EMAIL`, `GITHUB_ACCOUNT_PASSWORD`, `MACOS_ACCOUNT_USER`, `MACOS_ACCOUNT_PASSWORD` |

Creating these paths and moving the existing root entries into them is an Infisical control-plane deployment task. Do not deploy this source until that task is complete: the wrapper intentionally has no root-path fallback.

Provisioning is also a prerequisite for adding a path, not a follow-up. `infisical run` exits non-zero when the folder does not exist, so a launchd service whose `secretsPath` points at an unprovisioned path never reaches its program: it crash-loops on `Folder with path ... was not found`, which is what the chat console did on the deploy that introduced `/services/chat-console`. Create the folder and populate it before the release that declares it.

A one-time importer (`bin/infisical-import`, retired with the legacy local state it read from) performed that control-plane task on 2026-08-01 through a temporary write-capable Machine Identity; the import identity and its bootstrap were disposable. A new path today is provisioned directly in the Infisical control plane.

The paths above were created and populated on 2026-08-01, except `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, which do not exist yet, and `/services/vercel`'s `VERCEL_TOKEN`, which Vercel rejects as invalid. Google Workspace holds a document whose refresh token Google rejects with `invalid_grant`, so `gws` needs an interactive reauthentication before its value is trustworthy.

Phone no longer reads authorization from `.codex/config.toml`. It requires `PHONE_EXECUTOR_MCP_AUTHORIZATION` from the injected environment. Launchd supplies the non-secret `PHONE_EXECUTOR_MCP_URL`.

The Vercel email adapter must materialize three values in Vercel because the code executes there rather than on the Mac mini. `projects/fluffles-site/scripts/sync-infisical-env.sh` updates those production variables from Infisical and verifies hashes without printing values. `projects/fluffles-site/scripts/deploy.sh` runs that synchronization before every production deployment.

The repository also exposes optional credential interfaces that are not configured in the current runtime:

| Name | Interface | Current behavior |
|---|---|---|
| `SLACK_SIGNING_SECRET` | Slack HTTP Events API | Absent; Socket Mode is the configured transport and signed HTTP events fail closed |
| `EMAIL_WEBHOOK_SECRET` | Direct non-loopback email-channel webhook | Absent; non-loopback requests fail closed |
| `PHONE_WEBHOOK_SECRET` | Direct AgentPhone webhook | Absent; signed and non-loopback requests fail closed |
| `HARNESS_WEBHOOK_SECRET` | Generic webhook ingress | Absent; only loopback generic ingress is accepted without it |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook ingress | Absent; GitHub requests fail closed |
| `WEBHOOK_TRIGGER_SECRET` | One-shot `webhooks fire` caller input | No durable local value was found |

These names do not represent missing current credentials. If an optional interface is enabled, its credential must be created in Infisical before activation.

## Provisioning

1. Create one Machine Identity scoped to the Fluffles project and `dev` environment.
2. Grant read access to runtime paths. Grant update access only to `/services/codex` and `/services/amalgm` if their native auth files can rotate; no channel runtime needs update access.
3. Write the client ID and client secret to `/Users/ai/auth/infisical/machine-identity.env`.
4. Set `/Users/ai/auth/infisical` to mode `700`.
5. Set `machine-identity.env` to mode `600`.
6. Verify without printing values:

```sh
/Users/ai/packages/auth/bin/infisical-run --path /services/slack-send -- /bin/sh -c 'test -n "$SLACK_BOT_TOKEN"'
```

Two identities exist. The runtime identity in `machine-identity.env` reads every runtime path and may update an existing secret, which is what `auth-push` needs; creating a secret returns HTTP 403. The identity in `machine-identity-writeback.env` may also create secrets and folders, and is used only for provisioning a new path, never by a wrapper. Access to other projects cannot be proven from the repository and must be checked in the Infisical control plane.

## Onboarding a service

1. Choose stable environment-variable names.
2. Create one dedicated Infisical path and durable values for that service.
3. Keep endpoints, ports, paths, timeouts, and feature flags in source or machine configuration.
4. Add that path to the `infisical-run` allowlist and put `/Users/ai/packages/auth/bin/infisical-run --path <path> --` immediately before the service executable in every launch surface.
5. Continue reading credentials from `process.env`.
6. Remove local credential fallbacks only after non-printing injection and service health checks pass.
7. Add a service health check that proves the credential works separately from the bootstrap storage check.
8. Deploy through `deploy-main`, restart the service, and verify health before cleanup.

Do not add a generic root-path launch mode. A new service requires a reviewed source change that adds its explicit path and launch surface.

## Rotation

For Mac services:

1. Update the value in Infisical.
2. Restart the affected launchd service through the normal deployment path.
3. Run the service health check.
4. Restore the prior Infisical version and restart if health fails.

A new wrapper invocation fetches the current value and overrides an inherited stale value. Automated process tests verify these behaviors.

For the Vercel email adapter:

1. Update Infisical.
2. Run the normal site deployment.
3. The deployment synchronizes and verifies Vercel production environment values before deploying.

Do not restore a plaintext local secret file as the normal rollback path.

## Revocation and failure recovery

Revoking or expiring the Machine Identity causes Universal Auth to fail before the service starts. Automated tests cover invalid identity behavior. Revoking the only production identity has not been performed because it would intentionally interrupt every migrated service.

Failure behavior:

- missing or unsafe bootstrap: exit before authentication;
- malformed or duplicate bootstrap keys: exit before authentication;
- missing CLI: exit before authentication;
- invalid, expired, or revoked identity: retry, then exit;
- missing project, environment, or secret: `infisical run` exits before the target starts;
- network or Infisical outage: retry authentication, then fail closed;
- interrupted authentication: terminate the in-flight login and remove temporary token material;
- concurrent startup: each invocation uses an independent temporary token file.

launchd may retry a failed service according to its existing policy. Repair Infisical access, then restart normally.

## Deployment tasks

These tasks require Infisical access, deployment, or provider operations. They cannot be completed by a source-only change.

1. Create the listed service paths and move each current root entry to its listed path without printing values.
2. Import every remaining durable credential into Infisical from its current provider or local owner.
3. Deploy managed source through `deploy-main`, then reload every GUI, user, and system launchd definition.
4. Verify scoped injection and downstream credential health for each service.
5. Run `/Users/ai/packages/auth/bin/cleanup-legacy-infisical-secrets` as a dry run, then with `--apply`.
6. Grant the narrowly scoped Machine Identity update permission required by `/Users/ai/packages/auth/bin/auth-push`, then verify native rotating-auth write-back for Codex and Amalgm.

Cleanup refuses to run when:

- any source plist lacks runtime injection;
- any loaded launchd domain still uses a legacy definition;
- a required Infisical value is absent;
- a service health endpoint fails;
- deployed source still contains a migrated credential fallback.

Cleanup stages each legacy file under a temporary backup name, verifies runtime health again, and restores staged files on ordinary failure or interruption. It is idempotent. A hard kill can leave a backup name behind; the next cleanup run restores it before proceeding.

Cleanup is a deployment task. It must not run until the normal deployment and system-service installation have replaced every legacy definition.

## Manual credential migration tasks

These sources require secret import, provider reauthentication, or provider-specific write-back design. They are intentionally outside this source-only change.

| State | Current location | Classification | Migration status |
|---|---|---|---|
| Google, GitHub, and macOS account passwords | Infisical `/accounts` | Durable passwords | Migrated on 2026-08-02; the Keychain items were verified against Infisical by hash and deleted |
| GitHub CLI OAuth token and deploy keys | `/Users/ai/auth/tools/gh/hosts.yml`, two local private-key files | Durable provider credentials | Scoped runtime injection and temporary GitHub-only SSH materialization implemented; deploy and verify before cleanup |
| Vercel CLI token and refresh token | `/Users/ai/auth/tools/vercel/auth.json` | Durable provider tokens | `VERCEL_TOKEN` runtime injection implemented; verify before deleting local OAuth state and the obsolete refresh token |
| Google Workspace OAuth client and refresh state | `/Users/ai/auth/tools/gws` | Renewable provider state | Native `gws auth export` materialization is implemented; import `GOOGLE_WORKSPACE_OAUTH_CREDENTIALS_JSON` and verify whether the installed CLI mutates this document before enabling write-back |
| Google Cloud OAuth client and refresh state | `/Users/ai/auth/tools/gcloud` | Renewable provider state | Native `credentials.db` and ADC materialization is implemented; reauthenticate and import both documents before cleanup. The installed CLI can renew access tokens, but a safe canonical refresh-token write-back contract has not yet been verified |
| Codex account tokens | `/Users/ai/.codex/auth.json` | Renewable provider state | Native temporary auth-file materialization and guarded write-back implemented; import and grant scoped update access before deployment |
| Executor authorization used by Codex | `/Users/ai/.codex/config.toml` | Durable credential copy | Remove after the Codex provider migration; Phone already uses `/services/phone-executor` |
| Amalgm machine token | `/Users/ai/.amalgm/users/*/auth.json` | Durable provider credential | Native temporary auth-file materialization and guarded write-back implemented; the long-running launchd runtime still needs deployment conversion |
| Browser cookies and login databases | `/Users/ai/state/browser/profiles/fluffles` | Disposable session state | Keep as disposable local cache, never as the only durable credential copy |

OAuth refresh material cannot be copied once and declared canonical. The provider may rotate it during use, and the runtime Machine Identity deliberately lacks Infisical write permission. The source implements guarded native-state write-back for Codex and Amalgm. Google Workspace and Google Cloud require a provider-specific mutation and conflict test before their local credential stores can stop being authoritative.

Write-back treats Infisical as the durable cache it is. `auth-push` runs after the provider exits, under a single host-wide lock, and only for a credential whose file differs from the value that was materialized for that invocation. It refuses to upload a document that no longer parses, reports a failed upload as a breadcrumb, and keeps no pending state: the next invocation recomputes the same comparison. A push can therefore never fail a tool or hold one hostage, which the prior conflict protocol did.

The documented Infisical CLI and secret-update API expose no conditional-write version or ETag precondition, so no local protocol can provide remote compare-and-set semantics against a concurrent control-plane rotation. Last writer wins, and the reconciliation is a human rotating the credential.

The Google password, GitHub tokens and keys, Vercel tokens, Amalgm machine token, and inline Codex executor credential are durable values that belong in Infisical. They are not defensible as disposable caches.

## Security boundaries

- No Machine Identity credential is committed or written to launchd.
- No application package uses the Infisical SDK.
- Source secret scanning runs before deployment.
- Secret values are never intentionally printed by wrappers or tests.
- Vercel comparison uses SHA-256 values and does not print plaintext.
- Credential health is reported by service and tool health checks, separately from the smoke check for bootstrap presence and permissions.

Remaining deployment and provider-migration tasks:

- create and populate the required service paths before deploying scoped source;
- Google Workspace, Google Cloud, Codex, and Amalgm credentials still require a name-only import verification in Infisical;
- `.codex/config.toml` still contains a Codex-owned executor credential copy;
- deploy and reload the scoped launch definitions;
- execute guarded legacy cleanup only after downstream health verification.

These are deployment tasks, not remaining source-code changes.
