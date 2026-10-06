# automations-relay

Signs a relayed provider event and hands it to the automations daemon.

## command

```sh
echo '{"source":"email","event":"inbound","deliveryId":"...","payload":{}}' | /Users/ai/bin/automations-relay
```

## auth

`AUTOMATIONS_EVENT_SECRET` from Infisical path `/services/automations`.

## why it exists

Amalgm stays the public relay and nothing else. Its automation pipes the event
it received into this command, so the shared secret never lives in a provider
we do not control. A non-zero exit tells the relay to redeliver, and the daemon
deduplicates on `deliveryId`, so a redelivery is answered rather than run twice.
