#!/usr/bin/env bash
set -euo pipefail

VITEST_BIN="${VITEST_BIN:-./node_modules/.bin/vitest}"
if [ ! -x "$VITEST_BIN" ]; then
  echo "coverage check: missing $VITEST_BIN; run npm ci" >&2
  exit 2
fi

npm run strip-types-compat
# Round-18 finding 4: run the full coverage suite through the bounded battery runner so a
# synchronous fixture that wedges a worker (the round-16 72-minute `git hash-object` hang)
# converts into a truthful, bounded non-zero exit instead of silently stalling this gate.
# The runner forwards `--coverage` (and push-gate's `--pool=forks --fileParallelism=false`)
# to vitest and propagates its real exit code.
bash scripts/run-with-pinned-node.sh scripts/full-suite-battery.ts --coverage "$@"
npm --prefix console run coverage:check -- --strict
