# amalgm

Local Amalgm CLI install.

- command: `/Users/ai/bin/amalgm`
- registry: `/Users/ai/tools/amalgm`
- npm package: `/Users/ai/tools/payloads/npm/amalgm`
- auth: Infisical path `/services/amalgm` injects `AMALGM_AUTH_JSON`
- state: `/Users/ai/.amalgm`
- filesystem root: `/Users/ai`

The wrapper keeps the native persistent `AMALGM_DIR` so workflows, automations, configuration, and runtime state remain intact. It materializes only `auth.json` while holding an advisory lock, waits for the provider process tree before cleanup, writes a validated refresh back to Infisical, then removes the local auth document. The provider-managed launchd runtime is outside the source repository and remains an operational migration task.
