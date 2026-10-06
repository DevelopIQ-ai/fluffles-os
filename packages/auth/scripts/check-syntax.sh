#!/usr/bin/env bash
# Build gate for a package of executables: every script must parse in the
# interpreter its shebang names.
set -euo pipefail

package_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

for script in "$package_root"/bin/*; do
  [ -f "$script" ] || continue
  shebang="$(head -n 1 "$script")"
  case "$shebang" in
    "#!/bin/sh")           sh -n "$script" ;;
    "#!/usr/bin/env bash") bash -n "$script" ;;
    "#!/bin/bash")         bash -n "$script" ;;
    "#!/usr/bin/perl")     perl -c "$script" >/dev/null 2>&1 || { perl -c "$script"; exit 1; } ;;
    "#!/usr/bin/python3")  python3 -c "import ast,sys; ast.parse(open(sys.argv[1]).read())" "$script" ;;
    *)
      echo "check-syntax: unknown interpreter for ${script}: ${shebang}" >&2
      exit 1
      ;;
  esac
done

for spec in "$package_root"/bin/materialize.d/*; do
  [ -f "$spec" ] || continue
  sh -n "$spec"
done

echo "auth package syntax checks passed"
