#!/usr/bin/env bash
set -euo pipefail
PATTERN='constructor\s*\([^)]*\b(private|public|protected|readonly)\s'
DIRS=(src/ deploy/)
matches=$(grep -rn --include='*.ts' -E "$PATTERN" "${DIRS[@]}" 2>/dev/null || true)
if [ -n "$matches" ]; then
  echo "ERROR: TypeScript parameter properties detected (incompatible with --experimental-strip-types):"
  echo ""
  echo "$matches"
  echo ""
  echo "Fix: expand to explicit field declarations + constructor assignments."
  exit 1
fi
