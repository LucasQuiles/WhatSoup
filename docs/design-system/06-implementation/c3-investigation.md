# C3 Investigation Packet — consolidated polish pass + C4 branding preflight

Pre-implementation packet required by the A0 gate (program-directives §3). Implementation
is blocked until this packet carries `Ready` or `Ready with Constraints`. Drafted
READ-ONLY 2026-06-12 against:

- **Implementation tree:** `<soup-impl worktree>`, branch
  `feat/soup-v3-foundation`, HEAD `da0c33a7` (merge of origin/main). The tree carries
  unrelated dirty deploy/CI files from a concurrent lane; `package.json`/`package-lock.json`
  are mid-merge per the tasking — **ignored**; no npm/test invocation was run (static
  analysis only, per the brief). All impl paths below are relative to
  `<soup-impl worktree>/`.
- **Design SSOT:** `<design worktree>/docs/design-system/`, branch
  `design/soup-rebrand`. Binding inputs read in full: `06-implementation/program-directives.md`,
  `design-debt-register.md`, `dd8-decision-package.md`, `visual-qa-b-stages.md`,
  `d7-evidence.md`, `03-spec/{color,tokens-v3,brand,layout-density,typography,state-taxonomy}.md`,
  `02-directions/iterations/v2.html` (locked direction, consulted at cited line ranges),
  `05-cutover/branding-touchpoints.md` (T7), `06-implementation/c4-refresh-survey.md`,
  packet-structure reference `b3-wave4-investigation.md`.

Creative bar (binding, program-directives §4): serious industrial polish, Apple-level
consistency, restrained contrast, status-first color, operator scan paths, light mode
designed not inverted, no generic SaaS drift. Every PART 2 finding below is judged
against that bar and the locked v2 Blend direction.

---

# PART 1 — C3 scope items

## Item 1 — DD-5: nav polish

**Files inspected / classification**

| File | Class | Evidence |
|---|---|---|
| `console/src/components/Nav.tsx` (211 ln) | consumer (whole-file scope of the nav slice) | wordmark split-span 43–48; "Soup Kitchen" label 60; active underlines 63/96/124 (`bg-s-ok`); unread badge 89 (`bg-[var(--color-s-warn)]`); theme toggle 139–146 (`c-btn-ghost`, 24×24 via `w/h-[var(--sp-6)]`); Live/Polling 147–157 (Polling already `text-t2` — DD-8 promotion LANDED); ghost pipe separators 158/192; alert region 159–171 (**dead span**, not clickable); version/update 172–189; Lock 190–204; right cluster `text-xs` (9.6px) 138 |
| `console/src/styles/composites.css` | producer | `c-nav-link`, `c-btn-ghost` legacy classes consumed by Nav |
| `03-spec/brand.md` §1–§2 | spec | nameplate anatomy + locked vocabulary; attention = "lines not online; **always a click-through**" |
| `02-directions/iterations/v2.html` | locked direction | nameplate block ~285–300; unread badge `.chat-unread` 1062–1069 = **accent**, not amber |

**Current invariant:** functional nav with the legacy wordmark, status-green spent as the
selection accent, amber unread badge, ghost theme toggle (exactly at the 24px floor —
lawful), dead alert span, DD-8 Polling promotion already in place.

**Intended change:** DD-5's register row routes the *final* treatment to the nameplate
slice ("expiration: nameplate slice merged"). Ruling proposed: **split by concern** —
(a) color-semantics corrections that do not depend on the nameplate land at C3
(underline `bg-s-ok` → accent treatment; unread badge → accent per v2 `.chat-unread`;
see Item 16 map); (b) the nameplate, "Soup Kitchen"→Fleet label, theme-toggle final
treatment, attention-chip phrasing + click-through land together in the **C4 nav slice**
(they are one visual composition; touching the toggle twice is churn). DD-5 closes at C4.

**Duplication found:** three copies of the identical active-underline span (63–69, 94–103,
122–131) — extract one `NavItem` local or a CSS class when the slice lands.

**Change-now vs defer:** color corrections now (C3 slice 6); composition work deferred to
C4 nav slice (named, owned, expiry = nameplate merge). Out-of-scope: route IA, Lock flow.

**Test plan:** existing `tests/console/nav.test.tsx`, `nav-status.test.tsx` pin labels and
badge scoping — underline/badge color flips are class-assertion updates in the same
commit; the C4 slice flips T2–T4 clusters (Item 17). New pin: alert chip renders a link
(role/`href`) when the attention chip becomes interactive.

**Rollback:** Nav.tsx edits are self-contained; underline/badge color flip is a 3-line
class change reverting cleanly; no token changes ride this item.

## Item 2 — DD-9: half-step spacing alias removal (census)

**Census (fresh, 2026-06-12).** Tokens defined at `console/src/styles/tokens.primitive.css:77–81`:
`--sp-0h: 3px`, `--sp-1h: 6px`, `--sp-2h: 10px`, plus companions `--msg-pad-h: 14px`,
`--btn-pad-v: 7px`. Live consumers:

- **composites.css — 19 sites:** 237, 309, 330, 374, 436, 459, 610 (`.c-cell` 10px), 611
  (`.c-toolbar` 10px), 618, 647, 743 (`.c-btn-sm`), 744 (`.c-btn-xs`), 746, 760, 769,
  786, 821, 852, 937.
- **primitives.css — 6 sites:** 247, 294, 306, 562, and **two load-bearing optical
  values**: 55 (`inset: calc(-1 * var(--sp-0h))` halo ring) and 522 (pill hit-area
  expansion, "20px + 2×3px ≥ 24px" — DD-10-adjacent; the 3px is exact).
- **TSX — 34 sites across 21 files:** Nav.tsx ×5 (53, 76, 89, 111, 177, 196), ProvidersKeysCard ×4
  (64, 79, 100, 161), ChatListItem ×2 (41, 55), LineTags ×2 (57, 91), SearchInput ×2 (15, 24),
  SummaryTab ×2 (181, 191), ScheduledMessageRow ×2 (104, 132), AccessTab ×2 (56, 78),
  KpiCard:48, MessageContent:163, UpdateModal:419, MessageBubble:215, Toast:43,
  ConfigStep:698, HeartbeatStrip:12, KeyboardShortcutsHelp:42, ChartPanel:38,
  HistoryTab:206, PipelineTab:22, Inbox:413, Ops:292.
- **Companions:** `--msg-pad-h` — composites.css:718, ChatListItem:29, MessageBubble:215;
  `--btn-pad-v` — composites.css:718 only.

**Current invariant:** the grid is open — 59 half-step consumptions render 3/6/10/14/7px
values the v3 grid rejects (tokens-v3 §2.2: "the grid is closed").

**Intended change:** per-site rounding per tokens-v3 §2.2/§6.11: `sp-0h`→`--sp-1` (or a
declared component literal where 3px is load-bearing — the two primitives.css hit-area
sites become literal `3px` with a declared-optical-correction comment, layout-density §1
exception); `sp-1h`→`--sp-1` or `--sp-2` per site; `sp-2h`→`--sp-2` or `--sp-3` per site;
`--msg-pad-h`→ MessageBubble component token (tokens-v3 §6.11 "component" disposition);
`--btn-pad-v` dies with `.c-btn` padding (buttons are fixed-height in v3). Delete the
five definitions when their consumer count is zero (in-commit grep proof each).

**Duplication:** `.c-cell` and `.c-toolbar` carry the identical `10px 16px` recipe
(610–611) — both die with the composite retirement; do not migrate them twice.

**Change-now vs defer:** mechanical pass now for sites in files C3 already touches
(slices 2/6/7/9 below) plus a closing sweep in slice 10. **Density-visible roundings**
(`.c-cell`/`.c-toolbar` 10→12px shifts row chrome) are confirmed at the live checkpoint,
both themes — named delta C-C3-1. Out-of-scope: none (register expiry is C3).

**Test plan:** `git grep -c 'sp-0h\|sp-1h\|sp-2h\|msg-pad-h\|btn-pad-v' console/src` → 0
as the commit proof; shadow-ratchet `no-legacy-tokens` buckets fall-only; existing
class-contract suites unaffected (they assert classes, not paddings); live checkpoint
covers the visible deltas.

**Rollback:** rounding commits are pure value substitutions; token deletions ride the
last-consumer commit so any revert restores a self-consistent set (B3W4 §6 pattern).

## Item 3 — DD-26: type ramp — close the bridge

**Current status:** the original finding was correct when this packet was written:
consumed `--type-*` names had zero primitive definitions and rendered only through
fallbacks. The closeout bridge has since defined the 8 consumed `--type-*` names in
`tokens.primitive.css` to their exact fallback-preserving values and added the `--r-1`,
`--r-2`, and `--r-3` aliases. DD-26 remains open because the final tokens-v3 ramp is 12
tokens and the bridge values intentionally do not match the final spec values.

**Files inspected / classification**

| File | Class | Evidence |
|---|---|---|
| `console/src/styles/tokens.primitive.css` | producer | closeout bridge defines the 8 consumed `--type-*` names at fallback-preserving values; 4 final spec tokens remain absent until the final ramp pass; legacy `--text-*` sizes at 39–51 still feed Tailwind utilities |
| `console/src/styles/primitives.css` | consumer | 24 historical `var(--type-..., fallback)` sites drove the bridge inventory; fallbacks remain as the rollback/visual-stability guard until the final ramp pass |
| `console/scripts/design-regression.sh` 549–613 | enforcement | check 19's original burndown note drove the bridge; the bridge inventory is now pinned by `tests/console/design-token-type-ramp.test.ts`; final primitive type-ramp spec drift remains a DD-26/DD-37 closure item outside semantic token drift |
| `03-spec/tokens-v3.md` §2.6, `03-spec/typography.md` | spec | the 12-token closed ramp with exact values |

**Historical consumer inventory (all 24, pre-bridge fallback → final spec value):**

| Token | Sites (primitives.css) | Fallback today | Spec §2.6 value | Visual delta when defined |
|---|---|---|---|---|
| `--type-label` | 81 (`.soup-status-cell__lbl`), 141, 283, 415, 1420, 1508 | `500 11px/16px` sans | `500 12px/16px` sans | +1px on six label lanes |
| `--type-body` | 830, 872, 1011, 1221 | `400 13px/20px` sans | `400 14px/20px` sans | +1px body |
| `--type-body-st` | 94 (`.soup-status-cell__name`) | `500 13px/20px` sans | `500 14px/20px` sans | +1px |
| `--type-heading` | 388 (`.soup-modal-title`), 1364 (drawer title) | `600 13px/20px` sans | `600 15px/20px` sans | +2px on modal/drawer titles |
| `--type-caption` | 841 | `400 11px/16px` sans | `400 12px/16px` sans | +1px compressed table cells |
| `--type-overline` | 706 (table th) | `500 10px/16px` sans | `600 11px/16px` sans (+0.08em upper) | +1px, weight 500→600 |
| `--type-data` | 846, 888 | `400 12px/16px` mono | `400 13px/20px` mono | +1px size, +4px leading |
| `--type-data-sm` (mono) | 853, 1114 (log time), 1168 (log source), 1196, 1203 | `400 11px/16px` mono | `400 12px/16px` mono | +1px — also satisfies typography.md "minimum data text is 12px" which the 11px fallbacks currently violate |
| `--type-data-sm` (**sans fallback — mismatched**) | 958 (`.soup-toolbar-seg__btn`, 500 weight), 1179 (`.soup-log__msg`) | `…/16px var(--font-sans)` | mono per ramp | the two sites FLIP TO MONO; both are data lanes (seg range labels, log message text) so mono is spec-correct, but it is a visible change — named delta |
| `--type-display`, `--type-title`, `--type-data-lg`, `--type-nameplate` | zero CSS consumers today | — | §2.6 values | defined for the C3 screen passes (page titles, KPI values) and the C4 nameplate |

**Current invariant:** rendering is deterministic because the bridge definitions and the
consumer fallbacks agree exactly. The live console still renders the *fallback* ramp (one
step smaller than spec nearly everywhere, and below the 12px data floor on five
log/table lanes), but it no longer has undefined consumed type tokens.

**Remaining intended change:** define **all 12** `--type-*` tokens in
`tokens.primitive.css` exactly per tokens-v3 §2.6 (the final spec values, not the
fallback bridge values; any per-site veto at the checkpoint routes to a spec version
bump, never a divergent definition). Strip the now-redundant fallbacks after the visual
checkpoint so drift cannot reopen (register expiry: "fallbacks become redundant,
dangling-ref check stays at zero"). The `--r-1/--r-2/--r-3` alias leg is already landed
by the closeout bridge.

**Ruling needed (live checkpoint, both themes — C-C3-2):** the ramp lands the whole
console one type step up on primitive-built surfaces (modal/drawer titles +2px, body/data
+1px, two lanes to mono). This is the spec-mandated outcome; the checkpoint confirms it
against the v2 reference rather than re-deriving values.

**Duplication:** none — single definition site by design.

**Test plan:** extend `tests/console/design-token-classes.test.ts` (or sibling) with a
ramp-definition existence assertion (all 12 names present in tokens.primitive.css with the
§2.6 values); design-regression check 19 re-run is the dangling-ref proof; jsdom suites
asserting `font:` strings, if any, flip in the same commit (none found by grep on
`var(--type-` under `tests/`; verified — only class-level assertions exist).

**Rollback:** one-commit revert restores fallback rendering byte-identically (fallback
strips ride the same commit as the definitions).

## Item 4 — DD-27: focus-trap recapture falsified in real Chromium

**Files inspected:** `console/src/hooks/use-dismissable.ts` (FOCUSABLE_SELECTOR 53–61;
`getFocusableElements` 63–70; `handleTab` 167–187 — recapture branch 182–185 *does*
`preventDefault()` before `first.focus()`; bubble-phase document listener 189);
`tests/browser/keyboard-proofs.test.tsx` (C-B3W3-7 modal focus-trap block; now
strengthened to repeated trusted Tab containment); `d7-evidence.md` (falsification
record); DD-27 register row.

**Historical invariant (root cause, from the original suite header):** the trap's
focusable set is computed with a selector whose `button:not([disabled])` arm **matches
`tabIndex=-1` tab buttons** (the `[tabindex]:not([tabindex="-1"])` arm at :59 does not
exclude them because buttons match the earlier arm). So `last` = an unselected roving-tab
button native traversal skips → forward-Tab from the selected mid-list tab matches
*neither* `activeElement === last` *nor* `!contains(activeElement)` → no `preventDefault`
→ **the escape happens with no interception at all**. The recapture branch then fails
empirically on the *next* Tab under trusted CDP events (D7 verdict; the preventDefault is
present in source but the recovery was proven unreliable in real Chromium — the suite
characterizes the gap).

**Fix options:**

- **(A — RECOMMENDED) Fix the focusable computation.** In `getFocusableElements`, filter
  `el.tabIndex >= 0` (equivalently add `:not([tabindex="-1"])` to every selector arm).
  `last` then equals the element native traversal actually leaves from, the existing
  `activeElement === last` branch fires `preventDefault()` **on the boundary hop itself**,
  and the escape never occurs — the unreliable recapture becomes a backstop instead of the
  primary defense. Smallest diff, primitive-level, no DOM additions, exactly the register's
  named direction ("intercept Tab in keydown before traversal").
- **(B) Sentinel guards:** focusable bookend nodes inside the portal that refocus into the
  trap on `focusin`. Robust but adds DOM to every overlay and a second mechanism to spec.
- **(C) Capture-phase listener + full manual traversal** (always preventDefault, hook
  computes the next stop). Heaviest; re-implements the browser; highest regression risk
  against the Popover/combobox opt-outs.

**Recommendation: A**, with the recapture branch retained as written. Risk note: option A
changes the trap's *cycle order* for any overlay whose first/last focusable was previously
a `tabIndex=-1` element — survey says only Tabs panels qualify; jsdom modal-trap suites
(`primitives-modal.test.tsx`) assert containment, not the specific element identity, so
they should survive (verify at implementation; any pinned identity flips in-commit).

**Duplication:** none; one hook, one selector.

**Change-now:** yes — P2, register cleanup phase C3.

**Test plan / status:** the `keyboard-proofs.test.tsx` C-B3W3-7 case has been flipped
from characterization to the strengthened assertion (no escape across repeated trusted
Tab presses). `npm run test:browser` is the browser proof, and the jsdom trap suite
guards the selector change.

**Rollback:** single-function revert; the browser case flips back with it.

## Item 5 — DD-28 / DD-29: spec-home rulings

**Files inspected:** `03-spec/state-taxonomy.md` §3 findings 2–3;
`06-implementation/qa-hardening.md` §4 (by reference from the index); Nav.tsx 147–157
(transport badge); `console/src/components/EmptyState.tsx` (error variant w/ Retry);
`hooks/use-websocket.tsx` (polling fallback, by its Nav consumption); toast error paths.

**DD-28 (stale data) — proposed ruling:** stale is **carried by existing renderings**, not
a new component state: (a) every data lane renders real timestamps in mono (typography §4);
(b) feed recency is explicit; (c) the Nav transport badge (Live/Polling) is the freshness
qualifier for the whole console; (d) react-query refetch keeps poll surfaces ≤ seconds old
under a live transport. Therefore: **no component-spec stale treatment**; record the
interpretation as one paragraph in `qa-hardening.md` §4 (the QA case's own home) stating
the carrier set, and mark "stale: NOT-APPLICABLE (carried-by-rendering)" on each C3 screen
checklist. state-taxonomy §3 row 2 cell updates clerically after the ruling lands.
Becomes a spec change only if a surface ever caches across transport loss without
indication.

**DD-29 (console-transport-loss) — proposed ruling:** the console DOES have defined
behavior today — Nav badge flips to "Polling" (Nav.tsx:153–156, title names the WebSocket
loss), per-query failures render error-with-remedy composites (EmptyState error variant +
Retry), mutations toast failures. Ruling: **existing composites cover it**; the missing
piece is only that the Nav badge is unspec'd chrome. Amend `interaction-patterns.md` with
a short "console transport states" subsection (system-law home; there is no nav component
spec) defining: Live (ok-channel icon+label) / Polling (neutral text-2 icon+label, the
already-landed DD-8 tier) and the rule that transport loss never blocks the UI — surfaces
degrade to last-snapshot plus error composites. The badge's final visual treatment rides
the DD-5/C4 nav slice.

**Both rulings are spec edits on the design branch → user-gated sign-off at the C3
checkpoint** (program-directives §2: spec is design authority; these are additive
clarifications, not direction reopens). Test plan: none (doc rulings) beyond the clerical
state-taxonomy cell updates. Rollback: doc revert.

## Item 6 — DD-15 narrowed: MetricsTab Tokens/Sessions pair → Tabs

**Files inspected:** `console/src/components/line-detail/MetricsTab.tsx` 96–115 — two raw
`c-btn c-btn-sm` buttons (`c-btn-primary` when active, i.e. **status-green active state**),
switching `detailTab` between two chart panels (116–133); no tablist role, no
`aria-selected`, no keyboard contract, no panel association. `components/primitives/Tabs.tsx`
(producer, contract pinned by `primitives-tabs.test.tsx`); LineDetail tabpanel pattern
(pages/LineDetail.tsx 197–221) as the consumer precedent; tabs.md spec.

**Current invariant:** content-panel switching on raw buttons — the survey-ruled "tab
semantics" residual (both targets always activatable; DD-15 ruling 2026-06-12).

**Intended change:** adopt the Tabs primitive: `Tabs label="Detail metrics"` + two `Tab`
children (conditioned on `hasTokenData`/`hasSessionData` exactly as today) + the panel div
gains `role="tabpanel"`/`aria-labelledby` per the LineDetail pattern. Kills two
`c-btn-primary` sites (color win rides free). Single-tab edge: when only one of
tokens/sessions has data, render the section header as a plain `c-section-label` instead
of a one-tab tablist (a tablist of one is keyboard noise — same reasoning as B3W4 §7 b1
rejection); pin both arms.

**Duplication:** none new; removes a hand-rolled toggle in favor of the one primitive.

**Change-now:** yes — closes DD-15.

**Test plan:** extend the LineDetail/metrics suite (`tests/console/` — metrics-tab tests
exist per the test tree) with: tablist role + roving tabindex + arrow-key switch (jsdom
ARIA class), single-source-of-data renders no tablist, CSV button unaffected. Tabs
keyboard mechanics are primitive-pinned; consumed, not re-proven.

**Rollback:** one-component revert.

## Item 7 — Select zero-results ruling

**Files inspected:** `components/primitives/Popover.tsx` — `if (!open) return null` (169),
`options.map` (185): **an open panel with `options=[]` renders an empty floating listbox
with no content**; `components/shared/ChatPicker.tsx` 62–70 (client-side filter — zero
matches reachable by typing); `components/shared/ContactSearchPicker.tsx` (server search —
zero results reachable); `components/LinePicker.tsx` (non-searchable; zero-results NOT
reachable — options mirror the lines list); state-taxonomy §3 finding 1; select.md GAP
cells.

**Current invariant:** the GAP is live in code — two searchable pickers can open an empty
panel that reads as broken chrome.

**Proposed ruling (recommend amend, not N/A):** amend `select.md` States with a
**no-matches row**: non-interactive, `--text-2`, filtered-empty copy pattern ("No matches
for '{q}'" — re-using the table/log-stream filtered-empty discipline; remedy is implicit:
the query field is focused). Implementation: additive `emptyMessage?: string` prop on
Popover rendered as a single non-option row (`role="presentation"`, excluded from
`aria-activedescendant` math) when `open && options.length === 0`; ChatPicker and
ContactSearchPicker pass their copy; LinePicker passes nothing (unreachable). Spec edit is
user-gated at the checkpoint (G2-locked spec file; additive state).

**Test plan:** popover suite: empty-options + emptyMessage renders the row and keyboard
nav no-ops; ChatPicker filter-to-zero case. **Rollback:** additive prop, clean revert.

## Item 8 — `c-col-header` + empty-state CSS legs (DD-8 residue)

**Files inspected:** `console/src/styles/composites.css` 522–530 — the `c-col-header`
utility defaults `color: var(--color-t5)` (ghost); **14 call sites**, 11 already override
with `text-t4`, 3 bare: `components/line-detail/ModeTab.tsx:47`, `pages/Inbox.tsx:484`
("Details"), `pages/Inbox.tsx:507` ("Actions") — dd8 package's cited 489/512 have drifted
to 484/507; same sites. Empty-state legs (dd8 §2.2 borderline cluster, decision-independent):
`.feed-empty` composites.css 216–224 (`--color-t5`); `pages/Ops.tsx:137,141`
(loading/empty `text-t5`); `pages/Inbox.tsx:354` (load-more button `text-t5`), `:591`;
`components/line-detail/HistoryTab.tsx:134,148,186`; `components/ChartPanel.tsx:78`;
`components/line-detail/AccessTab.tsx:160`; pause control `.feed-toolbar__pause`
composites.css 168–180 (`--color-t5` at 173 — log-stream.md requires the paused state
visibly labeled; sub-AA at rest today).

**Cross-check of dd8's other named legs (verified LANDED, no C3 work):** Inbox chat meta
lane now `text-t2` (Inbox.tsx:256–258); MessageBubble timestamp row now `text-t2`
(MessageBubble.tsx:229–236); Nav Polling badge now `text-t2` (Nav.tsx:153). LogStream
time/detail lanes carry the Option-B comment (primitives.css:1109, LogStream.tsx:132).

**Intended change:** (a) re-tier the `c-col-header` default to `var(--color-t4)` (= text-2
via alias) — the 3 bare sites become lawful by default; drop the 11 now-redundant
`text-t4` overrides in the same commit (mechanical); (b) promote the empty-state cluster
to text-2: `.feed-empty` color, the 9 TSX sites above, and the pause control's resting
ink; (c) the Debug "D" level-tag alignment with the I tag at text-2 (dd8 §2.2 row 1
suggestion under Option B) — propose YES, border style keeps debug distinct
(primitives.css 1095–1100 region); checkpoint-confirmed.

**Duplication:** the 11 redundant `text-t4` overrides ARE the duplication — the default
fix removes the class-level noise.

**Change-now:** yes (DD-8 blocks final acceptance). **Test plan:** dd8's sweep command
re-run (`--text-3|text-t5|--color-t5` census) shows the essential/borderline set reduced
to exempt classes only; class-contract tests touching `c-col-header` flip in-commit; live
checkpoint eyeballs both themes. **Rollback:** CSS default + class strips revert together.

## Item 9 — `log-theme.ts` orphan verification

**Closed 2026-06-14.** `console/src/lib/log-theme.ts` was deleted after a whole-tree import
scan found zero production importers; the two test-only importers were removed because they
asserted the dead record values against themselves. Ops and LogsTab level styling now lives in
Pill tones plus the `LogStream` primitive. The color-semantics guard was widened so a new
source-local palette helper under `console/src/lib/**` fails `soup/no-component-local-palette`
unless it is the canonical `console/src/lib/color-semantics.ts` helper.

**Change-now:** yes. **Test plan:** suite green after deletion is itself the proof;
typecheck catches any missed importer. **Rollback:** restore three files.

## Item 10 — DD-30: `use-exit-presence.ts` cancelClosingRef — structurally dead, and the deadness has a live consequence

**Files inspected:** `console/src/hooks/use-exit-presence.ts` (181 ln);
`tests/console/use-exit-presence.test.tsx` (suite covers parse arms, phase transitions,
animationend guard, fallback timer, StrictMode — no reopen-mid-dwell stuck-phase pin
found in the describe inventory); consumers `Modal.tsx:116`, `Drawer.tsx:159` (both feed
`phase` → `data-state`); `tests/browser-motion/b5-exit-motion.test.tsx` (closing backdrop
computes `pointer-events: none`).

**Trace (confirms the register, with sharper consequence):** on `open` flipping
false→true mid-dwell, React runs the open=false effect's **cleanup first** (158–168): it
sets `cancelled = true`, **nulls `cancelClosingRef.current` (:160)**, tears down
timer/listener — but deliberately does NOT `setClosingActive(false)` (comment 164–167
claims cleanup only runs at unmount; **false** — it also runs on every `[open]` dep
change). Then the open=true branch (91–99) checks `cancelClosingRef.current` (:95) —
already null — so the cancel call that would have reset `closingActive` **never executes**.
Result: `closingActive` stays `true`; `mounted` is fine (`open || closingActive`) but
`phase` (:177) **stays `'closing'` for the entire reopened session** — the reopened
Modal/Drawer carries `data-state="closing"`, which (a) re-applies the `-out` keyframes and
(b) on the modal backdrop computes `pointer-events: none` (proven by the b5 motion suite)
— i.e., a reopened-mid-dwell modal can render mid-exit with a click-through backdrop
until the *next* close cycle clears the flag. The dwell window is ~120–180ms + 50ms
buffer, so the path is narrow but real (double-click toggles, rapid Escape+reopen).

**Remove-dead vs make-live: MAKE-LIVE (recommended).** Removing the ref alone preserves
the stale-closing defect. Fix: in the open=true branch replace the ref check with an
unconditional `setClosingActive(false)` (React bails out when already false — preserves
the "no extra render on open" design note), and delete `cancelClosingRef` entirely (the
ref, the assignment block 132–138, the null at :126/:160). The cleanup keeps its
timer/listener teardown; its comment is corrected.

**Test plan (both arms):** (a) **jsdom CAN pin the structural fix** despite the register's
caution — the C-B5-9 duration-stub seam (inline `animation-duration` on the shell) drives
the hook into the closing dwell in jsdom; flip `open` back to true mid-dwell and assert
`phase === 'open'` (fails today, passes after the fix) — add to
`use-exit-presence.test.tsx` phase-transitions describe; (b) the **browser round-trip
proof the register demands**: a `tests/browser-motion/` case — open → close → reopen
within the dwell → assert `data-state="open"` on the shell and backdrop
`pointer-events: auto` (real-animation reopen). StrictMode double-invoke cases re-run
guard the refactor.

**Duplication:** none. **Change-now:** yes (P3 but two-line fix + the proof the register
already budgeted). **Rollback:** single-hook revert; both new tests flip back.

## Item 11 — DD-24: contact-pane actions below the Inbox collapse

**Files inspected:** `pages/Inbox.tsx` 456–458 (pane), 507–581+ (the four actions: Mark
Read :510–532, Allow :534–552 `c-btn-success`, Block :553–571 `c-btn-danger`, Save Contact
:572–581); `styles/primitives.css` 1559–1582 — container query `@container (max-width:
1079px) { .soup-inbox-contact { display: none } }` with the orphaned-actions note naming
DD-24/C-B4-3; thread header 243–261 (the natural alternate home); button.md/toolbar.md
(by reference).

**Current invariant:** below a 1080px container the four actions have no path (spec-
mandated pane drop; CSS-only collapse, React state untouched).

**Intended change (design ruling needed):** add a **container-query-revealed ActionButton
cluster in the thread header** (243–261, after the unread label): four icon ActionButtons
(28×28, primitive already used in modal headers, aria-labels = the action verbs), wrapped
in a `.soup-inbox-thread-actions` span that is `display:none` ABOVE 1080px and shown below
it (the inverse of the pane query — same container root). Rationale: no new primitive, no
menu semantics to spec, symmetric CSS-only mechanism, the pane remains the rich surface at
width. Alternative considered and not recommended: a "⋯" Popover menu (Popover is a
listbox, not a menu — semantics mismatch would fork the primitive's contract, the exact
B3W4 §7-b1 reasoning). Mark-Read's conditional (`unreadCount > 0`) and the busy-state
plumbing are shared with the pane buttons — **extract the four handlers** (they live
inline today) into a small shared hook/component so the two surfaces cannot drift
(duplication pre-empted).

**Change-now:** yes (P2, owner C3). The Allow/Block button color identities are corrected
by Item 16 (status-colored resting buttons) in whichever slice lands first — coordinate.

**Test plan:** jsdom: cluster renders with the four labeled buttons and fires the same
api calls as the pane path (shared-handler proof); browser viewport-matrix Inbox rows
(the unblocked DD-18r leg) gain a 1024-width case asserting the cluster is the visible
action path (pane display none, cluster visible) — rides the same suite the D7 omission
audit already owes. **Rollback:** additive cluster + CSS block; clean revert.

## Item 12 — Wizard error banner "API 502:" dangling colon

**Files inspected:** render site `components/AddLineWizard.tsx` 325–330 (banner renders
`{createError}` raw; set at :254 and :298 from `err.message`); **the string is minted in
`lib/api.ts`**, not the wizard: `` throw new Error(`API ${res.status}: ${await res.text()}`) ``
at **api.ts:183** (core fetch path — the wizard's 502) and **api.ts:551** (second site,
same pattern); cousin at :121 (`auth-ticket … ${status}: ${text}`). Empty body → "API 502: "
— the live-QA finding (visual-qa-b-stages.md Notes).

**Intended change (SSOT fix at the mint, not the render):** extract one helper in api.ts —
`async function apiError(res: Response): Promise<Error>` → body = `(await res.text()).trim()`;
message = body ? `API ${res.status}: ${body}` : `API ${res.status}: request failed
(${res.statusText || 'no response body'})` — and use it at :183 and :551 (and :121's
pattern if touched). Every consumer (wizard banner, toasts, EmptyState descriptions)
inherits the fix. Brand voice check (brand.md §3 "specific + fix"): the banner copy gains
nothing wizard-local; remedy is already present (Next retry behavior, QA row 9's
fail-visible finding).

**Change-now:** yes. **Test plan:** unit test the helper with an empty-body 502 Response
(no dangling colon; status text path) and a body-carrying 4xx; wizard suite's
create-error pin unchanged (it stubs the api module). **Rollback:** helper inline-revert.

## Item 13 — Mock fixture: `config` on one MOCK_LINES entry

**Files inspected:** `console/src/mock-data.ts` MOCK_LINES (81+; `personal` 83–126 has NO
`config` key — none of the 8 entries do; `grep "config:"` = zero in MOCK_LINES, matching
QA row 4); gate `pages/LineDetail.tsx:304–311` — `{line.config && <ConfigEditDialog
config={line.config} …>}`; expected shape: `types.ts:62` `config?: Record<string, unknown>`
on LineInstance; dialog contract `components/line-detail/ConfigEditDialog.tsx:44–56`
(`config: Record<string, unknown>`), entry builder 73+ honoring
`CONFIG_EXCLUDE_KEYS = {name, type, paths, healthPort}` (config-helpers.ts:12) and
`AGENT_OPTION_FIELDS` (config-helpers.ts:105–118: sessionScope enum, cwd/instructionsPath
paths, sandboxPerChat bool, pluginDirs array, mcp.inheritUserConfig bool,
fallbackProvider enum, fallbackModel string).

**Intended change:** add a `config` object to ONE entry — recommend `support` (chat mode,
129+) or `personal`; fixture exercises every editor row type and the exclusion set:

```ts
config: {
  name: 'support',                    // excluded key — proves CONFIG_EXCLUDE_KEYS
  type: 'chat-bot',                   // excluded
  healthPort: 3101,                   // excluded
  accessMode: 'allowAll',             // string row
  adminPhones: ['+15550101'],
  agentOptions: {
    sessionScope: 'per_chat',         // enum row
    cwd: '~/.local/share/whatsoup/instances/support/workspace',  // path row — PROTECTED string preserved verbatim
    sandboxPerChat: false,            // boolean row
    fallbackProvider: 'anthropic-api',// enum row from PROVIDER_IDS
    fallbackModel: 'claude-sonnet-4-5',
    mcp: { inheritUserConfig: true }, // nested boolean row
  },
},
```

Protected-identifier note: the `cwd` fixture mirrors the real
`~/.local/share/whatsoup/instances/` contract — it must say whatsoup (branding do-NOT-touch
list, Item 17). Verify at implementation that `enrichLine`/`getLine` (mock-data.ts
1576–1581) pass `config` through untouched (it reads as a spread-enrich; if it whitelists
fields, extend it — checked claim, medium confidence, one-line verification).

**Change-now:** yes (unblocks live QA row 4). **Test plan:** jsdom — LineDetail with a
config-carrying line renders the editor trigger and the dialog opens on Modal with the
expected editable rows (one assertion per row type; exclusion proven by absence); QA
matrix row 4 flips PASS at the next live round. **Rollback:** fixture-only commit.

## Item 14 — State-taxonomy index verification (verify, don't redo)

**Verified 2026-06-12 — the index EXISTS and is substantively complete:**
`03-spec/state-taxonomy.md` carries the §0 subordination rule, the §1 canonical vocabulary
(14 states, every cell citing a spec section + test-evidence class), the §2 coverage
matrix over **exactly the 13 component specs on disk** (ls of `03-spec/components/`
matches the matrix rows 1:1), §3 findings (the DD-28/DD-29/select-GAP items this packet
rules on trace to it), §4 maintenance rule. Cited suites exist on the impl branch
(target-size, viewport-matrix, b5-inert-toast, b5-exit-motion, primitives-* — cross-checked
against d7-evidence.md). program-directives §5's "lands with the C3 stage" obligation is
**already satisfied**.

**Gaps found (clerical, not structural):** (a) after Items 5/7 land, §3 rows 1–3 need
their disposition cells updated (ruling recorded / spec amended) — clerical per §0;
(b) the matrix has no row for Popover — acceptable: select.md is its spec and the select
row covers it; note added value would be a one-line "(Popover implements select)" cell
note — optional. **No C3 work item beyond the post-ruling cell updates.**

---

# PART 2 — Operator directive: visual hierarchy, color semantics, SOUP rebranding

Operator directive (user gate for these items): *"address outstanding concerns regarding
visual hierarchy, color semantics, and a more serious professional rebranding to 'Soup'
in the front end, standardizing colors for a more serious but not sterile feel."*

## Item 15 — Visual hierarchy audit (per screen)

Criteria applied (program-directives §4): what the operator notices first, what recedes,
color reserved for meaning, scan-path typography, restrained contrast.

### SoupKitchen / Fleet

- **H-F1 (P1) — Seven-color KPI strip.** SoupKitchen.tsx 567–619 assigns a channel color
  to every KPI: ok-green (Lines Connected), crit-red (Need Attention), chat-cyan
  (Messages **Sent**), neutral, agent-violet (Agent Sessions), warn-amber (Unread),
  ok-green again (Media Processed). KpiCard.tsx renders the value in that color (40),
  borders the active card with it (36) and draws a **gradient-filled sparkline** in it
  (57–66). The locked direction is the opposite law: v2.html 922–939 — KPI values are
  NEUTRAL ink, labels `--text-2`, and **only** `.kpi--attn` gets a channel (warn wash +
  warn value). Consequence: the page's most prominent row is a rainbow; the one KPI that
  matters under stress (Attention) cannot pop. This is the single largest "generic SaaS
  dashboard" tell in the product. Fix: re-anchor KpiCard on the v2 anatomy (neutral
  value `--type-data-lg`, overline label, one `--attn` variant; sparkline in
  `--chart-bar` neutral; gradient fill dies — flat per v2).
- **H-F2 (P1) — Chromatic data columns in the Fleet table.** Sent column ok-green with ↑
  (945–950), Received chat-cyan with ↓ (951–956), Sessions agent-violet (972–980),
  Provider in a five-channel palette (981–993, see C-5), Unread amber (936–944). v2's
  locked table renders ALL numeric cells neutral `.num`; status ink appears only in the
  status label cell (v2.html 1462–1464). Severity rows (`row--warn/crit` washes, already
  implemented via statusWashClass) stop being visible against the ambient color. Fix:
  neutral ink for sent/recv/tokens/sessions/provider; keep the unread>0 amber ONLY if
  ruled an attention slot (recommend: neutral here too — Attention KPI + severity rows
  already carry it).
- **H-F3 (P2) — Decorative page/section motion.** Entry fades+slides at 0.5s with the
  legacy bezier (561–564, 715–718; same literal `[0.22,1,0.36,1]` — P3-6 stray; 500ms is
  outside the closed duration set; motion.md instant band for operator-caused changes).
  Fix: delete the page-level motion wrappers.
- **H-F4 (P3) — "Instances" heading** (723–726, `c-heading-lg`) — vocabulary (→ "Lines",
  Item 17) and legacy type utility; becomes `--type-title` at the screen pass.
- **Lawful, keep:** mode-colored FilterPills (733–757) — mode identity is load-bearing
  channel semantics for a mode filter; AlertBanner's crit treatment (712, AlertBanner.tsx)
  is a sanctioned annunciator slot (minor: chips render message text in crit ink — body
  could drop to text-1 with crit reserved for the count badge).

### Nav (global chrome)

- **H-N1 (P1) — Status-green spent as the action/selection accent.** Active-link
  underline `bg-s-ok` (63, 96, 124); wordmark "Soup" span `text-s-ok` (47). color.md §2:
  selection belongs to the ONE action accent (electric blue); ok-green is a status
  channel ("mostly absence"). Two action accents now coexist: migrated primitives use
  `--accent` (Button primary, tabs underline, seg pressed — primitives.css 177–182), nav
  + legacy composites use green. Fix: underline → `--accent`; wordmark → C4 nameplate.
- **H-N2 (P2) — Unread badge amber** (89, `bg-[var(--color-s-warn)]`). v2 `.chat-unread`
  (1062–1069) is ACCENT-filled; color.md §2 lists unread markers under the accent's
  budget. Amber misreads as a warning. Same fix applies to ChatListItem.tsx:70
  (`bg-m-cht` — a THIRD unread color, chat-mode cyan). One concept, one color: accent.
- **H-N3 (P2) — Attention chip is a dead span** (159–171) — brand.md locked vocabulary:
  attention is "always a click-through". Becomes a link to Ops/attention filter at the
  nav slice; phrasing unifies with AlertBanner (Item 17 table).
- **H-N4 (P3) — "All systems operational" verbose green** (161–163): calm-by-default
  wants the healthy state quiet (icon-only or neutral text); green prose + green check is
  double-shouting a non-event. Recommend neutral text-2 label, ok shape only.
- **H-N5 (P3) — 9.6px chrome**: right cluster runs `text-xs` (138) — below the 12px
  floor; ghost pipes (158, 192) are decoration carrying layout. Fix with the nav slice
  type pass.

### Inbox

- **H-I1 (P2) — Status-colored resting buttons.** Allow = `c-btn-success` (green-bordered),
  Block = `c-btn-danger` (red-bordered), stacked full-width at rest (534–571). Status ink
  on resting controls violates `status-ink-only-in-renderers`; interaction-patterns
  reserves danger treatment for the destructive *confirm* moment. Fix: neutral buttons;
  Block keeps a danger CONFIRM (it's destructive-ish), color appears there.
- **H-I2 (P2) — Selection marked with mode-cyan**: selected chat's left edge
  `--color-m-cht` (ChatListItem.tsx:29). Selection is accent duty (v2 chat list uses
  accent unread + neutral selected bed). Fix → `--accent`.
- **H-I3 (P3) — Composer is a legacy one-off**: raw input `bg-d1 placeholder-t5
  c-border-b2` (Inbox.tsx:413), off input.md anatomy; load-more button resting ghost
  text-t5 (354, Item 8). Composer migration is a named DD-18r/forms-track item — record,
  don't expand C3.
- **H-I4 (P3) — Avatar circles on `bg-d5`** (247, 467) — overlay-surface token as avatar
  fill (surface-role borrow); avatar tokens exist (tokens-v3 §6.12). Minor, rides the
  screen pass.

### Ops

- **H-O1 (P2) — Selection via mode-cyan ring**: active instance card
  `ring-1 ring-m-cht/30` (148) — accent duty again, and a Tailwind alpha-modifier on a
  semantic token (bypasses the derived-tint law §2.7). Fix → accent ring or `aria-current`
  + accent left edge (table row precedent).
- **H-O2 (P3) — Channel ink on stats**: agent session counts violet (184), queue/unread
  amber (171, 177), Terminal icon violet (243). The mode dot/badge already carries mode;
  numbers should be neutral data lanes (v2 table law). Amber-when-nonzero is an ad-hoc
  attention rule — either spec it as a KPI-attention slot or drop to neutral (recommend
  neutral; severity already drives card washes via statusWashClass at 149).
- **H-O3 (P3) — "all healthy" green chip** (111) — same calm-by-default note as H-N4.
- **H-O4 (P3) — Footer bar 9.6px ghost** (291–296: `text-t5` + `text-xs`) — sub-floor +
  sub-AA chrome carrying real data (entry count, active line, mode). → text-2 / 12px.
- **H-O5 (P3) — Page-entry fade literal** (86–93). Delete with H-F3.
- (Item 8 covers the t5 loading/empty states at 137–141.)

### LineDetail

- **H-L1 (P2) — Animated tab-panel switch** (222–229): AnimatePresence fade+rise 250ms
  custom-bezier on EVERY tab change — motion.md §1 instant band ("tabs switch instant");
  `mode="wait"` adds dead time to the operator's most frequent action on this screen.
  Fix: remove the wrapper (the B3W4 §2.6 precedent applied to step transitions).
- **H-L2 (P3) — `font-extrabold` h1** (154) — weight 800 does not exist in the system
  (400/500/600, typography §7); tracking utility is the legacy `--tracking-tight`. →
  `--type-display`/`--type-title` at the screen pass.
- **H-L3 (P3) — Meta lane** `text-sm` = 11.2px (166) — sub-floor data lane. → data ramp.
- **H-L4 (P2) — MetricsTab channel borrowing**: token usage bars + legend dots in
  agent-violet (MetricsTab.tsx 143–172), model names in passive-teal (189), section all
  `font-mono p-[…] bg-d2` ad hoc. Mode channels are for mode identity, not chart series
  (color.md §6: series differentiation by position/labels, not hue). Fix with C-4 below.
- Page-entry fade literal (131–135), as elsewhere.

### UnlockScreen — **NEW DEBT (proposed DD-31, P2)**

`components/UnlockScreen.tsx` 31–54 is entirely off-system AND partially broken: classes
`bg-b1`, `bg-b2`, `border-b3`, `text-err` reference utilities that **do not exist** (no
`--color-b1/b2/b3/err` in any `@theme` block — verified across styles/; `--b1/--b2/--b3`
are border-alpha tokens in the plain `:root`, which Tailwind does not turn into `bg-*`
utilities). Net effect: the production entry screen renders with NO surface treatment on
its panel/page and a **colorless error message**; spacing is raw Tailwind (`p-8`, `w-96`,
`gap-3`); the input/button are raw elements (no Input/Button primitives, no focus recipe).
The first screen a production operator sees is the weakest screen in the product — maximal
brand/hierarchy damage for a 58-line file. Fix (small, C3): rebuild on semantic utilities +
Input/Button primitives + EmptyState-style error (`text-s-crit` is the lawful error ink
here as a validation message per interaction-patterns §6). Register entry proposed:
DD-31, area component, P2, owner C3 slice 9, expiry "UnlockScreen renders on semantic
tokens with primitive controls; zero dead utility classes (grep `bg-b1|bg-b2|border-b3|text-err` = 0)".

### Wizard + dialogs

Recently migrated and live-QA'd (visual-qa rows 8–12) — residue is Item 12's banner copy
and the banner's anatomy (`bg-[var(--surface-raised)]` + crit text at AddLineWizard
326–329; interaction-patterns §6 error composite is the pattern home — acceptable now,
note for the screen pass). No new hierarchy defects found in Modal-family surfaces.

## Item 16 — Color semantics standardization

### Census results

1. **Raw hex/rgb in components: ZERO.** Verified across all TSX and component CSS
   (`#hex`/rgb grep; only token files + issue-number false positives). The
   `no-raw-color-in-components` law holds at the literal level. One nuance:
   `--avatar-hue-*` hsl set is declared-contract (tokens.primitive.css 63–74).
2. **The real bypass channel is the legacy alias layer.** TSX utility counts (grep -o,
   console/src): `text-t4` ×82, `text-t5` ×41, `text-t3` ×42, `bg-d2` ×14, `bg-d3` ×23,
   `bg-d4` ×10, `c-btn` ×144, `text-xs` (9.6px) ×40. Status utilities: `text-s-crit` ×35,
   `text-s-warn` ×24, `text-s-ok` ×20; mode: `text-m-cht` ×17, `text-m-agt` ×18,
   `text-m-pas` ×9. The alias schedule (tokens-v3 §7: lint-warning from C2, removed at
   C4) is the existing owner; the counts above are the C4 sweep's sizing input.
3. **Same concept, different colors (unification targets):**
   - *Primary action*: `--accent` (Button primitive, primitives.css 177–182) **vs**
     status-green `.c-btn-primary` (composites.css 729–730 — `var(--color-s-ok)` fill,
     the named ok-as-primary cautionary precedent, P2-12) used in **13 files** (EmptyState,
     LinkStep, ReviewStep, GroupsTab, HistoryTab, ScheduleComposerModal, ScheduledTab,
     GroupDetailModal, MetricsTab, Inbox, +).
   - *Selection/current*: `--accent` (tabs/seg/popover) vs `bg-s-ok` (nav underline) vs
     `--color-m-cht` (ChatListItem edge :29; Ops ring :148).
   - *Unread*: accent (v2 law) vs `s-warn` (Nav:89) vs `m-cht` (ChatListItem:70).
4. **Different concepts, same color (collision targets):**
   - ok-green = healthy status + primary buttons + nav selection + brand wordmark accent
     + Sent-traffic tint + Media KPI.
   - chat-cyan = chat mode + selection + Received-traffic + "Messages Sent" KPI(!).
   - agent-violet = agent mode + token charts + session stats.
   - **PROVIDER_COLORS (lib/providers.ts:98–106) maps providers onto status/mode
     channels**: codex→ok-green, **gemini→warn-amber** (a provider name renders as a
     warning), claude→agent-violet, openai→chat-cyan, anthropic→passive-teal. Used by the
     Fleet table provider column (SoupKitchen:985) and charts. This is the cleanest
     "different concepts share a color" violation in the tree.
5. **Chart palettes vs status palette:** MetricsChart.tsx 44–45 (inbound/outbound =
   passive/chat solids), FleetTokenChart.tsx 134–145 (agent-violet), FleetSessionChart
   (same family), MetricsTab token bars (143–172). color.md §6: "series differentiation
   must use position/labels, not hue"; the only sanctioned chart chroma is the accent
   "now" mark + `--chart-bar` neutral.

### Standardization map (token-level, not per-site hacks)

| # | Concept | Standard | Change (one definition site each) |
|---|---|---|---|
| C-1 | Primary action | `--accent`/`--accent-fg` | Re-point `.c-btn-primary` (composites.css:729) at accent as the interim SSOT fix — every one of the 13 consumer files corrects in one line; the raw-button→Button burn-down continues separately and retires the class |
| C-2 | Selection / current | `--accent` | Nav underline (Nav.tsx 63/96/124), ChatListItem edge (:29), Ops card ring (:148 — also remove the `/30` alpha-modifier; use `--accent-wash`/border) |
| C-3 | Unread markers | `--accent` fill + `--accent-fg` (v2 `.chat-unread` anatomy) | Nav badge (:89), ChatListItem badge (:70) |
| C-4 | Chart series | neutral `--chart-bar` + `--accent` second series; channel hues only where the series IS the channel (e.g. a per-mode breakdown) | MetricsChart, FleetTokenChart/SessionChart, MetricsTab bars, KpiCard sparklines (neutral). Requires a one-paragraph chart-color note in color.md §6 — **user-gated spec edit** |
| C-5 | Provider identity | NOT a color channel — neutral ink + label (color.md §6) | PROVIDER_COLORS collapses to neutral (`--text-2`) or, if per-provider hue is ruled essential, a declared component-tier palette OUTSIDE the six channels — **user decision**; recommend neutral |
| C-6 | KPI values | neutral data-lg; ONE `--attn` variant (warn wash) per v2 922–939 | KpiCard re-anchor (H-F1) |
| C-7 | Status ink | only in StatusCell/Badge/log tags/toast edges/severity rows/danger confirm | Fleet table column tints die (H-F2); Ops stat tints die (H-O2); Inbox resting success/danger buttons die (H-I1); `c-btn-success`/`c-btn-warning` variants retire with the Button migration |
| C-8 | Mode ink | mode badges, feed edges, wizard cards, mode filter pills ONLY | MetricsTab model names (:189) and token bars, Ops session counts/icon, recv column → neutral |
| C-9 | Ghost tier | per Item 8 / DD-8 Option B | empty states, col-headers, pause control → text-2 |

**"Serious but not sterile" guardrail:** what stays deliberately warm — mode identity
chips and feed left-edges (the product's signature triad), status washes on severity rows,
the breathing ok-disc, the teal brand tick, the accent's electric blue on real actions.
What reads playful/SaaS-generic and exits: the seven-color KPI rainbow, gradient sparkline
fills, traffic-direction green/cyan tinting, provider rainbow, amber/cyan unread pills,
`font-black` wordmark, the purple bolt favicon. The result is the locked v2 posture:
monochrome chrome, six meaningful channels, one accent.

## Item 17 — 'SOUP' rebranding (C4 preflight)

The T7 inventory (branding-touchpoints.md) and c4-refresh-survey were re-verified against
today's tree. **Verdict: inventory remains authoritative; line numbers have drifted; one
NEW protected occurrence found.** Raw sweep: `whatsoup` in console/src+index.html+README =
25 lines, `soup kitchen|soupkitchen` = 12 lines — all tagged below.

### Exact flip list (file:line · current · proposed)

**C4 UI-copy flips:**

| Site | Current | Proposed |
|---|---|---|
| `console/src/components/Nav.tsx:43–48` | split-span `<span class=text-t2>What</span><span class=text-s-ok>Soup</span>`, `font-black`, `tracking-tighter` | **Nameplate component** per brand.md §1: `[8×8 teal tick] SOUP`, `--type-nameplate` (Geist Mono 600 14/24, +0.38em, `margin-inline-end: -0.38em` compensation, translateY(0.5px) optical), tick `--mode-passive-solid`, gap `--sp-3`; `nameplate-reserved` lint lands with it |
| `console/src/components/Nav.tsx:60` | `Soup Kitchen` | `Fleet` |
| `console/src/components/KeyboardShortcutsHelp.tsx:18` | `'Go to Soup Kitchen'` | `'Go to Fleet'` |
| `console/src/components/UpdateModal.tsx:357` | `'Update WhatSoup'` | `'Update SOUP'` (restart-phase copy around it gets the Line pass below) |
| `console/index.html:7` | `<title>WhatSoup Console</title>` | `<title>SOUP Console</title>` (exact casing per nameplate caps — confirm copy at checkpoint) |
| `console/public/favicon.svg` | purple/blue bolt (`#863bff` fills) — unrelated to the locked identity | replace per §"Favicon candidates" below — **asset NEEDED, operator approval** |

**C3/C4-boundary vocabulary flips (Line / Fleet / attention):**

| Site | Current | Proposed |
|---|---|---|
| `pages/SoupKitchen.tsx:725` | heading `Instances` | `Lines` |
| `pages/SoupKitchen.tsx:883` | `No instances match the current filters` | `No lines match the current filters` |
| `pages/Ops.tsx:123` | `{n} instances` | `{n} lines` |
| `pages/Ops.tsx:142` | `No instances discovered. Create one from the Soup Kitchen.` | `No lines discovered. Create one from the Fleet.` |
| `pages/Ops.tsx:281, :286` | `Select an instance to view logs.` | `Select a line to view logs.` |
| `pages/Ops.tsx:317` | toast `Instance re-linked!` | `Line re-linked!` |
| `components/ActivityFeed.tsx:217` | confirm label `Stop instance` | `Stop line` |
| `components/ActivityFeed.tsx:223` | `…The instance will not reconnect until manually started.` | `…The line will not reconnect until manually started.` |
| `components/line-detail/MetricsTab.tsx:68` | `Fetching data for this instance.` | `Fetching data for this line.` |
| `components/line-detail/MetricsTab.tsx:77` | `Metrics will appear after the instance processes messages.` | `…after the line processes messages.` |
| `components/wizard/ReviewStep.tsx:85` | `An instance with this name already exists.…` | `A line with this name already exists.…` |
| `components/Nav.tsx:167–169` + `components/AlertBanner.tsx` count badge | `{n} alert{s}` (two surfaces, Nav's a dead span) | unified attention phrasing — propose `{n} need attention` / `{n} needs attention`, Nav chip becomes a click-through (H-N3) — **copy needs operator confirm** |

**C4 identifier rename (own sub-PR, T7 §3 blast radius applies):**
`pages/SoupKitchen.tsx` → `Fleet.tsx`; component refs now at SoupKitchen.tsx:325/:1039,
`App.tsx:14` (lazy import), `:73` (route element). Coupled test lines per T7 T7–T11
(soup-kitchen.test.tsx rename, error-boundary source-string pin :42, two path-reader
suites, app.test.tsx mocks) — **re-verify each at implementation; T7's numbers are
pre-drift** (src lines already moved: 67→325, 11→14, 55→73).

**C4 test-assertion flips (T1–T6 clusters; re-verify lines):** update-modal, nav-status,
nav, app, keyboard-shortcuts-help suites pin the old copy — flip in the same PR as each
copy change.

### Do-NOT-touch list (protected identifiers — NEVER flip)

| Surface | Location(s) |
|---|---|
| `whatsoup:` localStorage prefix (incl. `whatsoup:theme`) | `lib/preferences.ts:5`; **NEW since T7:** `console/index.html:9,13` — the inline theme-bootstrap script reads `localStorage.getItem('whatsoup:theme')`; the C4 title flip edits THIS SAME FILE — flag the line pair so the sweep cannot fat-finger it; `hooks/use-theme.ts:2` comment |
| `/run/whatsoup/` socket paths | `mock-data.ts:106,152,208,263,314,403,453,1120,1182` (fixtures mirror real contracts) |
| `~/.local/share/whatsoup/instances/…` workspace paths | `lib/agent-cwd.ts:17`; Item-13 fixture `cwd`; wizard cwd tests (T12–T15) |
| `mcp__whatsoup__*` tool namespace | `components/wizard/ConfigStep.tsx:780` |
| ConfigStep "via WhatSoup" generated agent prompt | `components/wizard/ConfigStep.tsx:117` (agent-contract surface; separate approval per T7 unknown queue) |
| `WhatSoupError`, systemd `whatsoup@<name>` / launchd units, wire contracts | server-side (`src/errors.ts:32`, deploy units); test fixtures T16–T21 (`/var/lib/whatsoup`, `whatsoup@a/b`, `~/.config/whatsoup/`) |
| `instance` as a process/API noun | `t.instance` fields, `agentOptions` keys, `restart-instances` phase id, code comments — the §6 demotion rule: operator-visible copy says Line; process/API keeps instance |
| Comment headers (`types.ts:2`, `use-fleet.ts:2`, `mock-data.ts:2`, `use-keyboard-shortcuts.ts:2,23`, `index.css` `--sk-col-*` comment) | P4-optional sweep, per T7 |

### Favicon — two generatable candidate directions (operator approval required)

Both flat SVG, no gradients/illustration (brand.md §1.3), dark-field so the mark reads in
both browser themes; light-scheme variant via `prefers-color-scheme` optional:

1. **"Tick" (recommended):** the nameplate's 8×8 tick scaled to favicon — a rounded-corner
   (r≈1/8 of side) square in `--mode-passive-solid` teal `#3BD6B0`, centered on a
   `#0E1013` rounded-square field. It is literally the brand mark's only graphic element;
   survives 16×16; pairs with the in-app nameplate 1:1.
2. **"S + tick":** Geist Mono 600 uppercase `S` in `#E8EAEE` with the small teal tick
   square set as a baseline dot to its right, on `#0E1013`. More nameplate-evocative at
   32px+, busier at 16px.

Either is generatable as hand-written SVG in the C4 slice; `console/index.html:6` link tag
unchanged. Verify `icons.svg` carries no brand text at the same time (T7 #22).

---

# Files expected to change

**C3 (implementation tree, by slice):**

- `console/src/styles/tokens.primitive.css` (type ramp + r-1/2/3 definitions; half-step
  token deletions at the end), `styles/primitives.css` (fallback strips; ghost-tier ink
  legs; D-tag; half-steps; inbox thread-actions container query), `styles/composites.css`
  (c-col-header default; .feed-empty; pause control; c-btn-primary re-point; half-steps),
  `console/scripts/design-regression.sh` (check-19 burndown comment).
- `console/src/hooks/use-dismissable.ts` (DD-27), `hooks/use-exit-presence.ts` (DD-30).
- `console/src/components/line-detail/MetricsTab.tsx` (DD-15 + channel ink),
  `components/KpiCard.tsx`, `pages/SoupKitchen.tsx` (KPI/table ink, motion, copy),
  `pages/Ops.tsx` (selection/ink/motion/copy/footer), `pages/Inbox.tsx` (buttons, DD-24
  cluster, ghost legs, copy), `pages/LineDetail.tsx` (tab motion, h1, meta),
  `components/Nav.tsx` (underline/badge color only at C3), `components/ChatListItem.tsx`,
  `components/UnlockScreen.tsx` (DD-31), `components/MetricsChart.tsx`,
  `components/FleetTokenChart.tsx`, `components/FleetSessionChart.tsx`,
  `components/ChartPanel.tsx`, `lib/providers.ts` (PROVIDER_COLORS), `lib/api.ts`
  (error helper), `components/primitives/Popover.tsx` (+`emptyMessage`),
  `components/shared/ChatPicker.tsx`, `components/shared/ContactSearchPicker.tsx`,
  `console/src/mock-data.ts` (config fixture).
- Tests: `tests/console/use-exit-presence.test.tsx`, `tests/browser/keyboard-proofs.test.tsx`,
  `tests/browser-motion/` (+reopen case), `tests/console/ops-actions.test.ts`,
  `tests/console/log-theme-motion.test.ts`, nav/kpi/metrics/inbox
  class-assertion updates as named per item, new LineDetail-config-dialog pin, api-error
  helper unit test, popover empty-row pins.
- Design branch (docs): `design-debt-register.md` (DD-8/9/15/24/26/27/28/29/30 deltas +
  DD-31 entry), `03-spec/select.md` + `interaction-patterns.md` + `color.md` §6 chart note
  + `qa-hardening.md` §4 stale paragraph (all user-gated), `state-taxonomy.md` clerical
  cells, this packet's evidence file.

**C4 (separate wave):** `components/Nav.tsx` (nameplate component + label),
new `components/Nameplate.tsx` (or co-located), `console/index.html` (title; theme
bootstrap lines untouched), `console/public/favicon.svg` (new asset),
`components/KeyboardShortcutsHelp.tsx`, `components/UpdateModal.tsx`,
`pages/SoupKitchen.tsx` → `Fleet.tsx` + `App.tsx`, the T1–T11 test clusters,
`tokens-legacy-aliases` removal sweep (tokens.semantic.css 225–300 + tokens.primitive.css
@theme aliases), docs prose (console-guide, README).

# Out of scope (owned elsewhere)

- DD-18r remaining legs (nav width pressure beyond label hiding and non-Fleet
  side-panel law); DD-22 streaming; DD-23 popover fold; D7 focus-ring battery +
  honesty labels + CI cache. DD-10 and DD-17 are closed in the current register.
- Composer/forms migration (input.md adoption) — forms track.
- The raw `c-btn` burn-down beyond the `.c-btn-primary` re-point (144 sites — P2 track).
- Alias removal (C4 schedule), comment-header sweep (P4), docs prose (P4), server-side
  naming (separate program; T7 unknown queue).
- Page IA/routes; locked direction itself (no reopen proposed anywhere in this packet).

# Commit slicing proposal (each independently revertible; battery per commit per program-directives §3)

1. **Foundations:** type ramp + radii definitions, fallback strips, check-19 comment;
   live checkpoint C-C3-2.
2. **DD-8 ink legs:** c-col-header default + override strips, empty-state/pause/D-tag
   tiering (Item 8).
3. **DD-27:** focusable filter + keyboard-proofs flip.
4. **DD-30:** make-live + jsdom dwell pin + browser-motion reopen case.
5. **DD-15:** MetricsTab → Tabs.
6. **Accent duty (C-1/2/3):** c-btn-primary re-point, nav underline, unread badges,
   selection edges/rings + class-assertion updates.
7. **Data-color neutralization (C-4/5/6/7/8):** KpiCard re-anchor, table/Ops ink, charts,
   PROVIDER_COLORS — after the color.md §6 note is approved; live checkpoint both themes.
8. **States & reach:** Popover emptyMessage + picker copy; DD-24 thread-action cluster +
   shared handlers; DD-28/29 ruling docs (design branch) + state-taxonomy cells.
9. **Microcopy & fixtures:** api error helper + test; mock `config`; vocabulary flips
   (instance→line table) + their test pins; UnlockScreen rebuild (DD-31).
10. **Motion conformance + closures:** page-entry fades + LineDetail tab animation
    removal; DD-9 final sweep + token deletions + shadow-baseline regen (counts
    fall-only; regen LAST, coordinate with any parallel lane per the C-B3W4-7 precedent).

C4 wave (separate packet not required — this preflight + T7 + brand.md §1 are the spec):
N1 nameplate+nav slice (incl. DD-5 close), N2 title+favicon, N3 SoupKitchen→Fleet rename
sub-PR, N4 alias removal sweep, N5 docs prose.

# Strong-claim audit (this packet's own claims)

- **Historical pre-bridge claim: "--type-* has zero definitions"** — at the time
  of this investigation, verified by definition-pattern grep over `console/src/styles/`
  (and check 19's own burndown note corroborated). Superseded by the closeout
  fallback bridge: 8 consumed `--type-*` names are now defined while DD-26 remains
  open for the final 12-token spec ramp. High confidence for the original packet.
- **"24 consumers"** — exact `grep -c 'var(--type-'` on primitives.css; composites.css 0.
  High.
- **DD-30 trace** — read directly from use-exit-presence.ts 90–177; the cleanup-before-
  open-branch ordering is React's documented effect sequencing on dep change. The
  *consequence* (stale `data-state="closing"` + backdrop pointer-events) is inferred from
  Modal/Drawer's phase consumption + the b5 motion suite's computed-style proof — inference,
  not an executed repro; the proposed jsdom dwell pin is the executable proof. Medium-high.
- **DD-27 root cause** — the selector fact (buttons match regardless of tabindex) is read
  from source; the "recapture empirically fails despite preventDefault" claim is carried
  by d7-evidence.md and the suite's recorded verdict, not re-run here (read-only packet;
  impl tree mid-merge). The fix recommendation rests on the boundary-interception logic,
  which holds regardless of why recovery failed. Medium-high.
- **UnlockScreen dead classes** — verified that no `--color-{b1,b2,b3,err}` exists in any
  `@theme` block and that Tailwind v4 color utilities derive only from the `--color-*`
  namespace; NOT verified against a rendered build (no dev server in this window). If some
  other layer defines them, the finding downgrades from "broken" to "off-system" — either
  way DD-31 stands. Medium.
- **log-theme orphan** — closed 2026-06-14 by deletion plus test-only importer removal; the
  widened color-semantics guard prevents another source-local palette helper from re-entering
  under `console/src/lib/**` outside the canonical `lib/color-semantics.ts` helper. High.
- **Counts (alias/status/mode utilities)** — `grep -o | wc -l` line-occurrence counts;
  substring-safe for the listed patterns; intended as sizing, not exact call-site counts.
- **v2 citations** (KPI law 922–939, table 1462–1464, `.chat-unread` 1062–1069, nameplate
  285–300) — read directly from the locked v2.html.
- **No test/build/lint was executed** — the brief forbids it (mid-merge package.json);
  every "suites flip/survive" statement is a plan, and gate 0 of each slice runs the full
  battery before any claim. Items whose line numbers are known-drifty (T7 test clusters)
  are explicitly marked re-verify-at-implementation.
- **Spec-edit set** (select.md, interaction-patterns.md, color.md §6, qa-hardening §4) —
  each is additive clarification, none reopens locked direction; all routed through the
  user gate per program-directives §2.

# Verdict: **Ready with Constraints**

Binding constraints:

- **C-C3-1:** DD-9 density-visible roundings (`.c-cell`/`.c-toolbar` 10→12px class) are
  confirmed at the live checkpoint, both themes, before the token deletions land.
- **C-C3-2:** the type-ramp definition (Item 3) ships only with a live visual checkpoint
  in both themes; per-site vetoes route to a typography.md version bump, never divergent
  values; the two sans→mono flips (seg buttons, log message lane) are named deltas.
- **C-C3-3 (USER GATES):** (a) the four spec edits (select zero-results, transport-loss
  section, stale paragraph, chart-color note); (b) C-5 provider-color disposition
  (neutral vs declared palette); (c) attention-chip phrasing; (d) favicon candidate pick
  (asset approval); (e) DD-24 placement ruling (header cluster vs alternative); (f) the
  DD-5 split ruling (color-now / composition-at-C4). None blocks the other slices.
- **C-C3-4:** every slice runs the full battery (typecheck + build + console suite +
  theme parity + shadow ratchet fall-only + `git diff --check`) before DONE; the browser
  suites (DD-27/DD-30 proofs) run from a clean clone if the impl tree is still mid-merge
  (the d7 `/tmp` pattern); no claim ships on static analysis alone.
- **C-C3-5:** shadow-baseline regen happens once, in slice 10, sequenced against any
  concurrent lane (C-B3W4-7 rule: counts fall-only, owning-lane attribution verified).
- **C-C3-6:** branding work in C3 is LIMITED to the vocabulary table and color duties;
  nameplate/title/favicon/rename are C4; protected identifiers per the Item-17 do-NOT-touch
  list are hard-gated (note the NEW index.html `whatsoup:theme` line pair).
- Integrator commits only; agents never commit; stage by explicit path (program-directives
  §3).
