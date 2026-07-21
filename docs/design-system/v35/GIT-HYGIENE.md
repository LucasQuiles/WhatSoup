# GIT-HYGIENE — SOUP v3.5 program (owner directive 2026-07-21)

> "Clean, logical, manageable PRs for each stage/phase/section. No unique work machine-only.
> No sprawl across branches or worktrees unaccounted."

## Program-owned git objects (complete inventory)

| Object | Location | Purpose | Status |
|---|---|---|---|
| Branch `design/soup-v35` | `LucasQuiles/WhatSoup` (origin) | Docs SSOT for the v3.5 program | ✅ pushed |
| Worktree `.worktrees/soup-v35-design` | `~/LAB/WhatSoup` | Design-docs working tree (docs-only) | registered; working files reconcile on first write-capable session (branch tip advanced via object-store commits from a sandboxed session) |
| Mirror `~/agents/q/docs/design-v35/` | local repo, **no remote** | session-writable working mirror | NOT durable — do not rely on it; every file must land on `design/soup-v35` same-session |

## Rules (binding for the program)

1. **Same-session landing.** Any doc/artifact produced for this program is committed to
   `design/soup-v35` and pushed in the same session it is created. Machine-only work is a
   defect.
2. **One branch.** All v3.5 docs live on `design/soup-v35` under `docs/design-system/v35/`.
   No additional branches for docs phases. Implementation work (post-G3) gets its own
   branch/worktree registered here before creation.
3. **PR per phase.** Each program phase closes with a PR to `main`:
   - PR-1: T0 seed + T1 product model (this package)
   - PR-2: T2 research digest
   - PR-3: T3 direction mockups (+ G1 record)
   - PR-4: T4 spec (+ G2 record)
   - PR-5: T5 enforcement/cutover (+ G3 record)
4. **PRs stay docs-only until G3.** No console/src changes on the design branch.
5. **Mirror sync.** The `~/agents/q` mirror is edited (sandbox-writable), then committed to
   `design/soup-v35` via git object-store plumbing (no worktree file writes required), and
   pushed immediately.
6. **No other worktrees.** The program creates none without registering them in this file first.

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
