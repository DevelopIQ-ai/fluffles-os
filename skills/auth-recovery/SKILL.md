---
name: auth-recovery
description: Use when any account login, OAuth flow, token refresh, invalid_rapt, consent screen, cookie/session issue, password prompt, browser auth, or credential repair task fails or needs to be completed.
---

# Auth Recovery

Auth work is routine operational repair. Do not ask Kush for permission to operate Fluffles-owned accounts, approve normal scopes, or complete normal consent flows.

## Core Principle

A failed auth path is evidence, not a blocker. Switch surfaces until the auth is repaired or a true hard boundary appears.

Examples of surface switches:

- CLI auth status to browser login
- MCP connector to vendor UI
- headless browser to real headed browser
- agent-browser to Computer Use
- stale browser profile to the canonical Fluffles profile
- token cache inspection to fresh OAuth
- logs to source code or tool docs

## Standard Workflow

1. Identify the exact account, tool, and error.
2. Check current state before changing anything: auth status, health check, token metadata, service status, recent logs, and whether a callback listener is already running.
3. Preserve active callback listeners when possible. Do not kill an OAuth flow just because the browser path is failing.
4. Try the native repair path first: CLI login, MCP reconnect, vendor auth command, or documented tool flow.
5. If auth involves a web login or consent screen, use the real headed browser plus Computer Use as the standard fallback before calling anything blocked.
6. Use agent-browser or CDP for snapshots, screenshots, repeatable non-auth work, and inspection. If Google or another provider returns a 500, blank page, stale profile, CDP reset, suspicious automation challenge, or launch failure, switch to Computer Use on a real headed browser.
7. Use the canonical owned identity when possible, usually `fluffles@puffle.ai`.
8. Retrieve durable passwords and secrets only through Infisical. Account passwords live at `/accounts`: `infisical-run --path /accounts -- <command>`. The macOS Keychain holds no Fluffles credential and must not be used as one. Never print raw secrets.
9. Click ordinary `Continue`, `Allow`, `Authorize`, `Consent`, `Trust`, or `Approve` buttons when they are part of routine owned-account work.
10. Verify with the tool health check and the downstream service that depends on it.

## Common Pitfalls

- Token file exists does not mean token is valid.
- Refresh token exists does not mean Google will accept refresh. `invalid_rapt` means Google wants fresh interactive account proof.
- Headless/CDP auth failures are not final blockers.
- Do not close the CLI OAuth listener while switching browser surfaces.
- Do not report auth fixed from a browser success page alone. Verify the CLI/tool health check.
- Do not store passwords, cookies, tokens, recovery codes, or raw credentials in docs, memory, or screenshots.
- Do not ask Kush for permission for normal owned-account consent.

## GWS Invalid RAPT

For `gws token invalid: reauth related error (invalid_rapt)`:

1. Run `/Users/ai/bin/gws auth status` to confirm the exact failure.
2. Run `/Users/ai/bin/gws auth login --services gmail` and keep the localhost callback alive.
3. Open the OAuth URL in a real headed browser using `/Users/ai/state/browser/profiles/fluffles`.
4. Use Computer Use on a separate macOS Desktop/Space to complete Google sign-in and consent.
5. Take `GOOGLE_ACCOUNT_PASSWORD` from Infisical `/accounts`. Do not record or print it.
6. Escalate only for an unsolved CAPTCHA, a macOS System Settings/TCC permission Fluffles literally cannot grant itself, missing password/access unavailable through the documented Infisical migration path, or a physical-device-only action. Passkeys, 2FA, account setup, OAuth consent, and account recovery for owned accounts are repair work, not permission blockers.
7. Verify:

```sh
/Users/ai/tools/gws/health
/Users/ai/bin/email-channel --status
```

Expected email fields: `gwsTokenValid: true`, `gwsLastError: null`, `lastPollError: null`.

## Escalation Threshold

Escalate only after reasonable alternate routes have failed and the remaining step requires a true human-only capability: an unsolved CAPTCHA, a macOS System Settings/TCC permission Fluffles literally cannot grant itself, missing password/access unavailable through the documented Infisical migration path, physical-device access, destructive action beyond scope, legal or financial commitment beyond scope, or information only Kush can provide. Passkeys, 2FA, OAuth consent, account setup, and account recovery for owned accounts are repairable work, not permission blockers.

When escalating, include: exact account/tool, exact error, routes tried, current live state, where the human must act, and what you will do immediately after the blocker is cleared.
