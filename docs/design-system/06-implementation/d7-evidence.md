# Slice Evidence — D7 (browser harness: computed-box / viewport / trusted-event proofs) + B5 animated-path proofs

Worktree `soup-impl`, branch `feat/soup-v3-foundation`. Commits (impl log order):
`c3b1ac52` browser harness + trusted-event smoke gate (commit 1) · `ca799b4f` smoke
typecheck fix (tsconfig.test narrowing) · `0bc340a4` C-D7-2 removable-X pseudo-element
expansion + truthful comment · `8c26fbb1` CI wiring (playwright install + test:browser
step; WVR-013/014 filed in the same commit) · `253df9f7` target-size computed-box battery
(DD-10) · `25629451` B5 modal/drawer exit motion + refcounted background inert + toast
portal + `vitest.browser.motion.config.ts` + exit-motion suite · `d80e9726` viewport
matrix + keyboard proofs + inert/toast suites · `cc3058f4` DD-27 filed (design branch).
Gate packet: `d7-investigation.md` (`ebc6f29c`, Ready with Constraints). B2 deferral
provenance: `b2-evidence.md` ("PASS WITH DEFERRED PROOF"). Wave-3 before-claim:
`b3-wave3-investigation.md` §7.2 / C-B3W3-7.

## Fresh-run capture (2026-06-12, integrator-independent)

| Command | Result |
|---|---|
| `npm run test:browser` (vitest.browser.config.ts, chromium headless, reducedMotion: reduce) | **76/76, 5 files** — viewport-matrix 23 · keyboard-proofs 9 · smoke 4 · target-size 37 · b5-inert-toast 3 (3.19s) |
| `npx vitest run --config vitest.browser.motion.config.ts` (no-reduce context) | **3/3** — b5-exit-motion (modal dwell+keyframe, backdrop pointer-events, drawer dwell+keyframe) |

Capture environment note: at evidence time the `soup-impl` working tree was mid-merge
(active integrator lane; package.json carried conflict markers, so no npm/vitest
invocation could run in place). Both runs executed from an unmutated shared clone of
the committed head `b260800e` (`/tmp/d7-run`, `node_modules` symlinked from the impl
tree — same exact-pinned playwright 1.60.0 chromium build). Zero writes to `soup-impl`.

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Positive-path | **PASS** | fresh 76/76 + 3/3 above · deps exact-pinned (`@vitest/browser` 3.2.6, `playwright` 1.60.0, `vitest-browser-react` 1.0.1, `tailwindcss`/`@tailwindcss/vite` 4.2.2 — no carets, package.json devDependencies) · `test:browser` script + `vitest.config.ts:35` exclude · CI browser step live on both Node matrix legs (quality.yml) |
| Negative-path | **PASS** | network sentinel throws named errors on any `/api`/`/ws` fetch or WebSocket (setup.ts — WebSocket guarded via subclass, no type suppression) · FINDING cases assert the measured defect values numerically instead of skipping (target-size §4/§5/§8) · the focus-trap case asserts a definite outcome on both branches (trap-holds OR escape-without-recapture) |
| Omission review | below | |
| Regression review | **PASS** | jsdom/node suite excluded by config and untouched at commit 1 (2,131 green at `c3b1ac52`; 2,296 at `25629451` per its commit battery — integrator record, not re-run for this packet) · B5 kept the jsdom modal suite byte-stable via the synchronous-instant exit path (jsdom's empty computed duration) · no console/src TSX changes in the D7 commits; C-D7-2 is CSS + one jsdom test file |
| Design-system conformance | **PASS with findings** | suites encode the spec floors directly — layout-density §4 (24px), tokens.component.css floors (32/28/24, 28×28), motion.md §9 (reduced = removed) and §10 (closing backdrop pointer-events: none) — and the battery *measured two conformance gaps* (below) instead of overclaiming them green |

## Contract proof — commit 1, the harness (`c3b1ac52` + `ca799b4f`)

- **Exact dep pins** (the version-skew defense, packet §6.5/C-D7-3): all five browser
  deps pinned without range operators; local and CI resolve the same chromium build
  from the same playwright version by construction.
- **Separate config** (`vitest.browser.config.ts`): esbuild JSX (no
  @vitejs/plugin-react — the vite-7/vite-8 split, packet §0.3), `@tailwindcss/vite`
  at root for `console/src/index.css`, `publicDir: console/public` (self-hosted Geist
  → identical text metrics macOS/ubuntu), single chromium instance,
  `fileParallelism: false`, `reducedMotion: 'reduce'` context,
  `screenshotFailures: true`, root-alias block mirrored for the single-React
  guarantee. jsdom config untouched except the one-line `tests/browser/**` exclude.
- **Network sentinel** (setup.ts): `fetch` wrapper + `WebSocket` subclass throw a
  named `[D7 network sentinel]` error on `/api`/`/ws` — an unmocked path fails loudly
  at the call site rather than silently exercising the dev-mode mock fallback in
  `lib/api.ts`. `document.fonts.ready` awaited per file before any assertion.
- **C-D7-1 smoke gate** (4 tests, run before any suite was built): (A) `vi.mock`
  interception works under the provider (tagged react-router-dom factory observed
  active); (B1) `userEvent.tab()` moves real focus; (B2) the focused Button matches
  `:focus-visible` from a keyboard-origin event — the proof jsdom cannot produce;
  (B3) Enter on the focused Button fires a click with `isTrusted: true`.

## Target-size battery — DD-10's computed-box proof (`253df9f7`, `0bc340a4`)

37 real-Chromium measurements (`tests/browser/target-size.test.tsx`), all terminal
assertions numeric: Button 6 variants × 3 sizes vs token floors (md ≥32, sm ≥28,
xs ≥24) + width floor; ActionButton 28×28 incl. danger; Pill interactive md ≥24
(idle + pressed); Pill interactive sm — visual 20px documented + `elementFromPoint`
probes proving the `::before` top extension; Pill removable X — visual ≤20px
documented + top-extension probes against the C-D7-2 band (`0bc340a4`: 16px glyph +
2×4px `inset: calc(-1*var(--sp-1))`, replacing the false "negative margin trick"
comment); Tabs ≥24 incl. disabled; ToolbarTimeRange segs ≥24 incl. disabled; Table
sort buttons (FINDING, below); Popover option rows ≥24 (portal-queried); SearchInput
≥24.

**FINDING 1 — table sort buttons measure below the floor.** `.soup-table-th__sort-btn`
is `inline-flex` with font-derived height (~16px); the 28px `<th>` height does not
transfer. The case asserts the measured deficiency (`maxHeight < 24`) so the defect is
pinned, not skipped; the assertion flips to the floor when the fix lands (remediation
direction recorded in the suite: `min-height` on the sort button). Not fixed in this
lane (report-finding discipline). Carried on the narrowed DD-10 row.

**FINDING 2 — pseudo-element hit-areas are confirmed top-side only.** For both the sm
interactive pill and the removable X, `elementFromPoint` proves the upward `::before`
reach; the downward extension is occluded by following inline content in Chromium's
hit-testing under this mount. The "effective ≥24px in both directions" claim is
therefore PARTIALLY proven (top confirmed, bottom unconfirmed). Carried on DD-10.

One packet deviation: C-D7-2 was committed (`0bc340a4`) *before* the suite rather than
with it; the packet's live-checkpoint glance for chip-row spacing side-effects has **no
recorded outcome** — listed under omissions.

## Viewport matrix (`d80e9726`) — DD-18r deterministic-tests leg

23 cases (`tests/browser/viewport-matrix.test.tsx`) on the §7 grid (390×844, 768×1024,
1024×768, 1280×800, 1440×900, 1440×500) plus the 1023/1024 boundary probes:

- **Fleet**: computed `flex-direction` column at 1023 / row at 1024 (tailwind `lg`,
  viewport-driven per packet §6.9); no horizontal overflow at all six cells
  (same-element scrollWidth-vs-clientWidth rule, C-D7-6); 1440×500 page scrolls.
- **LineDetail**: ≥40-char h1 actually truncates at 390 (scrollWidth > clientWidth —
  the computed proof B1's §7 named as D7's); 9-tab passive row at 390 is a real
  x-scroll region; overflow sweep at all six cells. Route params via a real
  MemoryRouter/Routes mount (react-router-dom deliberately unmocked).
- **Ops**: overflow sweep at all six cells.
- **Inbox: deliberately absent** — C-D7-4 sequenced it behind B4. B4 has since landed
  (`68a7beda` collapse, `9bfde5c3` close), so the sequencing condition is now
  satisfied and the Inbox rows are *unblocked but not yet written* (omissions).

**Mock-repair history (recorded engineering fact):** the first build used the jsdom
convention — `async (importOriginal)` spread-actual factories — which failed under the
browser runner's module mocker for the page-harness modules (factory re-evaluated in
the page context). Repaired to explicit-shape factories enumerating exactly the
consumed exports (use-fleet, use-metrics, lib/api, lazy modals, LinePicker). Separately,
dynamically-discovered deps caused mid-test vite re-optimization → dual-React "invalid
hook call"/QueryClient context failures; resolved by pre-listing the data/router deps in
`optimizeDeps.include` (config comment documents the symptom). Scope note: the smoke
gate's own importOriginal-spread mock *does* work in its file — the breakage was
observed on the page-harness module set, not universally.

## THE FALSIFICATION — C-B3W3-7 recapture claim proven false in real Chromium → DD-27

This is the packet's marquee result: the harness exists precisely to catch
jsdom-invisible claims, and on its first full keyboard pass it falsified one.

- **Before-claim** (`b3-wave3-investigation.md` §7.2, carried as constraint C-B3W3-7):
  with roving-tabindex tabs and a loading EmptyState body, one forward-Tab stop can
  escape the modal portal, and "the very next Tab press is recaptured by the
  `!container.contains(activeElement)` branch … transient (loading-only),
  **self-healing**, jsdom cannot exercise native traversal — recorded as a known edge
  owned by the D7 trusted-keyboard lane."
- **Proof** (`tests/browser/keyboard-proofs.test.tsx`, C-B3W3-7 case, CDP-driven
  trusted Tab): the escape occurs, and the next Tab does **not** return focus to the
  dialog. Mechanism pinned in the suite header: the document-level keydown handler in
  `use-dismissable.ts` (`handleTab`) calls `first.focus()`, but Chromium's native Tab
  traversal completes *after* the handler returns and overrides the programmatic
  focus. The recapture branch is ineffective under real browser Tab — a real P2
  defect, not a test artifact. The test characterizes actual behavior and is written
  to accept a future strengthened trap (no escape in 10 presses) so the fix commit
  flips it rather than fights it.
- **Disposition**: DD-27 filed (`cc3058f4`), P2, owner C3, fix direction named
  (intercept Tab before traversal / capture-phase), expiration = recapture proven
  under trusted-event Tab or the edge documented as accepted. The wave-3 "self-healing"
  disposition is formally REVISED by this packet.

## B2 deferred keyboard proofs — both false-P1s now positively proven

B2's live checkpoint recorded a formal deferral ("PASS WITH DEFERRED PROOF"): the CDP
screenshot harness was unreliable for keyboard QA, two reported P1s were exonerated by
mechanism only, and trusted-event proof was deferred to D7. `keyboard-proofs.test.tsx`
retires that deferral with positive trusted-event proof:

1. **"ArrowDown closes the composer" (false P1 #1)**: click opens the panel
   (aria-expanded true); ArrowDown sets aria-activedescendant to the first option
   (Alice); the surrounding wrapper stays mounted and the combobox stays connected.
2. **"Enter not committing" (false P1 #2)**: Down+Enter calls onSelect exactly once
   with the first chat; Down,Down+Enter selects the second (not always-first);
   Escape closes without selecting. The jsdom-pinned "Down + Enter selects the first
   result" contract holds under `isTrusted: true` events.

DD-12's closure note ("D7 confirms trusted-event") is now backed by executed evidence.

## B5 animated path — exit motion, inert, toast (`25629451`)

- **Reduce context** (`b5-inert-toast.test.tsx`, runs in the main 76): modal removed
  with no closing dwell under prefers-reduced-motion (motion.md §9 — removed, not
  shortened); `#root` carries `inert` while a modal is open with *behavioral* proof
  (background `focus()` is a no-op, refocusable after close — jsdom can only check the
  attribute); the toast stack portals outside the inert subtree.
- **No-reduce context** (`vitest.browser.motion.config.ts` +
  `tests/browser-motion/b5-exit-motion.test.tsx`, fresh 3/3): modal shell carries
  `data-state="closing"` with computed `animation-name: soup-modal-shell-out` and is
  removed within a bounded window; closing backdrop computes `pointer-events: none`
  (motion.md §10); drawer closing dwell with `soup-drawer-out`, bounded removal.
- **C-B5-7 standing**: the motion config is deliberately NOT in `test:browser` or CI
  pending the gate-placement decision — recorded, not silent.
- **DD-19 note**: the register row's expiration condition ("paired exit motion + inert
  background") now has committed implementation (`25629451`) plus browser proof (above,
  reproduced fresh). This packet's register scope is DD-10/DD-18r only — the DD-19
  closure flip is the integrator's, with this packet citable as the evidence.

## CI wiring (`8c26fbb1`)

`quality.yml`: `npx playwright install chromium --with-deps` + `npm run test:browser`
placed after the design gates, root deps only (the step order the packet verified in
§0.4), running on BOTH Node matrix legs (24.x/25.x). The trusted-event proof surface is
exercised in CI for the first time. NOT delivered from the packet's CI plan: the
playwright browser cache (≈170MB download per leg per run) and the failure-screenshot
`upload-artifact (if: failure())` step — both named in omissions.

## Omission audit (each item triaged, none silent)

- **drawer-squeeze suite NOT delivered.** The packet's `drawer-squeeze.test.tsx`
  (899/900 container flip, computed `position` + scrim) does not exist;
  `viewport-matrix.test.tsx:46` points at it — a stale pointer.
  `primitives-drawer.test.tsx:382` INCONCLUSIVE still stands. Carried on the narrowed
  DD-18r row (deterministic drawer-flip case). The manifest Drawer row stays PASS on
  its live-measured evidence (c2-3); only the *deterministic* backstop is missing.
- **focus-ring suite NOT delivered.** The §8.4 battery (per-primitive ring resolution
  vs `--focus-ring` in BOTH themes; composer box-shadow recipe; focused-tab-inside-
  scrollport) does not exist. What exists: the smoke's single `:focus-visible` Button
  proof. Follow-up owed to the D7 lane; integrator to schedule or file debt (no
  existing register row owns it; this packet's register scope is DD-10/DD-18r).
- **Honesty-label upgrades NOT delivered.** The six jsdom files' INCONCLUSIVE/
  class-only disclaimers (§3/§8.5) are unedited — e.g. `primitives-drawer.test.tsx:20`,
  `primitives-table.test.tsx:356` still point at "manual QA + D7" generically instead
  of the resolving browser case. Comment-only edits; follow-up owed.
- **Inbox matrix rows not yet written** though C-D7-4's blocker (B4) has landed —
  unblocked follow-up, carried on the narrowed DD-18r row.
- **DD-23 popover bottom-fold case not added.** The register row is now filed
  (`c82fb3cc`) with phase D7; the packet's rule was to add the 1440×500 popover-near-
  fold case when filed. Not yet done; DD-23 remains open with its expiry intact.
- **C-D7-2 live-checkpoint glance unrecorded.** Packet §2 left chip-row spacing
  INCONCLUSIVE until a live glance after the ::before band; no record of that glance
  exists in any commit or log entry found by this packet.
- **CI cache + failure-screenshot artifact upload** missing (above).
- **Explicit non-claims** (packet §14 discipline): DD-18r is NOT claimed closed — only
  its deterministic-tests leg, and only partially (Fleet/LineDetail/Ops). The
  log-stream aria-live INCONCLUSIVE (`primitives-log-stream.test.tsx:314`) is NOT
  claimed resolved — announcement semantics are not a geometry fact. The toolbar
  roving-arrow-keys deviation (manifest Toolbar row) is NOT covered by these suites.

## Unverifiable / overclaimed statements found (strong-claim audit)

| Claim | Status |
|---|---|
| Commit `253df9f7` message: "…revealed row actions" measured | **OVERCLAIM** — no row-action case exists in target-size.test.tsx (10 sections, none cover revealed row actions); the 37 measured cases are as listed above |
| `viewport-matrix.test.tsx:46`: squeeze "proved in drawer-squeeze.test.tsx" | **FALSE POINTER** — file does not exist (suite not delivered) |
| `b5-inert-toast.test.tsx` header enumerates 4 proofs | file carries 3 tests; the opener-refocus ordering proof (C-B5-4) is in the jsdom suite (`primitives-modal.test.tsx`, `25629451`), not here |
| b5-inert-toast "toast dismiss button is clickable" test name | **NAME/ASSERTION MISMATCH** — the test verifies the toast stack portals outside `#root` via a conditional (`if (toastStack)`); no dismiss click is exercised; vacuous-pass possible if the portal target is absent |
| viewport-matrix fallback branches (`if (!root) return;` overflow cases; empty-state `rowEls.length < 20` fallback at 1023) | soft paths that can pass without measuring the named fact — acceptable as written only because the primary branch is the one exercised today; flagged for the test-integrity lane |
| b5-exit-motion animation-name asserts are `if (closingShell)`-conditional | terminal removal asserts are unconditional, so each test ends on a hard assertion; the keyframe-name claims are best-effort |
| viewport-matrix header: spread-actual factories "do NOT work" under the browser mocker | **OVERBROAD** — the smoke gate's importOriginal-spread mock works in its file; the observed breakage was on the page-harness module set |
| "Suite 2,296 green" (`25629451`) | integrator record; not re-run for this packet (browser surfaces only were re-run fresh) |

## Debt register delta (this packet edits DD-10 and DD-18r only)

| ID | Change |
|---|---|
| DD-10 | **NARROWED** — computed-box battery delivered (37 measurements, `253df9f7`; C-D7-2 expansion `0bc340a4`); remaining: sort-button below-floor fix + bottom hit-extension proof or ruling |
| DD-18r | **NARROWED** — deterministic-viewport-tests leg delivered for Fleet/LineDetail/Ops, in CI; remaining legs re-scoped incl. the now-unblocked Inbox matrix rows and the undelivered drawer-flip case |
| DD-27 | (cross-reference) filed by this lane's falsification (`cc3058f4`); row untouched here |
| DD-19 | (note only) closure evidence now exists (`25629451` + browser proofs); flip is the integrator's call |

## Conformance manifest delta

**No rows flip to PASS.** The manifest's PASS bar is "decision implemented and proven";
the D7 evidence narrows two INCONCLUSIVE rows and *prevents* one premature flip:

- **24px target floor**: the missing evidence class (computed boxes) now exists — but
  the battery measured a live violation (sort buttons ~16px) and a partial hit-area
  proof. Row stays INCONCLUSIVE with the cell rewritten to name exactly those two
  gaps. Flipping it on "evidence exists" while the evidence shows a violation would be
  the Stage E defect the completion rule names.
- **Responsive layout rules**: cell rewritten — deterministic viewport tests now exist
  for Fleet/LineDetail/Ops (cited), the stale "LineDetail header/tabs overflow" item
  removed (closed at B1 per the register), remainder re-scoped to match the narrowed
  DD-18r. Stays INCONCLUSIVE while named DD-18r legs remain open.
- **Rows deliberately NOT flipped** (missing evidence named): reduced-motion row
  (DD-20 is register-closed via App.tsx MotionConfig, but no suite proves Framer
  springs honor the preference — flip needs that proof or an integrator citation
  decision); modal-law row note still says DD-19 open (PASS already; note refresh
  rides the integrator's DD-19 decision); toolbar row's roving-arrow deviation (not
  covered by these suites); brand/nameplate/tick/80ch/glass/ok-breathing/enforcement
  rows (C3/C4/C5 work, untouched by browser evidence).

Tally unchanged: **14 PASS · 7 INCONCLUSIVE · 3 PENDING.**

## Verdict: **PASS WITH DEFERRED DEBT.**

Everything committed is green and was reproduced fresh by this packet (76/76 + 3/3);
the harness performed its designed function — it falsified a packet-recorded claim
(C-B3W3-7 → DD-27), retired B2's deferred proof debt, measured DD-10's floors for
real, and put the trusted-event surface in CI. The deferral set is explicit and owned:
the two DD-10 findings, the DD-18r remainder (Inbox rows now unblocked, drawer-flip
case), the focus-ring battery, the honesty-label edits, the DD-23 fold case, the CI
cache/artifact steps, and the unrecorded C-D7-2 glance. None are silent; each is named
on a register row, in this omission audit, or in the flip-refusal list above.
