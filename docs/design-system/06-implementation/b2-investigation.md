# B2 Investigation Packet — pickers and inputs slice (Popover / DD-12..16)

Pre-implementation packet required by the working checklist (A0 gate). Implementation is
blocked until this packet carries a `Ready` or `Ready with Constraints` verdict.
Source survey: `docs/design-system/06-implementation/b2-survey.md` (2026-06-12) — its
load-bearing claims re-verified against the live tree for this packet (§3, §14).
Targets: DD-12 (LinePicker combobox), DD-13 (TagInput chips), DD-14 (CardSelector
radiogroup), DD-16 (search-picker family + orphan deletion), DD-15 time-range legs.

## 0. Scope confirmation (survey candidate shape → confirmed with two amendments)

1. **Popover primitive — NET-NEW. Confirmed.** `select.md` mandates custom selects ride
   "the shared Popover primitive + useDismissable"; no Popover exists under
   `console/src/components/primitives/` (verified: directory holds ActionButton, Badge,
   Button, Drawer, LogStream, Modal, Pill, Table, Tabs, Toolbar). Built on
   `hooks/use-dismissable.ts` as Drawer/Modal were — with one hook amendment (C-B2-1).
2. **LinePicker rebuild on Popover — Confirmed** (DD-12). Both variants, combobox
   keyboard contract.
3. **ChatPicker + ContactSearchPicker rebuilds; DELETE orphan ContactSearch + its test —
   Confirmed** (DD-16). Zero-caller claim re-verified (§3 grep evidence).
   ContactSearchPicker gains its missing test file. **Amendment A:**
   ContactSearchPicker's selected-contact chips also move to Pill `removable` in the
   same commit — they are already labeled, the swap is mechanical, and pill.md names
   "picker chips" in its migration list; leaving them re-rolled would re-open DUP-02.
4. **TagInput chips → Pill variant=removable — Confirmed** (DD-13; closes the
   unlabeled-remove gap, verified: the X button in `console/src/components/TagInput.tsx`
   carries no aria-label).
5. **CardSelector → radiogroup — Confirmed** (DD-14).
6. **DD-15 — ADOPT ToolbarTimeRange** for the SoupKitchen chart-range pills (analysis
   and rationale in §13 C-B2-7 and §2). **Amendment B:** the identical hand-rolled
   24h/7d/30d seg in `console/src/components/line-detail/MetricsTab.tsx` (c-btn
   primary/ghost toggles, lines 41–50) migrates in the same commit — same options, same
   semantic, ~10-line swap; leaving it would strand DD-15 with a one-line remainder.
   The OTHER seg-shaped sites (GroupDetailModal announce/locked/memberAdd/joinApproval
   button pairs; ScheduleComposerModal contentType/recurring/cron-preset toggles) are
   binary/preset option toggles on B3 dialog surfaces, NOT time ranges — they ride B3
   with their shells (double-touch avoidance); the DD-15 register row narrows
   accordingly rather than closing.
7. **Out of scope:** form-primitives field-kit promotion to `components/form/`
   (input.md DUP-12 — own sub-slice; TagInput's raw `c-input` therefore stays this
   slice), native-select skin restyle (select.md, rides the form-kit slice), wizard
   tablists ConfigStep/ModelAuthStep (B3 per DD-21r remainder), dialog shells (B3,
   `b3-survey.md`), Inbox chat list (DD-17, B4).

## 1. Gate 0 output

PLACEHOLDER — integrator fills at dispatch: worktree/branch state, origin/main delta +
merge, post-merge lint + test counts, worktree inventory. Note for the integrator: at
packet-writing time `console/src/components/line-detail/SummaryTab.tsx` showed as
modified in the `soup-impl` worktree — resolve/classify before dispatch.

## 2. frontend-design pre-implementation checkpoint

- **Popover/option-list anatomy per select.md:** panel on `--surface-overlay`, 1px
  `--border-subtle`, `--r-2`, `--shadow-overlay`, min-width = trigger width
  (`--dropdown-min-w` demotes to the Popover component token); options are 28px
  compressed rows, hover `--row-hover`, selected `--accent-wash` + leading 16px check +
  `aria-selected`. Matches the v2 Blend linepick specimen. PASS (spec-driven).
- **LinePicker trigger keeps the locked linepick anatomy** (status shape + name + mode
  badge + chevron); compact variant keeps mono name treatment. **Visual change
  recorded:** selected option row gains accent-wash + check (today: `bg-d4` ink swap
  only) — spec-driven. PASS.
- **TagInput chips become Pill spec** (500 11/16, `--r-1`, 24px remove hit area, labeled
  remove). **Visual change recorded:** the per-wizard `accentColor` chip tint drops to
  Pill semantic tones — accentColor is precisely the per-use color override pill.md
  consolidates away (FilterPill already deprecates it). INCONCLUSIVE until the live
  wizard review in both themes (C-B2-3).
- **Chart range control changes shape:** three separate FilterPills → joined seg frame
  (24px buttons, 1px `--border-strong` frame, pressed = accent fill). This is the
  toolbar.md seg anatomy, already live-reviewed nowhere (first production caller).
  INCONCLUSIVE until live review on the Fleet charts header and the LineDetail Metrics
  tab, both themes (C-B2-7).
- **CardSelector:** semantics-only change (roles + keyboard); zero visual delta
  intended. PASS (design intent).
- **Density:** 28px option rows; chips 20px static / 24px interactive floor; seg 24px.
  PASS (design intent).
- **Motion:** popover enter fade+scale at `--dur-fast` (select.md §States), exit
  instant-on-unmount (Modal/Drawer precedent, DD-19 pattern); reduced-motion: instant
  both ways via the existing global CSS policy. PASS.
- **Both themes:** all new surfaces ride semantic tokens; no new semantic tokens
  anticipated, component tokens only. PASS pending live review.

Checkpoint verdict: PASS with two INCONCLUSIVE rows (wizard chip tint, seg swap) —
resolved at the live checkpoint mid-slice.

## 3. Files inspected and classification

Caller greps (run 2026-06-12 against `soup-impl`, branch `feat/soup-v3-foundation`):

- `grep -rn "ContactSearch" console/src --include="*.ts*" | grep -v ContactSearchPicker`
  → exactly ONE hit: its own `export function ContactSearch` in
  `console/src/components/ContactSearch.tsx:10`. **Zero callers — survey claim
  VERIFIED.** Test-side: `tests/console/contact-search.test.tsx` exercises it (deleted
  with the component); no other test imports it.
- `grep -rn "ToolbarTimeRange" console/src` → hits only in
  `console/src/components/primitives/Toolbar.tsx` (definition) and
  `console/src/components/primitives/index.ts` (barrel). **Zero production callers —
  survey claim VERIFIED.** Contract tests exist in
  `tests/console/primitives-toolbar.test.tsx` (role=group, label, exactly-one
  aria-pressed, onChange, real buttons, class contract).

| File | Class | Current invariant | B2 invariant | Changes? |
|---|---|---|---|---|
| `console/src/hooks/use-dismissable.ts` (220 ln) | producer | THE dismissal hook: stack-aware Escape (capture + stopPropagation), focus trap, initial focus, restoration, optional outside-click | + focus-management opt-out options, default-on (C-B2-1); existing consumers byte-compatible | YES |
| `console/src/components/primitives/Popover.tsx` | producer | does not exist | NET-NEW: anchored panel + option-list keyboard contract (§4a) | NEW |
| `console/src/components/primitives/index.ts` | producer (barrel) | exports through Tabs/Toolbar | + Popover exports | YES |
| `console/src/styles/primitives.css` | producer | soup-* bands through tabs/toolbar | + `soup-popover*` band | YES |
| `console/src/styles/tokens.component.css` | producer | `--contact-search-max-h` (line 20, sole consumer = orphan), `--dropdown-min-w` | orphan token deleted; `--dropdown-min-w` demotes to Popover token (select.md) | YES |
| `console/src/components/LinePicker.tsx` (132 ln) | consumer | trigger button + absolute dropdown ×2 variants; open-gated document mousedown/keydown listeners; NO arrow keys, NO combobox aria | rebuilt on Popover: combobox trigger, listbox rows, Down/Up/Enter/Escape; both variants kept | YES |
| `console/src/components/shared/ChatPicker.tsx` (87 ln) | consumer | SearchInput + absolute results panel; UNGATED document mousedown/keydown listeners (mounted for component lifetime); panel hidden when filtered empty | rebuilt on Popover: searchable combobox, empty-results copy, listener lifecycle via hook | YES |
| `console/src/components/shared/ContactSearchPicker.tsx` (86 ln) | consumer | 300ms debounce, min-2-chars, labeled remove chips (re-rolled spans); NO Escape, NO outside-click dismissal at all | rebuilt on Popover (dismissal by construction); chips via Pill removable (Amendment A); debounce kept | YES |
| `console/src/components/ContactSearch.tsx` (91 ln) | orphan | zero callers (grep above); manual "Go" trigger | DELETED + its test + its token | DELETE |
| `console/src/components/TagInput.tsx` (94 ln) | consumer | input + raw span chips; remove button has NO aria-label (DD-13 gap); Enter/Backspace/blur behaviors | chips render via Pill removable (labeled "Remove tag X"); input + behaviors unchanged; accentColor chip tint dropped | YES |
| `console/src/components/CardSelector.tsx` (64 ln) | consumer | button grid, selection = wash + border only; no radio semantics | role=radiogroup (+ required label prop), role=radio + aria-checked, roving tabindex, arrow keys | YES |
| `console/src/pages/SoupKitchen.tsx` | consumer | chart range = 3 independent FilterPills in a bare flex div (no group role/label, no exactly-one contract), lines 622–629 | range via ToolbarTimeRange (first production caller) | YES |
| `console/src/components/line-detail/MetricsTab.tsx` (200 ln) | consumer | range = c-btn primary/ghost toggle row (hand-rolled seg) | range via ToolbarTimeRange (Amendment B) | YES |
| `console/src/components/primitives/Toolbar.tsx` (156 ln) | producer | ToolbarTimeRange: role=group + label + aria-pressed exactly-one; `.soup-toolbar-seg` CSS is a top-level class, no `.soup-toolbar` ancestor coupling (verified in primitives.css) | unchanged — consumed | NO |
| `console/src/components/primitives/Pill.tsx` | producer | C2 contract incl. removable variant | unchanged — consumed | NO |
| `console/src/components/shared/SearchInput.tsx` (31 ln) | producer | the ONE search input (`c-input c-input-search`), pinned by structural tests | unchanged — consumed | NO |
| `tests/console/line-picker.test.tsx` (207 ln) | fixture/consumer | open/close/selection/outside/Escape/lifecycle/empty/compact display | extended: keyboard + aria contract; lifecycle tests survive (hook-owned) | YES |
| `tests/console/chat-picker.test.tsx` (60 ln) | fixture/consumer | nullish-name display safety only | extended: full picker contract | YES |
| `tests/console/contact-search.test.tsx` (241 ln) | fixture/consumer | orphan's behaviors | DELETED with component | DELETE |
| `tests/console/tag-input.test.tsx` (195 ln) | fixture/consumer | entry/trim/dedupe/validate/remove/Backspace/blur/displayLabels | + remove-button accessible-name asserts; X-click queries updated to labeled queries | YES |
| `tests/console/card-selector.test.tsx` (122 ln) | fixture/consumer | render/click/selection-style/empty | + radiogroup roles, arrows, tabindex | YES |
| `tests/console/soup-kitchen.test.tsx` | fixture/consumer | range asserts query by text ('7d' click → useFleetMetrics arg) — survive the seg swap | + aria-pressed exactly-one assert on the seg | YES (additive) |
| `tests/console/metrics-tab.test.tsx` | fixture/consumer | range asserts query by role button + name — survive the seg swap | + aria-pressed assert | YES (additive) |
| `tests/console/primitives-toolbar.test.tsx` | evidence | ToolbarTimeRange contract | unchanged | NO |
| `tests/console/design-system-scheduled-groups-primitives.test.ts`, `tests/console/line-detail-ds-compliance-round2.test.ts` | enforcement (structural) | pin ChatPicker/ContactSearchPicker importing + rendering SearchInput; ban named raw literals | MUST STAY GREEN through the rebuilds (C-B2-4) | NO |
| `tests/console/create-group-modal.test.tsx`, `tests/console/schedule-composer-modal.test.tsx`, GroupDetailModal tests | fixture/consumer | exercise pickers through their dialogs | re-run; updated only if they pinned panel DOM details | MAYBE |
| `console/{eslint.config.shadow.mjs,lint-shadow-baseline.json}` | enforcement | rule×file fall-only ratchet (B1 baseline 594) | + dismissal-listener selector (§10); baseline regen — B2 buckets must FALL | YES |
| `docs/design-system/06-implementation/design-debt-register.md` | register | DD-12..16 open | deltas per §12 | YES |

**Exact new files:** `console/src/components/primitives/Popover.tsx`,
`tests/console/primitives-popover.test.tsx`,
`tests/console/contact-search-picker.test.tsx`, `b2-evidence.md` (at acceptance), this
packet. **Exact deletions:** `console/src/components/ContactSearch.tsx`,
`tests/console/contact-search.test.tsx`, the `--contact-search-max-h` token. Any file
beyond this table is added here before commit.

## 4. Patterns to replace

(a) **Hand-rolled dismissal** — LinePicker's open-gated and ChatPicker's
lifetime-mounted `document.addEventListener('mousedown'/'keydown')` pairs;
ContactSearchPicker's complete ABSENCE of dismissal (select.md names this P2-1).
Replaced by Popover + useDismissable (banned pattern per select.md).
(b) **Keyboard-less dropdowns** — no Down/Up/Enter on any picker; mouse-only option
rows. Replaced by the option-list contract: trigger `role="combobox"` +
`aria-expanded`/`aria-controls`; panel `role="listbox"` + `role="option"` rows;
Down opens/moves, Up moves, Enter selects active, Escape closes one layer and returns
focus to the trigger; focus REMAINS on the trigger/input while
`aria-activedescendant` tracks the active option (searchable pickers type while
navigating).
(c) **Re-rolled chips** — TagInput raw spans (unlabeled removes) and
ContactSearchPicker chip spans → Pill `removable`.
(d) **Radio-without-radio** — CardSelector visual-only selection → radiogroup
(role/aria-checked/arrow keys/roving tabindex; when `selected` is null the first card
takes tabindex 0 per the WAI radio pattern).
(e) **Hand-rolled segs** — SoupKitchen FilterPill range trio (no group/label/exactly-one
contract) and MetricsTab c-btn range toggles → ToolbarTimeRange.
(f) **Orphan code** — ContactSearch + test + token deleted (register expiration
condition for DD-16).

## 5. Fixture and data review

Per-file inline factories remain the convention (no shared fixture module — kept).

- `line-picker.test.tsx`: 3-line fixture set covering all statuses/modes. **Missing:**
  keyboard-nav cases (Down/Up/Enter/Escape-restores-focus), aria contract asserts,
  many-options set (≥15 — scroll + active-option visibility), long line name (≥40
  chars, option-row truncation), activeLine-not-in-lines case.
- `chat-picker.test.tsx`: nullish-name chats only. **Missing:** open/close, outside
  click, Escape, empty-results (today the panel hides when the filter matches nothing —
  rebuild renders empty-results copy instead), keyboard nav, clear-selection flow,
  many-chats and long-label fixtures.
- ContactSearchPicker: **NO test file exists** (survey claim verified — only structural
  string-read tests touch it). New `contact-search-picker.test.tsx` needs: fake-timer
  debounce cases (300ms, min-2-chars, rapid retype collapses to one call), add/remove
  chips with labeled removes, selected-jid exclusion from results, api-reject → empty
  results without throw, response-after-close discarded (§6.4), keyboard contract,
  long contact names, empty-results copy.
- `tag-input.test.tsx`: strong behavioral coverage. **Missing:** accessible-name
  asserts on removes ("Remove tag X"), long tag label (wrap/truncate), many-tags wrap
  row.
- `card-selector.test.tsx`: render/click/empty. **Missing:** role/aria-checked asserts,
  arrow-key traversal incl. wrap, roving tabindex, none-selected tabindex case.
- `soup-kitchen.test.tsx` + `metrics-tab.test.tsx`: range asserts query by visible
  text/role — survive the seg swap; gain aria-pressed exactly-one asserts.
- Runtime data shapes verified: `LineInstance` (status/mode/phone per row),
  `ChatItem` (name nullable — display fallback already tested), `ContactResult`
  (name/notify/number/jid fallback chain — currently tested only in the orphan's file;
  those fallback cases MIGRATE into the new ContactSearchPicker file before the orphan
  test is deleted, not lost with it).

## 6. Reliability answers (each becomes code, test, rule, DD, or non-goal)

1. **Popover near viewport edges:** placement is bottom-only (`bottom-start` /
   `bottom-span`, matching every current call site); panel gets max-height + internal
   scroll (existing pattern: ~5 rows). NO collision-flip engine this slice (no
   floating-ui dependency; jsdom cannot prove geometry). Risk: picker near the bottom
   fold inside short windows. → documented rule + manual QA at 1440×500 + D7 viewport
   tests; recorded as new DD entry (§12).
2. **Options list updates while open:** LinePicker lines refresh via React Query;
   ContactSearchPicker results arrive async. Active option is tracked by VALUE not
   index; if the active value leaves the list, the active descendant resets to the
   first option; focus is never disturbed (it lives on the trigger/input by
   construction). → code + test (rerender-with-new-options case).
3. **Escape stacking with modals:** Popover registers on the useDismissable overlay
   stack; the hook's handler is capture-phase + stopPropagation, so the topmost
   popover consumes Escape before the LEGACY dialog shells' bubble-phase document
   handlers (GroupDetailModal/CreateGroupModal/ScheduleComposerModal hand-roll
   non-stacking Escape — verified) ever see it. This FIXES a live defect: today,
   Escape with a ChatPicker panel open inside ScheduleComposerModal closes panel AND
   dialog together (both bubble handlers fire). After B2: first Escape closes the
   popover, second closes the dialog. → code + test (popover-inside-legacy-dialog
   ordering) + note in evidence; full dialog stacking lands at B3.
4. **Debounce in-flight when closed:** timer cleared on close AND unmount; a response
   resolving after close must not reopen the panel or set state on an unmounted
   component (stale-closure guard keyed on an open/generation token). → code + test
   (fake timers: close before timer fires; resolve after close).
5. **Selected item removed from options:** LinePicker `activeLine` absent from `lines`
   → trigger renders the raw name without status/mode adornment (current behavior,
   kept) and the listbox marks nothing selected; ChatPicker `selected` is
   caller-owned — unchanged contract. → code + test (LinePicker case), documented rule
   (ChatPicker).
6. **Rapid open/close:** listeners are effect-gated on `open` inside the hook; stack
   push/deregister is symmetric (lastIndexOf splice); no enter/exit animation
   machinery to orphan (exit = unmount). The existing LinePicker listener-lifecycle
   tests carry over against the hook-driven rebuild. → code + test (mount/unmount and
   open/close listener-count cases, Popover level).
7. **Arrow keys with zero options** (searchable, empty results): no-op, no crash,
   activedescendant unset. → code + test.
8. **Reduced motion:** popover enter transition is CSS-driven → the existing global
   off-and-instant block covers it; no JS springs added. → code + manual check.

## 7. Responsive decision note

Popover panel: `min-width` = trigger width (span variant) or the popover min-width
token (start variant); `max-height` token + `overflow-y: auto` is the governed scroll
valve; option-row text truncates (`min-w-0` + truncate) — long line names and contact
JIDs must not widen the panel past its anchor region. Mobile/narrow: popovers remain
anchored dropdowns — no bottom-sheet morph this slice (select.md keeps NATIVE select as
the mobile-friendly default for plain lists; the custom pickers are operator-console
surfaces). Chips: TagInput/picker chip rows `flex-wrap` (existing behavior, kept).
CardSelector grid keeps `flex-wrap` + `min-w-0`. Seg: fixed intrinsic width, never
wraps internally. No page-level horizontal overflow at 390/768/1024/1280/1440; jsdom
cannot prove computed boxes — class contracts + live QA now, D7 for computed proof
(existing DD-10 umbrella).

## 8. Targeted test plan

- **Popover primitive** (`primitives-popover.test.tsx`): open/closed rendering;
  `data-state`; combobox trigger aria (expanded/controls); listbox/option roles;
  Down opens + moves active, Up moves, wrap policy at ends (clamp — select.md is
  silent; clamping recorded as the interpretation), Enter selects + closes, Escape
  closes one layer + focus stays/returns to trigger; aria-activedescendant tracking;
  outside-click closes; stack ordering vs Modal (topmost-only); listener lifecycle on
  rapid open/close; options-mutation-while-open; zero-options no-op; max-height/scroll
  class contract (class-level, noted).
- **LinePicker**: existing 16 cases preserved (display fallbacks, compact names,
  lifecycle); + keyboard contract end-to-end; + selected-row check/wash class; +
  activeLine-missing case; + long-name truncation class contract.
- **ChatPicker**: existing display-safety cases; + open/dismiss/Escape; +
  empty-results copy; + keyboard select; + clear-selection focus behavior.
- **ContactSearchPicker** (new file): full list in §5 — debounce, min-chars, in-flight
  close, add/remove via labeled buttons, exclusion, error fallback, name fallback
  chain (migrated from the orphan's tests), keyboard contract.
- **TagInput**: all existing behavioral cases (Enter/trim/dedupe/normalize/validate/
  Backspace/blur/displayLabels) must pass UNCHANGED through the chip swap; + remove
  buttons expose "Remove tag X"; + chips carry soup-pill class contract.
- **CardSelector**: existing cases re-queried by role=radio; + radiogroup label; +
  aria-checked exactly-one; + arrows move selection (WAI radio: arrow selects) with
  wrap; + roving tabindex incl. none-selected → first card tabbable.
- **Seg adoption**: soup-kitchen + metrics-tab range asserts survive; + exactly-one
  aria-pressed; + group accessible name ("Time range"/"Range").
- **use-dismissable**: existing tests stay green UNTOUCHED (regression proof for
  C-B2-1); + opt-out option tests (trap/initial-focus disabled, Escape + outside-click
  still active).
- Weak-terminal-assertion rule honored (end on value/attribute asserts).

## 9. Observability plan

Accessible state only: `aria-expanded`, `aria-controls`, `aria-activedescendant`,
`aria-selected`, `aria-checked`, `aria-pressed`, role queries
(combobox/listbox/option/radiogroup/radio/group), `data-state="open|closed"` on the
Popover root for test/QA inspection. No production `console.*` (repo guard). No new
data attributes beyond `data-state`.

## 10. Enforcement plan

| Candidate rule | Classification | Note |
|---|---|---|
| hand-rolled dismissal listeners (`document.addEventListener('mousedown'│'pointerdown'│'keydown')` outside `hooks/`) | NEW shadow WARN selector | post-B2 hits = legacy dialogs + page-level shortcuts; fall-only ratchet holds them for B3; negative fixture at promotion |
| popover-via-primitive (ad-hoc absolute/fixed menus) | review + ratchet culture; the dismissal-listener selector is its lintable proxy | select.md hook; not separately selector-expressible without false positives (tooltips, toasts) |
| `c-input` in pickers | covered by existing `soup/no-raw-form-control` + structural tests | SearchInput itself legitimately renders `c-input c-input-search` (pinned); a c-input-zero rule belongs to the form-kit slice (DUP-12), NOT B2 |
| seg-via-ToolbarTimeRange | NOT PRACTICAL as lint | behavioral tests + review |
| chips-via-Pill | existing `pill-via-primitive` review hook + ratchet buckets | TagInput/picker buckets fall |

Baseline buckets that MUST FALL at regen: `soup/no-raw-button` ::
LinePicker(4)/ChatPicker(2)/ContactSearchPicker(2)/CardSelector(1)/MetricsTab(4);
`soup/no-legacy-tokens` :: same files; ContactSearch buckets (5+2+1) VANISH on
deletion; `soup/no-utility-smell` :: ChatPicker(1)/ContactSearchPicker(1).
**Explicitly NOT falling this slice:** `soup/no-raw-form-control :: TagInput` (1) —
the raw input stays until the form-kit sub-slice (recorded so the ratchet diff reads
honestly). Any rise anywhere is a regression to fix, never a bump.

## 11. Rollback strategy

One commit per component family, each independently revertible: (1) use-dismissable
opt-outs + Popover primitive + CSS + tests (purely additive); (2) LinePicker rebuild;
(3) ChatPicker + ContactSearchPicker rebuilds + ContactSearch/test/token deletion +
new picker test file; (4) TagInput chips → Pill; (5) CardSelector radiogroup; (6) seg
adoption (SoupKitchen + MetricsTab); (7) enforcement selector + baseline regen +
register/docs. Within commit 3 the orphan deletion is coupled to the family rebuild
(reverting 3 restores it). No cross-commit coupling: 2–6 each depend only on 1.

## 12. Debt register deltas planned

Close at acceptance with proof: **DD-12** (combobox contract + keyboard tests),
**DD-13** (chips via Pill, removes labeled), **DD-14** (radiogroup keyboard tests),
**DD-16** (one picker composite on Popover; orphan ContactSearch removed — the row's
expiration condition verbatim). **DD-15**: B2 closes both time-range legs (SoupKitchen
+ MetricsTab); the row NARROWS, not closes — remainder re-scoped to the
GroupDetailModal/ScheduleComposerModal toggle pairs riding B3 (register row updated at
acceptance with the new owner). New debt: **DD-23 (proposed id)** popover viewport-edge
handling — bottom-only placement, no collision flip; expiry: D7 viewport tests or the
first popover placed in a bottom-fold surface; blocks final acceptance: no. Anything
else discovered lands as a DD entry, not prose.

## 13. Constraints / open items

- **C-B2-1 (hook amendment):** select.md's combobox contract requires focus to REMAIN
  on the trigger/input while the panel is open — useDismissable today always installs
  a focus trap + initial-focus shift, which is wrong for comboboxes. The hook gains
  opt-outs (e.g. `trapFocus`/`manageFocus`, default true) so Modal/Drawer behavior is
  byte-identical; Popover opts out of trap/initial-focus and keeps stack-Escape +
  outside-click. Proof obligation: existing use-dismissable + modal + drawer tests
  pass UNMODIFIED. This consciously amends C2.3's "Drawer builds on it unmodified"
  stance — additive option, not behavior change.
- **C-B2-2:** bottom-only placement + max-height/scroll; collision flip is a
  documented non-goal (→ DD entry, §12).
- **C-B2-3:** TagInput/picker chip accent tint drops to Pill semantic tones —
  deliberate visual change; reviewed at the live frontend-design checkpoint (wizard +
  group dialogs, both themes) before the slice is accepted.
- **C-B2-4:** structural tests pin SearchInput usage and banned literals in
  ChatPicker/ContactSearchPicker — the rebuilds keep SearchInput and must not
  reintroduce pinned literals; these tests act as in-slice guards, not casualties.
- **C-B2-5:** type-ahead ("for long lists", select.md) deferred — current option sets
  are small (fleet lines, filtered chats); documented interpretation recorded here;
  revisit when any picker faces an unbounded list.
- **C-B2-6:** the legacy dialogs' own non-stacking Escape handlers stay until B3; B2
  only guarantees the popover layer wins while open (§6.3). Sequencing note for the
  integrator: B2 pickers land BEFORE B3 dialog shells (b3-survey wave 2 already
  assumes this) or accept double-touch.
- **C-B2-7 (DD-15 decision — ADOPT ToolbarTimeRange, recommended):**
  (1) CSS is standalone — `.soup-toolbar-seg` is a top-level class with no
  `.soup-toolbar` ancestor selector (verified in primitives.css), so it renders
  correctly in the charts-card header and the Metrics tab without a Toolbar shell.
  (2) Spec ownership — toolbar.md owns the seg anatomy ("the ONE time-scoping
  control"); no standalone segmented-control spec page exists, so extracting a
  SegmentedControl primitive now would create a spec-orphan primitive (violates
  traceability, qa-hardening §17).
  (3) Semantic exact-match — both call sites ARE time ranges (24h/7d/30d), the
  component's precise purpose; nothing is shoehorned.
  (4) The only non-time seg candidates (B3 dialog toggle pairs) are binary option
  switches; if B3 decides they justify a generic SegmentedControl, extracting one
  FROM ToolbarTimeRange then is mechanical and will be designed against real
  consumers instead of zero.
  (5) Naming (Toolbar-prefixed component outside a toolbar) is cosmetic; recorded as
  a documented interpretation per qa-hardening §10: the charts header is the
  time-scoping control band for the charts region, satisfying
  one-time-control-per-surface (the Fleet table toolbar omits its time-range per
  C2.3 C-2 — the chart seg is that page's single time control).

## 14. Strong-claim audit

Both survey orphan claims were independently re-verified by grep (§3) rather than
trusted. Every "must fall" in §10 is bucket-specific with one named exception
(TagInput form-control). "Fixes a live defect" in §6.3 is mechanism-verified
(capture+stopPropagation in use-dismissable.ts vs bubble-phase handlers in the three
dialogs) but the double-close itself is asserted from code reading, not a recorded
repro — the implementation adds the ordering test BEFORE the fix to prove the defect
existed. At slice end, grep the diff for done/complete/enforced/canonical/single/only/
never/guaranteed/final/accessible and verify each against code, tests, or evidence
before commit (A0 requirement carried into A6). The Popover header comment must say
"select.md-canonical for picker surfaces", not "the only popover" — legacy dialogs
still hand-roll overlays until B3.

## Verdict: **Ready with Constraints** (C-B2-1 hook amendment with regression proof obligation; C-B2-2 documented non-goal + DD entry; C-B2-3 resolved at live checkpoint; C-B2-4/5/6 documented; C-B2-7 decided: adopt ToolbarTimeRange). Implementation may begin.
