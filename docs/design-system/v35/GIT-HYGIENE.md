# GIT-HYGIENE — SOUP v3.5 program (owner directive 2026-07-21)

> "Clean, logical, manageable PRs for each stage/phase/section. No unique work machine-only.
> No sprawl across branches or worktrees unaccounted."

## Program-owned git objects (complete inventory)

| Object | Location | Purpose | Status |
|---|---|---|---|
| Merged PR #2009 / commit `0eb719db…` | `LucasQuiles/WhatSoup` `main` | Landed v3.5 docs package | ✅ merged 2026-07-22; live docs SSOT |
| Branch `design/soup-v35-t5-cutover` / PR #2027 | `LucasQuiles/WhatSoup` (origin) | T5 cutover plan | open and behind `main` as audited 2026-07-22 |
| Dedicated v3.5 worktree | local registry | Isolated design work | none registered as audited 2026-07-22 |
| `agents/q/docs/design-v35/` mirror | local filesystem | Historical scratch-mirror design | absent as audited 2026-07-22; never treat as SSOT |

## Rules (binding for the program — tightened 2026-07-21 per owner re-issue)

1. **Same-session landing.** Any artifact produced for this program is committed and pushed
   the same session. Machine-only work is a defect.
2. **PR per phase/track, each independently reviewable.** The cumulative single-PR model is
   retired. Current map:
   - **#2008** `fix/guard-tmup-artifacts-skip` — guard fix, merged 2026-07-21.
   - **#2009** `design/soup-v35` — T0/T1 seed plus T3 mockups and draft T4/WS5/WS6
     artifacts, merged 2026-07-22. The source branch is no longer present on origin.
   - **#2027** `design/soup-v35-t5-cutover` — current open T5 cutover-plan successor.
   - Future branches are created per independently reviewable track from then-current `main`;
     planned branch names are not a live inventory.
3. **PRs stay docs-only until G3.** No console/src changes on design branches.
4. **Mirror discipline.** No local scratch mirror is current. If one is recreated, it is never
   SSOT and every durable artifact must reach a reviewed branch in the same session.
5. **Worktree accountability.** No dedicated v3.5 worktree is currently registered. New work
   starts in a freshly registered isolated worktree from live `main`; unrelated worktrees are not
   program inventory and must not be touched.
6. **Append, don't rebuild.** Branch commits append to the remote tip (fast-forward);
   history rewrites only with explicit owner approval.

## Current mirror→branch file map

None. Live `main` under `docs/design-system/v35/` is authoritative.

## Historical #2009 admission notes (2026-07-21; not current gate evidence)

1. **Tempfile scanner** flagged gitignored `.tmup-artifacts` residue → root-fixed via
   `SKIP_RELPATHS` addition → merged **PR #2008** (`fix/guard-tmup-artifacts-skip`).
2. **`typecheck:all` OOM** at default ~2GB V8 heap → gate needs
   `NODE_OPTIONS=--max-old-space-size=8192` on this machine (pre-existing; heap-bump decision
   for the gate script is open — flagged in PR #2008).
3. Worktree provisioning required root + console `npm ci` in the then-active worktree.
4. One load-flake (`design-metrics.test.ts` 10s timeout) — green on retry.

**Landed:** `design/soup-v35` → merged **PR #2009**. The guard fix → merged **PR #2008**.
The former source branch/worktree is not current inventory.
