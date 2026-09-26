# 2026-09-25 Release Activation and Batch Catch-up Closure

## Public surface additions

- `npm run release:activate` switches a macOS launchd instance to an exported
  release as one coordinated operation: the wrapper symlink, the instance plist,
  and any auxiliary job plists re-rendered from inside the new release
  (`--aux-label <label>=setup-timer|release-drift`).
  - `--plan` (the default) is read-only. It prints the preconditions, staged
    plists and ordered actions as JSON.
  - `--apply` backs up the database with quick_check, then the wrapper symlink
    and plists. It switches, reloads each label, and verifies from the executing
    process: a new pid, argv naming the new release's `src/bootstrap.ts`, and
    authenticated health reporting the manifest commit with a connected session.
    Any failure triggers an automatic rollback, which is verified the same way.
  - Exit codes: `0` ok, `1` rolled back, `2` refused before any live change, `3`
    rollback unverified.
  - Other platforms are refused. See `docs/runbooks/release-deployment.md`.
- `npm run close-recovery-catchups` closes every caught-up operator catch-up
  recovery group in one pass.
  - Groups are selected with the automatic reconciler's rule and closed through
    the existing single-group closure primitive, recording the operator's
    `--actor` and `--evidence-ref`.
  - It runs as a dry run by default. `--confirm` requires `--backup-dir` and
    takes a quick_check-verified backup before the first write.
  - Output is redacted JSON with keyed fingerprints. See `docs/runbook.md`.

## Behavioral changes

- The reconciler's candidate selection is now the exported
  `selectOperatorCatchupCandidates`. `reconcileOperatorCatchupRecoveries` keeps
  the same ordering, budgets, closures and skip reasons.
- `src/fleet/platform.ts` exports its transient-bootstrap classifier and retry
  bounds, so release activation retries the same error class the same way.
