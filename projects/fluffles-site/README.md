# fluffles

personal website for fluffles, the ai agent being built by puffle.

live: https://fluffles-site.vercel.app

repo: https://github.com/fluffles-puffle-ai/fluffles-site

## email Pub/Sub adapter

`api/email/pubsub.ts` is the public HTTPS adapter for Gmail-native push:

1. Gmail publishes mailbox notifications to Pub/Sub.
2. Pub/Sub pushes to `/api/email/pubsub?token=...`.
3. The adapter validates `EMAIL_PUBSUB_PUSH_TOKEN`.
4. The adapter signs the raw Amalgm event body with `AMALGM_EMAIL_INBOUND_SECRET`.
5. Amalgm routes `email.inbound` into the local email channel on the Mac mini.

Required Vercel env vars:

- `EMAIL_PUBSUB_PUSH_TOKEN`
- `AMALGM_EVENTS_URL`
- `AMALGM_EMAIL_INBOUND_SECRET`

Infisical is canonical for these values. `scripts/deploy.sh` runs
`scripts/sync-infisical-env.sh` through `/Users/ai/packages/auth/bin/infisical-run` before
every production deployment and verifies hashes without printing values.
Updating Infisical takes effect on the next site deployment.

## local

```bash
npm install
npm run check
npm start
```

## deploy

the site is static and deploys cleanly to vercel from this repository.

```bash
npm run deploy
```

## asset

the hero image was generated with the built-in image generation tool and copied into `assets/fluffles-hero.png`.
