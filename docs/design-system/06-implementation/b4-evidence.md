# Slice Evidence — B4 (Inbox: ChatList listbox / pane collapse / MessageBubble / SearchInput / composer carve-out)

Worktree `soup-impl`, branch `feat/soup-v3-foundation`. Commits (all reachable from the
packet-time HEAD `244518c6`, whose console code is byte-identical to `76012b68` — the
top-up merge between them is docs-only, verified by
`git -C <soup-impl worktree> diff --name-only 76012b68..244518c6`,
3 files all under `docs/`):

| Commit | Concern (packet §11 rollback unit) |
|---|---|
| `bb9ba869` | ChatList extraction + roving tabindex + arrow contract + item tabIndex prop + 2 test suites (DD-17 traversal leg) |
| `099caaa4` | two chat-list assertions strengthened on the test-integrity flag (label attribute + no-op contract replace bare presence) |
| `517e4485` | legacy `text-t4` in ChatList empty state replaced (new-file ratchet ceiling 0 restored) |
| `68a7beda` | container-query contact-pane collapse + pane-token rename/revalue 288/256→264/248 + new Inbox page harness (DD-18r pane leg — the visible commit) |
| `d5627923` | MessageBubble focus reveal + Escape + measured edge placement + 14 additive tests (DD-18r card leg) |
| `9bfde5c3` | SearchInput adoption + composer `outline-none` removal + Group F carve-out retirement + ratchet 511→509 (B4 close) |
| `a4f1df10` | stale Group F comment corrected (eslint.config.js:704 now states the Inbox carve-out retired at B4 close) |

Gate packet: `b4-investigation.md` (`7d01d729`, Ready with Constraints). Sequencing
conditions honored: C-B4-5 — B3 wave 1 landed first as recommended (`7585eb8f`
03:23 < `bb9ba869` 11:35, SaveContact dialog already out of Inbox.tsx); C-B4-4 — the
B2 in-flight overlap on `tokens.component.css`/`primitives.css` was committed before
dispatch (`8ca44a4f` 03:13, `2b0a9591` 03:56, baseline regen `95ab4aa5` 03:30 all
precede the first B4 commit). Live QA source: `visual-qa-b-stages.md` rows 1–2.

Fresh verification runs for this packet (2026-06-12, evening, at the packet-time tree):
five B4 jsdom suites **125/125** (`chat-list` 20, `chat-list-item` 16, `inbox-page` 14,
`message-bubble-extended` 74, `message-bubble` 1, via
`npx vitest run --root . tests/console/<file> --pool=forks`); design enforcement suites
**73/73** (`design-lints.test.ts` + `design-token-classes.test.ts`); console
`npx eslint .` exit 0; shadow ratchet `check-shadow-baseline.mjs` **486 ≤ ceiling 486**;
theme parity 100/100 tokens; repo `npm run typecheck` exit 0. Full repo suite 10,148
green at `76012b68` per the integrator's record (not re-run here; the B4-relevant
slices above were re-run fresh).

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Spec fidelity | **PASS** | layout-density §5 contact-pane drop as a CONTAINER query at the spec's ~1080px stress (`primitives.css:1574–1582`: `.soup-inbox-layout { container-type: inline-size }` + `@container (max-width: 1079px) .soup-inbox-contact { display:none }` — C2.3 squeeze idiom, second use); tokens-v3 §4/§6.12 spec names+values live (`tokens.component.css:23–24`: `--inbox-pane-chats: 264px`, `--inbox-pane-contact: 248px`; legacy names survive only in the provenance comments, zero `var()` consumers — grep); WAI listbox roving with manual activation (`ChatList.tsx` — arrows move focus WITHOUT selecting, Enter/Space select; clamp per C-B4-7, header comment says "listbox-pattern home", not "the ONE listbox", per packet §14); interaction-patterns hover-never-required + instant focus feedback + one-layer Escape with stopPropagation (`MessageBubble.tsx:151–175`); input.md single-SearchInput ban closed — `c-input-search` exists in exactly one .tsx file console-wide, the producer (`shared/SearchInput.tsx:20`); hover path semantics byte-preserved (500ms timer intact, `MessageBubble.tsx:137–149`) |
| Code quality | **PASS** | roving stop tracked by `conversationKey`, never index (B2 §6.2 precedent; `ChatList.tsx:35–47` with the 4-step fallback documented in-file); collapse is CSS-only — React state untouched by resize, pane restores with identical content (§6.1, documented in the CSS band comment); zero-rect jsdom guard keeps unstubbed tests on the default placement (`MessageBubble.tsx:124–135`); focus/hover reveal is a simple OR (`showByHover \|\| showByFocus`, line 113); debounce stays page-owned, SearchInput stays a controlled presentational input; six commits match the packet's one-commit-per-concern rollback plan. Noted, not blocking: card clip detection uses estimated dims (160×220 constants, `MessageBubble.tsx:129–130`) rather than measuring the card itself — acceptable heuristic, geometry truth belongs to the live/D7 lane (omission audit) |
| Test integrity | **PASS with 2 findings (routed)** | 125/125 fresh; the 10 pre-existing hover-card tests are byte-unchanged in `d5627923` (its only test-file deletion is one header-comment line — regression proof for the hover path holds; suite 60→74); `099caaa4` strengthened the two flagged weak terminals; the tabIndex item assert re-targeted to the prop contract with 3 cases incl. the standalone default (`chat-list-item.test.tsx:154–177`). **FINDING T1:** the two `9bfde5c3` additions to `inbox-page.test.tsx` under-deliver — "search input is reachable by aria-label once a chat is selected" (line 294) never renders the selected-chat branch and never queries that aria-label (terminal assert is a token-absence check), and the composer test (line 338) renders the UNselected branch, so the composer is absent from the DOM it sweeps for `outline-none`. The claims are nevertheless TRUE and pinned by stronger evidence: the inverted carve-out fixture proves `soup/no-focus-suppression` FIRES at Inbox.tsx and stays silent at HistoryTab.tsx (`design-lints.test.ts:609–626`), live `eslint .` exit 0 under that config proves Inbox carries no suppression, `design-token-classes.test.ts:37–40` pins the Inbox source to `SearchInput` and to the absence of `c-input c-input-search`, and the whole-tree grep finds `outline-none` only at `HistoryTab.tsx:206`. Routed: rewrite the two harness cases to drive click-to-select (jsdom can — the harness mocks support it) and assert the rendered search row/composer directly — C3 Inbox screen pass. **FINDING T2:** the `9bfde5c3` baseline regen carries an unattributed +1 (`SummaryTab` 15→16) — traced to the main-side bond-read fix `37ab4115` absorbed via merge `ff5bb76b` between regens, same inherited-rise class the `95ab4aa5` Nav+3 precedent recorded explicitly; not a B4 regression, but the commit message's "511 → 509" hides a −3/+1 composition. Recorded here so the ratchet trail reads honestly |
| A11y / keyboard | **PASS on the traversal contract; RING LEG OPEN (DD-17 partial — see dedicated section)** | listbox + accessible name + exactly-one-stop proven (20-test suite: first-row/selected-row/long-list stop uniqueness; ArrowDown/ArrowUp move focus without firing onSelect; aria-selected unchanged by traversal; clamp both ends; Home/End; Enter/Space select with the right key; reorder keeps the stop on the same conversationKey; removed-focused-chat falls back to selected row then first row without focus theft; empty-list arrows no-op incl. the strengthened no-op contract; typing rows stay navigable — every §8 case present); arrow traversal fires zero message fetches by construction (manual activation, §6.4); bubble keyboard path: focusable wrapper, instant focus reveal (no timer), blur hide, Escape one-layer with propagation stopped only while shown, hover/focus OR cases, unmount-while-focused safe (`message-bubble-extended.test.tsx` new blocks); digit-shortcut coexistence unchanged (§6.10 non-goal). jsdom cannot prove visible focus treatment — which is exactly where the ring finding bites |
| Visual / live QA | **PASS for the two named matrix rows; named residue routed** | `visual-qa-b-stages.md` **row 1** — Inbox three panes at 1440×900, meta+timestamps+log-time-lane legibility, both themes: **PASS (5/5 sub-checks)**; **row 2** — contact pane collapses at 1024×768 per the collapse rule: **PASS**. Independently re-verified for this packet from the surviving session frames: `/tmp/check1-1440x900-FINAL.png` (dark, three panes; contact pane measures ≈246px on-screen, consistent with the 248px token) and `/tmp/check2-1024x768.png` (contact pane gone, chat list holds fixed width, thread absorbs the space) re-read directly; `/tmp/check3-chatlist-zoom.png` is the LIGHT-theme 1440 frame (white surfaces, legible list, designed-first-class — despite its filename). Deterministic backstop now in CI: the Inbox viewport-matrix rows landed post-B4 (`4fbad4ef` — computed contact-pane display proven present above and gone below the container threshold, no-horizontal-overflow sweep; browser 93/93). **Honest caveats:** every live Inbox frame shows the no-conversation-selected state, so the C-B4-1 search-row icon-offset glance and the composer focus-ring appearance were NOT exercised live (compensating: SearchInput renders the identical `c-input c-input-search` recipe — sub-pixel-class delta per packet §2 — and the composer ring is the pre-existing global recipe, `composites.css:999–1008`); no matrix row glances at the History tab (C-B4-6) or at edge-flipped card placements (C-B4-7 note). All routed in the omission audit |

## Constraint verification (binding constraints from the gate packet)

- **C-B4-1 (visible pane narrowing + search-row nuance):** pane leg RESOLVED live —
  matrix rows 1–2 PASS in both themes (frames re-verified above). Search-row icon
  glance NOT performed (no frame renders the search row) — residue routed to the C3
  Inbox screen pass; class-level identity argues the delta is sub-pixel.
- **C-B4-2 (1080px container threshold):** pinned exactly as specified —
  `@container (max-width: 1079px)` on the Inbox root (`primitives.css:1577–1581`),
  class contracts in the page harness, live collapse observed at 1024 (row 2), and
  computed-display browser proof in CI (`4fbad4ef`). The evidence pattern (class
  contract + live + browser matrix) mirrors C2.3 as the packet required.
- **C-B4-3 (orphaned contact-pane actions):** DD-24 filed (`c82fb3cc`) and present in
  the register; condition re-confirmed on the tree — Mark Read / Allow / Block / Save
  Contact render only inside `.soup-inbox-contact` (`Inbox.tsx:458` onward), which is
  `display:none` below the threshold. No alternate surface invented, per the packet.
- **C-B4-4 (dirty-worktree overlap):** satisfied before dispatch — see commit-timing
  proof in the header.
- **C-B4-5 (Inbox.tsx contention):** satisfied — B3-wave-1-first ordering held.
- **C-B4-6 (shared-bubble blast radius):** HistoryTab inherits the focus path and edge
  flip by construction (`HistoryTab.tsx:171` renders the shared MessageBubble; zero
  HistoryTab code change in any B4 commit); its composer `outline-none`
  (`HistoryTab.tsx:206`) remains THE one console-wide hit, carved out in eslint Block 2
  (`eslint.config.js:712–719`, files list = HistoryTab only) with the carve-out's
  continued silence fixture-pinned (`design-lints.test.ts`, "still silent at
  HistoryTab.tsx"). The packet's History-tab live glance was not performed — routed.
- **C-B4-7 (clamp interpretation):** clamp implemented (`ChatList.tsx:76–77`
  `Math.min`/`Math.max`), boundary-pinned by tests; both-interpretation record kept in
  the gate packet. Edge-placement live review near the thread top / outgoing bubbles
  not performed — jsdom stubbed-rect tests prove the flip branches
  (above/below/right-anchor via `data-placement`); geometry residue routed to D7/C3.
- **C-B4-8 (composer scope):** held exactly — only the suppression class was removed;
  the composer textarea stays raw (`Inbox.tsx:411–431`) and stays counted
  (`soup/no-raw-form-control :: src/pages/Inbox.tsx` = 1 in the current baseline, the
  packet's named non-falling bucket), owned by the form-kit composer-flavor slice.

## Enforcement ledger (packet §10 buckets, current baseline 486)

| Bucket | Packet-time | Now | Note |
|---|---|---|---|
| `soup/no-focus-suppression :: src/pages/Inbox.tsx` | 1 | **0 (bucket gone)** | fell at `9bfde5c3`; rule now FIRES at Inbox (fixture-proven, inverted carve-out test) |
| `soup/no-raw-form-control :: src/pages/Inbox.tsx` | 3 | **1** | −1 SearchInput swap (B4), −1 SaveContact input relocated by B3w1 (its slice's count); remaining 1 = composer textarea, the packet's explicit non-fall (C-B4-8) |
| `soup/no-legacy-tokens` Inbox / ChatListItem / MessageBubble | 29 / 3 / 7 | **25 / 3 / 7** | partial fall on rewritten lines only, as promised — no number was pinned in the packet |
| `soup/no-focus-suppression :: HistoryTab.tsx` | 1 | **1** | named remainder, owner C-B4-6 |

Ratchet trajectory across the lane: flat 533 through commits 1–3 (commit records),
511→509 at B4 close, current live count exactly at ceiling 486 (fresh run). No
unexplained rise: the single in-window rise (SummaryTab +1) is the inherited
main-side change documented in finding T2.

## DD-17 ring finding (carried from adoption-audit M2 — independently verified)

The adoption audit found ChatListItem rows keyboard-navigable but focus-silent. This
packet re-verified the claim against the tree rather than citing it:

- The rows are plain `div role="option" tabIndex` elements (`ChatListItem.tsx:20–22`).
- The design-system focus ring is painted by an element-type selector list —
  `button/input/select/textarea/a:focus-visible` (`composites.css:999–1008`). A div
  matches none of them.
- `.c-chat-item` defines transition/hover/active only — no `:focus-visible` rule
  exists for it anywhere (`composites.css:1016–1020`; whole-tree grep for
  `c-chat-item` and `[role="option"]` in the style tier returns nothing else).
- **One refinement to the audit's phrasing:** M2 says the global outline reset
  "removes outlines" for these rows — in fact neither cited selector
  (`composites.css:14` form-element reset, `:1004` inside the five-type ring recipe)
  matches a div, and Tailwind v4 preflight only normalizes `:-moz-focusring`. So the
  UA's default focus indicator is not affirmatively suppressed on the rows; whether
  Chromium paints its fallback ring there is UNPROVEN (no browser-suite case or live
  frame exercises row focus). Either way the row family is outside the spec'd ring
  recipe (interaction-patterns §1 / composites §1.9) — the design-system ring does
  not reach the only roving-focus surface B4 built, and no evidence shows ANY visible
  indicator.

Consequence: DD-17's register expiration condition ("arrow-key contract tested") is
literally met, but closing the row on it would paper over the gap the audit found.
This packet records DD-17 as **PARTIALLY closed** — traversal leg closed, ring leg
open — see the register delta below. Fix direction (for the follow-up owner): a
`.c-chat-item:focus-visible` rule on the §1.9 recipe (or row migration to a listbox
primitive), plus a browser-suite or live proof of the visible ring.

## Omission audit

- Not touched, per packet §0.6: HistoryTab composer + its `outline-none` twin
  (C-B4-6/C-B4-8 owners), LinePicker internals, message-virtualization internals,
  the other three legacy pane tokens (`--panel-actions`/`--panel-history`/
  `--panel-access-col` — LineDetail surfaces), chat-list behavior below the 1080px
  collapse (layout-density names only the contact-pane drop; sub-collapse behavior
  stays in the DD-18r side-panel-law remainder), SaveContact (B3w1's).
- Live-glance residue (named in the reviews): search-row icon offset, composer ring
  appearance, History-tab bubble glance, edge-flipped card geometry. None has a FAIL
  signal; all have compensating class/enforcement/jsdom evidence; all routed to the
  C3 Inbox/LineDetail screen passes and the D7 lane.
- jsdom limits, labeled as such in the suites: container-query evaluation, computed
  pane widths, real focus-ring rendering, real card geometry (estimated-dims
  heuristic) — class contracts + live frames + the CI browser matrix carry these.
- The page harness's two B4-close additions are weak (finding T1) — claims proven by
  the enforcement layer instead; harness rewrite routed.
- `tokens.component.css:23–24` comments still carry the legacy token NAMES as rename
  provenance — comment text only, zero consumers; acceptable, noted so a later grep
  doesn't misread it as live usage.
- Register staleness observed while assembling this packet (for the integrator, not
  B4 claims): DD-18r's REMAINING list still says the Inbox viewport-matrix rows are
  "unblocked but unwritten" and lists the drawer-flip case as undelivered — both
  landed post-B4 in `4fbad4ef` (browser 93/93). Proposed text refresh below.

## Debt register delta (PROPOSED — register edits belong to the integrator)

| ID | Proposed change |
|---|---|
| DD-17 | **PARTIALLY CLOSED — do not move to the Closed table.** Traversal leg closed: roving tabindex + arrow/Home/End/Enter/Space contract implemented (`bb9ba869`) and tested (20-case suite + 3 prop-contract item cases) — the row's literal expiration condition is met. Ring leg OPEN (adoption-audit M2, independently re-verified here): rows have no design-system `:focus-visible` treatment. Propose rewriting the row in place: title → "Inbox chat list focus-visible ring missing (roving landed)", sev stays P2, owner → C3 Inbox screen pass or a small B4 follow-up commit (adoption-audit burndown item B12), expiration → "row focus ring proven visible (browser suite or live frame) on the §1.9 recipe", blocks final acceptance: YES (unchanged — it is the a11y-visibility half of the original defect) |
| DD-18r | Narrow further: (a) Inbox three-pane collapse leg CLOSED — `68a7beda`, live rows 1–2, CI computed proof `4fbad4ef`; (b) MessageBubble hover-card positioning leg CLOSED at the code+jsdom level — `d5627923` (focus path, Escape, measured flip, `data-placement`), with the live/computed geometry glance carried as D7/C3 residue, not as an open implementation leg; (c) refresh the stale REMAINING text — Inbox viewport-matrix rows and the drawer-flip case were DELIVERED by `4fbad4ef`. Remaining legs after refresh: legacy modal sizing SSOT, nav width pressure, side-panel law for non-Fleet surfaces (incl. sub-collapse Inbox behavior), edge-card geometry glance |
| DD-24 | **Stands as filed** (no change) — condition re-confirmed on the tree this packet; expiry and non-blocking status as written |

## Verdict: **PASS WITH DEFERRED DEBT.**

All five packet concerns landed, constraint-clean, with fresh independent proof:
125/125 B4 suites + 73/73 enforcement suites, lint 0 / ratchet 486≤486 / parity
100 / typecheck 0, live rows 1–2 PASS re-verified from frames, and every C-B4-*
constraint either satisfied or carried with its named owner. The deferred debt is
named and owned: DD-17's ring leg (open, P2, blocks final acceptance), DD-24's
orphaned actions, C-B4-6's HistoryTab carve-out, the T1 harness rewrite, and the
live-glance residue routed to C3/D7. No closure is claimed beyond what the evidence
shows: DD-17 does NOT close with this slice.
