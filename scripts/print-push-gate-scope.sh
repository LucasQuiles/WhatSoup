#!/usr/bin/env bash
# Scope statement for the push gates, printed on success so a green is never
# read as more than it covers. Two axes of narrowness:
#
#   1. Coverage: `verify:push:branch` runs a guard subset + TypeScript checks + a
#      targeted test subset + console design/lint/build. The FULL vitest suite and
#      coverage thresholds are NOT evaluated here. CI runs those. `verify:push:fast`
#      runs only the disclosure checks.
#   2. Surface: manual npm run verify:push:branch bypasses ref classification,
#      while the installed hook invokes pre-push-guard.ts. Branch updates run
#      verify:push:fast, main/tag updates run release verification, an update with
#      no readable refs runs verify:push:branch, and delete-only runs design
#      metadata checks only.
#
# A green here means "the checked subset passed", not "ready to merge". History:
# a subset green was read as a full-suite pass (a console flake then failed CI),
# and a manual green was read as hook-covered (three extra checks were skipped).
set -eu
if [ "${1:-}" = "fast" ]; then
  cat <<'SCOPE'

verify:push:fast scope: green covers ONLY the disclosure checks:
  coverage: branch-diff repo hygiene + commit authors + publication audit table +
            private-literal scan of the lines this branch adds
            (tests, typecheck and console build NOT run here; the required hosted
            checks run them and block merge; npm run verify:push:branch runs the
            complete local gate)
SCOPE
  exit 0
fi
cat <<'SCOPE'

verify:push:branch scope: green covers ONLY the checked subset:
  coverage: guard subset + TypeScript checks + targeted test subset
            + console design/lint/build
            (full vitest suite + coverage thresholds NOT run here; CI does)
  surface:  manual npm run verify:push:branch bypasses ref classification;
            the installed hook invokes pre-push-guard.ts:
            branch -> verify:push:fast; main/tag -> release verification;
            no readable refs -> this chain;
            delete-only runs design metadata checks only
SCOPE
