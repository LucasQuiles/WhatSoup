# Suspend and Platform Hardening Implementation Report

## Status

DONE

Baseline: `bd2ebbef51d4df21a74cbf52c4450781e90e944b`

Final base after the requested rebase:
`f372f69ff96c416b3aa8576593a89c8f3722cd41`

## Implemented

- Replaced separate timer/provisional snapshot handling with one synchronous
  monotonic observation transition.
- Preserved the existing full-window nearest-rank p95 rule and strict
  `p95 > 250 ms` starvation boundary.
- Retained an exactly 10-second lag sample without assuming one outlier makes
  p95 starved.
- Classified only gaps above 10 seconds as discontinuities, resetting the
  retained window without retaining the gap.
- Added timer-first/snapshot-first single consumption and a saturating,
  process-lifetime discontinuity counter.
- Published `event_loop.discontinuity_count`.
- Rate-limited only producer-health warning logs: immediate entry, five-minute
  monotonic repeat, immediate re-entry after recovery.
- Added generated launchd `WorkingDirectory` from the module-derived repository
  root.
- Added trimmed non-empty `WHATSOUP_REPO_ROOT` precedence without fallback from
  an invalid explicit root.
- Added the schema-v1 private-operation-record validator and read-only
  `validate-private-operation-record` CLI with closed registries, safe
  descriptor-based file reads, canonical private-state directory binding,
  pre/post-open mode and ownership re-attestation, exact private
  modes/ownership, constrained structured-evidence keys, content-free errors,
  one-object JSON output, and exit `0/1/2`.
- Updated configuration, public-surface, operational, macOS launchd, release,
  and work-index documentation.

## TDD Evidence

### Cycle 1: sampler and health

- RED:
  `npm test -- tests/fleet/probe-liveness-escalation.test.ts tests/core/health.test.ts --pool=forks --fileParallelism=false --retry=0`
  exited 1 with 14 expected failures for the missing discontinuity state,
  reset/single-consumption behavior, health field, and warning gate.
- GREEN: the same two suites passed 166 tests; source typecheck passed.

### Cycle 2: launchd and ARC

- RED:
  `npm test -- tests/fleet/platform.test.ts tests/core/arc-binding-health.test.ts tests/fleet/probe-liveness-escalation.test.ts --pool=forks --fileParallelism=false --retry=0`
  exited 1 with four expected failures for missing `WorkingDirectory` and ARC
  root resolution.
- GREEN: the combined sampler/health/platform/ARC set passed 200 tests. An
  initial source typecheck exposed a too-narrow environment parameter type;
  after correction, tests and typecheck passed.

### Cycle 3: private operation record

- RED: the validator/CLI suites first failed because the two modules did not
  exist. Later RED subcycles proved missing chronology/duplicate-target/schema
  constraints and a nested forbidden-field JSON-path leak.
- GREEN: 12 validator/CLI tests passed with source and scripts typechecks.

### Security gap cycle

- RED: three focused failures proved the validator accepted a record outside
  the canonical private-state directory, did not re-attest modes after opening,
  and accepted a phone-shaped evidence key.
- GREEN: 15 validator/CLI tests passed after canonical-directory binding,
  descriptor/directory post-open re-attestation, and content-free evidence-key
  constraints.
- A follow-up RED proved phone-shaped `target_ids` and incomplete published
  evidence-key schemas; GREEN rejects full phone-like targets while preserving
  short numeric quarantine row IDs and publishes the same key constraints used
  by runtime validation.

## Requested Review Passes

- Verify: fresh focused suites and all three TypeScript configurations passed.
- Gap analysis: tightened timestamp ordering, duplicate target rejection,
  structured evidence schema, and nested forbidden-field redaction.
- Hypothesis-driven falsification: exact boundary, timer/snapshot ordering,
  suspend-sized poller behavior, continuous warning/re-entry behavior, invalid
  ARC-root no-fallback, CLI exit taxonomy, and content-free diagnostics.
- Deduplication: reused `scripts/lib/cli-args.ts#takeValue`, the existing
  module-derived fleet `repoRoot`, and one sampler observation transition.
- Simplification/fitness: import-cycle, ring-boundary, SSOT, baseline-growth,
  and lint-fitness checks passed. Lint reported 202 pre-existing warnings and
  zero errors; ratcheted architecture counts remained at baseline.

## Final Verification Before Commit

- Focused tests: 6 files, 216 tests passed.
- `npm run typecheck -- --pretty false`: passed.
- `npm run typecheck:all -- --pretty false`: passed.
- `npm run typecheck:scripts -- --pretty false`: passed.
- Public-surface, documentation drift, work-index, publication, import-cycle,
  ring-boundary, SSOT, baseline-growth, Node-pin, and repo branch-diff guards:
  passed.
- `npm run guard:lint:src`: passed with 202 existing warnings, 0 errors.
- `git diff --check`: passed.

## Post-Rebase Verification

After rebasing onto `origin/main` at
`f372f69ff96c416b3aa8576593a89c8f3722cd41`:

- The same six focused files passed all 216 tests.
- Source, test, and scripts TypeScript configurations passed.
- Public-surface, documentation drift, work-index, publication, import-cycle,
  ring-boundary, SSOT, baseline-growth, Node-pin, and repo branch-diff guards
  passed.
- Baseline-growth compared against the rebased main commit and held or shrank
  all seven baselines.
- The worktree was clean before this report-only closeout update.

## Concerns

- No host remediation, secret migration, launchd reload, push, PR, or other
  external mutation was performed.
- The full repository test suite was not part of this bounded lane; the focused
  suites and all TypeScript configurations are the fresh evidence recorded
  above.
