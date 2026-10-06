# automations

one composable primitive for schedules, events, http triggers, and manual runs.

## command

```sh
/Users/ai/bin/automations
```

## source

```text
/Users/ai/automations          definitions
/Users/ai/packages/automations engine (@fluffles/automations)
```

## state

```text
/Users/ai/state/automations
```

## auth

step secrets are injected from Infisical by `/Users/ai/packages/auth/bin/infisical-run` and are
referenced in specs by environment variable name only.

## common commands

```sh
/Users/ai/bin/automations list
/Users/ai/bin/automations validate
/Users/ai/bin/automations sync
/Users/ai/bin/automations run <id>
/Users/ai/bin/automations fire <source>.<event> '{}'
/Users/ai/bin/automations runs <id>
/Users/ai/bin/automations doctor
```

The daemon listens on `http://127.0.0.1:8788`: `GET /healthz`, `GET /automations`,
`POST /events/inbound` for relayed provider events, and any `http` trigger path a
spec declares.
