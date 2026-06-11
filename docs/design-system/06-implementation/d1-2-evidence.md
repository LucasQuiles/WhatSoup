# Slice Evidence — D1.2 (C1: token value swap + dual themes + toggle)

Worktree `soup-impl`, commit `9b0087ef` (on `4e98f0b5`). The reskin moment: semantic tokens became
canonical with per-theme literal values; legacy `@theme` entries inverted to `@theme inline` aliases;
Geist typography landed; theme toggle shipped. 8 files (7 modified + new `hooks/use-theme.ts`).

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Positive-path | **PASS** | lint clean; build success; **1614/1614 console tests**; dev render verified: Fleet dark (new `#0E1013` base, Geist, toggle in nav), Fleet LIGHT (designed: hairlines + real shadows + darker saturated chromatics, charts/alerts/badges legible), Inbox light (3-pane clean, badges legible, calm empty state). Toggle cycles dark⇄light, persists (`whatsoup:theme`), pre-paint init in index.html (no flash). |
| Negative-path | **PASS (scoped)** | Theme-parity: 50 semantic tokens defined in BOTH scopes (scripted check). Offline-font fallback stacks in place. Legacy alias resolution verified via computed styles. Remaining matrix rows inherit C2+ surface migrations. |
| Omission review | below | |
| Regression review | **PASS** | All sanctioned visual shifts enumerated pre-review (d4→translucent interaction surface; t3/t4→text-2 collapse; d5→overlay #1B1F26; font metrics) and confirmed acceptable in render. 5 test assertions updated, all because the new nav toggle made bare `getByRole('button')` ambiguous — tightened to name-specific queries, nothing weakened. Rollback = single-commit revert. |
| Design-system conformance | **PASS** | Spec §3 values exact incl. all four AA fixes confirmed in light scope (`--text-3` #7C8490, ok #15722F, warn #855900, passive #096853); tints via color-mix; colliding roles separated (focus/action/ok/passive independent); motion tokens landed (120/180/280 + enter/exit easings); `data-theme` on `<html>` per spec §5. |

## Omission audit

- **Not touched:** component primitives, screens, lint rules (D1.3/C2 scope); v2 mockup's pre-AA-fix hexes (spec authoritative).
- **Font delivery:** Google Fonts CSS import as DOCUMENTED fallback (Geist files unavailable offline) — **DD-4: self-host under console/public/fonts/ by C2**; fallback stacks keep rendering offline.
- **Not screenshotted:** LineDetail/Ops (compose the same token surfaces; verified at C2/C3 migration); reduced-motion and keyboard matrices unchanged this slice.
- **Old pattern remaining:** all legacy class/token consumption (sanctioned until C2 per-directory flips).

## Spec ambiguities resolved (durable interpretations)

1. `--wash`/`--chan-border` strength knobs declared per-theme scope (the color-mix formulas require per-theme strengths: 12/36% dark, 9/32% light).
2. `--dur-norm` dual definition (primitive + alias) kept — harmless, order-independent.
3. `data-theme` on `documentElement` (spec §5 letter).

## Design debt

| ID | Title | Type | Cleanup |
|---|---|---|---|
| DD-4 | Geist via Google Fonts import instead of self-hosted | typography | C2 / before release freeze |
| DD-5 | Theme toggle is a minimal ghost button (final nav treatment lands with C3 nameplate/Nav polish) | component | C3 |

## Verdict: **PASS** — C1 acceptance met (theme parity green, AA fixes in place, both themes reviewed on live surfaces). Next: D1.3 (lint shadow stage — regression greps + first soup/* rules report-only).
