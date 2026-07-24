# G3 — v3.5 Conformance Gate Sign-off (T5 b-13)

Gate: screenshot-conformance vs mockups (both themes, 1440×900), AA
re-verification per owner gate, full lint. This document records the gate
result and the merge-readiness evidence.

## 1. Integration validation (the load-bearing evidence)

The T5 program shipped as 11 parallel branches stacked on #2059. The G3 gate
was executed against a **local integration worktree** (`scratch/g3-integration`
@ `5c4637a6`) assembling all eleven surface branches — never pushed, no merges
to the repo (the owner's merge decisions stay the owner's).

Integrated-tree results:

| Gate | Result |
|---|---|
| Full test suite | **21,282/21,282 green** (2 skipped) |
| Design-guard battery (`verify:console-design`) | **182/182** |
| Browser legs (Chromium) | **157/157** |
| Typecheck (`tsc -b` + `typecheck:all`) | clean |
| Console lint + shadow baseline | clean |
| Design burndown | **49 total / 0 blocking** |
| Build | green (entry chunk 130KB gzip ≤ 250KB provisional budget) |
| Perf lane (b-12, report-only) | bundle 130KB ✓ · cold FCP 256ms ✓ · warm 60ms ✓ |
| Both-theme 1440×900 captures, all 9 surfaces | **18/18 PASS** (`artifacts/soup-v3-follow-up/visual-matrix/g3-conformance/`) |

Integration conflicts were mechanical (union of additive token blocks, spec
section renumbering, test-suite unions). Three integration-only defects were
found and fixed at the root: a window-at-module-load crash in the perf meter
(import-safe now), the b-09a tab panels migrating onto the TabPanel primitive
(anti-sprawl guard), and the route-table union that briefly re-shadowed the
graduated surfaces behind stubs (restored; **zero SurfaceStub references
remain** — the stub is fully retired from the route table).

## 2. Per-surface conformance summary (mockup SSOT vs shipped)

| Surface | Bead/PR | Acceptance pins (browser-computed) | Honest-state posture |
|---|---|---|---|
| Fleet | b-03 #2086 | virtualization >50 rows; honesty markers intact | live data |
| Agents | b-04 #2094 | 1000px stacking; internal detail scroll | soul from real claudeMd only |
| Skills Hub | b-05 #2096 | 900px rail collapse | real 23-plugin catalog; compat cells honest n/a |
| Dream Lab | b-06 #2099 | 980px stack; 72ch diff cap | no backend — honest empties, anatomy fixture-proven |
| Inbox | b-07 #2108 | 1100px ctx / 760px master-detail; uniform 36px composer | takeover local-only (no endpoint); disabled caps disclosed |
| Deployments | b-08 #2112 | 1000px grid collapse; fits 1440×900 | one real host; hub/pair designed-states disclosed |
| Settings | b-09 #2119 | 800px nav collapse; fits 1440×900; swatch sync | wired where real (theme, silences, keys, lock) |
| Journey (splash+hatch) | b-10 #2125 | 700px props stack; glow ≤800ms single-play; journey radius 16px | baileys-only channel honesty; no ceremony dice |
| Motion | b-11 #2131 | one ambient loop (ambient-disc) product-wide | v3 loop family retired |
| Ops metrics tab | b-09a #2140 | keep-alive panels; deep-link redirect | content absorbed unchanged |
| Perf | b-12 #2143 | lane runs (report-only) | provisional budgets flagged |

## 3. AA / accessibility re-verification

- Single-h1 law pinned on every route (a11y-contracts suite; the discovered
  rule: visible pagerow h1 exactly when the mockup header carries surface
  actions — fleet/agents/skills/dream/deployments; sr-only h1 otherwise —
  inbox/settings; journey/splash own their h1s).
- Disabled controls carry `title` + `aria-description` everywhere (b-05..b-10
  posture); takeover toggle is `role="switch"` with the no-endpoint disclosure.
- Heading hierarchy: no skipped levels (the landing h3→h2 correction, on record).
- Theme parity 139 tokens both scopes; focus-ring law (no suppression); status
  shape mandatory (●/◆/■); DD-8 ink-tier pins retargeted to the -v35 register
  with supersession notes.

## 4. Full lint

design-regression blocking set (1 2 6 8 10 11 12 13 14 15 16 17 19) PASS;
shadow baseline in sync; waivers WVR-005/006 retired with their subjects;
no-infinite-animation sanctioned set = `ambient-disc` only.

## 5. Residual items (explicit, not blocking)

1. **Merges pending (owner decisions)** — #2030, #2059, #2086, #2094, #2096,
   #2099, #2108, #2112, #2119, #2125, #2131, #2140, #2143 (+ #2098 already
   merged). Merge order recommendation: b-01 → b-02 → surfaces in any order →
   b-09a → b-10 → b-11 → b-12. The integration worktree above is the exact
   preview of the merged result.
2. **§1 perf budgets** are provisional — the b-12 lane flips to blocking
   (`PERF_LANE_ENFORCE=1`) on owner sign-off of `19-performance-budget.md` §1.
3. **Reduced-motion harness debt** — the browser suite's
   `context.reducedMotion: 'reduce'` is inert in the current provider version
   (probe-proven in b-10); the vitest page wrapper exposes no per-test media
   emulation. Own bead; ceremony/motion contracts are source+computed pinned
   meanwhile.
4. **Deferred perf legs** — 200-line mount + event-storm frame cost need a
   fixture-fed headless harness (recorded in the lane output).
5. **Ops surface** remains v3-era (no mockup, no bead) with the metrics tab
   absorbed; a v3.5 Ops restyle would need a mockup first.

## 6. Gate verdict

All computable gate criteria PASS on the integrated tree. G3 sign-off is
recommended **conditional on the owner merge decisions in §5.1** — the merged
main will be byte-equivalent to the validated integration worktree.
