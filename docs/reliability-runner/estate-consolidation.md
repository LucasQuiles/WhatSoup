# Reliability Estate Consolidation

Status: active ledger. Updated: 2026-06-14T23:02Z.

Purpose: keep merge, branch, worktree, sweep, and instruction-hierarchy cleanup evidence in one tracked place while the reliability runner stays active.

## Current Live Queue

- GitHub PR queue is volatile; re-run `gh pr list --state open` before merge or cleanup. Recorded checkpoint at 2026-06-14T22:58Z showed no open PRs after PR #857 merged.
- Audited docs/merge hygiene checkpoints: PR #848 merged as `2954b695`; PR #849 merged as `35b18970`; PR #850 merged as `470e768b`; PR #851 merged as `cb1bedad`; PR #852 merged as `556919e4` and records the mock-data coverage slice; PR #853 merged as `37ab6f7b`; PR #854 merged as `1f6bcb91`; PR #855 merged as `1c07f8ef` and records the GroupDetailModal coverage slice; PR #856 merged as `2327667a` and records post-#855 hygiene state; PR #857 merged as `c947d639` and records post-#856 hygiene state.
- Open GitHub issue: #640, `Prevent ignored canonical docs from disappearing from work-index coverage`; do not close or comment without explicit operator approval.
- `test/session-classifier-pid-coverage-20260614` was merged through PR #843 and then pruned locally and remotely after `git cherry -v origin/main test/session-classifier-pid-coverage-20260614` returned empty.
- `test/fleet-silence-route-coverage-20260614` was merged through PR #844 and then pruned locally and remotely after `git merge-base --is-ancestor test/fleet-silence-route-coverage-20260614 origin/main` succeeded and `git cherry -v origin/main test/fleet-silence-route-coverage-20260614` returned empty.
- `test/main-bootstrap-coverage-20260614` was merged through PR #846 and then pruned locally and remotely after `git merge-base --is-ancestor test/main-bootstrap-coverage-20260614 origin/main` succeeded and `git cherry -v origin/main test/main-bootstrap-coverage-20260614` returned empty.
- `docs/estate-ledger-refresh-20260614-main-bootstrap` was merged through PR #847 and then pruned locally and remotely after `git merge-base --is-ancestor docs/estate-ledger-refresh-20260614-main-bootstrap origin/main` succeeded and `git cherry -v origin/main docs/estate-ledger-refresh-20260614-main-bootstrap` returned empty.
- `chore/estate-hygiene-sweep-20260614` was merged through PR #848 and then pruned locally and remotely after `git merge-base --is-ancestor chore/estate-hygiene-sweep-20260614 origin/main` succeeded and `git cherry -v origin/main chore/estate-hygiene-sweep-20260614` returned empty.
- `test/feed-card-coverage-20260614` had no commits ahead of `origin/main`; `git diff --stat origin/main...HEAD`, `git cherry -v origin/main HEAD`, and `git range-diff origin/main origin/main HEAD` produced no change output, so the empty local branch was deleted.
- `test/mock-data-coverage-20260614` had no commits ahead of `origin/main`; `git merge-base --is-ancestor test/mock-data-coverage-20260614 origin/main`, `git cherry -v origin/main test/mock-data-coverage-20260614`, and `git log --oneline origin/main..test/mock-data-coverage-20260614` produced no change output, so the empty local branch was deleted.
- `test/mock-data-coverage-20260614b` was merged through PR #852 and then pruned locally and remotely after `git merge-base --is-ancestor test/mock-data-coverage-20260614b origin/main` succeeded, `git cherry -v origin/main test/mock-data-coverage-20260614b` returned empty, and `git range-diff origin/main~2..origin/main test/mock-data-coverage-20260614b~1..test/mock-data-coverage-20260614b` showed the PR commit identical on main. The isolated review worktree `.worktrees/pr-852` was clean and removed with `git worktree remove`.
- `docs/post-852-hygiene-ledger-20260614` was merged through PR #853 and pruned locally/remotely before this pass.
- `docs/post-853-hygiene-ledger-20260614` was merged through PR #854 and pruned locally/remotely before this pass.
- `test/group-detail-modal-coverage-20260614` was merged through PR #855 and then pruned locally and remotely after `git merge-base --is-ancestor test/group-detail-modal-coverage-20260614 origin/main` succeeded, `git cherry -v origin/main test/group-detail-modal-coverage-20260614` returned empty, and `git range-diff origin/main^2~1..origin/main^2 test/group-detail-modal-coverage-20260614~1..test/group-detail-modal-coverage-20260614` showed the PR commit identical on main.

## Artifact And Feature Sweep

- `npm run guard:work-index`: clean.
- `docs/work-index.md`: 188 entries, 13 unknown-status rows, 38 pending rows, 0 inconsistencies.
- Artifact sweep dry-run `20260614T074934Z`: 1939 matched artifacts, 1346 report-only residuals, 1297 low-confidence artifacts, 0 swept.
- Artifact sweep dry-run `20260614T201234Z`: 1956 matched artifacts, 1339 report-only residuals, 1325 low-confidence artifacts, 0 swept.
- Artifact sweep dry-run `20260614T203303Z`: 1955 matched artifacts, 1341 report-only residuals, 1322 low-confidence artifacts, 0 swept.
- Artifact sweep dry-run `20260614T213735Z`: 1950 matched artifacts, 1355 report-only residuals, 1322 low-confidence artifacts, 0 swept.
- Artifact sweep dry-run `20260614-coverage-hygiene`: 1954 matched artifacts, 1356 report-only residuals, 1325 low-confidence artifacts, 0 swept.
- Artifact sweep dry-run `20260614T224223Z`: 1956 matched artifacts, 1354 report-only residuals, 1331 low-confidence artifacts, 0 swept.
- Broad artifact-sweep apply mode is deferred: the latest dry-run still marks canonical tracked docs under `docs/specs`, `docs/superpowers`, and closed SDLC evidence under `docs/sdlc` as `would-sweep`, so cleanup needs a narrow allowlist rather than a whole-manifest archive/delete pass.
- Ignored `.sweep/` cache was pruned reversibly: 109 older run directories were moved to the sweep-backup namespace `whatsoup-457b0e0360/ignored-cache-prune-20260614T193531Z`, the superseded `20260614T193531Z` run moved to `whatsoup-457b0e0360/ignored-cache-prune-20260614T201310Z`, the older `20260614T074934Z` plus `20260614T201234Z` dry-runs moved to `whatsoup-457b0e0360/ignored-cache-prune-20260614T203418Z`, `20260614T203303Z` moved to `whatsoup-457b0e0360/ignored-cache-prune-20260614T214000Z`, and `20260614-coverage-hygiene` plus `20260614T213735Z` moved to `whatsoup-457b0e0360/ignored-cache-prune-20260614T224600Z`. The repo keeps only `.sweep/20260614T224223Z` and `.sweep/superseded-local`.
- Coverage slice validation: `tests/console/mock-data.test.ts` passed 11/11, Test Integrity reported no findings, focused coverage for `console/src/mock-data.ts` is statements 100%, branches 99%, functions 100%, lines 100%, branch `npm run coverage:check` passed with 596 files passed, 2 skipped files, 9713 tests passed, 11 skipped tests, and isolated Node 24 `npm run verify:release` passed with 597 files passed, 1 skipped file, 9723 tests passed, 1 skipped test, aggregate coverage at statements 84.46%, branches 77.84%, functions 82.86%, lines 86.12%, and console production build complete.
- Merged #855 coverage slice validation: `tests/console/group-detail-modal.test.tsx` passed 16/16; adjacent console group/modal tests passed 63/63; Test Integrity reported no findings; focused coverage for `console/src/components/line-detail/GroupDetailModal.tsx` is statements 90.86%, branches 82.46%, functions 87.5%, lines 93.19%; branch `npm run coverage:check` passed with 597 files passed, 2 skipped files, 9729 tests passed, 11 skipped tests, and aggregate coverage at statements 85.15%, branches 78.47%, functions 84.14%, lines 86.84%. Exact-head Node 24 `npm run verify:release` passed with guard package 43 files / 424 tests, repo suite 598 files passed / 1 skipped and 9739 tests passed / 1 skipped, aggregate coverage unchanged at statements 85.15%, branches 78.47%, functions 84.14%, lines 86.84%, and console production build complete.
- Initial unpinned `npm run verify:release` for #855 failed in `tools/whatsoup_guard` because PATH resolved Node 26 for nested npm install while the package requires Node `<26`; that failed run is recorded as environment evidence only and was not used as clean merge evidence.

## Instruction Hierarchy

Instruction audit summary at 2026-06-14T22:42Z: all configured root-router references resolved for the checked machine/global and project surfaces; every audited surface had 0 missing refs, 0 ambiguous refs, and 0 hardcoded-count hits. Strict verification passed with 10 checks, 0 failures, and 0 warnings. No instruction files were edited in this pass.

## Branch And Worktree Hygiene

- Remote-tracking refs were refreshed with `git fetch --prune origin`.
- Do not delete branches with nonzero `git cherry -v origin/main <branch>` output.
- Do not remove worktrees with dirty or staged files, even when branch history is already reachable from `origin/main`.
- Post-#855 classifier at 2026-06-14T22:24Z: primary checkout is on `docs/post-855-hygiene-ledger-20260614` from `origin/main` head `1c07f8ef`; local `main` is owned by a peer worktree. Merged-local refs outside the current branch are attached to dirty peer worktrees or still have unclassified local state, so they are not deletion candidates.
- Post-#855 prune checks: `git fetch --prune origin`, `git worktree prune --dry-run --verbose`, and `git remote prune origin --dry-run` produced no cleanup output after the merged coverage branch was deleted.
- Clean/merged candidate check: `git cherry -v origin/main` returned empty for `feat/systemd-unit-reconciliation` plus merged `worktree-agent-a361a4a53a4323750`, `worktree-agent-a4279b57df647e6a7`, `worktree-agent-a5ef92da83488803f`, `worktree-agent-a7681ff96f17ce486`, and `worktree-agent-a91f218ef14989532`, but every corresponding checked worktree has dirty or untracked files, so no peer worktree was removed.
- Post-#856 classifier at 2026-06-14T22:46Z: primary checkout is on `docs/post-856-hygiene-ledger-20260614` from `origin/main` head `2327667a`; local `main` remains owned by a peer worktree. `gh pr list --state open` returned no open PRs, and issue #640 remains the only open issue.
- Post-#856 prune checks: `git fetch --all --prune`, `git worktree prune --dry-run --verbose`, and `git remote prune origin --dry-run` produced no cleanup output.
- Post-#856 merged-branch check: `git branch --merged origin/main` returned only the detached HEAD plus `feat/systemd-unit-reconciliation` and the merged agent branches `worktree-agent-a361a4a53a4323750`, `worktree-agent-a4279b57df647e6a7`, `worktree-agent-a5ef92da83488803f`, `worktree-agent-a7681ff96f17ce486`, and `worktree-agent-a91f218ef14989532`. All are attached to worktrees with modified or untracked files, so no branch or worktree was deleted. `worktree-agent-a95f0ed6926a574a0` is clean but is not merged into `origin/main`, so it is also not a deletion candidate.
- PR #857 branch `docs/post-856-hygiene-ledger-20260614` was merged as `c947d639` and pruned locally/remotely after `git merge-base --is-ancestor docs/post-856-hygiene-ledger-20260614 origin/main` succeeded, `git cherry -v origin/main docs/post-856-hygiene-ledger-20260614` returned empty, and `git range-diff origin/main^2~1..origin/main^2 docs/post-856-hygiene-ledger-20260614~1..docs/post-856-hygiene-ledger-20260614` showed `0aa1b7a7 = 0aa1b7a7`.
- `git fetch --prune origin`, `git worktree prune --dry-run --verbose`, and `git remote prune origin --dry-run` produced no cleanup output after cache relocation.
- Broad worktree/branch deletion is deferred while peer-agent worktrees and nonzero cherry evidence remain. Do not prune shared worktrees solely from clean status or stale branch names unless the owning process is clear or the operator explicitly approves the batch.
- Do not create a new docs-only ledger PR solely to record the merge of another docs-only ledger PR. Record the next checkpoint only when there is a material estate change: source work landing, branch/worktree/cache pruning, instruction hierarchy edits, artifact disposition changes, or a new blocker.

## Closure Gates

- Public docs must point to tracked ledgers, not ignored `.codex` artifacts or local-only chat summaries.
- Any branch/worktree removal requires clean worktree state plus `git cherry -v` or `git range-diff` evidence recorded in this ledger or a successor.
- Any artifact deletion requires a backup or archived copy, a replacement canonical path, and a reason that distinguishes historical evidence from active work.
- Ledger validation: `npm run guard:work-index`, `bash ~/.claude/scripts/verify-instruction-hierarchy.sh --strict`, and `npm run verify:push:branch` passed after dependency setup; branch gate result was 17 files passed, 252 tests passed, 1 file skipped, 10 tests skipped.
