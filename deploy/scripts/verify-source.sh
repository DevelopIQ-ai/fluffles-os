#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

# Fast mode gates on secrets hygiene, dependency install, and every package
# compiling, but skips the test suites. It exists for rapid iteration windows:
# CI already ran the full matrix on the exact merged SHA, and the post-install
# `smoke --deploy` gate still fails closed with rollback. Full mode remains
# the default.
mode="full"
case "${1:-}" in
  "") ;;
  --fast) mode="fast" ;;
  *)
    echo "usage: verify-source.sh [--fast]" >&2
    exit 64
    ;;
esac

# Source verification decides whether a candidate may be installed, so it must
# only judge the candidate. Suites that drive the live runtime on this machine
# (Amalgm, the running channel servers) skip here and run in `smoke --deploy`
# after the install, where deploy-main retries them before rolling back.
export SOURCE_VERIFY_PORTABLE=1

./deploy/scripts/check-secrets.sh

packages=(
  .
  packages/auth
  packages/storage
  packages/conversations
  packages/scheduler
  packages/task-registry
  packages/repair-ledger
  packages/automations
  packages/memory
  packages/capabilities
  packages/mcp
  packages/tasks
  channels/slack
  channels/email
  channels/phone
  channels/webhooks
  channels/chat-console
  projects/fluffles-site
)

for package_dir in "${packages[@]}"; do
  npm ci --ignore-scripts --no-audit --no-fund --prefix "$package_dir"
done

if [[ "$mode" == "fast" ]]; then
  npm run build --prefix packages/auth
  npm run build --prefix packages/storage
  npm run build --prefix packages/conversations
  npm run build --prefix packages/scheduler
  npm run build --prefix packages/task-registry
  npm run build --prefix packages/repair-ledger
  npm run build --prefix packages/tasks
  npm run build
  npm run build --prefix channels/slack
  npm run build --prefix channels/email
  npm run build --prefix channels/phone
  npm run build --prefix channels/webhooks
  npm run build --prefix packages/automations
  npm run build --prefix packages/memory
  npm run build --prefix packages/capabilities
  npm run build --prefix packages/mcp
  npm run build --prefix channels/chat-console
  npm run check --prefix projects/fluffles-site
  echo "source verification passed (fast: builds only, test suites skipped)"
  exit 0
fi

npm test --prefix packages/auth
npm test --prefix packages/storage
npm test --prefix packages/conversations
npm test --prefix packages/scheduler
npm test --prefix packages/task-registry
npm test --prefix packages/repair-ledger
npm test --prefix packages/automations
npm test --prefix packages/memory
npm test --prefix packages/capabilities
npm test --prefix packages/mcp
npm test --prefix packages/tasks
npm test
npm test --prefix channels/slack
npm test --prefix channels/email
npm test --prefix channels/phone
npm test --prefix channels/webhooks
npm test --prefix channels/chat-console
npm run check --prefix projects/fluffles-site

echo "source verification passed"
