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

## Open blocker (2026-07-21) — push gate fails environmentally

Branch `design/soup-v35` tip `083dbb5e` holds the full package; push to origin is blocked by
`verify:push:branch` infra issues, NOT content (all content-level guards passed after one
label scrub):

1. `check-insecure-tempfile.ts` scans gitignored working-tree residue — flags
   `.tmup-artifacts/…20260717…/verify_receipt_index.sh` in the main checkout. **Root fix (1
   line):** add `'.tmup-artifacts'` to `SKIP_RELPATHS` at
   `scripts/check-insecure-tempfile.ts:103` (mirrors the existing `.claude/worktrees` skip).
2. Worktree push path: gate requires `node_modules` (installed via `npm ci`), then node
   core-dumps (`0x1953f71`) mid-gate in the worktree context — needs diagnosis in a
   write-capable session. Not blocking if pushing from the main checkout after fix #1.

Unblock options: (a) land the SKIP_RELPATHS fix then push; (b) one-time owner-authorized
`push --no-verify` (docs-only; CI runs the full superset on the PR); (c) archive/delete the
`.tmup-artifacts` residue in the main checkout, then push normally.
