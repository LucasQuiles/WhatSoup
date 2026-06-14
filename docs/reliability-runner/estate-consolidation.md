# Reliability Estate Consolidation

Status: active ledger. Updated: 2026-06-14T20:34Z.

Purpose: keep merge, branch, worktree, sweep, and instruction-hierarchy cleanup evidence in one tracked place while the reliability runner stays active.

## Current Live Queue

- GitHub PR queue is volatile; re-run `gh pr list --state open` before merge or cleanup. Latest read at 2026-06-14T20:30Z showed no open PRs after PR #850 merged.
- Audited docs/merge hygiene checkpoints: PR #848 merged as `2954b695`; PR #849 merged as `35b18970`; PR #850 merged as `470e768b` and records the post-849 hygiene ledger.
- Open GitHub issue: #640, `Prevent ignored canonical docs from disappearing from work-index coverage`; do not close or comment without explicit operator approval.
- `test/session-classifier-pid-coverage-20260614` was merged through PR #843 and then pruned locally and remotely after `git cherry -v origin/main test/session-classifier-pid-coverage-20260614` returned empty.
- `test/fleet-silence-route-coverage-20260614` was merged through PR #844 and then pruned locally and remotely after `git merge-base --is-ancestor test/fleet-silence-route-coverage-20260614 origin/main` succeeded and `git cherry -v origin/main test/fleet-silence-route-coverage-20260614` returned empty.
- `test/main-bootstrap-coverage-20260614` was merged through PR #846 and then pruned locally and remotely after `git merge-base --is-ancestor test/main-bootstrap-coverage-20260614 origin/main` succeeded and `git cherry -v origin/main test/main-bootstrap-coverage-20260614` returned empty.
- `docs/estate-ledger-refresh-20260614-main-bootstrap` was merged through PR #847 and then pruned locally and remotely after `git merge-base --is-ancestor docs/estate-ledger-refresh-20260614-main-bootstrap origin/main` succeeded and `git cherry -v origin/main docs/estate-ledger-refresh-20260614-main-bootstrap` returned empty.
- `chore/estate-hygiene-sweep-20260614` was merged through PR #848 and then pruned locally and remotely after `git merge-base --is-ancestor chore/estate-hygiene-sweep-20260614 origin/main` succeeded and `git cherry -v origin/main chore/estate-hygiene-sweep-20260614` returned empty.
- `test/feed-card-coverage-20260614` had no commits ahead of `origin/main`; `git diff --stat origin/main...HEAD`, `git cherry -v origin/main HEAD`, and `git range-diff origin/main origin/main HEAD` produced no change output, so the empty local branch was deleted.
- `test/mock-data-coverage-20260614` had no commits ahead of `origin/main`; `git merge-base --is-ancestor test/mock-data-coverage-20260614 origin/main`, `git cherry -v origin/main test/mock-data-coverage-20260614`, and `git log --oneline origin/main..test/mock-data-coverage-20260614` produced no change output, so the empty local branch was deleted.

## Artifact And Feature Sweep

- `npm run guard:work-index`: clean.
- `docs/work-index.md`: 188 entries, 13 unknown-status rows, 38 pending rows, 0 inconsistencies.
- Artifact sweep dry-run `20260614T074934Z`: 1939 matched artifacts, 1346 report-only residuals, 1297 low-confidence artifacts, 0 swept.
- Artifact sweep dry-run `20260614T201234Z`: 1956 matched artifacts, 1339 report-only residuals, 1325 low-confidence artifacts, 0 swept.
- Artifact sweep dry-run `20260614T203303Z`: 1955 matched artifacts, 1341 report-only residuals, 1322 low-confidence artifacts, 0 swept.
- Broad artifact-sweep apply mode is deferred: the latest dry-run still marks canonical tracked docs under `docs/specs`, `docs/superpowers`, and closed SDLC evidence under `docs/sdlc` as `would-sweep`, so cleanup needs a narrow allowlist rather than a whole-manifest archive/delete pass.
- Ignored `.sweep/` cache was pruned reversibly: 109 older run directories were moved to the sweep-backup namespace `whatsoup-457b0e0360/ignored-cache-prune-20260614T193531Z`, the superseded `20260614T193531Z` run moved to `whatsoup-457b0e0360/ignored-cache-prune-20260614T201310Z`, and the older `20260614T074934Z` plus `20260614T201234Z` dry-runs moved to `whatsoup-457b0e0360/ignored-cache-prune-20260614T203418Z`. The repo keeps only `.sweep/20260614T203303Z` and `.sweep/superseded-local`.

## Instruction Hierarchy

Instruction audit summary at 2026-06-14T20:11Z: all configured root-router references resolved for the checked machine/global and project surfaces; every audited surface had 0 missing refs, 0 ambiguous refs, and 0 hardcoded-count hits. No instruction files were edited in this pass.

## Branch And Worktree Hygiene

- Remote-tracking refs were refreshed with `git fetch --prune origin`.
- Do not delete branches with nonzero `git cherry -v origin/main <branch>` output.
- Do not remove worktrees with dirty or staged files, even when branch history is already reachable from `origin/main`.
- Current classifier at 2026-06-14T20:34Z: primary checkout is on `docs/post-850-hygiene-ledger-20260614` from `origin/main` head `470e768b`; local `main` is owned by a peer worktree. Merged-local refs outside the current branch are attached to dirty peer worktrees or still have unclassified local state, so they are not deletion candidates.
- Clean/merged candidate check: `feat/systemd-unit-reconciliation` and merged `worktree-agent-*` refs remain checked out in peer worktrees; six of those checked worktrees have dirty or untracked files, and `worktree-agent-a95f0ed6926a574a0` is clean but still not merged into `origin/main`, so no peer worktree was removed.
- `git worktree prune --dry-run --verbose` and `git remote prune origin --dry-run` produced no output after fetch/prune and cache relocation.
- Broad worktree/branch deletion is deferred while peer-agent worktrees and nonzero cherry evidence remain. Do not prune shared worktrees solely from clean status or stale branch names unless the owning process is clear or the operator explicitly approves the batch.

## Closure Gates

- Public docs must point to tracked ledgers, not ignored `.codex` artifacts or local-only chat summaries.
- Any branch/worktree removal requires clean worktree state plus `git cherry -v` or `git range-diff` evidence recorded in this ledger or a successor.
- Any artifact deletion requires a backup or archived copy, a replacement canonical path, and a reason that distinguishes historical evidence from active work.
- Ledger validation: `npm run guard:work-index`, `bash ~/.claude/scripts/verify-instruction-hierarchy.sh --strict`, and `npm run verify:push:branch` passed after dependency setup; branch gate result was 17 files passed, 252 tests passed, 1 file skipped, 10 tests skipped.
