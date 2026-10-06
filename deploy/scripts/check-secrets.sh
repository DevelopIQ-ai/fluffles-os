#!/usr/bin/env bash
set -euo pipefail

# Which harness this is comes from the account the wrapper runs as, so the
# same file serves production and the dev harness.
home="${FLUFFLES_HOME:-${HOME:?HOME must be set}}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${repo_root}"

blocked_roots=(
  './Library'
  './.codex'
  './.amalgm'
  './node_modules'
  './.vercel'
)

for blocked in "${blocked_roots[@]}"; do
  if find . -path "${blocked}" -o -path "${blocked}/*" | grep -q .; then
    echo "blocked runtime path found: ${blocked}" >&2
    exit 1
  fi
done

is_forbidden_file() {
  local path="$1"
  case "$path" in
    ./.git/*|./package-lock.json|*/.gitkeep|*.env.example|*webhooks.env.example)
      return 1
      ;;
    ./auth/*)
      return 0
      ;;
    ./browser/*|./state/browser/profiles/*/*|./state/browser/downloads/*|./state/browser/screenshots/*|./state/browser/scratch/*|./state/browser/tools/agent-browser/home/*)
      return 0
      ;;
    *.env|*.env.*|*.pem|*.key|*.p12|*.pfx|*id_rsa|*id_ed25519|*.sqlite|*.sqlite-*|*.sqlite3|*.sqlite3-*|*.db|*.db-*|*.jsonl|*.log)
      return 0
      ;;
    *token*|*Token*|*credential*|*Credential*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

while IFS= read -r path; do
  if is_forbidden_file "$path"; then
    echo "blocked secret/runtime file found: ${path#./}" >&2
    exit 1
  fi
# Installed dependency trees are never committed, and package names alone
# ("registry-auth-token") match the credential-shaped filename rules.
done < <(find . -type f -not -path './.git/*' -not -path '*/node_modules/*')

patterns=(
  'xox[baprs]-[A-Za-z0-9-]{20,}'
  'xapp-[A-Za-z0-9-]{20,}'
  'gh[opsu]_[A-Za-z0-9_]{30,}'
  'github_pat_[A-Za-z0-9_]{80,}'
  'AKIA[0-9A-Z]{16}'
  'AIza[0-9A-Za-z_-]{35}'
  '-----BEGIN (RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----'
)

resolve_ripgrep() {
  local candidate=""
  local version_output=""
  local first_line=""
  local codex_install_root="${CODEX_HOME:-${HOME}/.codex}"
  local candidates=()

  # Prefer the system tool selected by PATH. This keeps CI and ordinary Linux
  # or macOS development independent of Codex's bundled platform binary.
  if command -v rg >/dev/null 2>&1; then
    candidates+=("$(command -v rg)")
  fi
  candidates+=(
    /usr/bin/rg
    /usr/local/bin/rg
    /opt/homebrew/bin/rg
  )
  if [[ -d "${home}/homebrew/lib/node_modules/@openai/codex" ]]; then
    while IFS= read -r candidate; do
      candidates+=("$candidate")
    done < <(find "${home}/homebrew/lib/node_modules/@openai/codex" \
      -type f -name rg -perm -111 -path '*/codex-path/rg' -print 2>/dev/null)
  fi
  if [[ -d "$codex_install_root" ]]; then
    while IFS= read -r candidate; do
      candidates+=("$candidate")
    done < <(find "$codex_install_root" \
      -type f -name rg -perm -111 -path '*/codex-path/rg' -print 2>/dev/null)
  fi

  for candidate in "${candidates[@]}"; do
    [[ -x "$candidate" ]] || continue
    version_output="$("$candidate" --version 2>/dev/null)" || continue
    first_line="${version_output%%$'\n'*}"
    if [[ "$first_line" =~ ^ripgrep[[:space:]][0-9] ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

if [[ -n "${SECRET_SCAN_RIPGREP:-}" ]]; then
  if [[ ! -x "$SECRET_SCAN_RIPGREP" ]]; then
    echo "secret scanner tool failure: configured ripgrep is not executable" >&2
    exit 69
  fi
  configured_version="$("$SECRET_SCAN_RIPGREP" --version 2>/dev/null)" || {
    echo "secret scanner wrapper failure: configured executable is not ripgrep" >&2
    exit 69
  }
  configured_first_line="${configured_version%%$'\n'*}"
  if [[ ! "$configured_first_line" =~ ^ripgrep[[:space:]][0-9] ]]; then
    echo "secret scanner wrapper failure: configured executable is not ripgrep" >&2
    exit 69
  fi
  ripgrep_bin="$SECRET_SCAN_RIPGREP"
else
  ripgrep_bin="$(resolve_ripgrep)" || {
    echo "secret scanner tool failure: a compatible ripgrep executable is required" >&2
    exit 69
  }
fi

# Validate the exact option contract before trusting a clean scan. A command
# shim can report a ripgrep-looking version while rejecting real ripgrep flags.
probe_dir="$(mktemp -d "${TMPDIR:-/tmp}/secret-scan-probe.XXXXXX")" || exit 70
printf '%s\n' 'scanner capability probe' >"${probe_dir}/probe.txt"
if "$ripgrep_bin" --hidden --glob '!.git/' --glob '!package-lock.json' \
  --files-with-matches --regexp '__step3_scanner_capability_probe__' "$probe_dir" >/dev/null 2>&1; then
  probe_status=0
else
  probe_status=$?
fi
rm -rf "$probe_dir"
if [[ "$probe_status" -ne 1 ]]; then
  echo "secret scanner wrapper failure: ripgrep option contract is incompatible" >&2
  exit 69
fi

for pattern in "${patterns[@]}"; do
  match_file="$(mktemp "${TMPDIR:-/tmp}/secret-scan.XXXXXX")" || exit 70
  if "$ripgrep_bin" --hidden --glob '!.git/' --glob '!package-lock.json' \
    --files-with-matches --regexp "$pattern" . >"$match_file"; then
    while IFS= read -r matched_path; do
      printf 'possible secret matched in: %s\n' "${matched_path#./}" >&2
    done <"$match_file"
    rm -f "$match_file"
    echo "possible secret matched pattern: ${pattern}" >&2
    exit 1
  else
    scanner_status=$?
    rm -f "$match_file"
    if [[ "$scanner_status" -ne 1 ]]; then
      echo "secret scanner failure: ripgrep exited ${scanner_status}" >&2
      exit 70
    fi
  fi
done

echo "no high-confidence secrets found"
