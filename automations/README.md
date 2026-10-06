# automations

One primitive for every trigger. A schedule, an inbound event, an HTTP request, and a manual invocation are four ways to fire the same automation, and they share one id, one set of steps, and one run history.

- Definitions: `/Users/ai/automations/<id>/automation.json`.
- Engine: `@fluffles/automations` in `packages/automations`, which owns the clock, the durable run store, and the runner.
- Daemon: `com.puffle.fluffles.automations`, listening on `http://127.0.0.1:8788`.
- State: `/Users/ai/state/automations` (SQLite run ledger plus per-automation `runs.jsonl`).

## Spec

```jsonc
{
  "id": "capability-health",
  "name": "capability tool health",
  "enabled": true,
  "triggers": [
    { "kind": "schedule", "cron": "*/5 * * * *", "tz": "America/Los_Angeles" },
    { "kind": "event", "source": "email", "event": "inbound" },
    { "kind": "http", "method": "POST", "path": "/github/events",
      "verify": { "style": "hmac-sha256", "header": "x-hub-signature-256", "secretEnv": "GITHUB_WEBHOOK_SECRET" } },
    { "kind": "manual" }
  ],
  "steps": [
    { "kind": "command", "name": "probe", "argv": ["{{ROOT}}/bin/breadcrumb", "run", "--", "/bin/sh", "-lc", "..."],
      "cwd": "{{ROOT}}", "timeoutMs": 180000 },
    { "kind": "http", "name": "forward", "method": "POST", "url": "http://127.0.0.1:3001/webhook/email",
      "body": { "inbound": "{{event.payload.inbound|event.payload}}" } }
  ],
  "limits": { "maxConcurrentRuns": 1, "queueLimit": 1 }
}
```

Commands are argv, never shell strings, so nothing is interpolated into a shell unless the spec asks for `/bin/sh -lc` itself. Secrets are referenced by environment variable name and are never stored in a spec. `{{ROOT}}`, `{{AUTOMATION_DIR}}`, `{{STATE_DIR}}`, and `{{AUTOMATION_STATE_DIR}}` expand when the spec is loaded; `{{event.*}}` resolves against the firing event when a step runs.

## Commands

```sh
/Users/ai/bin/automations list
/Users/ai/bin/automations validate
/Users/ai/bin/automations sync
/Users/ai/bin/automations run <id>
/Users/ai/bin/automations fire email.inbound '{"inbound":{}}'
/Users/ai/bin/automations runs <id>
/Users/ai/bin/automations doctor
```

`sync` only recomputes next-run times from the specs; it never contacts a provider, and `deploy-main` runs it after installing a candidate.

## Ingress

Amalgm stays the public relay and nothing else. One automation per source lives in Amalgm, and its only job is to pipe the event it received into a local command:

```
echo "$event" | /Users/ai/bin/automations-relay
```

`automations-relay` signs the body with `AUTOMATIONS_EVENT_SECRET` from `/services/automations` and posts it to the one static endpoint:

```
POST http://127.0.0.1:8788/events/inbound
x-webhook-signature: sha256=<hmac of the raw body>
x-delivery-id: <the relay's own delivery id>
{"source":"email","event":"inbound","payload":{...}}
```

The secret therefore never lives inside Amalgm, and a redelivery carries the same `x-delivery-id`, so the daemon answers it instead of running the automation twice. A non-zero exit is the relay's signal to redeliver.

Those two relay automations are configured once and never change as specs change, which is what lets the automation registry live entirely in this repository. Nothing else may remain registered in Amalgm: an automation left enabled there runs the same job a second time on its own clock. `channels/webhooks/` remains the raw local ingress service for GitHub and generic machine events on port 8787.
