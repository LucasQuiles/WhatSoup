#!/usr/bin/env bash
set -euo pipefail

VITEST_BIN="${VITEST_BIN:-./node_modules/.bin/vitest}"
if [ ! -x "$VITEST_BIN" ]; then
  echo "coverage check: missing $VITEST_BIN; run npm ci" >&2
  exit 2
fi

npm run strip-types-compat
"$VITEST_BIN" run --coverage "$@"
npm --prefix console run coverage:check -- --strict
