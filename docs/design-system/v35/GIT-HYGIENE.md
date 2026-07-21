# GIT-HYGIENE — SOUP v3.5 program (owner directive 2026-07-21)

> "Clean, logical, manageable PRs for each stage/phase/section. No unique work machine-only.
> No sprawl across branches or worktrees unaccounted."

## Program-owned git objects (complete inventory)

| Object | Location | Purpose | Status |
|---|---|---|---|
| Branch `design/soup-v35` | `LucasQuiles/WhatSoup` (origin) | Docs SSOT for the v3.5 program | ✅ pushed |
| Worktree `.worktrees/soup-v35-design` | `~/LAB/WhatSoup` | Design-docs working tree (docs-only) | registered; working files reconcile on first write-capable session (branch tip advanced via object-store commits from a sandboxed session) |
| Mirror `~/agents/q/docs/design-v35/` | local repo, **no remote** | session-writable working mirror | NOT durable — do not rely on it; every file must land on `design/soup-v35` same-session |

## Rules (binding for the program — tightened 2026-07-21 per owner re-issue)

1. **Same-session landing.** Any artifact produced for this program is committed and pushed
   the same session. Machine-only work is a defect.
2. **PR per phase/track, each independently reviewable.** The cumulative single-PR model is
   retired. Current map:
   - **#2008** `fix/guard-tmup-artifacts-skip` — guard fix (independent, mergeable first)
   - **#2009** `design/soup-v35` — program seed: T0 package + T1 product model + design
     language (rounds 1–4) + Direction A mockups. Retitled to match. After merge, the branch
     STAYS as the program's long-lived base.
   - **Next PRs** — one branch per track off `design/soup-v35`, stacked PRs targeting it:
     `design/soup-v35-t3-agents` (Agents roster/detail), `-t3-skills-hub`, `-t3-dream-lab`,
     `-t3-inbox-line`, `-t3-deployments`, `-t3-settings-splash`, `-t4-spec`, `-t5-cutover`.
     Each PR diff shows only its track. Branches are created when work lands, never empty.
3. **PRs stay docs-only until G3.** No console/src changes on design branches.
4. **Mirror discipline.** `~/agents/q` (no remote) is a scratch mirror only — every file must
   reach a pushed branch same-session. Its local commits are not SSOT.
5. **Worktree accountability.** Program-owned: `.worktrees/soup-v35-design` (registered,
   provisioned, push-capable). The ~10 worktrees under `~/agents/q/` (restart-reliability,
   pr1666/7, pr1671, flake-fix, qr247-harden, r1-sensitive, sticky-actor, wa-routing,
   mcp-servers-verify) belong to other programs/PRs — not v3.5-owned, not touched.
   New worktrees require registration here first.
6. **Append, don't rebuild.** Branch commits append to the remote tip (fast-forward);
   history rewrites only with explicit owner approval.

## Current mirror→branch file map

`~/agents/q/docs/design-v35/*.md` → `docs/design-system/v35/*.md` (1:1, same filenames).

## Resolved blocker (2026-07-21) — push gate environmental failures

1. **Tempfile scanner** flagged gitignored `.tmup-artifacts` residue → root-fixed via
   `SKIP_RELPATHS` addition → **PR #2008** (`fix/guard-tmup-artifacts-skip`, open).
2. **`typecheck:all` OOM** at default ~2GB V8 heap → gate needs
   `NODE_OPTIONS=--max-old-space-size=8192` on this machine (pre-existing; heap-bump decision
   for the gate script is open — flagged in PR #2008).
3. Worktree provisioning: gate needs root + console `npm ci` in the worktree (done; worktree
   is now push-capable).
4. One load-flake (`design-metrics.test.ts` 10s timeout) — green on retry.

**Landed:** `design/soup-v35` pushed → **PR #2009** (docs T0+T1, open). Fix branch pushed →
PR #2008. Worktree `.worktrees/soup-v35-design` provisioned + push-capable.
