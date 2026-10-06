# gws

Google Workspace CLI for `fluffles@puffle.ai`.

- command: `/Users/ai/bin/gws`
- registry: `/Users/ai/tools/gws`
- auth: Infisical path `/services/google-workspace` injects `GOOGLE_WORKSPACE_OAUTH_CREDENTIALS_JSON`
- materialization: a mode-`600` native credentials document exists only for one `gws` invocation. A successful provider refresh is validated and written back through the serialized Infisical writeback path.
- logs: `/Users/ai/state/tools/gws/logs`

Use this for Gmail and Google Workspace automation. Do not print secrets or raw credential files.

For reusable auth repair behavior, load `/Users/ai/skills/auth-recovery/SKILL.md`.

## health

Run:

```sh
/Users/ai/tools/gws/health
```

The health check verifies:

- `gws auth status` reports `token_valid: true`
- the authenticated user is `fluffles@puffle.ai`
- `gws gmail users getProfile --params '{"userId":"me"}'` returns `fluffles@puffle.ai`

If it fails with `invalid_rapt`, Google rejected the injected OAuth refresh path. Treat this as routine OAuth reauth. It can recur when Google requires fresh RAPT-backed account proof for the refresh token path.

## reauth runbook

Use this when health reports `gws token invalid: reauth related error (invalid_rapt)`:

1. Run `/Users/ai/bin/gws auth status` and confirm the exact failure.
2. Run `/Users/ai/bin/gws auth login --services gmail` and keep the localhost callback listener alive.
3. Follow `/Users/ai/skills/auth-recovery/SKILL.md`, especially the real headed browser plus Computer Use fallback.
4. Complete normal Google consent for `fluffles@puffle.ai` without asking Kush for permission.
5. Escalate only for an unsolved CAPTCHA, a macOS System Settings/TCC permission Fluffles literally cannot grant itself, missing password/access unavailable through the documented Infisical migration path, or a physical-device-only action. The account password is in Infisical `/accounts`. Passkeys, 2FA, account setup, OAuth consent, and account recovery for this owned account are repair work, not permission blockers.

## verification

After reauth, verify before claiming the task is done:

```sh
/Users/ai/tools/gws/health
/Users/ai/bin/email-channel --status
/Users/ai/tools/_health/run-all
/Users/ai/bin/smoke --json
```

Expected email status fields include `gwsTokenValid: true`, `gwsLastError: null`, and `lastPollError: null`.
