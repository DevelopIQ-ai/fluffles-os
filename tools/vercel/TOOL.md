# vercel

Vercel CLI for deploying and managing Vercel projects from the `ai` account.

- command: `/Users/ai/bin/vercel`
- package: `/Users/ai/tools/payloads/npm/vercel`
- auth: Infisical path `/services/vercel` injects `VERCEL_TOKEN`
- state: `/Users/ai/state/tools/vercel`
- global config: `/Users/ai/state/tools/vercel/config`

Use this wrapper instead of calling the npm payload directly so the current Infisical token and non-secret CLI cache state stay in their canonical locations.
