# webhooks

local webhook ingress service for the harness.

## command

```sh
/Users/ai/bin/webhooks
```

## source

```text
/Users/ai/channels/webhooks
```

## state

```text
/Users/ai/state/webhooks
```

## auth

provider secrets are injected from Infisical by `/Users/ai/packages/auth/bin/infisical-run`.

## common commands

```sh
/Users/ai/bin/webhooks status
/Users/ai/bin/webhooks smoke
/Users/ai/bin/webhooks logs
```

## automations

Event-driven work lives in `/Users/ai/automations` and runs on the
`com.puffle.fluffles.automations` daemon. This service only receives raw
provider requests and stores receipts.

```sh
/Users/ai/bin/automations list
/Users/ai/bin/automations fire email.inbound '{"inbound":{"from":"Kush <kush@puffle.ai>","subject":"can you check this?","text":"can you review this and let me know?"}}'
```

Gmail auth currently works through `gws` for `fluffles@puffle.ai`; the email channel owns Gmail reply sending and webhook ingestion.
