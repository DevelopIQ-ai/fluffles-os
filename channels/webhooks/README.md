# webhooks

event ingress surfaces for one-way machine events.

this is separate from `channels/`. Slack lives in `/Users/ai/channels/slack`
through socket mode, and email lives in `/Users/ai/channels/email` through
Gmail polling. webhook routes are for provider callbacks and other one-way
machine events.

## service

local service:

```text
http://127.0.0.1:8787
```

manager:

```sh
/Users/ai/bin/webhooks status
/Users/ai/bin/webhooks smoke
/Users/ai/bin/webhooks logs
/Users/ai/bin/webhooks validate
/Users/ai/bin/webhooks sync
/Users/ai/bin/webhooks live
```

launchd label:

```text
com.puffle.harness.webhooks
```

state and logs:

```text
/Users/ai/state/webhooks
/Users/ai/state/webhooks/logs/service.log
```

provider secrets, if needed, are injected at runtime from Infisical. do not
commit or print them.

## routes

| method | path | purpose |
| --- | --- | --- |
| `GET` | `/` | service status |
| `GET` | `/healthz` | compact health check |
| `GET` | `/routes` | route inventory |
| `GET` | `/events/latest` | latest stored event receipt |
| `POST` | `/events/test` | local smoke event, no secret required |
| `POST` | `/events/generic` | generic machine event, optional shared secret |
| `POST` | `/github/events` | GitHub webhook, requires `GITHUB_WEBHOOK_SECRET` |

provider routes acknowledge quickly and persist a receipt to jsonl. slow work
should be attached through the central task ledger when it represents accepted
human work.

## Automations

Event-driven work no longer lives here. `/Users/ai/automations` is the single
registry for schedules, events, HTTP triggers, and manual runs, executed by the
`com.puffle.fluffles.automations` daemon on port 8788 and managed with
`/Users/ai/bin/automations`. This service owns raw provider ingress and event
receipts only.
