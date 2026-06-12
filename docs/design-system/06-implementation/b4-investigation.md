# B4 Investigation Packet — Inbox slice (chat list / pane collapse / bubble detail / DD-17 + DD-18r legs)

Pre-implementation packet required by the working checklist (A0 gate). Implementation is
blocked until this packet carries a `Ready` or `Ready with Constraints` verdict.
Source survey: `docs/design-system/06-implementation/b4-survey.md` (2026-06-12) — its
load-bearing claims re-verified against the live tree for this packet; three corrections
recorded (§0.1, §0.3, §0.4 — the b2/b3 falsification bar applied). Targets: DD-17 (chat
list listbox keyboard contract), DD-18r Inbox legs (three-pane collapse path +
MessageBubble hover-card positioning), `search-input-single-source` Inbox adoption
(input.md P2-4), one of the two console-wide `soup/no-focus-suppression` hits.

## 0. Scope confirmation (survey candidate shape → confirmed with corrections)

1. **Chat list roving tabindex + arrow nav — CONFIRMED, rationale corrected, one
   amendment.** Survey claims verified: every row carries `tabIndex={0}`
   (`console/src/components/ChatListItem.tsx:19`) inside a `role="listbox"` container
   (`console/src/pages/Inbox.tsx:233`) — matching NEITHER WAI pattern. **Correction:
   the chat list is NOT virtualized.** It is a plain `chats?.map(...)`
   (`console/src/pages/Inbox.tsx:234–242`); `useVirtualMessages` consumers are the
   message thread and search results only (`console/src/pages/Inbox.tsx:117–126`,
   `console/src/components/line-detail/HistoryTab.tsx:116`). The survey's "roving
   tabindex (simpler under virtualization)" justification is therefore moot. Roving
   tabindex is still the right pick, for these reasons instead: (a) the rows are
   themselves the focusable activation targets, and `tests/console/chat-list-item.test.tsx`
   already pins row-focus semantics (option role queries, Enter/Space activation,
   aria-selected); `aria-activedescendant` would move focus to the container and
   invalidate that model — it is the right tool for stationary-anchor composites (the
   B2 combobox pickers), not for a list of self-activating rows; (b) tab-stop pollution
   (one stop per chat) is the named DD-17 defect, and roving removes it directly;
   (c) roving is the established house pattern for composite row widgets (B1 Tabs,
   B2 CardSelector radiogroup). **Amendment A:** the survey's "ChatListItem is 77 ln,
   single edit site" is wrong as scoped — roving tabindex requires list-level
   coordination (one stop among N), which cannot live in the item alone. The listbox
   container, roving state, and arrow handling extract to a new
   `console/src/components/ChatList.tsx`; ChatListItem's hardcoded `tabIndex={0}`
   becomes a prop. This also gives the listbox contract a component-test home that does
   not require the full page harness.
2. **Contact-pane collapse + token reconciliation — CONFIRMED** (DD-18r leg). Verified:
   zero collapse logic of any kind — both side panes are `flex-shrink-0` at fixed token
   widths (`console/src/pages/Inbox.tsx:222, 479`); no `md:`/`lg:` classes, no media or
   container queries anywhere in the file. layout-density.md §5 is explicit ("contact
   pane hides" at the ~1080px stress; "Inbox keeps the active conversation, drops the
   contact pane") and prefers container queries on the stressed container. Mechanism:
   the C2.3 squeeze idiom — `container-type: inline-size` on the page flex root +
   `@container` rule hiding the contact pane below the 1080px threshold (precedent:
   `.soup-drawer-layout` band, `console/src/styles/primitives.css:1188–1247`).
   Token drift verified: `--panel-chat-list: 288px` / `--panel-contact: 256px`
   (`console/src/styles/tokens.component.css:24–25`) vs spec 264/248 — tokens-v3.md §4
   names the v3 tokens `--inbox-pane-chats`/`--inbox-pane-contact` at 264/248, and the
   §6.12 disposition row maps the legacy pair onto those values. Reconciliation = rename
   to the spec token names + take the spec values. The two legacy tokens have exactly
   two consumers (the two Inbox panes — grep §3), so the blast radius is the Inbox page
   alone; **this is a visible change** (chat list 24px narrower, contact pane 8px
   narrower, thread correspondingly wider) and is flagged for the live checkpoint
   (C-B4-1). **Risk surfaced:** hiding the contact pane orphans Mark Read / Allow /
   Block / Save Contact below the threshold (they exist nowhere else,
   `console/src/pages/Inbox.tsx:530–605`) — spec-mandated drop accepted, recorded as a
   new DD entry (§12, C-B4-3).
3. **MessageBubble keyboard alternative + edge-aware positioning — CONFIRMED, cost
   estimate corrected** (DD-18r leg). Verified: the detail card is hover-only
   (`onMouseEnter`/`onMouseLeave` at `console/src/components/MessageBubble.tsx:133–134`,
   500ms timer at line 100, wrapper not focusable) and hard-positioned
   `bottom: 100%; left: 0` with no measurement (`MessageBubble.tsx:27–31`) — clips at
   the viewport top and, for outgoing (right-aligned) bubbles, can overflow the right
   edge. Mechanism (per interaction-patterns §3 hover-never-required, kept minimal):
   the hover path stays byte-identical (it pins the existing tests); the bubble wrapper
   additionally becomes focusable (`tabIndex={0}`), the card shows on focus with NO
   delay (focus feedback is instant per the motion law), hides on blur, and Escape
   hides it and stops propagation (one-layer law, §2). Edge handling: measured-rect
   flip on reveal — measure the card, flip below (`top: 100%`) when clipped at the
   viewport top, right-anchor when clipped at the right edge; the CURRENT placement
   stays the default, exposed as a `data-placement` attribute. **Correction (survey
   said "test migration is the bulk of the work"):** the extended suite is 572 lines
   (not 573), ~59 tests; exactly 10 open the detail card, all via
   `mouseEnter` + fake timers — the 7-test `hover detail card` block
   (`tests/console/message-bubble-extended.test.tsx:476–534`) and 3 F-044 card-content
   tests (lines 351–380). Because the design is additive (hover path unchanged,
   defaults hold in jsdom where rects measure 0), **all 10 survive unchanged**; the
   work is additive new tests, not migration. The remaining ~49 tests never touch the
   card.
4. **SearchInput adoption — CONFIRMED; the survey's B2 dependency is FALSIFIED.**
   `console/src/components/shared/SearchInput.tsx` (31 ln) already exists on the
   committed tree (landed with the scheduled/groups refactor, pre-B2; B2's packet lists
   it as an unchanged producer). It is consumed today by ChatPicker,
   ContactSearchPicker, and GroupDetailModal, and supports `containerClassName` +
   `endAdornment` — exactly the slots the Inbox search needs for its spinner/clear
   affordances. There is no dependency on B2 and nothing to extract: B4 swaps the
   hand-rolled block (`console/src/pages/Inbox.tsx:281–312`: raw
   `c-input c-input-search` + hand-positioned icon) for `SearchInput`, passing the
   existing busy-spinner/clear button as `endAdornment`. The 300ms debounce stays
   page-owned (`Inbox.tsx:80–84`) — SearchInput is a controlled presentational input,
   same as its other call sites. Verified precision: this is the LAST raw
   `c-input-search` re-roll in the console (grep §3), so the input.md "Inbox and Fleet
   (P2-4)" migration note reduces to Inbox — the named adoption closes the ban's last
   open site.
5. **Composer focus-suppression fix — CONFIRMED, with a behavioral nuance.** Verified:
   exactly two `outline-none` hits console-wide — `console/src/pages/Inbox.tsx:434`
   (this slice) and `console/src/components/line-detail/HistoryTab.tsx:206` (identical
   composer class string; stays, see §13 C-B4-6). Nuance: a global
   `textarea:focus-visible` rule already paints a box-shadow focus ring + border
   recolor (`console/src/styles/composites.css:956–965`), and box-shadow is not
   suppressed by the outline utility — so the composer is not actually ringless today.
   The fix removes the suppressing class (the global rule already neutralizes default
   outline under `:focus-visible`), making the file honest against
   interaction-patterns §1 and dropping the
   `soup/no-focus-suppression :: src/pages/Inbox.tsx` bucket to zero. Near-zero visual
   delta; confirmed at the live checkpoint alongside C-B4-1. Migrating the composer to
   the input.md "composer flavor" textarea is the form-kit slice, NOT B4 (C-B4-8).
6. **Out of scope:** SaveContact dialog extraction (`Inbox.tsx:619–660` + its
   document-level Escape effect at 203–208 — B3 wave 1, packet already `Ready`);
   LinePicker internals (B2 rebuilds it on Popover; Inbox stays a `variant="toolbar"`
   consumer, untouched); message virtualization internals
   (`console/src/hooks/use-virtual-messages.ts`, `console/src/lib/inbox-virtualization.ts`);
   the other three legacy pane tokens in the tokens-v3 §6.12 row
   (`--panel-actions`/`--panel-history`/`--panel-access-col` — LineDetail surfaces,
   ride their owning slices); the HistoryTab composer `outline-none` twin; chat-list
   behavior below the 1080px collapse (layout-density names only the contact-pane drop
   for Inbox — narrower-still behavior stays in the DD-18r remainder).

## 1. Gate 0 output

PLACEHOLDER — integrator fills at dispatch: worktree/branch state, origin/main delta +
merge, post-merge lint + test counts, worktree inventory. Notes for the integrator at
packet-writing time (2026-06-12, branch `feat/soup-v3-foundation`):

- **B2 is in flight in the `soup-impl` worktree**: `Popover.tsx` +
  `primitives-popover.test.tsx` untracked; `use-dismissable.ts`, `primitives.css`,
  `tokens.component.css`, `primitives/index.ts` modified. B4 also edits
  `tokens.component.css` and `primitives.css` — dispatch B4 only after the in-flight B2
  commits land (or are shelved), never into this dirty overlap (C-B4-4).
- **B3 wave 1 (`Ready`) also edits `Inbox.tsx`** (deletes the dialog block + Escape
  effect). Either order works; B3-wave-1-first is recommended — the page shrinks and
  B4's page harness then needn't stub the dialog (C-B4-5).

## 2. frontend-design pre-implementation checkpoint

- **Pane geometry per layout-density §7:** Inbox panes take the spec tokens 264px
  (chats) / 248px (contact). **Visual change recorded:** both side panes narrow
  (−24px/−8px) and the thread widens; chat names/previews truncate ~3 characters
  earlier at the item's existing ellipsis classes. INCONCLUSIVE until live review in
  both themes (C-B4-1).
- **Collapse posture per layout-density §5:** below the ~1080px container stress the
  contact pane is dropped entirely ("more detail on fewer items" — the spec names this
  exact surface). No intermediate squeeze state; the chat list keeps its fixed width,
  the thread absorbs the space. PASS (spec-driven); live proof at C-B4-2.
- **Chat list keyboard:** semantics-only change (roving tabindex + arrows); zero visual
  delta intended. Focus ring on rows rides the existing global focus-visible recipe.
  PASS (design intent).
- **Bubble detail card:** anatomy unchanged (same card, same content); new reveal path
  (focus) and new placement states (below-flip, right-anchor). The flipped placements
  reuse the existing card surface unchanged. PASS (design intent); edge placements
  live-reviewed near the thread top and on outgoing bubbles (C-B4-7 note).
- **Search row:** SearchInput renders the same `c-input c-input-search` recipe the
  hand-rolled block uses today; icon position moves from a hand-placed `left-2.5` to
  the component's token offset — sub-pixel-class delta. PASS pending live glance.
- **Density:** Inbox panes are `default` density per layout-density §3 — unchanged.
  PASS.
- **Motion:** no new transitions. Card reveal on focus is instant; collapse is a
  declarative CSS flip (snap); reduced-motion unaffected. PASS.
- **Both themes:** no new colors, no new semantic tokens; two component tokens renamed.
  PASS pending live review.

Checkpoint verdict: PASS with one INCONCLUSIVE row (pane narrowing) — resolved at the
live checkpoint mid-slice.

## 3. Files inspected and classification

Caller greps (run 2026-06-12 against `soup-impl`, branch `feat/soup-v3-foundation`):

- `grep -rn "panel-chat-list\|panel-contact" console/src` → definitions
  (`tokens.component.css:24–25`) + exactly two consumers (`pages/Inbox.tsx:222,479`).
  **Token blast radius = Inbox only — verified.** No test pins 288/256.
- `grep -rn "outline-none" console/src` → exactly 2 hits (`pages/Inbox.tsx:434`,
  `line-detail/HistoryTab.tsx:206`). **Survey claim VERIFIED.**
- `grep -rn "c-input-search" console/src` (excluding the SearchInput producer) →
  exactly 1 hit (`pages/Inbox.tsx:293`). **Inbox is the last raw search re-roll.**
- `grep -rn "useVirtualMessages" console/src` → `pages/Inbox.tsx` (messages + search)
  and `line-detail/HistoryTab.tsx` only. **Chat list not virtualized — survey premise
  corrected.**
- `grep -rn "MessageBubble" console/src` → consumers: `pages/Inbox.tsx` (350, 402) and
  `line-detail/HistoryTab.tsx:171`. **Bubble changes reach HistoryTab too** (C-B4-6).
- `console/src/hooks/use-keyboard-shortcuts.ts` → binds Cmd/Ctrl+K, `?`, and 1/2/3 page
  jumps only when not in an input; no arrow keys. **No conflict with chat-list arrow
  nav** (rows are not INPUT/TEXTAREA, so digit shortcuts still fire while a row is
  focused — acceptable, they navigate pages, recorded in §6.10).

| File | Class | Current invariant | B4 invariant | Changes? |
|---|---|---|---|---|
| `console/src/pages/Inbox.tsx` (663 ln) | consumer | three fixed `flex-shrink-0` panes, no collapse; inline chat-list listbox map (233–242); raw search input + spinner/clear (281–312); composer `outline-none` (434); 300ms debounce effect (80–84) | root carries the container-query layout class; renders `<ChatList>`; search block renders `SearchInput` + `endAdornment`; composer suppression removed; pane widths via renamed spec tokens | YES |
| `console/src/components/ChatList.tsx` | consumer (NEW) | does not exist | listbox container (role, label, keydown), roving tabindex tracked by `conversationKey`, Down/Up/Home/End, manual selection (Enter/Space via item), empty state moved in | NEW |
| `console/src/components/ChatListItem.tsx` (77 ln) | consumer | `role="option"`, hardcoded `tabIndex={0}` (19), Enter/Space activation (21), aria-selected | `tabIndex` becomes a prop (roving-driven); everything else unchanged | YES |
| `console/src/components/MessageBubble.tsx` (168 ln) | producer (shared with HistoryTab) | hover-only detail card, 500ms delay, fixed `bottom:100%/left:0`, wrapper not focusable | + focusable wrapper, focus/blur reveal (no delay), Escape hide + stopPropagation, measured-rect flip with current placement as default + `data-placement` | YES |
| `console/src/components/shared/SearchInput.tsx` (31 ln) | producer | the ONE search input, `endAdornment`/`containerClassName` slots, pinned by structural tests | unchanged — consumed | NO |
| `console/src/styles/tokens.component.css` | producer | `--panel-chat-list: 288px`, `--panel-contact: 256px` | renamed `--inbox-pane-chats: 264px`, `--inbox-pane-contact: 248px` (tokens-v3 §4/§6.12) | YES |
| `console/src/styles/primitives.css` | producer | container-query precedent = drawer band only (1188–1247) | + Inbox layout band: `container-type: inline-size` root + `@container` contact-pane drop below 1080px | YES |
| `console/src/hooks/use-virtual-messages.ts` (65 ln) | producer | overscan 8, pk-keyed rows | unchanged — out of scope | NO |
| `console/src/components/line-detail/HistoryTab.tsx` | consumer | renders MessageBubble (171); own composer `outline-none` (206) | unchanged file; inherits the bubble focus path by construction | NO |
| `tests/console/chat-list-item.test.tsx` (154 ln) | fixture/consumer | pins option role, aria-selected, Enter/Space, AND `tabIndex === '0'` (152) | tabIndex assert becomes prop-driven (roving); all other cases survive | YES |
| `tests/console/chat-list.test.tsx` | evidence (NEW) | does not exist | listbox contract (§8) | NEW |
| `tests/console/message-bubble-extended.test.tsx` (572 ln) | fixture/consumer | ~59 tests; 10 open the card via hover + fake timers (476–534, 351–380) | all existing cases survive unchanged; + focus-reveal block and placement-flip cases (stubbed rects) | YES (additive) |
| `tests/console/message-bubble.test.tsx` (47 ln) | fixture/consumer | timestamp marker in bubble + detail surfaces | unchanged (card content untouched) | NO |
| `tests/console/inbox-page.test.tsx` | evidence (NEW) | does not exist — NO Inbox page harness exists anywhere (only lib unit tests `inbox-chat-selection`/`inbox-virtualization`) | page harness + structural/behavioral contract (§8) | NEW |
| `console/{eslint.config.shadow.mjs,lint-shadow-baseline.json}` | enforcement | rule×file fall-only ratchet (594 at B1 close; B2/B3 regens pending) | baseline regen — B4 buckets must FALL (§10); no new selectors | YES |
| `docs/design-system/06-implementation/design-debt-register.md` | register | DD-17 open; DD-18r Inbox legs open | deltas per §12 | YES |

**Exact new files:** `console/src/components/ChatList.tsx`,
`tests/console/chat-list.test.tsx`, `tests/console/inbox-page.test.tsx`,
`b4-evidence.md` (at acceptance), this packet. **Exact deletions:** none (the legacy
token names disappear via rename). Any file beyond this table is added here before
commit.

## 4. Patterns to replace

(a) **All-stops listbox** — `tabIndex={0}` on every option row, container with no focus
management; matches neither WAI listbox pattern. Replaced by roving tabindex (exactly
one stop: the selected row, else the first), Down/Up move focus WITHOUT selecting
(manual activation — selection triggers a `useMessages` fetch, see §6.4), clamp at the
ends, Home/End jump, Enter/Space select (existing item behavior, kept).
(b) **Collapse-less fixed panes** — three `flex-shrink-0` panes that overflow rather
than adapt. Replaced by the container-query drop of the contact pane at the documented
stress; the named threshold is "inbox loses contact pane" per layout-density §5.
(c) **Hover-only, edge-blind detail card** — 500ms hover with no keyboard path and
fixed top-left placement. Replaced by hover-plus-focus reveal with Escape dismiss and
measured edge flip (hover path byte-identical).
(d) **Re-rolled search input** — raw `c-input c-input-search` + hand-placed icon,
spinner, and clear button. Replaced by the shared SearchInput (input.md ban: "inline
re-implementations are banned"); last raw site console-wide.
(e) **Focus suppression** — `outline-none` on the composer without an in-file
focus-visible pairing. Removed; the global focus-visible recipe takes over.
(f) **Token drift** — 288/256 legacy widths → spec tokens/values 264/248.

## 5. Fixture and data review

Per-file inline factories remain the convention (kept).

- `chat-list-item.test.tsx`: solid `chat()` factory (nullish/markdown/unread/typing
  variants). **Missing for B4:** nothing item-level beyond the tabIndex re-assert.
- `chat-list.test.tsx` (new): needs a many-chats factory (≥20 rows — roving across a
  long list), a reorder fixture (same keys, new order — focus-by-key survival, §6.5),
  selected-mid-list and none-selected cases, an empty list, and a long-name chat
  (≥40 chars — truncation class contract at the narrowed 264px).
- `message-bubble-extended.test.tsx`: `msg()`/`outgoing()` factories suffice. New
  cases stub `getBoundingClientRect` to drive the flip branches (jsdom rects are 0 by
  default, which exercises the no-flip default for free).
- `inbox-page.test.tsx` (new): **no Inbox page harness exists** — build one copying the
  B1 LineDetail harness pattern (hoisted mocks): `useLines`/`useChats`/`useMessages`/
  `useTyping` stubs (from `hooks/use-fleet`), `useSearchParams`, `api`, toast context,
  React Query provider. Survey's "ZERO tests pin pane layout, collapse, or listbox
  semantics" is **true at list/page level but imprecise at item level** —
  `chat-list-item.test.tsx` already pins option role, aria-selected, Enter/Space, and
  the per-item `tabIndex='0'` (the very thing B4 changes; line 152). The genuinely
  untested surface this harness covers for the first time: pane layout classes, the
  collapse class contract, search-row composition, composer attributes, listbox wiring
  with live chats data.
- Runtime data shapes verified: `ChatItem` (`name` nullable — display fallback already
  tested), `Message` (pk sentinels −1/negative/positive drive the card's ID row —
  pinned by F-044 tests, untouched).

## 6. Reliability answers (each becomes code, test, rule, DD, or non-goal)

1. **Selection vs collapse interplay:** the collapse is CSS-only (`display: none` via
   container query) — React state (`selectedChat`, queries, composer text) is never
   touched by a resize; re-growing the container restores the pane with identical
   content. → code by construction + documented rule; live QA resize pass.
2. **Focus inside the pane when it collapses:** if focus sits on a contact-pane action
   while the container shrinks past the threshold, the browser drops focus to body
   (display:none). Rare (requires keyboard focus + simultaneous resize); accepted and
   documented — no focus-rescue machinery this slice. → documented rule + manual QA.
3. **Focus during virtualized scroll (bubble focus path):** a focused bubble that
   scrolls beyond the render window (overscan 8, `use-virtual-messages.ts:11`)
   unmounts; focus falls to body and the card disappears with the unmount (state is
   component-local). This matches the existing behavior of any focusable inside
   virtual rows (e.g. the retry button). No scroll-anchored focus restoration this
   slice. → documented rule + test (unmount-while-focused leaves no card and does not
   throw).
4. **Rapid chat switching:** arrow keys move focus WITHOUT selecting (manual
   activation), so keyboard traversal fires zero message fetches; Enter selects and
   React Query dedupes/caches per `['messages', line, chat]`. Composer text and
   in-panel search already reset per chat (`Inbox.tsx:54, 60–63`) — unchanged. → code
   + test (arrow traversal does not change selection; Enter does).
5. **Chats refresh/reorder while focus is in the list:** the roving target is tracked
   by `conversationKey`, not index (B2 §6.2 precedent: track by value). On reorder,
   focus stays with the same chat; if the focused chat leaves the list, the stop falls
   back to the selected row, else the first; focus is never stolen. → code + test
   (rerender-with-reordered/removed rows).
6. **Empty chat list:** empty state renders (existing copy), no tab stop in the
   listbox, arrows no-op. → code + test.
7. **Hover card near viewport edges:** measured flip per §0.3. jsdom cannot measure —
   stubbed-rect unit tests prove the branch logic; live QA proves geometry at the
   thread top and on right-edge outgoing bubbles; D7 viewport tests are the
   deterministic backstop (existing DD-18r/D7 lane). → code + test + manual QA.
8. **Escape stacking:** the card's Escape handler fires only while a card is shown and
   stops propagation — it cannot reach the SaveContact dialog's document-level handler
   (pre-B3) or any future overlay; one layer per press. → code + test (Escape with
   card shown does not close an open dialog).
9. **Hover and focus simultaneously:** reveal state is a simple OR; mouse leave while
   focused keeps the card (focus owns it), blur while hovered keeps it (hover owns
   it). The 500ms timer applies to hover only. → code + test.
10. **Global digit shortcuts while a row is focused:** chat rows are DIVs, so the
    1/2/3 page-nav shortcuts still fire while the list has focus (they are gated on
    INPUT/TEXTAREA/SELECT only, `use-keyboard-shortcuts.ts:31–36`). Pre-existing
    behavior, unchanged by B4; arrows/Home/End/Enter/Space do not collide with any
    registered shortcut. → non-goal, documented.
11. **Reduced motion:** no new transitions added; card reveal is instant by
    construction; the collapse is a declarative snap. → code + manual check.

## 7. Responsive decision note

The Inbox root becomes the queried container (`container-type: inline-size` — second
use of the C2.3 idiom). At container width below 1080px the contact pane is removed
from layout (`display: none`); the chat list keeps `--inbox-pane-chats` fixed width and
the thread flexes. The threshold is named after the stress per layout-density §5
("inbox loses contact pane") — not a device class. Chat list rows keep their existing
truncation classes (name and preview `min-w-0` + ellipsis) and must absorb the 24px
narrowing without layout breakage — long-name fixture in §5. Below the collapse
(stress continues toward the 320px reflow floor) the chat-list/thread pair has NO
specified behavior for Inbox — layout-density names only the contact-pane drop;
narrower behavior remains in the DD-18r remainder (side-panel law for non-Fleet
surfaces) and is NOT invented here. jsdom cannot evaluate container queries — class
contracts + live QA at 1024/1080±/1280/1440 now; computed proof remains D7.

## 8. Targeted test plan

- **ChatList** (`chat-list.test.tsx`): listbox role + accessible name; exactly one
  row with `tabIndex=0` (selected, else first); ArrowDown/ArrowUp move focus without
  changing selection; clamp at both ends; Home/End; Enter/Space on a focused row
  selects it; reorder keeps the roving stop on the same `conversationKey`;
  focused-chat-removed falls back without focus theft; empty list renders empty state
  and arrows no-op; typing-indicator rows remain navigable.
- **ChatListItem**: all existing cases survive; the `tabIndex` assert (line 152)
  re-targets the prop contract (0 when roving target, −1 otherwise).
- **MessageBubble** (additive block in the extended file): existing 10 card tests
  UNCHANGED (regression proof for the hover path); + focus reveals the card with no
  timer advance; blur hides; Escape hides and does not propagate; hover+focus OR
  cases (§6.9); unmount-while-focused safe (§6.3); `data-placement` defaults with
  jsdom zero-rects; flip branches via stubbed `getBoundingClientRect` (top-clipped →
  below; right-clipped → right-anchored).
- **Inbox page** (`inbox-page.test.tsx`, new harness): root carries the container
  layout class and panes carry the renamed token width classes (class contract,
  labeled as such); contact pane carries the collapse-target class; search row renders
  the shared SearchInput (structural import + render assert, mirroring the
  ChatPicker/ContactSearchPicker pins) with working 300ms debounce (fake timers,
  unchanged behavior); clear button and busy spinner ride `endAdornment`; composer
  textarea carries NO `outline-none` and Enter-sends still works; listbox receives
  chats and selection flows to `useMessages`.
- Weak-terminal-assertion rule honored (end on value/attribute asserts).

## 9. Observability plan

Accessible state only: roving `tabIndex`, `aria-selected`, role queries
(listbox/option), `data-placement="above|below"` (+ right-anchor state) on the detail
card for test/QA inspection. No production `console.*` (repo guard). No other new data
attributes.

## 10. Enforcement plan

No new shadow selectors this slice: roving-tabindex and container-collapse are not
selector-expressible without false positives; the focus-suppression and raw-form
selectors already exist. Baseline regen at the final task — B4 buckets that MUST FALL:

| Bucket | Now | After | Why |
|---|---|---|---|
| `soup/no-focus-suppression :: src/pages/Inbox.tsx` | 1 | 0 | composer fix |
| `soup/no-raw-form-control :: src/pages/Inbox.tsx` | 3 | −1 | search input → SearchInput; the SaveContact input leaves with B3 wave 1 (its slice, not B4's count); **explicitly NOT falling:** the composer textarea (form-kit slice, C-B4-8) — recorded so the ratchet diff reads honestly |
| `soup/no-legacy-tokens` :: Inbox/ChatListItem/MessageBubble (29/3/7) | 39 | partial fall | only hits on lines B4 rewrites (search block, pane wrappers, bubble wrapper) — exact counts read from the regen, no number promised here |

`soup/no-focus-suppression :: src/components/line-detail/HistoryTab.tsx` (1) stays —
named remainder, owner per C-B4-6. Any rise anywhere is a regression to fix, never a
bump.

## 11. Rollback strategy

One commit per concern, each independently revertible: (1) ChatList extraction +
roving/arrow contract + item tabIndex prop + tests (DD-17); (2) container-query
collapse + token rename/revalue + page harness layout tests (DD-18r pane leg —
the visible commit, revertible alone); (3) MessageBubble focus path + edge flip +
tests (DD-18r card leg); (4) SearchInput adoption; (5) composer suppression removal;
(6) baseline regen + register/docs. No cross-commit coupling — 2 through 5 are
mutually independent; 6 depends on all.

## 12. Debt register deltas planned

Close at acceptance with proof: **DD-17** (roving tabindex + arrow-key contract tested
— the row's expiration condition verbatim). **DD-18r narrows, does not close**: the
Inbox three-pane collapse leg and the MessageBubble hover-card positioning leg close
with this slice's evidence; remaining legs re-scoped in the row — legacy modal sizing
SSOT (B3), nav width pressure, side-panel law for non-Fleet surfaces (includes the
sub-collapse Inbox behavior, §7), deterministic viewport tests (D7). New debt:
**DD-24 (proposed id; B2 reserved DD-23)** — contact-pane actions (Mark Read / Allow /
Block / Save Contact) are unreachable below the collapse threshold; expiry: an
alternate action path on the thread surface (e.g. chat-header action affordance,
designed against button.md/toolbar.md in a later slice) or an explicit NOT-APPLICABLE
ruling in the QA matrix; blocks final acceptance: no. Anything else discovered lands
as a DD entry, not prose.

## 13. Constraints / open items

- **C-B4-1 (visible change):** pane narrowing 288→264 / 256→248 + the search-row icon
  offset nuance — reviewed at the live frontend-design checkpoint in both themes
  before the slice is accepted.
- **C-B4-2 (threshold interpretation):** layout-density §5 gives "~1080px" — pinned
  here at a 1080px CONTAINER query on the Inbox root (the spec's preferred unit);
  jsdom cannot prove the flip — class contract + live QA + D7, mirroring the C2.3
  squeeze evidence pattern.
- **C-B4-3 (orphaned actions):** the spec-mandated contact-pane drop removes the only
  path to four actions at narrow widths → DD-24; B4 does not invent an unspecified
  alternate surface.
- **C-B4-4 (dirty-worktree overlap):** B2 work is in flight in `soup-impl` touching
  two files B4 also edits (`tokens.component.css`, `primitives.css`) — Gate 0 must
  find these resolved before dispatch.
- **C-B4-5 (Inbox.tsx contention):** B3 wave 1 edits the same page; integrator
  sequences (B3-wave-1-first recommended); whichever lands second rebases its page
  diff.
- **C-B4-6 (shared-bubble blast radius):** the MessageBubble focus path and edge flip
  apply to HistoryTab (LineDetail) by construction — zero HistoryTab code change, its
  existing tests don't pin the card; noted for the live checkpoint to glance at the
  History tab. HistoryTab's own composer `outline-none` is the OTHER console hit and
  stays (owner: the form-kit composer-flavor sub-slice, with `input.md` §Variants
  naming the composer flavor).
- **C-B4-7 (clamp interpretation):** WAI listbox leaves end-wrap optional; clamp
  chosen, consistent with B2's option-list clamp (tabs wrap per tabs.md — different
  widget, both interpretations recorded in their packets).
- **C-B4-8 (composer scope):** only the suppression hit is fixed; composer migration
  to the input.md composer flavor rides the form-kit slice (same boundary B2 drew for
  TagInput's raw input).

## 14. Strong-claim audit

Every load-bearing survey claim was re-verified against the live tree; four were
corrected: the chat list is NOT virtualized (the survey's stated reason for roving
tabindex — replaced with reasons that hold, §0.1); ChatListItem is NOT a single edit
site for roving (list-level coordination required, §0.1 Amendment A); SearchInput has
NO B2 dependency (it already exists, committed, three consumers — §0.4); the 572-line
bubble suite is NOT "the bulk of the work" (10 of ~59 tests touch the card and all
survive the additive design, §0.3). One imprecision tightened: "zero listbox tests"
holds at list level but item-level option semantics ARE pinned — including the
per-item `tabIndex='0'` assert that B4 must flip, found before it could fail in CI
(§5). The composer fix's "suppression" is a lint/honesty fix, not a missing-ring fix —
the global recipe already paints a ring (§0.5); the evidence packet must not claim a
behavioral a11y repair there. At slice end, grep the diff for done/complete/enforced/
canonical/single/only/never/guaranteed/final/accessible and verify each against code,
tests, or evidence before commit (A0 requirement carried into A6). The ChatList header
comment must say "listbox-pattern home for the Inbox chat list", not "the ONE listbox"
— B2's pickers own their own listboxes.

## Verdict: **Ready with Constraints** (C-B4-1 resolved at live checkpoint; C-B4-2/3/6/7/8 documented; C-B4-4/5 are Gate-0/sequencing conditions for the integrator). Implementation may begin once Gate 0 confirms the worktree overlap is resolved.
