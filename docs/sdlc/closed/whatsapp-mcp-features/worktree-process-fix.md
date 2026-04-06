# Worktree Branch Divergence — Process Fix

## Problem

During Phase 1-2, BES Bot's worktree agents repeatedly branched from stale main. Every merge required reconciliation:

- SP2 Task 7: agent reverted MediaDeps.db fix (branched from pre-SP1-fix code)
- SP3: seed data missing content_text (branched from pre-SP2 code)
- SP7: BES Bot's cleanup_media was superseded by Q's combined commit

The root cause: `git worktree add` creates a worktree from the current HEAD. If main has moved since the worktree was created, the agent works against outdated code.

## Fix

**Before dispatching any worktree agent:**

1. `git pull` or verify main is up to date
2. Create worktree from current main: `git worktree add .worktrees/<name> -b <branch> main`
3. NOT from HEAD of a stale branch

**Before merging any worktree back:**

1. Check: `git log main..<branch> --oneline` — are there commits from main that the branch doesn't have?
2. If diverged: cherry-pick only the new tool/test files, not the full branch
3. Run typecheck + full suite AFTER merge, not just in the worktree

**Automation opportunity:**

Add a pre-dispatch check to the sdlc-os colony mode that verifies the worktree base commit matches current main HEAD. If it doesn't, rebase the worktree branch before dispatch.

## Affected Sprints

- SP2 (Task 7), SP3, SP7 — all had merge friction from stale branches
- SP5, SP8, SP10, SP11 — same pattern but handled cleanly via cherry-pick
