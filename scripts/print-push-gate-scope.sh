#!/usr/bin/env bash
# Scope statement for `verify:push:branch` — printed on success so a green is
# never read as more than it covers. Two axes of narrowness:
#
#   1. Coverage: this gate runs a guard subset + TypeScript checks + a targeted
#      test subset + console design/lint/build. The FULL vitest suite and
#      coverage thresholds are NOT evaluated here — CI runs those.
#   2. Surface: manual npm run verify:push:branch bypasses ref classification,
#      while the installed hook invokes pre-push-guard.ts. Branch updates run
#      this chain, main/tag updates run release verification, and delete-only
#      runs design metadata checks only.
#
# A green here means "the checked subset passed", not "ready to merge". History:
# a subset green was read as a full-suite pass (a console flake then failed CI),
# and a manual green was read as hook-covered (three extra checks were skipped).
set -eu
cat <<'SCOPE'

verify:push:branch scope — green covers ONLY the checked subset:
  coverage: guard subset + TypeScript checks + targeted test subset
            + console design/lint/build
            (full vitest suite + coverage thresholds NOT run here — CI does)
  surface:  manual npm run verify:push:branch bypasses ref classification;
            the installed hook invokes pre-push-guard.ts:
            branch -> this chain; main/tag -> release verification;
            delete-only runs design metadata checks only
SCOPE
