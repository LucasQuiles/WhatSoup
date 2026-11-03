# Objective Tracking and Review

Use this runbook to keep goals, active work, remaining items, and closure
evidence visible without turning chat history into the source of truth.

## Canonical Surfaces

| Surface | Purpose | Review command |
|---|---|---|
| Git branch and worktree state | Local truth for in-flight code | `git status -sb`, `git branch --show-current`, `git worktree list`, `git stash list` |
| GitHub pull requests and issues | Live queue truth | `gh pr list --state open`, `gh issue list --state open` |
| Work index | Generated index of scoped planning, SDLC, and superpowers artifacts | `npm run guard:work-index` |
| Current program narrative | Active-work navigation to requirements, delivery and scoped planning records | `docs/current-program.md` |
| Artifact sweep dry run | Report-only scan for scattered plans, specs, tasks, beads, and sessions | Operators with the artifact-sweep plugin can invoke its `run-sweep.sh` script; otherwise run `npm run guard:work-index` and read `docs/work-index.md`. The index covers `docs/sdlc`, `docs/superpowers` and `docs/plans`; it cannot prove the absence of other active work. |
| Verification gates | Evidence that a change is ready to publish | `npm run verify:push:branch` for branch work; `npm run verify:release` for release work |

Static docs must not be treated as live queue truth. Re-query GitHub for open
PRs/issues, and regenerate or check the work index before using it as evidence.

## Review Cadence

Run this lightweight review at the start of any substantial session:

1. Confirm the current repo, branch, upstream, and dirty files.
2. List worktrees and stashes so abandoned work is visible before new work
   starts.
3. Query open PRs and issues from GitHub instead of trusting old copied lists.
4. Read `docs/work-index.md` for indexed active, pending, and unknown artifacts.
5. State the active objective, the intended branch, and the expected evidence
   before editing.

Before a commit or PR:

1. Update the relevant spec, runbook, SDLC artifact, or release note when the
   behavior or operator process changed.
2. Run the narrow tests for the changed surface.
3. Run the publication and repo hygiene guards for staged content when the
   change touches docs, config, fixtures, deployment, or examples.
4. Run `npm run guard:work-index` when indexed planning artifacts changed.
5. Record inconclusive checks explicitly. A masked, skipped, or environment-
   blocked test is not clean evidence.

Before declaring an objective complete:

1. Verify the PR state, merge commit, and CI status with `gh pr view` or
   `gh pr checks`.
2. Verify the checkout used for follow-up work contains the required merge commit.
   Keep a runtime-pinned checkout pinned until its existing migration procedure
   permits advancement.
3. Move or mark the planning artifact according to
   `docs/canonical-status-policy.md`.
4. Leave any remaining blockers as explicit follow-up items with owner, evidence
   gap, and next action.

Weekly maintenance review:

1. Run `npm run guard:work-index`.
2. Run an artifact-sweep dry run and review the matched, report-only,
   low-confidence, and unmatched counts. Do not run `--apply` without explicit
   operator approval, a narrow allowlist, and replacement/backup evidence; a
   broad dry-run match on canonical `docs/` artifacts is not enough to archive
   or delete them.
3. Review open PRs, draft PRs, branches, worktrees, and stashes for stale or
   superseded work. Use `git range-diff` or `git cherry -v` before deleting any
   branch claimed to be superseded, and never remove a worktree that has staged,
   unstaged, or untracked files.
4. Check whether `docs/current-program.md` still routes readers to the current
   owners, delivery records and scoped planning index. Correct stale references.

Monthly maintenance review:

1. Triage unknown and pending rows from `docs/work-index.md`.
2. Convert still-actionable loose plans into GitHub issues (with explicit operator approval; external posting is never autonomous) or SDLC artifacts.
3. Archive or mark superseded artifacts only when the replacement and evidence
   are explicit.
4. Remove stale operational notes from always-read docs when they no longer
   change behavior.

## Review Packet

Use this structure when handing work between agents or resuming after a long
session:

```text
Objective:
Current branch:
Open PRs:
Open issues:
Dirty files:
Worktrees/stashes:
Changed surfaces:
Verification run:
Inconclusive checks:
Remaining blockers:
Next review date:
```

Keep private deployment labels, credentials, client details, and local-only host
facts out of public docs. Track private operational details in the appropriate
private overlay or machine-local runbook instead.
