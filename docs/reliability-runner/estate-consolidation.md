# Reliability Estate Consolidation

Status: active ledger. Updated: 2026-06-14T07:35:00Z.

Purpose: keep merge, branch, worktree, sweep, and instruction-hierarchy cleanup evidence in one tracked place while the reliability runner stays active.

## Current Live Queue

- GitHub PR queue: empty as of 2026-06-14T07:30Z.
- Latest merged PR: #841, merge commit `0ad5ab47`, with CodeQL and Quality Node 24/25 checks successful.
- Open GitHub issue: #640, `Prevent ignored canonical docs from disappearing from work-index coverage`; do not close or comment without explicit operator approval.
- Active unmerged local branch: `test/session-classifier-pid-coverage-20260614`; `git cherry -v origin/main` shows two unique commits: `96b9c6f0` and `5c721f1d`.

## Artifact And Feature Sweep

- `npm run guard:work-index`: clean.
- `docs/work-index.md`: 188 entries, 13 unknown-status rows, 38 pending rows, 0 inconsistencies.
- Artifact sweep dry-run `20260614T073043Z-codex-dry-run`: 1939 matched artifacts, 1342 report-only residuals, 1290 low-confidence artifacts, 0 swept.
- Broad artifact-sweep apply mode is deferred: the dry-run marks canonical tracked docs under `docs/specs` and `docs/superpowers` as `would-sweep`, so cleanup needs a narrow allowlist rather than a whole-manifest archive/delete pass.

## Instruction Hierarchy

Instruction audit summary at 2026-06-14T07:33Z: all configured surfaces reported 0 missing refs, 0 ambiguous refs, and 0 hardcoded count hits. Covered surfaces include global Claude/Codex routers, workspace `AGENTS.md`, WhatSoup `CLAUDE.md`, and the Claude memory index.

## Branch And Worktree Hygiene

- Remote-tracking refs were refreshed with `git fetch --prune origin`.
- Do not delete branches with nonzero `git cherry -v origin/main <branch>` output.
- Do not remove worktrees with dirty or staged files, even when branch history is already reachable from `origin/main`.
- Current example: `feat/systemd-unit-reconciliation` has no unique cherry patch relative to `origin/main`, but its worktree has 14 dirty/staged paths, so it is not safe to prune.
- Current agent worktrees with zero unique cherry work still have dirty paths except `worktree-agent-a95f0ed6926a574a0`, which has one unique commit; none are safe for deletion in this pass.

## Closure Gates

- Public docs must point to tracked ledgers, not ignored `.codex` artifacts or local-only chat summaries.
- Any branch/worktree removal requires clean worktree state plus `git cherry -v` or `git range-diff` evidence recorded in this ledger or a successor.
- Any artifact deletion requires a backup or archived copy, a replacement canonical path, and a reason that distinguishes historical evidence from active work.
- Ledger validation: `npm run guard:work-index`, `bash ~/.claude/scripts/verify-instruction-hierarchy.sh --strict`, and `npm run verify:push:branch` passed after dependency setup; branch gate result was 17 files passed, 252 tests passed, 1 file skipped, 10 tests skipped.
