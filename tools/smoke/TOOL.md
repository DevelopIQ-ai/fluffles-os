# smoke

Harness smoke test runner.

- command: `/Users/ai/bin/smoke`
- source: `/Users/ai/tools/smoke`
- state: `/Users/ai/state/smoke`

Use this before claiming the harness is healthy. The default run is non-spammy and does not send Slack messages.

It also runs `/Users/ai/bin/capabilities register --json`, so every callable
tool is checked through its manifest's canonical health probe.
