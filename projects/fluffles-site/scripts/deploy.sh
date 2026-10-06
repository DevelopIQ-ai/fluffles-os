#!/usr/bin/env bash
set -euo pipefail

# Which harness this is comes from the account the wrapper runs as, so the
# same file serves production and the dev harness.
home="${FLUFFLES_HOME:-${HOME:?HOME must be set}}"

cd "$(dirname "$0")/.."

VERCEL_CLI="${VERCEL_CLI:-${home}/bin/vercel}"
INFISICAL_RUN="${INFISICAL_RUN:-${home}/packages/auth/bin/infisical-run}"

if [[ "${1:-}" == "--health" ]]; then
  "${VERCEL_CLI}" whoami >/dev/null
  echo "vercel deployment identity is available"
  exit 0
fi

npm run check
"$INFISICAL_RUN" --path /services/email-pubsub -- "$PWD/scripts/sync-infisical-env.sh"
"${VERCEL_CLI}" --prod
