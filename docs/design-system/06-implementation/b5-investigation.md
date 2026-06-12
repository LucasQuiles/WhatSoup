# B5 Investigation Packet — D5 motion polish: paired Modal/Drawer exit motion + background inert (DD-19)

Pre-implementation packet required by the A0 gate (program-directives §3). Implementation is
blocked until this packet carries a `Ready` or `Ready with Constraints` verdict. Scope is the
two legs of DD-19: (1) paired exit motion for the Modal and Drawer primitives (both currently
unmount instantly on close), and (2) background inert while a modal is open. Target register
delta: DD-19 closes per its own expiration condition — "paired exit motion + inert background
or documented exception" — with the Drawer inert leg taken as the documented exception (§5.5).

## 1. Gate 0 output

Packet drafted read-only against `soup-impl` @ `feat/soup-v3-foundation` HEAD `c3b1ac52`
("land vitest browser mode + trusted-event smoke gate (D7)"), 2026-06-12. Standing facts at
this HEAD, each re-verified in source:

- B3 wave 2 is landed: ConfigEditDialog and ScheduleComposerModal consume the Modal primitive.
  The full migrated-consumer set is exactly 7 files (grep `<Modal\b`): ConfirmDialog,
  RelinkModal, KeyboardShortcutsHelp, SaveContactDialog, ScheduleComposerModal,
  CreateGroupModal, ConfigEditDialog. GroupDetailModal, UpdateModal, and AddLineWizard are
  still legacy shells — they do NOT consume the primitive and are untouched by this slice
  (their exit stays instant until B3 waves 3–4 migrate them; the parallel b3-wave3 lane owns
  that, file-disjoint from this slice — §3).
- The Drawer primitive has exactly 1 consumer: `console/src/pages/SoupKitchen.tsx`
  (FleetDrawer, 129–317; open-gated on inspected-line name, 354, 530–534).
- D7 is landed: `tests/browser/` exists (setup.ts + smoke.test.tsx) with its own
  `vitest.browser.config.ts` (playwright/chromium, sequential, `reducedMotion: 'reduce'`
  context — load-bearing for §8.2).
- DD-20's MotionConfig wrapper is landed at `console/src/App.tsx:59`
  (`<MotionConfig reducedMotion="user">`); the DD-20 register row itself is still OPEN (§16.4).
- The implementation worktree carries foreign-lane dirty files
  (`console/src/components/MessageBubble.tsx`, `tests/console/message-bubble-extended.test.tsx`)
  — not touched by this slice; integrator stages by explicit path per directives §3.

Standard gate 0 (worktree inventory, lint, full test run) executes at implementation start and
is recorded in the B5 evidence packet — this packet pins source facts, not run results.

**Empirics pinned for the test plan** (probed against the repo's own jsdom 29.0.1):
`window.matchMedia` is NOT a function in jsdom; `getComputedStyle(el).animationDuration`
returns `""`; the `inert` PROPERTY does not reflect to the attribute (`el.inert = true` leaves
`hasAttribute('inert')` false) — only `setAttribute('inert','')`/`removeAttribute('inert')`
behave correctly across jsdom and browsers. These three facts drive the mechanism (§4.2, §5.2)
and the jsdom-stability constraint (C-B5-1).

## 2. frontend-design pre-implementation checkpoint

**Visual changes recorded** (deliberate, to confirm at the live checkpoint — C-B5-8):

1. Modal close gains a visible exit: reverse of the enter (fade + slight scale + 8px drop),
   `--dur-fast` (120ms) `--ease-exit`; scrim fades out linear in parallel at `--dur-fast`
   (modal.md §States "close (exit): --dur-fast --ease-exit — faster out than in; scrim out
   linear fast"). Today close is a hard cut.
2. Drawer close gains a visible exit: `translateX(0 → 100%)` at `--dur-base` (180ms)
   `--ease-exit` (motion.md §1/§5: drawer 280 in / 180 out). In squeeze mode the table
   reflows wider on unmount as a snap — sanctioned by drawer.md squeeze rule 1 ("the table
   reflow snapping at open/close under the compositor budget; either way row internals never
   tween").
3. No geometry, color, type, or anatomy changes anywhere. No enter-motion changes. Reduced
   motion remains off-and-instant both ways (§6).
4. Background inert is non-visual (a11y/interaction containment); no scrim or dimming change.

Motion-budget audit: both exits classify as **enter/exit** per motion.md §4 (structural, not
decorative); properties are transform + opacity only (§3 allowlist — no waiver needed);
durations and easings are existing tokens (`tokens.primitive.css:116–121`); no new ambient
loops; exits do not block the next operator action (§10 — enforced by the closing-state
`pointer-events: none` contract, §4.3).

## 3. Files inspected and classification

| File | Class | Current invariant | B5 invariant | Changes? |
|---|---|---|---|---|
| `console/src/components/primitives/Modal.tsx` (195 ln) | producer | `if (!open) return null` (96) — instant unmount, exit never plays; portals to `document.body` (108–125); docblock OVERCLAIMS "Enter/exit CSS classes" (11) while honestly flagging inert as DD-19 (14–16, with a garbled orphan line 16) | adopts exit-presence hook (§4) + background-inert hook (§5); docblock corrected | YES |
| `console/src/components/primitives/Drawer.tsx` (261 ln) | producer | `if (!open) return null` (145) — instant unmount; NOT portaled — renders inline in the page tree (149–168); docblock states intended exit `--dur-base --ease-exit` (18–19) and honestly admits "exit transition does not play … DD-19" (22–24) | adopts exit-presence hook; docblock corrected; inert exception recorded (§5.5) | YES |
| `console/src/hooks/use-exit-presence.ts` | producer (NEW) | — | phase machine open→closing→unmounted; animationend + computed-duration fallback; instant when duration resolves 0/empty (§4.2) | NEW |
| `console/src/hooks/use-background-inert.ts` | producer (NEW) | — | refcounted `inert` attribute on `#root` while any modal is open (§5.2–5.3) | NEW |
| `console/src/hooks/use-dismissable.ts` (251 ln) | producer | "Reduced-motion neutral: no motion logic here; this hook is purely behavioural" (19); restoration fires on the open→false transition (218–230); Escape capture-phase document listener, stack-gated (196–214); trap scans the overlay container only (147–191) | **unchanged — consumed as-is** (motion stays out of it; §5.4 ordering analysis) | NO |
| `console/src/styles/primitives.css` | producer | modal enter keyframes + `forwards` (327, 340, 415–429); the exit seam is already reserved: "Exit animation — applied via class when closing (future enhancement); for now exits are instant" (349–350); reduced-motion kills enter only (432–437 modal, 1265–1270 drawer); drawer enter keyframe (1234, 1260–1263) | `soup-modal-shell-out`/`soup-modal-backdrop-out`/`soup-drawer-out` keyframes; `[data-state="closing"]` selectors; closing backdrop `pointer-events: none`; reduced-motion blocks extended to the -out animations | YES |
| `console/src/hooks/use-toast.tsx` (68 ln) | consumer | toast stack renders INSIDE `#root` (43–65, no portal); uses framer `AnimatePresence` with hardcoded `duration: 0.25` + non-token bezier (54) | stack portals to `document.body` so inert cannot silence it (§5.6, C-B5-3); motion literals NOT touched (debt entry, §13) | YES |
| `console/src/components/Toast.tsx` | evidence | `role="alert"` `aria-live="polite"` (41–42); auto-dismiss timer (35) | unchanged | NO |
| `console/src/main.tsx` / `console/index.html` | evidence | app renders into `#root` (main.tsx:19, index.html); `StrictMode` ON (main.tsx:20) — effects double-invoke in dev, so the inert refcount must be cleanup-symmetric; ToastProvider inside `#root` (24) | unchanged | NO |
| `console/src/App.tsx` | evidence | `MotionConfig reducedMotion="user"` (59) — governs framer surfaces only; UpdateModal (82–88) + KeyboardShortcutsHelp (89) both always-mounted at app level (stacking is reachable: "?" while the update modal is open) | unchanged | NO |
| `console/src/components/primitives/Popover.tsx` | evidence | panel portals to `document.body` (13, 225) "matching Modal/Drawer"; opts out of trap/autofocus (C-B2-1) | unchanged — unaffected by `#root` inert (§5.4) | NO |
| `tests/console/primitives-modal.test.tsx` | fixture | initial-closed pin (73–75); rerender-close flows; the P1-2 two-stacked-modals fixture (270–310) — the natural base for the inert refcount pin | NEW closing-phase, inert, refcount, restoration-ordering tests (§8.1) | YES |
| `tests/console/primitives-drawer.test.tsx` | fixture | initial-closed pin (99–103); retarget flow (288–313) | NEW closing-phase tests | YES |
| `tests/console/{toast,use-toast}.test.tsx` | fixture/consumer | pin current stack rendering | verified against the portal move; queries by role survive; any container-relative locator moves to document level | YES (verify at impl) |
| 7 Modal-consumer suites + SoupKitchen drawer coverage | evidence | close flows assert via `onClose` mocks or rerender-close | **must show ZERO diffs** on the jsdom instant path (C-B5-1) | NO |
| `tests/browser/` + `vitest.browser.config.ts` | fixture/producer | chromium context pins `reducedMotion: 'reduce'` for geometry determinism (config comment + d7-investigation §6.1) | NEW browser proofs (§8.2); animated-exit proofs need a separate no-reduce config (C-B5-7) | YES (additive) |
| `vitest.browser.motion.config.ts` + package.json script | producer (NEW) | — | no-reduce context for the animated-exit lane (§8.2) | NEW |
| `console/{eslint.config.shadow.mjs,lint-shadow-baseline.json}` | enforcement | primitives dir permanently exempt from shadow rules; `soup/motion-needs-reduced-variant` is a registered zero-fire stub (231) | NO baseline movement expected (§12) | NO |
| `docs/design-system/03-spec/{motion.md,components/modal.md,components/drawer.md}`, `06-implementation/design-debt-register.md` | spec/register | normative | register deltas at close (§13) | register only |

**Exact new files:** `use-exit-presence.ts`, `use-background-inert.ts`,
`vitest.browser.motion.config.ts`, 2–3 browser test files, the B5 evidence packet, this packet.
Any file beyond this table is added here before commit.

## 4. Exit motion — mechanism decision

### 4.1 CSS keyframes + deferred unmount — NOT AnimatePresence

The tasking's either/or is answered **CSS transition/animation with delayed unmount**, for four
reasons, each anchored:

1. **It is the established primitive idiom.** Both primitives animate enter via CSS keyframes
   consuming motion tokens (`primitives.css:340` modal `--dur-base --ease-enter`; `:1234`
   drawer `--dur-slow --ease-enter`), and the exit seam is already reserved in CSS as a class
   switch (`primitives.css:349–350`). The Drawer docblock describes its intended exit in CSS
   token terms (`Drawer.tsx:18–19`). Matching the Drawer idiom means CSS.
2. **The register prescribes it.** DD-19's reason field reads "exit animation needs
   unmount-delay machinery (Drawer follows Modal's unmount-on-close)" — unmount-delay around
   CSS, not an engine swap.
3. **Token SSOT.** motion.md §1: "Hardcoded time literals in CSS/TSX are lint findings."
   Framer transitions take numeric literals (the codebase's one `AnimatePresence` use,
   `use-toast.tsx:54`, hardcodes `duration: 0.25` and a non-token bezier — itself a debt
   finding, §13). CSS keyframes consume `--dur-fast`/`--ease-exit` directly.
4. **Reduced-motion SSOT.** The primitives' reduced-motion contract is the CSS media block
   (`primitives.css:432–437`, `1265–1270`); `MotionConfig reducedMotion="user"` (App.tsx:59)
   reaches only framer-driven surfaces and would create a second, parallel kill-path if the
   primitives moved to framer.

AnimatePresence is acknowledged as a live idiom in this codebase (toast stack) and rejected
for primitives on the grounds above — recorded so the live checkpoint does not re-litigate it.

The exit law applied (motion.md §1/§2/§5, modal.md §States, drawer.md §States & motion):
modal 180 in / **120 out** (`--dur-fast --ease-exit`, scrim linear out in parallel); drawer
280 in / **180 out** (`--dur-base --ease-exit`, "visibility gated after transition").

### 4.2 The presence machine (`use-exit-presence.ts`)

Phase state `'open' | 'closing'`, plus unmounted. On `open` true→false: phase → `closing`,
shell + backdrop get `data-state="closing"` (the CSS applies the `-out` keyframes, overriding
the `forwards`-filled enter animation). Unmount commits on the FIRST of:

- `animationend` on the shell, **guarded** by `e.target === shell && e.animationName` matching
  the expected `-out` name — `animationend` bubbles, and an unguarded listener would unmount
  early on any child animation finishing inside the shell (C-B5-6);
- a fallback timer armed from `parseFloat(getComputedStyle(shell).animationDuration)` plus a
  small buffer, computed AFTER `data-state="closing"` is applied.

**Instant path (load-bearing):** when the computed duration parses to `0`/empty, the hook
skips the closing phase and unmounts synchronously. This single rule covers BOTH
reduced-motion (the extended media block sets `animation: none` on the closing state →
computed duration `0s` → instant, exactly modal.md's "skip exit animation entirely — the v2
JS pattern" and motion.md §9's "per-component checks for JS-driven timing") AND jsdom (no
stylesheet → `""` → instant → every existing suite stays byte-stable, C-B5-1). No
`window.matchMedia` call — jsdom doesn't implement it (§1 empirics) and no stub is needed.

Re-open during closing (`open` false→true before unmount) cancels the timer/listener and
returns to `open` without remount (pin, §8.1). Timer and listener are cleaned on unmount.

### 4.3 What changes in each primitive

- `Modal.tsx:96` `if (!open) return null` → `if (!mounted) return null` from the presence
  hook; backdrop and shell carry `data-state={open ? 'open' : 'closing'}`.
  `useDismissable` keeps receiving the REAL `open` — so on close-start the Escape
  registration drops (196–214), the trap disarms, and focus restores immediately (218–230);
  the dying shell never captures input. The closing backdrop gets `pointer-events: none` in
  CSS so the operator's next click lands instantly (motion.md §10).
- `Drawer.tsx:145` same change. Scrim (153) rides the drawer's closing state.
- CSS: `soup-modal-shell-out` (reverse of `soup-modal-shell-in`: opacity→0,
  translateY(8px) scale(0.985)), `soup-modal-backdrop-out` (opacity→0, `--ease-linear`),
  both `--dur-fast`; `soup-drawer-out` (translateX(0→100%)), `--dur-base --ease-exit`;
  `forwards` fill so the end-state holds until unmount; the two reduced-motion blocks extend
  to the closing state.

## 5. Background inert

### 5.1 Which element

`#root` (main.tsx:19 / index.html), via a NEW `use-background-inert` hook wired into Modal.
The Modal portals to `document.body` (Modal.tsx:108–125), so `#root` is precisely "everything
that is not an overlay": Popover panels also portal to body (Popover.tsx:13, 225) and modal
shells are body children — none of them are inside the inert subtree. This satisfies
modal.md §Accessibility's "background content inert" with a single attribute on a single
stable element. Mechanism: `setAttribute('inert','')` / `removeAttribute('inert')` — the
attribute API, NOT the property, because jsdom 29.0.1 does not reflect the property (§1
empirics) and the attribute is what activates native behavior in browsers.

### 5.2 Refcount — stacked modals are real

Module-level acquire/release counter (same shape as the hook's `_overlayStack`,
use-dismissable.ts:36–48): attribute set on 0→1, removed on 1→0. Required because
modal-over-modal is sanctioned one level deep (modal.md §States "stacking") and reachable
today: ConfirmDialog (a migrated Modal consumer) is rendered from eight sites including
inside other dialog flows, and App.tsx always-mounts UpdateModal (82–88) and
KeyboardShortcutsHelp (89) side by side — "?" while the update modal is open stacks two
migrated modals. A naive boolean would un-inert the background when the TOP modal closes
under a still-open bottom modal. StrictMode is ON (main.tsx:20), so acquire/release must be
a symmetric effect-with-cleanup (double-invoke safe by construction).

### 5.3 Interaction with the focus trap — double protection, no conflict

The trap (use-dismissable.ts:147–191) scans ONLY the overlay container
(`getFocusableElements(container)`); it never reads `#root`, so inert changes nothing it
sees. The two mechanisms are complementary layers: the trap owns Tab-cycling within the
modal; inert removes the background from sequential focus, the accessibility tree, and
pointer targets (covering what the trap never could: AT virtual-cursor access and
programmatic focus into the background, e.g. the Cmd+K nav-search focus call no-ops while a
modal is open — an improvement, noted not redesigned). No conflict path exists.

### 5.4 Ordering with focus restoration — the one real hazard

`useDismissable` restores focus to the opener on the open→false transition
(use-dismissable.ts:218–230). The opener lives INSIDE `#root`; calling `.focus()` on an
element in an inert subtree is a no-op. So inert MUST be released before restoration runs.
Implementation shape that guarantees this without depending on hook order: the inert hook is
a single `useEffect` keyed on `open` whose CLEANUP releases the refcount — React runs all
effect cleanups for a commit before any setups, so the release always precedes the
restoration effect body in the same close commit. Pinned by a dedicated test (restoration
lands on the opener with the inert machinery active, §8.1). `aria-hidden` is NOT added
alongside (inert already removes the subtree from the a11y tree; redundant attributes are
drift surface).

### 5.5 Stacked overlays and the Escape stack

- **Modal + Popover** (live case: ChatPicker inside ScheduleComposerModal): the Popover panel
  portals to body — outside `#root`, unaffected by inert. Escape ordering is owned by the
  overlay stack (use-dismissable.ts:196–214) exactly as today: topmost (Popover) closes
  first, modal second.
- **Does inert break the capture-phase Escape stack? No.** The handler is a document-level
  capture listener (use-dismissable.ts:209). Keyboard events target the focused element,
  which the trap + initial-focus keep inside the modal portal (a body subtree, not `#root`);
  inert suppresses interaction WITHIN the inert subtree only and has no effect on document
  listeners. Even if focus escapes to `<body>`, keydown still dispatches through document
  capture. Asserted behaviorally in the browser lane (§8.2).
- **Escape during the closing dwell** goes to the next overlay down (the closing modal
  deregistered at close-start) — each press still closes exactly one layer
  (interaction-patterns §2 law preserved; a rapid double-Escape closing two layers ~120ms
  apart is correct behavior, not a defect).

### 5.6 The toast finding — inert would silence the live region

The toast stack renders INSIDE `#root` (use-toast.tsx:43–65, no portal) with `role="alert"`
`aria-live="polite"` (Toast.tsx:41–42), and consumers fire toasts WHILE modals are open
(e.g. ScheduleComposerModal validation toasts). Inert on `#root` would suppress those
announcements and dead-zone the toast dismiss buttons for the whole modal-open window — an
a11y regression introduced by this slice if unhandled. Fix IN this slice (C-B5-3): portal
the toast stack to `document.body`, the move Popover's own header comment already describes
as the overlay convention ("portals to document.body (matching Modal/Drawer)"). Toast motion
retiming (its hardcoded literals) is explicitly NOT this change — debt entry, §13.

### 5.7 Drawer — documented exception (the second half of DD-19's expiration clause)

The Drawer does NOT get background inert, recorded as the DD-19-sanctioned "documented
exception":

1. **It is non-modal by spec.** drawer.md §Accessibility: `role="complementary"`, "in squeeze
   mode Escape also closes while table interaction stays live." Inerting the background would
   contradict the squeeze rule's entire point (G2 open item 1).
2. **The modal-lite overlay mode is a CSS-only decision.** Squeeze vs overlay flips on a
   container query (`primitives.css:1245–1257`); no JS signal exists to scope inert to
   overlay mode, and inventing one (ResizeObserver on the container) is machinery the spec
   does not ask for.
3. **It is structurally outside the pattern.** The Drawer renders inline inside `#root`
   (Drawer.tsx:149–168, no portal) — inert on `#root` would inert the drawer itself.

The exception is recorded in the Drawer docblock and the DD-19 closing note (§13). The
drawer's existing containment (focus trap, Escape stack, scrim in overlay mode) is unchanged.

## 6. Reduced motion — the proven path

`MotionConfig reducedMotion="user"` (App.tsx:59) does **not** cover the primitives — they are
CSS-driven, not framer-driven; the tasking's "prove the path through MotionConfig" branch is
answered NO with this evidence, and the CSS fallback is the governing mechanism:

- **Enter (exists):** `primitives.css:432–437` (modal) and `1265–1270` (drawer) set
  `animation: none` under `prefers-reduced-motion: reduce`.
- **Exit (this slice):** the same blocks extend to the `data-state="closing"` animations, AND
  the presence hook's computed-duration read makes the JS timing collapse to instant
  (`animation: none` → computed `animationDuration` `0s` → synchronous unmount, §4.2). This
  is exactly motion.md §9's prescription ("global kill via the media query plus per-component
  checks for JS-driven timing — the v2 modal demo pattern") and modal.md §States
  reduced-motion ("skip exit animation entirely").

Result: instant both ways under reduce, with ONE source of truth (the CSS media block) and no
duplicated `matchMedia` predicate in TSX. Browser-lane proof rides the existing
`reducedMotion: 'reduce'` context for free (§8.2).

## 7. Fixture and data review

No new fixture machinery beyond two items:

- **`#root` fixture for inert tests:** RTL renders into body-appended containers with no
  `id="root"`; inert tests create a `<div id="root">` carrying the opener button and render
  the modal tree from inside it (the modal portals to body regardless). The hook no-ops
  gracefully when `#root` is absent — which is also why every EXISTING suite (no `#root`)
  is untouched by the inert wiring.
- **Closing-phase exercise in jsdom:** since the jsdom default path is instant (C-B5-1), the
  closing phase is exercised by dispatching `fireEvent.animationEnd` against a shell whose
  duration resolution is stubbed (the hook exposes its duration resolver for tests, or the
  test sets an inline `animation-duration` style on the shell — chosen at implementation,
  whichever keeps the resolver un-exported if possible). The P1-2 two-modal fixture
  (primitives-modal.test.tsx:270–310) is extended, not duplicated, for the refcount pin.

Consumer suites keep all fixtures untouched (zero-diff requirement, C-B5-1).

## 8. Test plan

### 8.1 jsdom (class/attribute contracts — the instant path keeps everything else stable)

`tests/console/primitives-modal.test.tsx` — NEW describe blocks (appended whole per
directives §3 test-integrity rule):

- closed-initial renders nothing — EXISTING pin (73–75) survives verbatim.
- rerender open→false with duration unresolvable → removed synchronously (pins the jsdom
  instant path explicitly, so a future regression that introduces an async dwell in jsdom
  fails loudly).
- with stubbed duration: open→false → shell present with `data-state="closing"`; backdrop
  carries `data-state="closing"`; `fireEvent.animationEnd` on the shell (matching
  animationName) → removed; animationEnd from a CHILD element or wrong animationName →
  NOT removed (C-B5-6 guard pin).
- reopen during closing → `data-state` back to `"open"`, no unmount, no focus re-steal.
- inert: with a `#root` fixture — attribute appears on open, absent after close; refcount:
  extend the P1-2 stacked fixture — close the top modal, `#root` STILL inert; close the
  bottom, inert gone.
- restoration ordering: opener inside the `#root` fixture regains focus on close WITH the
  inert machinery active (pins §5.4).
- Escape-while-closing: second Escape during the closing dwell reaches the next overlay down
  (extends the stacking describe).

`tests/console/primitives-drawer.test.tsx` — closed-initial pin (99–103) survives; closing
data-state + animationEnd unmount + reopen-cancel analogs; retarget flow (288–313) unchanged.

`tests/console/{toast,use-toast}.test.tsx` — verified against the stack portal; role-based
queries survive; any container-scoped locator moves to document level (named at
implementation in the evidence packet).

**Zero-diff gate:** the 7 Modal-consumer suites and SoupKitchen coverage run untouched; any
needed edit there is treated as a defect in the instant path, not a migration task (C-B5-1).
`typecheck` + build + full console suite per the directives battery before any DONE claim.

### 8.2 Browser lane (tests/browser/) — what jsdom cannot prove

jsdom cannot run animations (no animationend, computed duration empty) and does not implement
inert BEHAVIOR (only the attribute) — so the following are browser-lane proofs:

Under the EXISTING config (context `reducedMotion: 'reduce'` — vitest.browser.config.ts):

- **Reduced-motion exit proof (free):** close a modal/drawer → element removed with no
  closing dwell (asserts the §6 instant path in a real engine).
- **Inert behavioral proof:** modal open → `#root` has `inert`; a button inside `#root`
  refuses programmatic focus (`focus()` no-op, `document.activeElement` unchanged) and does
  not receive clicks; modal closed → button focusable/clickable again; opener regains focus.
- **Escape stack with inert active:** Popover-in-modal — first Escape closes the panel only,
  second closes the modal (proves §5.5 in-engine).
- **Toast liveness with modal open:** toast fired while a modal is open renders outside the
  inert subtree (body-level) and its dismiss button is clickable.

NEW no-reduce lane (C-B5-7) — `vitest.browser.motion.config.ts`, separate include glob
(e.g. `tests/browser-motion/**`), context WITHOUT `reducedMotion`, `npm run test:browser:motion`,
mirroring the established config-split pattern (the D7 vite-split rationale). The existing
browser suite's `reduce` context is deliberate determinism machinery (d7-investigation §6.1)
and MUST NOT be flipped globally. Proofs there:

- modal close → shell persists with `data-state="closing"`, computed `animation-name`
  `soup-modal-shell-out`, computed duration 120ms (token), removed within a bounded window;
  scrim fades in parallel.
- drawer close → `soup-drawer-out`, 180ms, translateX end-state, removed after.
- closing backdrop has computed `pointer-events: none` (next-action never blocked).

### 8.3 What stays manual

Perceptual exit quality (does the 120ms fall read as "accelerate away"), squeeze-mode table
snap feel, and both-themes scrim fade ride the D5 live checkpoint (C-B5-8) — same disposition
as every prior slice's live QA.

## 9. Reliability answers

1. **Premature unmount via bubbling animationend:** guarded by target + animationName match
   (§4.2, pinned §8.1). Without the guard, any child animation (e.g. a spinner inside a
   loading confirm) would cut the exit short or unmount mid-enter.
2. **animationend never fires** (tab backgrounded, engine quirk, `animation: none` via user
   stylesheet): fallback timer from computed duration + buffer guarantees unmount; timer
   cleared on animationend/reopen/unmount (no leak; pinned by the reopen-cancel test).
3. **Rapid open/close/open:** phase machine cancels closing and returns to open without
   remount — no flicker, no double-registration on the Escape stack (the hook re-registers
   via its own open-keyed effect exactly as today).
4. **In-flight async during exit** (save completing while the modal animates out): consumers
   are controlled (`open` prop) and stay MOUNTED through the closing dwell, so post-close
   `setState`/`invalidateQueries` sequences land on mounted components — strictly no worse
   than today, marginally better (the dwell extends mounted life by ≤180ms).
5. **Input during the closing dwell:** Escape/trap/outside-click all deregister at
   close-start (real `open` drives useDismissable); the closing backdrop is
   `pointer-events: none`; the ≤120ms keyboard window into a dying shell is accepted and
   noted (focus has already been restored to the opener at close-start).
6. **Inert left stuck** (modal crashes/unmounts while open): the refcount release lives in
   the effect cleanup, which React runs on unmount-for-any-reason, including error-boundary
   teardown; StrictMode double-invoke is symmetric (§5.2).
7. **Restoration into inert background:** impossible by ordering — release-on-cleanup
   precedes restoration setup in the same commit (§5.4, pinned).
8. **Legacy shells unaffected:** GroupDetailModal/UpdateModal/AddLineWizard don't consume the
   primitive; no behavior change until their migration waves; nothing in this slice blocks or
   is blocked by the parallel b3-wave3 lane (disjoint files: primitives + hooks + toast vs
   consumer dialogs).

## 10. Responsive note

Exit motion is viewport-independent (transform/opacity on the overlay itself). The drawer's
two layout modes both have sanctioned exits: overlay mode slides out over the scrim fade;
squeeze mode slides out with the table reflow snapping on unmount (drawer.md squeeze rule 1
allowance). No breakpoint, width, or cap changes anywhere. Small-viewport (390px) overlay
drawer exit and modal exit confirmed at the live checkpoint alongside C-B5-8.

## 11. Enforcement classification

- **No ratchet movement expected.** All TSX changes land in `console/src/components/primitives/`
  and `console/src/hooks/` — the primitives dir is permanently exempt from shadow rules
  (eslint.config.shadow.mjs exemption comment), and the hooks changes introduce no
  shadow-bucket syntax. `use-toast.tsx` gains a `createPortal` import (no bucket). Baseline
  regen is NOT planned; if the final-commit check shows any bucket movement, it is
  investigated as a defect, not absorbed (counts fall-only per directives §3).
- **Shadow-rule candidates recorded (not built this slice):**
  1. `soup/motion-needs-reduced-variant` is a registered zero-fire stub
     (eslint.config.shadow.mjs:231); this slice creates the first real pattern it should
     check — every `-in`/`-out` keyframe pair must appear in a `prefers-reduced-motion`
     kill block. As a CSS-side invariant it likely lands as a conformance-manifest grep
     gate rather than an ESLint rule; routed to the enforcement lifecycle (lint-plan.md)
     as a candidate.
  2. Raw `transition`/`animation` literals on dialog/drawer shells outside primitives —
     the dying-pattern complement of `soup/no-adhoc-modal`; subsumed by motion.md §13's
     planned `duration-easing-tokens-only`; candidate noted, owner stays with the lint
     plan.
  3. `data-state` contract: primitives now expose `data-state="open|closing"` — a candidate
     conformance pin that no consumer branches on `data-state` for logic (it is a styling
     hook only).

## 12. Rollback strategy

Three commits, each independently revertible:

1. **Exit motion** — `use-exit-presence.ts` + Modal/Drawer adoption + primitives.css
   keyframes/selectors/reduced-motion extension + docblock corrections + primitives-suite
   closing tests. Reverting restores instant exit exactly as today (the CSS `-out` rules
   become dead selectors only within this commit's revert window).
2. **Background inert** — `use-background-inert.ts` + Modal wiring + toast-stack portal +
   inert/refcount/restoration tests. Independent of commit 1 (separate hooks; Modal edits
   are disjoint lines). Reverting restores trap-only containment (DD-19's current
   workaround posture).
3. **Browser-lane proofs** — `vitest.browser.motion.config.ts` + package.json script +
   browser test files (motion + inert + toast-liveness). Depends on 1–2 functionally but
   reverts clean (additive files).

No token changes, no consumer-contract changes, no spec edits — the smallest rollback
surface of any slice so far.

## 13. Debt register deltas planned

- **DD-19 CLOSES** at wave end: Modal exit + Drawer exit + Modal background inert landed;
  Drawer inert taken as the documented exception (§5.7) — the expiration condition's own
  "or documented exception" clause, recorded in the closing row's evidence column with a
  pointer to this packet.
- **NEW entry (toast motion literals):** `use-toast.tsx:54` hardcodes `duration: 0.25` + a
  non-token bezier inside `AnimatePresence` — violates motion.md §1 (no hardcoded time
  literals) and the toast band (180 in / 120 out, `--ease-enter`/`--ease-exit`). Found while
  auditing the inert/toast interaction; deliberately NOT fixed in the portal commit (scope
  discipline — the portal is inert-correctness, the retiming is motion work with its own
  visual checkpoint). P3, owner: D5 follow-up or C3 polish pass.
- **DD-20 is NOT closed by this slice** (§16.4): its MotionConfig leg landed earlier; the
  register row stays open pending its spot-checks leg, owned elsewhere.

## 14. Out of scope (owned elsewhere)

- GroupDetailModal, UpdateModal, AddLineWizard migrations — B3 waves 3–4 (parallel lane;
  they inherit exit motion + inert for free on migration, with zero additional wiring).
- Toast motion retiming and any toast anatomy work (§13 new entry).
- `useDismissable` internals — explicitly unchanged; it stays motion-neutral per its own
  contract (use-dismissable.ts:19).
- Scroll-locking the background while a modal is open — not part of DD-19, not in modal.md;
  would be a new spec conversation, not silent drift.
- Page-level framer motion (DD-20 spot checks), enter-motion changes, Popover motion.
- Trusted-event keyboard QA — D7 lane owns trusted-event proofs; this slice's browser tests
  use programmatic events under the D7 harness conventions.

## 15. Constraints / open items

- **C-B5-1 (jsdom stability):** the jsdom default path MUST be synchronous-instant (computed
  duration empty → no closing dwell). The ~2,120-test jsdom suite, including all 7 Modal
  consumer suites and the drawer/SoupKitchen coverage, must show ZERO diffs from the exit
  machinery. Any consumer-suite edit is a regression signal to fix in the hook, not a
  migration task.
- **C-B5-2 (Drawer inert exception):** Drawer ships exit motion only; the inert exception is
  recorded in its docblock and the DD-19 closing row (§5.7). If the live checkpoint rejects
  the exception, it becomes a new register entry + user decision, not improvisation.
- **C-B5-3 (toast portal):** the toast stack moves to a body portal IN the inert commit —
  inert without it is an a11y regression (§5.6). Toast suite updates verified at
  implementation.
- **C-B5-4 (ordering):** inert release must precede focus restoration on close — implemented
  as effect-cleanup (§5.4) and pinned by a test; do not depend on hook call order.
- **C-B5-5 (refcount):** inert is refcounted module-level, StrictMode-symmetric; stacked-modal
  pin extends the existing P1-2 fixture.
- **C-B5-6 (animationend guard):** unmount only on target+animationName match; child
  animations must not cut exits short. Pinned.
- **C-B5-7 (browser motion lane):** animated-exit proofs need a no-reduce browser context via
  a SEPARATE config file + script; the existing browser suite's `reducedMotion: 'reduce'`
  context is determinism machinery and must not be flipped. If the implementer finds a
  per-test emulation route (playwright custom command) with smaller surface, it may replace
  the config split — recorded in the evidence packet either way.
- **C-B5-8 (live checkpoint):** the two new visible exits + scrim fade + squeeze snap (§2)
  confirmed or reverted at the D5 live frontend-design checkpoint, both themes.
- **C-B5-9 (duration-stub seam):** how jsdom tests exercise the closing phase (exported
  resolver vs inline style) is chosen at implementation; whichever is picked, it must not
  add a public prop to Modal/Drawer.

## 16. Strong-claim audit

Claims verified or corrected against current source:

1. Tasking "Modal currently unmounts instantly" — TRUE: `Modal.tsx:96`; the CSS reserves the
   exit seam and admits the gap (`primitives.css:349–350`).
2. `Modal.tsx` docblock line 11 claims "Enter/exit CSS classes; exit faster than enter" —
   OVERCLAIM today (no exit classes exist); lines 14–16 carry the honest DD-19 note but with
   a garbled orphan fragment (line 16). Both corrected when the machinery lands.
3. `Drawer.tsx` docblock lines 18–19 state exit at `--dur-base --ease-exit` — SPEC INTENT,
   not implementation (no `-out` keyframe exists; CSS header `primitives.css:1191` and
   docblock lines 22–24 admit it). Corrected in the slice.
4. Tasking "App.tsx MotionConfig reducedMotion=user wrapper (already landed, DD-20)" — HALF
   TRUE: the wrapper is landed (`App.tsx:59`) but the DD-20 register row is still OPEN
   (blocks-final-acceptance YES; spot-checks leg outstanding) — and MotionConfig is
   IRRELEVANT to this slice's primitives, which are CSS-driven (§6).
5. Tasking title "paired modal/drawer exit motion + background inert" — CORRECTED for the
   drawer: inert is Modal-only; the Drawer takes DD-19's own documented-exception clause
   (§5.7), grounded in drawer.md's non-modal squeeze contract and the component's
   non-portaled structure (`Drawer.tsx:149–168`).
6. "Match the established Drawer idiom" — the Drawer's established idiom is CSS keyframes on
   motion tokens (`primitives.css:1234`), NOT AnimatePresence; the codebase's one
   AnimatePresence use (toast) was found, weighed, and rejected for primitives with cited
   grounds (§4.1) — and itself yielded a debt finding (motion literals, §13).
7. Empirics, not assumptions, for the three platform behaviors the design leans on (jsdom
   29.0.1: no `matchMedia`, no `inert` property reflection, empty computed
   `animationDuration`) — probed directly against the repo's installed jsdom (§1).
8. Browser-lane reduced-motion context (`reducedMotion: 'reduce'`) — read from
   `vitest.browser.config.ts` including its own comment declaring the determinism rationale;
   drives C-B5-7 rather than being discovered mid-implementation.
9. Toast/inert interaction — verified in source (`use-toast.tsx:43–65` in-`#root`,
   `Toast.tsx:41–42` live region), not hypothesized; consumers demonstrably fire toasts while
   modals are open (ScheduleComposerModal validation toasts).
10. Stacked-modal reality — modal.md one-deep sanction + the existing two-modal jsdom fixture
    (`primitives-modal.test.tsx:270–310`) + App-level UpdateModal/KeyboardShortcutsHelp
    coexistence (`App.tsx:82–89`); refcount is therefore mandatory, not defensive
    gold-plating.
11. Consumer counts (7 Modal consumers, 1 Drawer consumer) — grepped at HEAD `c3b1ac52`;
    legacy shells confirmed NOT consuming the primitive (no behavior change for them).

All other absolutes are file:line-cited or carried by a planned test.

## Verdict: **Ready with Constraints**

(C-B5-1 zero-diff jsdom gate and C-B5-3 toast portal are the two load-bearing constraints;
C-B5-2 drawer exception and C-B5-8 visual deltas ride the live checkpoint; C-B5-4/5/6
are pinned by named tests; C-B5-7 adds the browser motion lane; C-B5-9 resolved at
implementation. No spec conflicts are reopened — the drawer inert exception is exercised
under DD-19's own expiration clause, and the one new spec-adjacent finding (toast motion
literals) routes to a debt entry, not improvisation.) Implementation may begin.
