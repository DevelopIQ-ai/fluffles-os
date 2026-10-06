#!/usr/bin/env bash
set -euo pipefail

# Which harness this is comes from the account the wrapper runs as, so the
# same file serves production and the dev harness.
home="${FLUFFLES_HOME:-${HOME:?HOME must be set}}"

VERCEL_CLI="${VERCEL_CLI:-${home}/bin/vercel}"
NODE="${NODE:-${home}/homebrew/bin/node}"
VERCEL_SYNC_STATE_DIR="${VERCEL_SYNC_STATE_DIR:-${home}/state/vercel-sync}"
max_reconciliation_rounds=3
operation_timeout_seconds=30

required=(
  EMAIL_PUBSUB_PUSH_TOKEN
  AMALGM_EVENTS_URL
  AMALGM_EMAIL_INBOUND_SECRET
)

run_with_timeout() {
  /usr/bin/perl -e '
    my ($timeout, @command) = @ARGV;
    my $pid = fork();
    die "fork failed: $!\n" unless defined $pid;
    if ($pid == 0) {
      setpgrp(0, 0) or exit 127;
      exec @command or exit 127;
    }
    my $timed_out = 0;
    local $SIG{ALRM} = sub {
      $timed_out = 1;
      kill "TERM", -$pid;
      select undef, undef, undef, 1;
      kill "KILL", -$pid;
    };
    alarm $timeout;
    while (waitpid($pid, 0) == -1 && $!{EINTR}) {}
    my $status = $?;
    alarm 0;
    exit 124 if $timed_out;
    exit 127 if $status == -1;
    exit($status >> 8) if ($status & 127) == 0;
    exit(128 + ($status & 127));
  ' "$operation_timeout_seconds" "$@"
}

vercel_cli() {
  run_with_timeout env \
    -u SLACK_BOT_TOKEN \
    -u SLACK_APP_TOKEN \
    -u SLACK_ALLOWED_CHANNELS \
    -u SLACK_AMBIENT_CHANNELS \
    -u PHONE_EXECUTOR_MCP_AUTHORIZATION \
    -u EMAIL_PUBSUB_PUSH_TOKEN \
    -u AMALGM_EVENTS_URL \
    -u AMALGM_EMAIL_INBOUND_SECRET \
    "$VERCEL_CLI" "$@"
}

for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    echo "missing Infisical runtime value: ${key}" >&2
    exit 78
  fi
done

export STEP3_EXPECTED_EMAIL_PUBSUB_PUSH_TOKEN_SHA256="$(
  printf '%s' "$EMAIL_PUBSUB_PUSH_TOKEN" | shasum -a 256 | awk '{print $1}'
)"
export STEP3_EXPECTED_AMALGM_EVENTS_URL_SHA256="$(
  printf '%s' "$AMALGM_EVENTS_URL" | shasum -a 256 | awk '{print $1}'
)"
export STEP3_EXPECTED_AMALGM_EMAIL_INBOUND_SECRET_SHA256="$(
  printf '%s' "$AMALGM_EMAIL_INBOUND_SECRET" | shasum -a 256 | awk '{print $1}'
)"

file_owner_mode() {
  if stat -f '%u:%Lp' "$1" >/dev/null 2>&1; then
    stat -f '%u:%Lp' "$1"
  else
    stat -c '%u:%a' "$1"
  fi
}

if [[ -e "$VERCEL_SYNC_STATE_DIR" ]] && { [[ ! -d "$VERCEL_SYNC_STATE_DIR" ]] || [[ -L "$VERCEL_SYNC_STATE_DIR" ]]; }; then
  echo "Vercel synchronization state path is unsafe" >&2
  exit 78
fi
mkdir -p -m 700 "$VERCEL_SYNC_STATE_DIR" || exit 70
chmod 700 "$VERCEL_SYNC_STATE_DIR" || exit 70
if [[ "$(file_owner_mode "$VERCEL_SYNC_STATE_DIR")" != "$(id -u):700" ]]; then
  echo "Vercel synchronization state must be owned by the service user with mode 700" >&2
  exit 78
fi

transaction_file="${VERCEL_SYNC_STATE_DIR}/pending.json"
"$NODE" - "$transaction_file" <<'NODE'
const fs = require("node:fs");
const destination = process.argv[2];
for (const entry of fs.readdirSync(require("node:path").dirname(destination))) {
  if (entry.startsWith("pending.json.pending.")) {
    const stale = require("node:path").join(require("node:path").dirname(destination), entry);
    const stat = fs.lstatSync(stale);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid()) process.exit(78);
    fs.unlinkSync(stale);
  }
}
const pending = `${destination}.pending.${process.pid}`;
const value = {
  version: 1,
  state: "reconciling",
  keys: ["EMAIL_PUBSUB_PUSH_TOKEN", "AMALGM_EVENTS_URL", "AMALGM_EMAIL_INBOUND_SECRET"]
};
const descriptor = fs.openSync(
  pending,
  fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
  0o600
);
try {
  fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
  fs.fsyncSync(descriptor);
} finally {
  fs.closeSync(descriptor);
}
fs.renameSync(pending, destination);
const directory = fs.openSync(require("node:path").dirname(destination), fs.constants.O_RDONLY);
try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
NODE

expected_hash() {
  case "$1" in
    EMAIL_PUBSUB_PUSH_TOKEN) printf '%s' "$STEP3_EXPECTED_EMAIL_PUBSUB_PUSH_TOKEN_SHA256" ;;
    AMALGM_EVENTS_URL) printf '%s' "$STEP3_EXPECTED_AMALGM_EVENTS_URL_SHA256" ;;
    AMALGM_EMAIL_INBOUND_SECRET) printf '%s' "$STEP3_EXPECTED_AMALGM_EMAIL_INBOUND_SECRET_SHA256" ;;
    *) return 64 ;;
  esac
}

verify_key() {
  local key="$1"
  local expected="$2"
  STEP3_VALUE_NAME="$key" STEP3_EXPECTED_VALUE_SHA256="$expected" \
    vercel_cli env run --environment=production -- "$NODE" -e '
      const crypto = require("node:crypto");
      const value = process.env[process.env.STEP3_VALUE_NAME];
      const expected = process.env.STEP3_EXPECTED_VALUE_SHA256;
      if (!value || !expected) process.exit(78);
      const actual = crypto.createHash("sha256").update(value).digest("hex");
      if (actual !== expected) process.exit(1);
    ' >/dev/null
}

round=1
while true; do
  round_failed=0
  for key in "${required[@]}"; do
    if printf '%s' "${!key}" \
      | vercel_cli env update "$key" production --sensitive --yes >/dev/null; then
      :
    else
      status=$?
      printf '{"ok":false,"component":"vercel-env-sync","event":"update-failed","key":"%s","attempt":%d,"status":%d}\n' \
        "$key" "$round" "$status" >&2
      round_failed=1
      continue
    fi
    if verify_key "$key" "$(expected_hash "$key")"; then
      :
    else
      status=$?
      printf '{"ok":false,"component":"vercel-env-sync","event":"verification-failed","key":"%s","attempt":%d,"status":%d}\n' \
        "$key" "$round" "$status" >&2
      round_failed=1
    fi
  done
  if [[ "$round_failed" -eq 0 ]]; then break; fi
  if [[ "$round" -ge "$max_reconciliation_rounds" ]]; then
    printf '%s\n' '{"ok":false,"component":"vercel-env-sync","event":"reconciliation-failed","action":"pending-metadata-retained"}' >&2
    exit 75
  fi
  sleep "$round"
  round=$((round + 1))
done

unset EMAIL_PUBSUB_PUSH_TOKEN AMALGM_EVENTS_URL AMALGM_EMAIL_INBOUND_SECRET

vercel_cli env run --environment=production -- "$NODE" -e '
  const crypto = require("node:crypto");
  const pairs = [
    ["EMAIL_PUBSUB_PUSH_TOKEN", "STEP3_EXPECTED_EMAIL_PUBSUB_PUSH_TOKEN_SHA256"],
    ["AMALGM_EVENTS_URL", "STEP3_EXPECTED_AMALGM_EVENTS_URL_SHA256"],
    ["AMALGM_EMAIL_INBOUND_SECRET", "STEP3_EXPECTED_AMALGM_EMAIL_INBOUND_SECRET_SHA256"]
  ];
  for (const [valueName, hashName] of pairs) {
    const value = process.env[valueName];
    const expected = process.env[hashName];
    if (!value || !expected) process.exit(78);
    const actual = crypto.createHash("sha256").update(value).digest("hex");
    if (actual !== expected) process.exit(1);
  }
' >/dev/null

unset STEP3_EXPECTED_EMAIL_PUBSUB_PUSH_TOKEN_SHA256
unset STEP3_EXPECTED_AMALGM_EVENTS_URL_SHA256
unset STEP3_EXPECTED_AMALGM_EMAIL_INBOUND_SECRET_SHA256

rm -f "$transaction_file" || exit 70
"$NODE" - "$VERCEL_SYNC_STATE_DIR" <<'NODE'
const fs = require("node:fs");
const descriptor = fs.openSync(process.argv[2], fs.constants.O_RDONLY);
try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
NODE

echo "Vercel production environment matches Infisical"
