#!/usr/bin/env bash
# Scope statement for `verify:push:branch` — printed on success so a green is
# never read as more than it covers. Two axes of narrowness:
#
#   1. Coverage: this gate runs a guard subset + typecheck x3 + a ~40-file test
#      subset + console lint/build. The FULL vitest suite and coverage
#      thresholds are NOT evaluated here — the CI `quality` job runs those.
#   2. Surface: a MANUAL `npm run verify:push:branch` does NOT run
#      pre-push-guard.ts / design:metrics / design:burndown — the pre-push HOOK
#      adds those. So: manual green < hook green < CI green.
#
# A green here means "the checked subset passed", not "ready to merge". History:
# a subset green was read as a full-suite pass (a console flake then failed CI),
# and a manual green was read as hook-covered (three extra checks were skipped).
set -eu
cat <<'SCOPE'

verify:push:branch scope — green covers ONLY the checked subset:
  coverage: guard subset + typecheck x3 + ~40-file test subset + console lint/build
            (full vitest suite + coverage thresholds NOT run here — CI quality job does)
  surface:  manual run omits pre-push-guard.ts / design:metrics / design:burndown
            (the pre-push HOOK adds those) — manual green < hook green < CI green
SCOPE
