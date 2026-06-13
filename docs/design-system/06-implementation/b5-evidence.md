# Slice Evidence — B5 (motion polish: exit presence + background inert + toast portal)

Worktree `soup-impl` @ `feat/soup-v3-foundation`, verified at HEAD `da0c33a7` (clean tree at
packet time). Gate packet: `b5-investigation.md` (Ready with Constraints, `fab8a11c`). Closes
DD-19 (register flip already landed at `b966fd84`/`8b2127bd`; this packet is the consolidated
B5 evidence those flips cite forward). Live-QA law for this round: `visual-qa-b-stages.md`
rows 13–14.

## Commits

| Commit | What | Where |
|---|---|---|
| `fab8a11c` | B5 investigation packet (Ready with Constraints) | design docs |
| `25629451` | exit motion (use-exit-presence) + refcounted background inert (use-background-inert) + toast portal + browser-motion config/suite + jsdom closing/inert pins (10 files, +1,024/−50) | impl |
| `d80e9726` | D7 browser suites incl. `tests/browser/b5-inert-toast.test.tsx` (3 tests, reduce context) | impl |
| `b966fd84` | D7 evidence packet — fresh 76/76 + 3/3 runs; DD-19 closure evidence; register flip | design docs |
| `889bff89` | B5 hook unit suites (42 tests; coverage-floor breach closed; DD-30 found) | impl |
| `4fbad4ef` | D7 residue — b5-inert-toast vacuous toast test strengthened to unconditional assertions; CI playwright cache + failure-screenshot artifacts; commit record: "Browser suite 93/93 across 5 files; jsdom 2,376 green" | impl |
| `8b2127bd` | DD-30 filed; B-stage register truth-up | design docs |
| `c82fb3cc` | DD-25 (toast motion literals) filed | design docs |

Commit set confirmed via
`git -C <soup-impl worktree> log --oneline -i --grep="b5\|exit-presence\|background-inert\|inert\|toast"`.

## Fresh runs executed by this packet (2026-06-12, HEAD `da0c33a7`)

| Command | Result |
|---|---|
| `cd <soup-impl worktree> && npx vitest run tests/console/use-exit-presence.test.tsx tests/console/use-background-inert.test.tsx --pool=forks` | **42/42** — use-exit-presence 24, use-background-inert 18 (2 files, 1.78s) |
| `npx vitest run tests/console/toast.test.tsx tests/console/use-toast.test.tsx tests/console/primitives-modal.test.tsx tests/console/primitives-drawer.test.tsx --pool=forks` | **87/87** — toast 13 · use-toast 15 · primitives-modal 37 · primitives-drawer 22 (portal/exit/inert adjacency all green) |
| `npx vitest run --pool=forks` (full repo, = the CI "Test suite" step) | Tests **10,114 passed / 1 skipped**; **Test Files 1 FAILED** — `tests/browser-motion/b5-exit-motion.test.tsx` fails at collection under the default config (finding F-B5-1 below); plus 4 unhandled `ReferenceError: EventSource is not defined` errors from `add-line-wizard.test.tsx`/`LinkStep.tsx:41` (file itself passes; not B5-owned, routed below) |

**Browser suites — proof-of-record, NOT re-run by this packet** (per tasking: no browser
launches). The committed wiring: root `package.json:76` `"test:browser": "vitest run --config
vitest.browser.config.ts"` (include `tests/browser/**`, chromium, `reducedMotion: 'reduce'`
context — `vitest.browser.config.ts:83,96`); `.github/workflows/quality.yml` steps "Cache
Playwright browsers" → "Install Playwright chromium" → "Browser test suite" (`npm run
test:browser`) → "Upload browser test failure screenshots". Recorded results, labeled as
records: d7-evidence.md fresh runs **76/76 + 3/3** (reproduced integrator-independent from an
unmutated clone at `b260800e`); commit record `4fbad4ef` **"Browser suite 93/93 across 5
files"** after the Inbox/drawer-flip rows landed; visual-qa-b-stages.md row 14 cites the same
**93/93 + 3/3** as the canonical B5 motion/toast proof. The branch is push-gated, so these CI
steps have not executed on GitHub for these commits — the wiring is committed, the recorded
runs are local.

## Architecture delivered (what the packet certifies)

- **`console/src/hooks/use-exit-presence.ts`** (180 ln, new): phase machine
  `open | closing | unmounted`; on open→false reads
  `getComputedStyle(shell).animationDuration` (`:110`), unmounts on FIRST of guarded
  `animationend` (`:140–144`) or a computed-duration + 50ms fallback timer armed after a rAF
  re-read (`:148–156`); empty/0 duration → synchronous instant unmount (`:112–115`).
- **`console/src/hooks/use-background-inert.ts`** (31 ln, new): module-level refcount
  (`:2–17`), `setAttribute('inert','')` on 0→1 / `removeAttribute` on 1→0, applied to `#root`;
  release lives in effect cleanup (`:19–23`); `_resetInertCount` test seam (`:25–31`).
- **`Modal.tsx`**: real `open` still drives `useDismissable` (`:107–109` — Escape deregisters,
  trap disarms, focus restores at close-start); `useBackgroundInert(open)` (`:111–112`);
  `useExitPresence` gates mount (`:114–118`); backdrop + shell carry `data-state={phase}`
  (`:134,143`); docblock corrected (the pre-B5 "Enter/exit CSS classes" overclaim and the
  garbled line-16 fragment are gone — `:11–24` now describe shipped behavior).
- **`Drawer.tsx`**: `useExitPresence` with `soup-drawer-out` (`:101,159`); scrim and shell ride
  `data-state` (`:173,182`); NO inert (exception docblock `:25–31`); docblock's old
  "exit does not play" admission replaced with shipped behavior (`:18–23`).
- **`primitives.css`**: closing selectors `:354–362` (backdrop `--dur-fast --ease-linear` +
  `pointer-events: none`; shell `--dur-fast --ease-exit`); exit keyframes `:444–458` (reverse
  of enter: fade + translateY(8px) + scale(0.985)); reduced-motion kill extended to closing
  state `:462–469`; drawer closing `:1288–1295` (`--dur-base --ease-exit`, scrim
  `pointer-events: none`), keyframe `:1326`, reduced-motion `:1339–1343`.
- **`use-toast.tsx`**: stack portals to `document.body` (`:73–75`) with the rationale comment
  naming C-B5-3 and the deliberate DD-25 non-fix (`:39–43`).
- **`vitest.browser.motion.config.ts`**: no-reduce context (`context: {}`, `:75`), separate
  include `tests/browser-motion/**` (`:64`), deliberately unwired (header `:13–19`).

Because B3 waves 3–4 completed the dialog burn-down after B5 landed (ad-hoc-modal shadow set
EMPTY), every dialog surface in the console now inherits exit motion + background inert
through the one Modal primitive — the "legacy shells unaffected" carve-out in the packet §9.8
has since emptied itself.

## C-B5-* constraint verification

| Constraint | Status | Evidence (file:line) |
|---|---|---|
| **C-B5-1** jsdom instant path; zero consumer-suite diffs | **MET** | Hook: `use-exit-presence.ts:110–115` (parse `""`/`0s` → return before any closing state; doc `:18–21`). Pins: `primitives-modal.test.tsx:512–533` (open→false removes dialog synchronously, backdrop gone), `primitives-drawer.test.tsx:502+` analog, `use-exit-presence.test.tsx:461–492` (component-fixture instant path incl. initial-closed). Zero-diff: `25629451` diffstat touches only `primitives-modal/drawer` test files — no consumer suite edited; all 7 Modal-consumer suites + SoupKitchen are inside the 10,114 green of this packet's full run |
| **C-B5-2** Drawer inert exception recorded | **MET** | `Drawer.tsx:25–31` exception docblock (non-modal `role="complementary"`, renders inline in `#root`, squeeze keeps table live); Drawer imports (`:45–56`) carry `useExitPresence` but NOT `useBackgroundInert`; DD-19 closed row records "drawer holds the documented non-modal exception" |
| **C-B5-3** toast portal in the inert commit; suites survive | **MET** | `use-toast.tsx:73–75` body portal, `:39–43` rationale; same commit `25629451` as inert. Browser proof: `b5-inert-toast.test.tsx:131–176` — toast fired while modal open, `#root` inert, stack portal exists (unconditional `not.toBeNull()`) and `root.contains(toastPortal)===false` (strengthened from the D7-recorded vacuous version at `4fbad4ef`). Toast suites unedited and fresh-green (13 + 15) |
| **C-B5-4** inert release precedes focus restoration | **MET** | Release-on-cleanup: `use-background-inert.ts:19–23`; React runs cleanups before setups in the same commit (design per packet §5.4; `Modal.tsx:18,111–112`). Pins: `primitives-modal.test.tsx:776–823` (opener inside a `#root` fixture regains focus on Escape-close with inert machinery active), `use-background-inert.test.tsx:231–261` (end-state pin — its own comments honestly state it cannot interleave effect order), browser `b5-inert-toast.test.tsx:82–124` (focus refusal under inert, refocusable after close, in-engine). Honest bound: the literal opener-refocus-in-browser case is jsdom-only — recorded in d7-evidence's strong-claim audit (header enumerates 4 proofs, file carries 3) and still true |
| **C-B5-5** refcounted, StrictMode-symmetric inert | **MET** | `use-background-inert.ts:2–17` module counter, over-release guard `:11`; P1-2 stacked-modal pin extended: `primitives-modal.test.tsx:727–773` (close top → still inert; close both → released); `use-background-inert.test.tsx:121–229` (2-deep, 3-deep, unmount-while-open, refcount-never-negative), `:350–398` StrictMode symmetric |
| **C-B5-6** guarded animationend (target + name) | **MET** | `use-exit-presence.ts:140–144`; expected names pinned at call sites (`Modal.tsx:92` `soup-modal-shell-out`, `Drawer.tsx:101` `soup-drawer-out`). Pins: `use-exit-presence.test.tsx:256–355` (matching name unmounts; child-target does NOT; wrong-name arm documented), `primitives-modal.test.tsx:597–631` (bubbling child animationend does not unmount). jsdom limit held honestly: jsdom has no `AnimationEvent`, so the wrong-name arm is browser-territory — pinned by an explicit labeled test (`primitives-modal.test.tsx:633–641`) and by the browser-motion suite's computed `animation-name` asserts |
| **C-B5-7** separate no-reduce motion lane; existing reduce context untouched | **MET WITH DEVIATION + 1 NEW DEFECT** | Config delivered: `vitest.browser.motion.config.ts:64,75` (separate include, no-reduce context); `vitest.browser.config.ts:96` still `reducedMotion: 'reduce'` (untouched). Deviation (recorded, not silent): the packet asked "config file + script"; no `test:browser:motion` npm script exists — the config header `:13–19` records the deliberate non-wiring pending the gate-placement decision and gives the manual invocation (`npx vitest run --config vitest.browser.motion.config.ts`); execution log and d7-evidence both record the same standing. NEW DEFECT found by this packet: **F-B5-1** below — the lane leaks into the DEFAULT config |
| **C-B5-8** live checkpoint, both themes | **MET BY RECORDED DISPOSITION, perceptual leg open** | visual-qa-b-stages.md row 13: **PASS** — inert behavioral live observation (nav theme toggle suppressed while GroupDetailModal open, fires after close; by-design). Row 14: B5 toast/exit motion **delegated** to the committed browser suites (93/93 + 3/3) rather than re-proven manually — the matrix's recorded disposition for this round. The §8.3 perceptual checks (120ms "accelerate away" read, squeeze-snap feel, both-themes scrim fade as scrim *fade*) were NOT eyeballed — named in the omission audit, routed to the C3 per-screen polish passes |
| **C-B5-9** duration-stub seam without public props | **MET** | No motion/duration prop added: `Modal.tsx:51–81` props are open/onClose/size/dismissable/children/initialFocus/labelledById; Drawer props unchanged. Seam = inline `animation-duration` style on the shell (`primitives-modal.test.tsx:537–548` with the C-B5-9 citation in-comment) and a persistent-ref element for the hook suite (`use-exit-presence.test.tsx:84–93`); the duration resolver stays un-exported |

## Finding F-B5-1 (new, found by this packet's full-suite run) — default vitest config collects the motion lane

`vitest.config.ts:32–35`: `include: ['tests/**/*.test.ts(x)']` with
`exclude: ['tests/browser/**']`. The glob `tests/browser/**` does **not** match
`tests/browser-motion/**`, so the full-repo run collects `b5-exit-motion.test.tsx` in the
forks pool and fails:

```
FAIL  tests/browser-motion/b5-exit-motion.test.tsx
Error: @vitest/browser/context can be imported only inside the Browser Mode. Your test is
running in forks pool. Make sure your regular tests are excluded from the "test.include"
glob pattern.
```

Reproduced fresh at HEAD `da0c33a7`: `Test Files 1 failed | 601 passed | 1 skipped`,
`Tests 10114 passed | 1 skipped`. Introduced by `25629451` (created `tests/browser-motion/`
without extending the jsdom exclude). Why it stayed invisible: every recorded battery ran the
**console** suite by path (directives §3), which never collects the directory, and the push
gate has kept the CI "Test suite" step (`npm test -- --pool=forks`, quality.yml) from ever
running on this branch. Impact: `npm test` at repo root fails today; CI would go red on first
push. Fix is one line (add `'tests/browser-motion/**'` to the exclude); not applied by this
packet (docs-only write). **Blocking-before-push; owner: integrator, next impl commit.**

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Spec fidelity (motion.md) | **PASS** | Durations/easings are the law's: modal 180 in / **120 out** (`--dur-fast --ease-exit`, scrim linear out in parallel — motion.md §1 table "modal exit", §2 "exits faster than entrances — law", §5 modal anatomy "fade + slight scale (0.985) + 8px rise"; modal.md §States "close (exit): --dur-fast --ease-exit"; CSS `primitives.css:354–362,449–458`); drawer **180 out** `--dur-base --ease-exit` (motion.md §1 "drawer exit"; drawer.md "exit: --dur-base --ease-exit — faster out; visibility gated after transition"; CSS `:1288–1295`). Tokens real (`tokens.primitive.css:116–121`); zero new time literals in the slice (DD-25's pre-existing toast literals deliberately untouched). Properties transform+opacity only (§3 allowlist). §9 off-and-instant: CSS kill extended to closing state (`:462–469,1339–1343`) + the hook's zero-duration read — one source of truth, no `matchMedia` in TSX. §10 non-blocking: closing backdrop/scrim `pointer-events: none` (`:356,1295`), pinned in the browser-motion suite |
| Code quality | **PASS with disclosed dead mechanism (DD-30)** | Hooks are small, documented, StrictMode-symmetric, cleanup-complete (timer + listener + rAF all cleared, `use-exit-presence.ts:158–168`). **DD-30 disclosure (not hidden):** the `cancelClosingRef` reopen-cancel branch (`use-exit-presence.ts:88–98`) is structurally dead — the open=false effect's cleanup nulls the ref (`:160`) before the open=true branch checks it (`:95`); actual reopen-cancellation works via the cleanup's `cancelled=true`. Found by the `889bff89` suite analysis, documented in the suite header (`use-exit-presence.test.tsx:24–37`), filed as DD-30 (owner C3: browser round-trip reopen-mid-dwell proof, then delete or fix — not a blind delete). The hook docblock (`:14–16`) still describes the ref mechanism as live — a doc/code tension that rides the DD-30 cleanup. Minor seam noted: `_resetInertCount` is a test-only export in a production module (`use-background-inert.ts:25–31`) — the accepted price of module-level refcount state, mirrored from the `_overlayStack` precedent. One source suppression, rationale + expiry carried: `use-exit-presence.ts:169` (`exhaustive-deps`, intentional open-only dependency, expires 2026-12-31) |
| Test integrity | **PASS with named caveats** | 42 hook tests fresh-green; appended-whole describe blocks per directives §3. Suppressions: 2 total, both with rationale + expiry 2026-12-31 (`use-exit-presence.ts:169`; `b5-inert-toast.test.tsx:145` fire-once harness). The D7 packet's strong-claim audit items stand acknowledged, with one since FIXED: the vacuous "dismiss button clickable" toast test was strengthened to unconditional portal assertions at `4fbad4ef`; still standing: the `b5-inert-toast.test.tsx` header enumerates 4 proofs over 3 tests (the C-B5-4 opener-refocus pin lives in jsdom), and the browser-motion keyframe-name asserts are `if (closingShell)`-conditional with unconditional bounded-removal terminals. NEW caveats this packet adds: (a) the browser reduced-motion exit test (`b5-inert-toast.test.tsx:56–74`) unmounts via `cleanup()` rather than `rerender(open=false)` — it would pass even if a dwell existed, so the no-dwell-under-reduce claim really rests on the hook's instant path (jsdom-pinned) + the CSS kill, not on this test; (b) the jsdom closing-phase tests carry documented dual-outcome conditionals (`primitives-modal.test.tsx:559–564` — rAF timing makes both outcomes valid in jsdom), with the deterministic versions living in the hook suite under stubbed durations and fake timers; (c) one explicitly labeled INCONCLUSIVE test pins the jsdom AnimationEvent limit (`:633–641`) — honest, not theatre. No assertion inversions; no deleted coverage (toast suites byte-stable through the portal move) |
| A11y / reduced motion | **PASS** | Inert is behaviorally proven in-engine (focus refusal + post-close refocusability, `b5-inert-toast.test.tsx:82–124`; live row 13). Toast live region (`role="alert"`/`aria-live`, Toast.tsx) portals outside the inert subtree so alerts are never silenced and dismiss stays reachable (C-B5-3 proof). Focus trap untouched (`use-dismissable` consumed as-is — packet §5.3 double-protection holds); restoration ordering pinned (C-B5-4). Reduced motion is off-and-instant both ways with one SSOT (CSS media kill + zero-duration read; d7-evidence records the reduce-context run green). Drawer exception is an a11y POSITIVE: inerting `#root` would have inerted the inline drawer itself and contradicted the squeeze rule's live-table contract |
| Visual / live QA | **PASS per matrix, perceptual leg routed** | visual-qa-b-stages.md row 13 PASS (by-design inert observation live, both-themes frames in the round); row 14 delegates exit/toast motion to the committed suites (93/93 + 3/3) as canonical proof. The animated dwell is machine-verified (computed `animation-name`, dwell, bounded removal, `pointer-events: none`) under the no-reduce config — what the matrix could not have eyeballed deterministically. Remaining human judgment (does 120ms read as "accelerate away"; squeeze snap feel; scrim fade quality in both themes) is NOT claimed — routed to C3 per-screen polish passes |

## Omission audit (each item named, none silent)

- **F-B5-1** (above) — the one defect: default-config collection of the motion lane breaks
  full-repo `npm test`. Blocking-before-push; integrator one-liner.
- **Escape-while-closing jsdom pin NOT delivered** (packet §8.1 planned it). Compensating
  structure: `useDismissable` receives the real `open` (`Modal.tsx:107–109`), so the closing
  modal deregisters from the Escape stack at close-start by construction, and the stacking
  single-fire pins (`primitives-modal.test.tsx:270+`, drawer stack tests) cover the stack
  contract. The specific during-dwell behavior is exercised nowhere — candidate case for the
  DD-30 browser round-trip suite (same mid-dwell apparatus).
- **C-B5-7 script leg not delivered** — deviation recorded in the config header and execution
  log; manual `npx` invocation documented; gate-placement decision (CI wiring of the motion
  lane) still pending with the D7 lane.
- **C-B5-8 perceptual checks not performed manually** — row 14's delegation is the recorded
  disposition; the feel-level checks ride C3 polish.
- **DD-25 deliberately not fixed** — the toast portal commit changed mounting only; the
  hardcoded `duration: 0.25` + non-token bezier (`use-toast.tsx:56`) remain, per the packet's
  scope discipline (§13). Register row's "cleanup phase: B5" is now stale — delta below.
- **`b5-inert-toast.test.tsx` header still enumerates 4 proofs over 3 tests** — comment-only
  correction owed (already on the d7-evidence record); the C-B5-4 browser opener-refocus case
  remains unwritten.
- **Hook docblock vs DD-30** — `use-exit-presence.ts:14–16` describes the dead cancel-ref as
  live; correct alongside the DD-30 resolution.
- **Not B5-owned, observed by this packet's full run:** 4 unhandled
  `EventSource is not defined` errors from `LinkStep.tsx:41` under jsdom
  (`add-line-wizard.test.tsx` passes; vitest counts them as run errors). Routed to the B3w4/C3
  wizard surface owner for an EventSource stub or guard.
- **jsdom limits held, not papered over:** inert *behavior* (focus/click suppression) and real
  animation timing are browser-lane facts; jsdom pins attribute/data-state contracts only —
  labeled in the suites.
- **Coverage:** the two hooks sit at 88.5% / 100% statements (`889bff89` record) — remaining
  use-exit-presence gap = SSR guards + the DD-30 dead branch, both named there.

## Debt register delta (PROPOSAL ONLY — register edits belong to the integrator)

| ID | Proposed change |
|---|---|
| DD-19 | **Already CLOSED** (`b966fd84` flip on the D7 evidence; closing row cites impl commit, jsdom pins, browser-motion 3/3, drawer exception). Proposal: append `b5-evidence.md` to the closed row's evidence column as the consolidated packet. Closure proof re-verified here: exit machinery + inert + toast portal all confirmed in source at HEAD with fresh 42/42 + 87/87 runs |
| DD-25 | **Stays OPEN.** Row currently says cleanup phase "B5" / "alongside the exit-motion slice" — stale now that B5 closed without it (deliberate, packet §13). Proposal: re-home to **C3 polish pass** (P3 unchanged); expiration condition unchanged ("toast motion reads tokens and honors reduced motion") |
| DD-30 | **Stays OPEN, owner C3 — recorded by this packet as a known open item, not hidden.** The structurally-dead `cancelClosingRef` mechanism (`use-exit-presence.ts:160` nulls before `:95` checks) needs the browser round-trip reopen-mid-dwell proof before delete-or-fix; jsdom cannot exercise it. Proposal: add the escape-while-closing case and the hook docblock correction to the same C3 work item |
| NEW (propose **DD-31** only if not hotfixed in the next impl commit) | F-B5-1: `vitest.config.ts:35` exclude misses `tests/browser-motion/**` → full-repo `npm test` / CI "Test suite" step fails at collection. Preferred resolution is the immediate one-line integrator fix + a fresh full-run proof, making a register row unnecessary; if it must wait, file it P1, blocks push |

## Verdict: **PASS WITH DEFERRED DEBT.**

All nine C-B5 constraints verified against source at HEAD with fresh test runs (42/42 hook
suites, 87/87 adjacent suites); DD-19's expiration condition is met and the register flip
stands; the animated path's proof-of-record is the committed browser suites (93/93 + 3/3,
recorded — not re-run here). The deferred debt is named and owned: **F-B5-1 (one-line vitest
exclude fix, blocking before any push — the only item that must not wait)**, DD-25 re-homed to
C3, DD-30 + escape-while-closing + docblock/header corrections bundled to C3, the motion
lane's CI gate-placement decision with the D7 lane, and the C-B5-8 perceptual leg riding the
C3 polish passes. No overclaims: browser results are cited as records, jsdom limits are
labeled, and the one defect this packet found is reported, not absorbed.

---

## Integrator addendum (2026-06-12, post-packet)

Both defects this packet surfaced were resolved the same evening in soup-impl commit
`76012b68` (immediately after merge `a4d8febc`, which absorbed origin/main's vitest 4
migration):

- **F-B5-1 RESOLVED** — `vitest.config.ts` exclude now lists `tests/browser-motion/**`
  alongside `tests/browser/**`. Fresh full-repo proof at `76012b68`: 601 files /
  10,148 tests passed, zero collection failures. Per this packet's preferred
  resolution, no DD-31 register row is filed.
- **EventSource unhandled rejections RESOLVED** — `add-line-wizard.test.tsx` now stubs
  a minimal inert `EventSource` (jsdom has none); LinkStep's SSE behavior remains
  pinned by its own suite's controllable FakeEventSource. Fresh run: zero unhandled
  errors.

Browser proofs re-validated under the vitest-4 stack (vitest 4.1.8 +
@vitest/browser-playwright 4.1.8 + vitest-browser-react 2.2.0, async render/rerender):
browser 93/93, motion 3/3 — the C-B5 records cited above now have a current-stack
re-run behind them.
