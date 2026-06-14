# Reliability Estate Consolidation

Status: active ledger. Updated: 2026-06-14T19:17Z.

Purpose: keep merge, branch, worktree, sweep, and instruction-hierarchy cleanup evidence in one tracked place while the reliability runner stays active.

## Current Live Queue

- GitHub PR queue is volatile; re-run `gh pr list --state open` before merge or cleanup. Latest read at 2026-06-14T19:17Z showed no open PRs.
- Latest merged PR: #846, merge commit `96d4181a`, head `81166160d93e9dc0dc6e4d1cb9883799484c9b7b`, with exact-head local `verify:release` under pinned Node 24 plus CodeQL and Quality Node 24/25 checks successful.
- Open GitHub issue: #640, `Prevent ignored canonical docs from disappearing from work-index coverage`; do not close or comment without explicit operator approval.
- `test/session-classifier-pid-coverage-20260614` was merged through PR #843 and then pruned locally and remotely after `git cherry -v origin/main test/session-classifier-pid-coverage-20260614` returned empty.
- `test/fleet-silence-route-coverage-20260614` was merged through PR #844 and then pruned locally and remotely after `git merge-base --is-ancestor test/fleet-silence-route-coverage-20260614 origin/main` succeeded and `git cherry -v origin/main test/fleet-silence-route-coverage-20260614` returned empty.
- `test/main-bootstrap-coverage-20260614` was merged through PR #846 and then pruned locally and remotely after `git merge-base --is-ancestor test/main-bootstrap-coverage-20260614 origin/main` succeeded and `git cherry -v origin/main test/main-bootstrap-coverage-20260614` returned empty.

## Artifact And Feature Sweep

- `npm run guard:work-index`: clean.
- `docs/work-index.md`: 188 entries, 13 unknown-status rows, 38 pending rows, 0 inconsistencies.
- Artifact sweep dry-run `20260614T074934Z`: 1939 matched artifacts, 1346 report-only residuals, 1297 low-confidence artifacts, 0 swept.
- Broad artifact-sweep apply mode is deferred: the dry-run marks canonical tracked docs under `docs/specs` and `docs/superpowers` as `would-sweep`, so cleanup needs a narrow allowlist rather than a whole-manifest archive/delete pass.
- No new sweep run was created for the 18:29Z refresh. Existing ignored `.sweep/` run directories are local evidence cache only; tracked runner docs remain the canonical source.

## Instruction Hierarchy

Instruction audit summary at 2026-06-14T18:31Z: all configured root-router references resolved for the checked machine/global and project surfaces. No instruction files were edited in this pass.

## Branch And Worktree Hygiene

- Remote-tracking refs were refreshed with `git fetch --prune origin`.
- Do not delete branches with nonzero `git cherry -v origin/main <branch>` output.
- Do not remove worktrees with dirty or staged files, even when branch history is already reachable from `origin/main`.
- Current classifier at 2026-06-14T19:17Z: the primary checkout is detached at `origin/main` because local `main` is owned by a peer worktree; many other worktrees are clean and `git cherry -v origin/main <branch>` returns empty, but their histories are not direct ancestors because the work appears patch-equivalent or superseded through other merges.
- Broad worktree/branch deletion is deferred while peer-agent Claude shells are present in this checkout. Do not prune shared worktrees solely from cherry-empty evidence unless the owning process is clear or the operator explicitly approves the batch.

## Closure Gates

- Public docs must point to tracked ledgers, not ignored `.codex` artifacts or local-only chat summaries.
- Any branch/worktree removal requires clean worktree state plus `git cherry -v` or `git range-diff` evidence recorded in this ledger or a successor.
- Any artifact deletion requires a backup or archived copy, a replacement canonical path, and a reason that distinguishes historical evidence from active work.
- Ledger validation: `npm run guard:work-index`, `bash ~/.claude/scripts/verify-instruction-hierarchy.sh --strict`, and `npm run verify:push:branch` passed after dependency setup; branch gate result was 17 files passed, 252 tests passed, 1 file skipped, 10 tests skipped.
