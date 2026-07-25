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

1. **Merge path — one integration PR, not thirteen.** Superseded by §7: the
   bead PRs stay the reviewed record; `feat/console-v35-integration` is the
   single merge to main.
2. **§1 perf budgets** are provisional — the b-12 lane flips to blocking
   (`PERF_LANE_ENFORCE=1`) on owner sign-off of `19-performance-budget.md` §1.
   This is the one gate that stays open by design; it is an owner numeric
   decision, not an engineering residual.
3. ~~**Reduced-motion harness debt**~~ — CLOSED by #2158: the provider option is
   `contextOptions` at the factory level (`instances[].context` was a key the
   provider never read). The removal law is computed-proof with reduce actually
   active; the failure class is recorded in `qa-hardening.md`.
4. ~~**Deferred perf legs**~~ — CLOSED in #2143: 200-row mount + 10-event storm
   frame cost land as real Chromium budget tests through the Profiler's
   `actualDuration`, inside the existing CI lanes.
5. **Ops surface** — remains v3-era with the metrics tab absorbed. Tracked as
   bead **b-14** (mockup first, then restyle); it is the last surface that has
   not been through the v3.5 language.

## 6. Gate verdict

All computable gate criteria PASS on the integrated tree. G3 sign-off is
recommended **conditional on the owner merge decision in §7** — the merged main
will be byte-equivalent to the validated integration branch.

## 7. Post-gate: the merge path (integration re-run, 2026-07-24)

The gate above ran against a local worktree that was never pushed. That left a
structural problem for landing: main squash-merges, and the eleven surface
branches are stacked on b-02, so every squash landing rewrites the base of the
next PR. #2030 (b-01) merging proved it — #2059 went `DIRTY` immediately, on the
two additive doc registries, and each later merge would have re-conflicted the
same way (12 more conflict walls, serialized behind owner merges).

Resolution, in two parts:

- **#2059 restored to mergeable** — main merged into b-02 with the doc-registry
  union resolved by taking the branch side (verified line-by-line as a strict
  superset of main's b-01 squash; no main-side content dropped). The full
  pre-push gate ran green on the result.
- **`feat/console-v35-integration`** — branched off current main and assembling
  all thirteen bead branches plus #2158, with every conflict resolved
  mechanically (additive union, framed union for renumbered headings, line-wise
  3-way for the route table, deletion union for the retired stub rows). This is
  the single PR to main; the bead PRs remain the review record.

**Three defects the re-assembly surfaced, all fixed at the root:**

| Defect | Why no branch could see it | Fix |
|---|---|---|
| `const Metrics = lazy(() => import('./pages/Metrics'))` resurrected against the page file b-09a deleted | the lazy-import block unions additively; only the assembled tree has both the b-09a deletion and another branch's import list | import removed; `ops-metrics-tab.test.ts` already pins the absence |
| `SurfaceStub` survived as a dead import, and `app.test.tsx`'s stub table degraded to an **empty loop** — a vacuously passing test | each branch removed only its own row; the last removal emptied the table without failing | stub module deleted; table replaced with a graduation pin (5 routes render their surface, none renders the placeholder), falsified by re-shadowing `/agents` |
| duplicate `§` numbering across the spec docs (4× `## 12.` in tokens-v3, 8× `## 5.` in the addendum) | each bead numbered against its own base | renumbered sequentially with every in-body Spec-SSOT cross-reference repointed |

**Flagged convergence closed.** b-03's fleet-local transport map and b-07's
console-wide `transport-identity.ts` both carried the same mapping; both PRs
flagged that one must absorb the other once both landed. The shared mapping and
copy now live once in `lib/transport-identity.ts`, with `fleet/channel-kind.ts`
extending it for the fleet-only silhouettes and keeping the shape-mandatory
Baileys fallback. Direction chosen so the inbox glyph set stays pinned to its
own mockup SSOT. **Enforcement effect:** `channel-kind.ts` drops out of *both*
hygiene allowlists (`no-whatsapp-copy-in-generic-ui`,
`no-health-whatsapp-key-read`) — each rule now admits one file instead of two —
and the merge-duplicated allowlist entries (4× per rule) collapse to one. 30 new
pins cover every raw spelling the pre-convergence map resolved, the
honest-vs-shape fallback split, and a tripwire that fails if the fleet map ever
re-rolls transport copy or the legacy key read.
