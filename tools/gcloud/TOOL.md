# gcloud

Google Cloud CLI for the Fluffles account and project setup.

- command: `/Users/ai/bin/gcloud`
- registry: `/Users/ai/tools/gcloud`
- auth: Infisical path `/services/gcloud` injects `GCLOUD_APPLICATION_DEFAULT_CREDENTIALS_JSON` and `GCLOUD_CREDENTIALS_DB_BASE64`
- materialization: `CLOUDSDK_CONFIG` is a mode-`700` temporary directory for one invocation. It retains non-secret account and project configuration from `/Users/ai/state/tools/gcloud/config`, materializes only the credential documents, and validates successful credential refreshes before writeback.

Use this for Google Cloud project and API management.
