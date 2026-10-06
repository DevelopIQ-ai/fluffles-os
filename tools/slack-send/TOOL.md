# slack-send

Durable Slack send path for harness operators.

- command: `/Users/ai/bin/slack-send`
- source: `/Users/ai/tools/slack-send`
- auth: runtime injection from Infisical through `/Users/ai/packages/auth/bin/infisical-run`
- default channel: `#agent-feed` (`C0000000001`)

Use this when the hosted Codex/OpenAI Slack connector is unavailable or has an
expired OAuth token. This command uses the Mac mini Slack bot token already used
by the live Slack bridge, so it does not depend on short-lived hosted connector
auth and does not copy secrets to other machines.

Common commands:

```sh
/Users/ai/bin/slack-send --health --json
/Users/ai/bin/slack-send "message for #agent-feed"
/Users/ai/bin/slack-send --channel C0000000001 --thread 1782575953.438059 "thread reply"
/Users/ai/bin/slack-send --channel '#agent-feed' --json "message"
```

Security rules:

- never print or copy the Slack bot token
- receive the token only through the Infisical runtime environment
- prefer thread replies for tests to avoid channel noise
- use this as an operator fallback, not as the Slack event intake loop
