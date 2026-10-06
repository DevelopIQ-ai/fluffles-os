# smoke

Harness smoke test runner.

Source: `/Users/ai/tools/smoke`. The last receipt is written to `/Users/ai/state/smoke/last-run.json`.

Run:

```sh
/Users/ai/bin/smoke
```

The default run is non-spammy. It does not send Slack messages. It checks:

- core directory structure
- executable wrappers
- Infisical bootstrap presence and permissions
- tool health for every real `/Users/ai/tools/<name>` directory
- memory index health and search
- launchd job drift
- Slack and webhooks launchd services and socket/HTTP health
- automations launchd service, registry validation, schedule liveness, and live execution
- executor launchd service and tool catalog
- deploy-main poller and latest receipt
- Codex hook pipeline
- breadcrumb coverage enforcement

For a recent scheduled automation run check:

```sh
/Users/ai/bin/smoke --deep
```

The `--deploy` mode is a smaller, faster subset used during `deploy-main`.
