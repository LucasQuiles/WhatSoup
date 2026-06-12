# B3 Wave-3 Investigation Packet — legacy dialog burn-down, complex-shell tier (UpdateModal · GroupDetailModal)

Pre-implementation packet required by the working checklist (A0 gate). Implementation is
blocked until this packet carries a `Ready` or `Ready with Constraints` verdict. Scope is
WAVE 3 of the b3-survey.md inventory: `console/src/components/UpdateModal.tsx` (six-phase
SSE-driven update flow) and `console/src/components/line-detail/GroupDetailModal.tsx`
(tabbed detail shell with nested confirms) move onto the Modal primitive + `useDismissable`;
GroupDetailModal's hand-rolled tablist adopts the Tabs primitive; its four binary
settings toggle pairs adopt the canonical seg (the last DD-15 sites — the register leg
closes). Targets: 2 more `soup/no-adhoc-modal` file buckets to zero (7 of 8 shells
migrated cumulative; AddLineWizard is the last); DD-18r modal-sizing-SSOT leg retires
`--panel-confirm` and `--panel-max-inline`; the console's last two hand-rolled
document-level Escape handlers die (grep-verified: after this wave no
`document.addEventListener('keydown', …)` Escape copy remains outside hooks/primitives).

## 1. Gate 0 output

Packet drafted read-only against the implementation tree @ `feat/soup-v3-foundation`
(`c3b1ac52`), 2026-06-12. B3 waves 1–2 are landed facts re-verified in source:
ConfigEditDialog and ScheduleComposerModal are Modal-based (their file headers record
the wave-2 token deletions); the composer's two toggle pairs sit on `ToolbarTimeRange`
(`ScheduleComposerModal.tsx` 33, 231, 311); ConfirmDialog is Modal-based
(`ConfirmDialog.tsx` 38–43: `size="sm" dismissable={false}`) — which makes
GroupDetailModal's three nested confirms already-stacked Modal consumers today. The
checkout carries unrelated in-flight edits in `console/src/components/MessageBubble.tsx`
plus its test (another lane); neither file intersects this wave's table (§3). Standard
gate 0 (worktree inventory, lint, full test run) executes at implementation start and is
recorded in the wave-3 evidence packet — this packet pins source facts, not run results.

## 2. frontend-design pre-implementation checkpoint

- Modal anatomy per modal.md: scrim > shell > head/body/foot. Neither dialog maps 1:1:
  1. **UpdateModal** has NO single footer — actions are per-phase (confirm:
     Cancel/Update 360–366; error: Close 404–407; restart-instances: Skip/Restart
     Selected 452–463; updating/restarting-fleet/done: none). Mapping: a conditional
     `ModalFooter` rendered only in the three action-bearing phases (refines the
     survey's "per-phase actions stay in body" framing — the actions ARE footer
     anatomy; the phases without actions simply omit the foot region).
  2. **GroupDetailModal** has a rich header (avatar + two-line subject/participant-count
     + X, 765–783) and a tab strip between header and body (786–802) — two regions
     beyond the modal.md head. Mapping: a custom header region as a direct shell child
     styled `soup-modal-header` (wired via Modal's documented `labelledById` escape
     hatch, `Modal.tsx` 66–70), then the Tabs primitive (inset variant carries the
     hairline + side padding), then `ModalBody`. Follows the wave-2 fourth-region
     precedent (C-B3W2-6); recorded as spec tension C-B3W3-4.
- **Visual changes recorded** (deliberate, to confirm at the live checkpoint):
  1. Widths adopt the sizing law: UpdateModal `--panel-confirm` 420px → `size="sm"`
     `min(480px, calc(100% - var(--sp-8)))` (+60px; exact RelinkModal precedent —
     its header comment records the same 420→480 disposition). GroupDetailModal
     `--panel-wizard` 720px → `size="lg"` 720px (exact width match); caps move from
     `--panel-max-inline` 90% to the law (slightly wider on viewports above 320px);
     `--modal-max-h` 85vh is an exact max-height match. UpdateModal additionally GAINS
     the 85vh cap it never had (no-op at current content heights; `overflow-hidden`
     shell today).
  2. Vertical anchor: legacy `c-dialog-backdrop` centers (composites.css 696–705);
     `soup-modal-backdrop` anchors top-center with clamp padding (primitives.css
     318–328, spec-sanctioned "anchored top-center"). Both dialogs ride up — same
     delta every prior wave absorbed.
  3. Decorative header icons drop (wave-1/2 convention): UpdateModal's Download (342)
     dies. GroupDetailModal's avatar block (766–771) is identity-bearing content, not
     decoration — KEPT, explicitly flagged for the checkpoint.
  4. Title typography normalizes to `soup-modal-title` (13px heading ramp): UpdateModal
     drops `font-sans font-semibold text-lg` (343); GroupDetailModal's subject drops
     `c-heading-lg` (773) but keeps `truncate`; the participant-count `c-label` line
     stays. Header X buttons become 18px ActionButtons named `Close dialog`
     (UpdateModal's legacy X is 16px at 347–349; GroupDetailModal's is already 18px).
  5. UpdateModal's action-bearing phases gain the footer hairline-top + `--sp-3 --sp-5`
     padding (legacy action rows sat inside body padding with no rule).
  6. GroupDetailModal tab strip restyles `c-tab` → `soup-tab` (2px accent underline,
     instant switch); the four settings pairs restyle `c-btn c-btn-xs` → 24px
     `soup-toolbar-seg` buttons (labels unchanged: All/Admins only, Off/On).
  7. Both gain the enter animation (fade + rise + scale); reduced-motion covered by the
     global rule.
- Density: no layout changes inside bodies. UpdateModal phase blocks become ModalBody
  children (`soup-modal-body` grid `gap --sp-4` padding `--sp-5` ≈ legacy
  `py-[--sp-4] px-[--sp-5]`; +4px vertical padding). GroupDetailModal tab panels keep
  their internal layout; their per-tab `py-[--sp-4] px-[--sp-5]` wrappers reconcile
  with ModalBody's `--sp-5` padding (equal horizontal; +4px vertical) — wrappers die,
  ModalBody provides the padding (wave-2 wrapper-death pattern).

## 3. Files inspected and classification

| File | Class | Current invariant | Wave-3 invariant | Changes? |
|---|---|---|---|---|
| `console/src/components/UpdateModal.tsx` (482 ln — survey's 456 superseded by landed reliability fixes, §16) | consumer | `open` prop + reset-on-open via `prevOpenRef` (136–142, deliberately NOT resetting on `lines` churn); own bubble-phase Escape effect (145–150); backdrop `onClick={handleClose}` (326–329) + `stopPropagation` (334); `if (!open) return null` (313); X `aria-label="Close"` raw `c-btn` (347); SSE reader with typed `{step?, status?, message?}` payload (247–251); `handleClose` aborts the stream + clears poll/timeout (303–311); 6-phase reducer (`Phase` union, 36) | `Modal size="sm" dismissable={false}` + `ModalHeader` (dynamic title) + `ModalBody` (phase blocks) + conditional `ModalFooter`; `onClose={handleClose}` everywhere; reducer, SSE pipeline, refs, reset effect unchanged | YES |
| `console/src/components/line-detail/GroupDetailModal.tsx` (847 ln — survey count re-verified exact) | consumer | own bubble-phase Escape effect (729–734); backdrop `onClick={onClose}` (756) + `stopPropagation` (762); `if (!open \|\| !group) return null` (742); X `aria-label="Close"` (780); hand-rolled `role="tablist"`/`role="tab"` with `aria-selected`, click-only, no roving tabindex (786–802); tab reset on group change via render-time derivation (737–740); query gated `enabled: open && !!group` (721–726); 3 nested ConfirmDialogs (225–234, 433–443, 700–710); 4 binary settings pairs with `disabled={saving === key}` (556–664); raw subject input/desc textarea/ephemeral select (129, 147, 676) | `Modal size="lg" dismissable={false} labelledById` + custom header region + `Tabs`/`Tab` + `ModalBody`; pairs → seg (§7); `!group` guard, tab-reset derivation, query, confirms, API pipelines unchanged | YES |
| `console/src/App.tsx` (82–87) | consumer | always-mounts UpdateModal with `open`/`onClose` — already the Modal-shaped contract | unchanged — zero caller breakage (no wave-2-style C-B3W2-1 rewiring needed) | NO |
| `console/src/components/line-detail/GroupsTab.tsx` (77–83) | consumer | always-mounts GroupDetailModal with `open={!!selectedGroup}` | unchanged | NO |
| `console/src/components/primitives/Modal.tsx` | producer | full contract: `dismissable` default false (85), `initialFocus`, `labelledById` (66–70, 92) for externally-controlled titles, open gate (96), portal (108) | unchanged — consumed | NO |
| `console/src/hooks/use-dismissable.ts` | producer | stack registry (36–48); capture-phase single-fire Escape (196–214); outside-dismissal on `pointerdown`, topmost-only (233–250); focus restore on open→false with `document.contains` guard (218–230); trap selector counts `button:not([disabled])` regardless of `tabindex="-1"` (53–61) — drives the §10.5 edge | unchanged — consumed | NO |
| `console/src/components/primitives/Tabs.tsx` | producer | tablist/tab roles, roving tabindex, Arrow/Home/End wrap, MANUAL activation (109–114); callers may conditionally mount panels — aria contract identical (header 11–13); LineDetail (197–221) is the landed conditional-panel precedent | unchanged — consumed | NO |
| `console/src/components/primitives/Toolbar.tsx` (`ToolbarTimeRange`, 89–108) | producer | canonical seg; `{label, value}` string options; **NO disabled support** (73–87) — GroupDetailModal's pairs disable while `saving` | additive optional `disabled?: boolean` group prop, default undefined → existing consumers byte-identical (C-B2-1 amendment precedent) — C-B3W3-2 | YES (prep) |
| `console/src/components/primitives/Button.tsx` / `ActionButton.tsx` | producer | Button: 6 variants, sizes md/sm/xs, `icon`, `disabled`, rest-prop passthrough; ActionButton: labelled icon button | unchanged — consumed | NO |
| `console/src/components/ConfirmDialog.tsx` | evidence | Modal-based, `size="sm" dismissable={false}` (38–43) — GroupDetailModal's nested confirms already register on the overlay stack | unchanged | NO |
| `console/src/components/shared/ContactSearchPicker.tsx` | evidence | Popover-based, capture-phase stack Escape (header 4–20); rendered inside GroupDetailModal's ParticipantsTab (324–329) and already inside Modal-based CreateGroupModal | unchanged — B2 owns internals | NO |
| `console/src/styles/tokens.component.css` (36, 39) | producer | `--panel-confirm` 420px / `--panel-max-inline` 90% — each has its LAST consumer in this wave (verified: `--panel-confirm` only at UpdateModal:335, RelinkModal hit is a comment; `--panel-max-inline` only at GroupDetailModal:761; zero CSS-internal consumers) | two token DELETIONS, split per dialog commit (§6, §12) | YES (deletions) |
| `console/src/styles/composites.css` (706–718, 892–910) | producer | `.c-dialog`, `.c-dialog-header` lose their last TSX consumers this wave (GroupDetailModal 761, 765); `.c-dialog-footer` and `.c-dialog-body` already have ZERO consumers (wave-2/spec note); `.c-dialog-backdrop` keeps AddLineWizard:255 | delete the four zero-consumer blocks in commit 2 after a pre-edit grep proof; `.c-dialog-backdrop` survives until wave 4 | YES (deletions) |
| `tests/console/update-modal.test.tsx` (536 ln) | fixture/consumer | full phase coverage; pins literal `aria-labelledby="update-dialog-title"` (168) and `title.id` (174, 431); backdrop-click-closes (216–222); Escape closes / unbound-when-closed (231–236, 245–250); SSE/restart machinery mocked at module level (no react-query Provider — `useQueryClient` stubbed, safe: Modal uses no query) | updated (§8) | YES |
| `tests/console/update-modal-a11y.test.tsx` (129 ln) | fixture/consumer | exact-name `Close` queries for the header X (91–93) | updated (§8) | YES |
| `tests/console/update-modal-sse-error.test.tsx` (128 ln) | fixture/consumer | body-content assertions only (error text, no fleet-wait) | survives verbatim — re-run proof only | NO |
| `tests/console/groups-tab.test.tsx` (22–32) | evidence | MOCKS GroupDetailModal entirely — proves the caller contract only | unchanged | NO |
| **`tests/console/group-detail-modal.test.tsx` (NEW)** | fixture/consumer | does not exist — **no test in the repo renders GroupDetailModal** (correction §16.4) | new dedicated suite (§8) — the wave's largest test cost (C-B3W3-6) | YES (new) |
| `tests/console/line-detail-ds-compliance-round2.test.ts` (160 ln) | enforcement pin | legacy loop `[groupDetail]` pins `c-dialog-backdrop`/`c-dialog`/`c-dialog-header` (58–62); `c-tab` pin (71); `<SearchInput` pin (72, survives); `max-h-[var(--modal-max-h)]` pin (148) | 58–62, 71, 148 flip (§8) | YES |
| `tests/console/design-system-scheduled-groups-primitives.test.ts` (83 ln) | enforcement pin | pins groupDetail `className="c-tab"`/`role="tablist"`/`role="tab"` source literals (63–65); not-contains style pins (33–34, 42) survive | 63–65 flip (§8) | YES |
| `tests/console/design-token-classes.test.ts` (51) | evidence | NOT-contains pin on a dead `--panel-confirm` width rule — survives token deletion | unchanged | NO |
| `tests/console/primitives-modal.test.tsx`, `tests/console/primitives-popover.test.tsx`, `tests/console/primitives-tabs.test.tsx`, `tests/console/primitives-toolbar.test.tsx` | evidence / fixture | stack, trap, restore, tabs-contract proofs cited in §10; toolbar suite gains the seg `disabled` pins (prep commit) | toolbar suite only | YES (toolbar only) |
| `docs/design-system/03-spec/components/modal.md`, `tabs.md`, `toolbar.md` §seg, `06-implementation/design-debt-register.md` (DD-15, DD-18r, DD-19) | spec/register | normative | register deltas at wave close (§13) | register only |

**Exact new files:** `tests/console/group-detail-modal.test.tsx`, wave-3 evidence packet,
this packet. No other new source or test files. Any file beyond this table is added here
before commit.

## 4. Per-dialog mapping to Modal anatomy

### 4.1 UpdateModal

| Legacy piece | Modal anatomy |
|---|---|
| `c-dialog-backdrop` + `onClick={handleClose}` (326–329) + `stopPropagation` (334) | Modal scrim + `useDismissable` (dies entirely) |
| `role="dialog" aria-modal aria-labelledby="update-dialog-title"` shell, `w-[var(--panel-confirm)] max-w-[90%]` + raised-surface class string (330–335) | Modal shell, `size="sm"` (420→480, RelinkModal precedent) |
| header (337–350: Download icon + phase-dependent title + raw `c-btn` X `aria-label="Close"`) | `ModalHeader title={phase === 'restart-instances' \|\| phase === 'done' ? 'Update Complete' : 'Update WhatSoup'} onClose={handleClose}` (icon dropped; X name → `Close dialog`) |
| own bubble-phase Escape effect (145–150) | dies — stack-aware capture-phase Escape, wired to `handleClose` |
| `if (!open) return null` (313) | dies — Modal owns the open gate; the component body that still executes while closed is pure rendering helpers (`stepIcon`), safe |
| body phase blocks (353–476) | `ModalBody` children; phase-conditional rendering, step list, checkbox list, error block all UNTOUCHED internally |
| per-phase action rows (360–366, 404–407, 452–463) | conditional `ModalFooter` per phase with `Button` primitives: confirm → ghost Cancel / primary Update (Download icon kept — footer-icon precedent); error → ghost Close; restart-instances → ghost Skip / primary Restart Selected (RotateCcw kept, `disabled` gating preserved verbatim, 458) |
| reset-on-open effect (136–142), SSE reader + `hasErroredRef` discipline (184–280), fleet-restart poller (152–182), instance restart pipeline + 2.2s auto-close (282–301), `handleClose` cleanup (303–311) | unchanged |

**Dismissable posture across the SSE flow (the wave's central question) — existing Modal
API SUFFICES; no non-dismissable phase switching is added:**

- `dismissable={false}`, constant across all six phases. Before the update (confirm
  phase) this is the standard destructive-confirm rule (modal.md: outside-click off).
  DURING `updating`/`restarting-fleet` it removes today's most dangerous path: a stray
  scrim click mid-update silently calls `handleClose`, which aborts the SSE stream and
  kills the poller (303–311) — the operator loses all progress observability while the
  fleet restarts underneath (the server-side update does not stop; the POST already
  fired). After (restart-instances/done/error) the explicit verbs (Skip, Restart
  Selected, Close) own dismissal. One inverted test rides this (C-B3W3-1).
- Escape and the header X remain available at EVERY phase — that is the `useDismissable`
  contract ("Escape and the header close button are ALWAYS available", hook header
  14–17) and exact legacy parity (the legacy Escape handler and X are phase-independent,
  145–150, 347). Closing mid-update remains a deliberate two-element action with full
  cleanup because `handleClose` is the single `onClose` target. A phase-switched
  `dismissable` prop (false→true per phase) was considered and REJECTED: it adds no
  protection Escape/X don't already need, and no migrated dialog varies `dismissable`
  at runtime — inventing the first runtime-varying consumer for zero behavioral gain
  contradicts the primitive's one-contract premise.
- Reopen-after-mid-update-close resets to the confirm phase (136–142) while an update
  may still be running server-side — a pre-existing legacy hazard, byte-identical after
  migration (parity, observed at live QA, not redesigned this wave).

`initialFocus` — NONE (Modal default: first focusable = header close X). Legacy has no
autofocus anywhere in the file, and modal.md forbids default-focusing the destructive
action (the confirm-phase Update button triggers a fleet restart). Deliberate; pinned by
a focus-lands-inside test.

### 4.2 GroupDetailModal

| Legacy piece | Modal anatomy |
|---|---|
| `c-dialog-backdrop` + `onClick={onClose}` (756) + `stopPropagation` (762) | Modal scrim + `useDismissable` |
| `role="dialog" aria-modal aria-labelledby="group-detail-dialog-title"` shell `c-dialog … w-[var(--panel-wizard)] max-w-[var(--panel-max-inline)] max-h-[var(--modal-max-h)]` (757–762) | Modal shell, `size="lg"` (720px exact match), `labelledById="group-detail-dialog-title"` — the documented escape hatch for externally-controlled titles (`Modal.tsx` 66–70); the literal id is PRESERVED, so the title-id wiring needs no test rewrite |
| header (765–783: avatar + subject `c-heading-lg` + count `c-label` + raw `c-btn` X) | custom header region as direct shell child, `className="soup-modal-header"` + local layout classes; avatar KEPT; subject span keeps id `group-detail-dialog-title`, adopts `soup-modal-title truncate`; X → `ActionButton label="Close dialog"` — C-B3W3-4 |
| own bubble-phase Escape effect (729–734) | dies — stack-aware capture-phase Escape |
| hand-rolled tab strip (786–802: `role="tablist"` unlabelled, `c-tab` buttons, click-only, ALL tabs in the Tab order, no roving tabindex, no keyboard support) | `Tabs label="Group detail sections" inset` + three `Tab` children (ids unchanged: info/participants/settings) — gains roving tabindex, Arrow/Home/End, manual Enter/Space activation (tabs.md; LineDetail 197–221 precedent) |
| `if (!open \|\| !group) return null` (742) | `if (!group) return null` stays (header/body cannot render without group); Modal owns the `open` gate. Always-mounted under GroupsTab already (77–83) — focus restoration works by construction, no caller change |
| body scroll div (805–843, conditional per-tab mounting) | `ModalBody`; the conditional-mount pattern stays (Tabs header 11–13 sanctions it; panels get `role="tabpanel"`/`id`/`aria-labelledby` wiring per the LineDetail single-dynamic-panel precedent); per-tab padding wrappers die (§2) |
| 4 settings toggle pairs (announce 556–574, locked 585–605, memberAddMode 616–634, joinApproval 645–663) | `ToolbarTimeRange` segs with the new `disabled` prop carrying the existing `saving === key` gating — §7 |
| ephemeral `<select>` (676–686), subject input (129), desc textarea (147), Info/Participants action buttons (195, 203, 214, 332, 354, 361, 410, 418), Leave button (691) | UNTOUCHED — body-internal raw controls/buttons ride the P2 raw-button burn-down and the form-kit track, not the shell wave (wave-2 preset-button precedent) |
| nested ConfirmDialogs (225–234, 433–443, 700–710) | UNTOUCHED — already Modal-based; the stack upgrade is automatic (§10.2) |
| tab-reset-on-group-change derivation (737–740), query (721–726), admin resolution (744–750), all API handlers + toasts | unchanged |

`dismissable={false}` — CORRECTED semantics, the same form/destructive rule every prior
wave applied. Today a scrim click closes the whole detail surface, discarding unsaved
subject/description edits (InfoTab keeps local state, 48–58) and any in-progress
add-participant selection (257). Escape and the X remain available and cancel.

`initialFocus` — NONE (default: first focusable = the header close X; the avatar div is
not focusable). Legacy has no autofocus; no stable primary input exists across three
tabs. Deliberate; pinned, revisitable at the live checkpoint.

## 5. Patterns to replace (what dies)

Per dialog: own backdrop div + `onClick` + `stopPropagation` pair; hand-wired
`role="dialog" aria-modal aria-labelledby`; raw `c-btn` header X; per-dialog sizing
utility classes (`--panel-confirm`, `--panel-wizard`/`--panel-max-inline`/
`--modal-max-h` consumption). UpdateModal additionally loses: its bubble-phase Escape
effect, the `if (!open) return null` gate, all six raw `c-btn` sites, the `max-w-[90%]`
non-var utility, and the unused `X`/`Download`-in-header imports. GroupDetailModal
additionally loses: its bubble-phase Escape effect (the console's LAST hand-rolled
document Escape, with UpdateModal's), the `open` half of its return-null gate, the
hand-rolled tablist (the first of the two remaining `c-tab` consumers dies;
ModelAuthStep's is wave-4/register territory), the 8 pair buttons, and `.c-dialog`/
`.c-dialog-header` class consumption (last consumers — CSS blocks deleted, §3). What
both gain beyond parity: stacking single-fire Escape, pointerdown outside-click
semantics, focus trap, focus restoration, portal rendering; GroupDetailModal's tablist
gains its entire keyboard contract and the pairs gain `aria-pressed` + group labels
(today the pressed state is a `c-btn-primary` class only — invisible to AT).

## 6. Sizing decision — DD-18r SSOT leg + responsive note

Mapping per tokens-v3 §6.12 (sizing law `min(Wpx, calc(100% - 32px))`, max-height 85vh):

- UpdateModal: `--panel-confirm` 420px → `size="sm"` 480px. +60px is the identical,
  already-confirmed RelinkModal disposition (same token, same size, recorded in its
  file header). No new size, no override mechanism. Cap `max-w-[90%]` → law: at and
  below 320px the law and 90% converge (288px at 320); above 320px the dialog may be up
  to 32px wider on small viewports. No legacy max-height → gains 85vh (no-op: tallest
  phase content is the instance checklist, far short of 85vh at realistic fleet sizes;
  long fleets ride the live QA script).
- GroupDetailModal: `--panel-wizard` 720px → `size="lg"` 720px (exact); `--modal-max-h`
  85vh → law 85vh (exact); cap 90% → law (wider below ~720px+32 viewports, never
  narrower above 320px). The tab strip at 320px: three short labels in a flex row with
  `--sp-1` gap — fits without overflow machinery (B1's governed tab x-scroll exists for
  the 9-tab LineDetail bar if live QA disagrees).

Token retirement (each verified sole-consumer via whole-src grep; zero CSS-internal
consumers; zero test pins — `design-token-classes.test.ts:51` is a NOT-contains pin
that survives):

| Token | Last consumer | Dies in |
|---|---|---|
| `--panel-confirm` (RelinkModal hit is a header comment) | UpdateModal:335 | commit 1 |
| `--panel-max-inline` (sole consumer) | GroupDetailModal:761 | commit 2 |

NOT deletable this wave: `--panel-wizard` (AddLineWizard:263 remains, wave 4),
`--modal-min-h` (AddLineWizard), `--modal-max-h` (now a primitive-side token — the
Modal shell itself consumes it, primitives.css 336; it leaves the legacy ledger rather
than dying). After this wave the DD-18r modal-sizing leg's remaining scope is exactly
AddLineWizard (wave 4: `--panel-wizard`, `--modal-min-h`).

## 7. Tabs adoption + DD-15 closure decisions

### 7.1 Seg: MIGRATE ALL FOUR PAIRS THIS WAVE; ToolbarTimeRange gains `disabled`

Decision: announce, locked, memberAddMode, and joinApproval pairs move onto
`ToolbarTimeRange` in the GroupDetailModal commit. Rationale mirrors wave-2 §7: DD-15's
own path-to-zero names these as the last sites; all four are strict binaries whose
`value` derives from server state (`detail.announce` etc.), satisfying the
exactly-one-pressed contract (no none-active state — unlike the wave-2 presets); each
group gains `role="group"` + a label ("Messaging", "Edit group info", "Who can add
members", "Join approval") and `aria-pressed`, an accessibility fix over the
class-only active styling.

**Contract gap found:** the seg has no disabled support (`Toolbar.tsx` 73–87), but every
legacy pair disables both buttons during its in-flight save (`disabled={saving === key}`,
559/567/589/597/619/627/648/656) — dropping that would regress double-fire protection
on async settings calls. Resolution: additive optional `disabled?: boolean` on
`ToolbarTimeRange` (group-level; buttons get the `disabled` attribute), default
undefined so the four existing consumers are byte-identical — the C-B2-1 additive-
amendment pattern. Lands as a prep commit with `primitives-toolbar.test.tsx` pins
(C-B3W3-2). A consumer-side `if (saving) return` guard was rejected: it preserves the
no-double-fire invariant but silently drops the visible/AT disabled affordance legacy
has.

**C-B3W2-4 closure (the seg rename/extraction question deferred to this wave):** KEEP
`ToolbarTimeRange` as the canonical seg; NO rename, NO extraction. The spec is the
design authority and it places the seg under Toolbar explicitly (tabs.md: "The
segmented time-range control is Toolbar's (toolbar.md), not a Tabs variant"); renaming
a shipped primitive against the locked spec for naming comfort is exactly the drift the
program forbids, and after this wave the name has six stable consumer sites. The
residual awkwardness (a toolbar-namespaced name in modal bodies) is recorded as a
closed decision in the register delta (§13), not as new debt. tabs.md's "mode pickers →
radio-card (wizard) or filter pills" migration line does not apply: these are binary
state toggles on a settings row, not mode pickers between content panels — recorded
here so the live checkpoint can veto with full context rather than discovering the
tension later.

### 7.2 Tablist: ADOPT Tabs THIS WAVE; semantics verified, one edge found

GroupDetailModal adopts `Tabs`/`Tab` in the same commit as its shell (survey's wave-3
recommendation, confirmed). The Tabs-in-Modal interaction analysis the tasking asked
for:

- **Escape single-fire through the stack:** Tabs is NOT an overlay — it never registers
  on the `useDismissable` stack, so tablist presence cannot perturb Escape ordering.
  The stack cases that matter are modal+confirm and modal+popover:
  `primitives-modal.test.tsx:271` ('Escape closes ONLY the topmost modal when two are
  open') is byte-for-byte the post-migration GroupDetailModal + ConfirmDialog topology;
  `primitives-popover.test.tsx:608` ('two stacked Popovers: Escape closes only the
  topmost') plus :557 (capture-phase beats a bubble-phase legacy handler) cover the
  ContactSearchPicker-panel-inside-the-modal case both before and after migration.
- **Initial focus:** Modal default = first focusable in DOM order
  (`primitives-modal.test.tsx:491` pins close-X-first) — the header ActionButton, not a
  tab. The selected tab is reachable as the second Tab stop (roving tabindex,
  `primitives-tabs.test.tsx:54–58`).
- **Trap:** `primitives-modal.test.tsx:342` pins the Tab cycle. **Edge found
  (C-B3W3-7):** the trap's focusable selector counts `button:not([disabled])` even at
  `tabindex="-1"` (`use-dismissable.ts` 53–61), so wrap interception keys off elements
  the browser itself skips. While the body is the loading EmptyState (no focusable
  content), the LAST selector-focusable element is an unselected `tabindex="-1"` tab —
  a forward Tab from the selected tab is not intercepted and native focus can step out
  of the portal for one stop; the very next Tab press is recaptured by the
  `!container.contains(document.activeElement)` branch (170–186). Transient
  (loading-only), self-healing, jsdom cannot exercise native traversal — recorded as a
  known edge owned by the D7 trusted-keyboard lane, NOT fixed by patching the hook in a
  consumer wave.
- **No Tabs-in-Modal test exists anywhere** (whole-tests grep) — the tasking's premise
  that such stack tests exist is corrected (§16.5). The new GroupDetailModal suite
  becomes the first integration proof: arrow-key navigation inside the open modal,
  manual activation, Escape-with-confirm-open single-fire, trap presence (C-B3W3-6).

## 8. Test changes per file

`tests/console/update-modal.test.tsx` (536 ln):
- Portal: backdrop locator `screen.getByRole('dialog').parentElement` still resolves
  post-portal; container-scoped queries move to `screen`/document level where needed.
- 'renders the dialog with aria-modal and aria-labelledby' (164–169): the literal
  `update-dialog-title` pin becomes a resolution assertion (attribute points at the
  element whose text is the phase title). Same flip for `title.id` pins at 174 and 431.
  (UpdateModal does NOT use `labelledById` — unlike GroupDetailModal there is no
  externally-controlled title element, so reaching for the escape hatch just to keep a
  test literal would abuse the documented contract.)
- **'calls onClose when backdrop is clicked' (216–222) INVERTS** → backdrop pointerdown
  does NOT dismiss (`dismissable=false`) — mirror the wave-2 inverted pin verbatim
  (C-B3W3-1).
- 'does NOT call onClose when dialog body is clicked' (224–229): outcome preserved,
  mechanism becomes `fireEvent.pointerDown` on the shell (the pinned `stopPropagation`
  dies).
- Escape pins (231–236, 245–250) carry over — document-level dispatch reaches the
  capture-phase stack handler (proven by every prior wave).
- X-close test (207–214) queries `name: /close/i` — survives `Close dialog`; tighten to
  the exact name while touching it.
- Phase/SSE/restart/state suites (257–536) survive by construction: queries are
  role/name/text-based, Button forwards text content and `disabled`, and the
  `@tanstack/react-query` module stub is untouched by Modal (verified: neither Modal
  nor useDismissable imports react-query).
- NEW: Escape during the updating phase closes AND aborts the stream (assert the
  fetch mock's `signal.aborted` flips — pins the handleClose-as-onClose wiring); focus
  lands inside the dialog on open; focus restores to the opener.

`tests/console/update-modal-a11y.test.tsx`:
- Exact-name `Close` queries (91–93) update to `Close dialog` for the header X; the
  error-phase assertion (99–111) keeps finding the TEXT Close button by exact name —
  the header X no longer collides with it, which strengthens the test's original
  intent. Skip-button test (113–128) survives.

`tests/console/update-modal-sse-error.test.tsx`: survives verbatim (body-content
assertions only); re-run is the proof.

**`tests/console/group-detail-modal.test.tsx` (NEW — C-B3W3-6):** the repo's first
rendering coverage of this 847-line dialog. Fixtures: QueryClientProvider + toast
provider wrappers, api mock (`getGroupDetail` + the settings/participant mutators),
GroupInfo/GroupDetail fixtures using the hygiene-safe JID forms groups-tab.test.tsx
documents (1555-prefix users; group JIDs avoiding the real-looking shape). Minimum
pins: closed-state renders nothing; aria-labelledby resolves to the subject element
(id `group-detail-dialog-title` preserved via `labelledById`); backdrop pointerdown
does NOT dismiss (inverted from legacy — the legacy behavior was never tested, so this
lands as a fresh pin, not an inversion of an existing one); Escape closes via the
stack; **Escape with the Leave confirm open closes ONLY the confirm, second Escape
closes the modal** (the P1-2 regression pin, first time tested at the consumer level);
X close; tablist: label, roving tabindex, ArrowRight moves focus without selecting,
Enter selects, panels conditionally mounted with correct aria wiring; seg pins:
`aria-pressed` exactly-one per pair, group labels, `disabled` during in-flight save
(mock unresolved promise); admin gating (isAdmin=false hides admin controls — pins the
744–750 resolution); tab resets to info when `group` changes; focus restore to opener.

`tests/console/primitives-toolbar.test.tsx` (prep commit): seg `disabled` —
all buttons disabled, onChange not fired, default-undefined leaves existing behavior
pins green.

Structural pins that MUST flip (named exactly):
- `tests/console/line-detail-ds-compliance-round2.test.ts` 58–62: the legacy loop
  `[groupDetail]` empties — replace with the migrated set mirroring the
  createGroup/scheduleComposer blocks (`toContain('<Modal')`,
  `not.toContain('c-dialog-backdrop')`); 71 `className="c-tab"` flips to the Tabs
  imports (`toContain('<Tabs')`, `not.toContain('className="c-tab"')`); 72
  `<SearchInput` SURVIVES; 148 `max-h-[var(--modal-max-h)]` flips to a
  not-contains (the shell owns max-height now).
- `tests/console/design-system-scheduled-groups-primitives.test.ts` 63–65: the
  `c-tab`/`role="tablist"`/`role="tab"` source literals leave the file — flip to the
  Tabs-primitive equivalents; 33–34, 42 not-contains pins survive.
- Legacy pins that STAY (out of this wave): every AddLineWizard pin —
  `design-system-compliance-pages.test.ts:57–58` (dialog ARIA on the backdrop — the
  known wave-4 defect), `design-system-accessibility.test.tsx:70–72`,
  `modal-workflows.test.ts:11–13`. No Inbox dialog pins exist to preserve:
  `pages/Inbox.tsx` has zero `role="dialog"`/`c-dialog` hits (SaveContact migrated in
  wave 1) — the tasking's "any Inbox dialogs" set is EMPTY (§16.6).

Weak-terminal-assertion rule honored; `typecheck` across the full workspace plus the
console build before any DONE claim.

## 9. Fixture and data review

UpdateModal keeps everything: the `makeLine` fixtures, SSE `makeStreamBody`/
`makeHangingStream` builders, the interval-capture pattern for reaching
restart-instances, and the module-level react-query stub (verified Modal-safe, §8). The
new GroupDetailModal suite builds its fixture set fresh (§8) — the only place fixture
machinery is added this wave. ContactSearchPicker renders REAL inside ParticipantsTab
tests (its own suite plus the Popover stack suite already own its keyboard contract;
the new suite only needs it present, not exercised). Long-content sanity (large
participant lists, long subjects, tall settings) and the §2 visual deltas ride the live
QA script, not jsdom. The D7 lane owns trusted-event keyboard proof (C-B3W3-7).

## 10. Reliability answers

1. **Escape/X during an in-flight update (SSE):** parity-preserving by wiring
   `handleClose` as the Modal `onClose`. Legacy closes at any phase via Escape (145–150),
   X (347), or scrim (326); all three run the same cleanup — abort the fetch stream,
   clear the poll interval and timeout (303–311). Post-migration the scrim path is
   removed (§4.1) and Escape/X keep identical cleanup. The abort is client-side only:
   the server-side update continues regardless (the POST fired; this file cannot and
   does not cancel it) — unchanged by migration. The done-phase auto-close timer (297)
   calls `onClose` directly after the pipeline already cleared its own refs; harmless,
   preserved.
2. **Nested confirm stack (Leave/Revoke/Remove):** today protection is phase-ordering —
   ConfirmDialog's capture-phase stack handler + `stopPropagation`
   (`use-dismissable.ts` 201–207) beats GroupDetailModal's bubble-phase handler
   (729–734). Post-migration both layers are stack members: confirm open ⇒ confirm is
   topmost ⇒ first Escape closes only it; second closes the modal. Mechanism pinned at
   the primitive level (`primitives-modal.test.tsx:271`) and — new this wave — at the
   consumer level (§8). Outside-click cannot double-dismiss either layer (both
   `dismissable=false`; the pointerdown handler is additionally topmost-gated,
   245–250).
3. **ContactSearchPicker panel inside the modal:** Popover registers on the stack
   (picker header contract); panel open ⇒ Escape closes only the panel. Already true
   under the legacy shell (capture vs bubble), upgraded to stack membership; pinned by
   `primitives-popover.test.tsx` 557/608 and the CreateGroupModal precedent (same
   picker, already inside a Modal since wave 1).
4. **Focus restore targets:** UpdateModal → the Nav update button (App 67); after the
   update completes, `invalidateQueries` may re-render Nav — `document.contains` guard
   (218–230) drops restoration if the node was replaced; accepted edge (wave-1/2
   disposition). GroupDetailModal → the GroupCard opener; after Leave, the groups
   refetch removes that card — guarded drop, accepted. Confirm-level restores target
   the in-modal trigger buttons (Revoke/Remove/Leave); a post-action refetch can
   unmount a participant row mid-restore — guarded drop, accepted, observe at live QA.
5. **Focus trap with roving tabindex (Tabs):** the loading-state boundary edge and its
   self-healing recovery, §7.2 / C-B3W3-7. With any loaded tab active, the last
   focusable is body content and the wrap behaves; pinned structurally in the new
   suite, natively at D7.
6. **State while closed:** UpdateModal loses its early return — all hooks are
   open-gated, the reducer is inert, and the remaining render-path helpers are pure;
   Modal returns null. GroupDetailModal keeps `if (!group) return null` and its query
   stays `enabled: open && !!group` (721–726) — no closed-state fetching. The
   tab-reset derivation (737–740) still runs on the null-group render and correctly
   re-arms for the next open.
7. **Mid-save Escape (settings/participants):** closing while a settings save or
   participant mutation is in flight leaves the toast/refetch pipeline running on a
   still-mounted component (always-mounted under GroupsTab) — strictly better than a
   legacy unmount-mid-async; parity-plus, not redesigned.
8. **Reduced motion / repeated open-close:** global `prefers-reduced-motion` rule covers
   the gained enter animations; Escape listener lifecycle is hook-owned; the
   unbound-when-closed pins carry (update 245–250) and the new suite adds the
   GroupDetailModal equivalent.

## 11. Enforcement plan

Shadow ratchet (`console/eslint.config.shadow.mjs` + `lint-shadow-baseline.json`),
regenerated once at the wave's final commit. Buckets (current values read from the
baseline JSON; expectations only — final numbers read off the regen and must only fall,
C-B3W3-5):

| Bucket | Now | After |
|---|---|---|
| `soup/no-adhoc-modal :: src/components/UpdateModal.tsx` | 2 | 0 |
| `soup/no-adhoc-modal :: src/components/line-detail/GroupDetailModal.tsx` | 2 | 0 |
| `soup/no-raw-button :: src/components/UpdateModal.tsx` | 6 | 0 (all six sites are dying anatomy: X, Cancel, Update, Close, Skip, Restart Selected) |
| `soup/no-raw-button :: src/components/line-detail/GroupDetailModal.tsx` | 19 | 9 (dying: X 780, tab 791, 8 pair buttons; staying: 8 body action buttons + Leave — P2 burn-down scope, wave-2 precedent) |
| `soup/no-legacy-tokens :: src/components/UpdateModal.tsx` | 13 | 12 (only the shell literal's `bg-d2` dies; the step-list/body literals are untouched) |
| `soup/no-legacy-tokens :: src/components/line-detail/GroupDetailModal.tsx` | 17 | 17 — does NOT fall (every hit is body-internal or the kept avatar block; correction to any assumption that shell migration moves this bucket) |
| `soup/no-utility-smell :: src/components/UpdateModal.tsx` | 1 | 0 (`max-w-[90%]` dies with the shell) |
| `soup/no-brand-regression :: src/components/UpdateModal.tsx` | 1 | 1 — STAYS ('Update WhatSoup' title; brand strings flip at the C5 cutover, not here) |
| `soup/no-raw-form-control` (1 / 3) | 1 / 3 | unchanged — checkbox, subject input, desc textarea, ephemeral select stay raw (no form kit exists); any movement is a regression |

`soup/no-adhoc-modal` remaining after wave 3: AddLineWizard only (2) — 7 of 8 shells
migrated. No rule promotions ride this wave (no-legacy-tokens stays PROPOSED/shadow per
the lint plan). Structural pins flip per §8; CSS deletions (§3) are grep-gated.

## 12. Rollback strategy

Three commits, each independently revertible:

1. **Prep:** `ToolbarTimeRange` additive `disabled` prop + toolbar test pins. Zero
   consumer changes (default undefined) — reverting it strands nothing.
2. **UpdateModal migration** + its two test-file updates + deletion of
   `--panel-confirm`.
3. **GroupDetailModal migration** (shell + custom header + Tabs + 4 segs) + the NEW
   test suite + both structural-pin file flips + deletion of `--panel-max-inline` +
   the zero-consumer `.c-dialog*` CSS block deletions (grep-proven in-commit) +
   baseline regen.

Token and CSS deletions ride the commit that kills their last consumer, so any revert
restores a self-consistent set. Commits 2 and 3 share no files (each dialog's pins live
in disjoint test files; both compliance pin files touch only commit 3). Order is
easy-first: UpdateModal has no tabs, no segs, no nested overlays — its complexity is the
already-isolated SSE pipeline, which this wave does not touch.

## 13. Debt register deltas planned

- **DD-15: CLOSES.** All segmented sites land on the canonical seg (composer pairs in
  wave 2; GroupDetailModal's four pairs here). Closure note records the C-B3W2-4
  decision: `ToolbarTimeRange` keeps its name per toolbar.md/tabs.md ownership — no
  rename, no extraction (§7.1).
- **DD-18r modal-sizing leg: narrows to AddLineWizard.** `--panel-confirm` and
  `--panel-max-inline` deleted; remaining: `--panel-wizard` + `--modal-min-h` (wave 4);
  `--modal-max-h` reclassified as primitive-owned (shell consumer), not legacy debt.
- **DD-19 unchanged** (exit motion + background inert are primitive-level, motion-polish
  stage); noted because UpdateModal's gained enter animation makes the
  instant-exit asymmetry visible on a high-traffic surface — observe at the live
  checkpoint, route any veto to DD-19, not to this wave.
- New entries only if the live checkpoint rejects a §2 delta (lands as a DD entry, not
  prose) or if C-B3W3-4 demands a modal.md amendment proposal.

## 14. Out of scope (owned elsewhere)

- **AddLineWizard — wave 4, BLOCKED on a named open decision:** the Stepper
  primitive/spec decision (5-step strip + framer-motion step transitions + the
  step-0→1 creation side-effect + exit-confirm-deletes-instance), plus the
  step-transition motion question (DD-19 territory). Its `role="dialog"`-on-backdrop
  defect (pinned at `design-system-compliance-pages.test.ts:57`) is wave-4 scope
  regardless of the Stepper outcome. Its pins, its `--panel-wizard`/`--modal-min-h`
  tokens, and the `.c-dialog-backdrop` CSS block all STAY this wave.
- GroupDetailModal body-internal raw buttons (Info/Participants actions, Leave) and raw
  form controls — P2 raw-button burn-down / form-kit track (§4.2).
- ContactSearchPicker, SearchInput, ConfirmDialog, EmptyState internals — consumed
  unchanged.
- ModelAuthStep's `c-tab` button — wizard surface, register-tracked (Tabs.tsx header).
- Brand strings in UpdateModal ('Update WhatSoup') — C5 cutover scope.
- Background inert/aria-hidden + exit motion (DD-19) — primitive-level.
- All previously migrated dialogs — precedents, untouched.

## 15. Constraints / open items

- **C-B3W3-1:** `dismissable=false` inverts a currently TESTED backdrop-close on
  UpdateModal (update-modal.test.tsx 216) — deliberate correction per modal.md, inverted
  pin mirrors the wave-1/2 wording. GroupDetailModal's backdrop-close was never tested;
  it gets a fresh protective pin, not an inversion.
- **C-B3W3-2:** `ToolbarTimeRange` gains an additive optional `disabled` prop (prep
  commit + toolbar pins). Required to preserve the legacy in-flight-save disabling on
  all four settings pairs. Default undefined keeps every existing consumer
  byte-identical.
- **C-B3W3-3:** visual deltas (§2: widths/caps, top-anchoring, Download icon drop, title
  ramp normalization, footer hairlines, c-tab→soup-tab restyle, pairs→24px segs, kept
  avatar) — confirmed or reverted at the live frontend-design checkpoint.
- **C-B3W3-4:** GroupDetailModal's custom header (avatar + two-line title block) and
  in-shell tab strip are regions modal.md's anatomy does not name (head lists title +
  close X; the only sanctioned extra strip is wizard-only). Composed as direct shell
  children on the wave-2 fourth-region precedent, with the title wired through the
  documented `labelledById` prop. Recorded as spec tension: if the checkpoint wants it
  spec-blessed, it lands as a modal.md amendment proposal, not silent drift.
- **C-B3W3-5:** §11 expected counts are expectations — final numbers read off the regen,
  must only fall.
- **C-B3W3-6:** GroupDetailModal has ZERO existing rendering coverage; the new dedicated
  suite (§8) is a hard prerequisite of the migration commit, not a follow-up. Its
  Escape-stack and seg pins are the wave's acceptance evidence.
- **C-B3W3-7:** focus-trap boundary edge with roving-tabindex tabs while the body is the
  loading EmptyState (one forward-Tab stop can escape, recaptured on the next press) —
  known, transient, self-healing; owned by the D7 trusted-keyboard lane; NOT a hook
  patch in this wave.
- **C-B3W3-8:** UpdateModal keeps Escape/X dismissal during in-flight updates (parity;
  hook contract) with `handleClose` cleanup; the reopen-resets-to-confirm hazard while a
  server-side update still runs is pre-existing parity, observed at live QA. Any
  redesign (e.g., a blocking "update in progress" reopen state) is a new product
  decision, out of this wave.

## 16. Strong-claim audit

Claims this packet verified or corrected (each by reading current source):
(1) survey's UpdateModal line count 456 — STALE: 482 today (reliability fixes landed
since the survey); GroupDetailModal 847 re-verified exact; test counts: three update
suites at 536/129/128 lines verified present;
(2) survey's "6-phase state machine; per-phase actions (no single footer)" — TRUE
(Phase union at line 36; actions in three of six phases), refined to a conditional
ModalFooter rather than actions-in-body (§2);
(3) the tasking's "typed SSE payload {step?, status?, message?}" — VERIFIED
(UpdateModal.tsx 247–251, with the malformed-block skip guard at 256);
(4) survey's implication that every dialog has a dedicated test file — FALSE for
GroupDetailModal: no test renders it; groups-tab.test.tsx MOCKS it (22–32). New suite
required (C-B3W3-6);
(5) the tasking's premise that Popover/Tabs stack tests prove Tabs-in-Modal focus
semantics — CORRECTED: no Tabs-in-Modal test exists anywhere in tests/. What exists and
is cited: stacked-modal Escape (primitives-modal 271), trap (342), restore (316),
initial-focus (461/491), Popover stack ordering (primitives-popover 557/608). Tabs is
stack-inert by construction; the genuine gap (consumer-level integration proof) is
closed by the new suite, and one real trap edge was found and dispositioned (§7.2);
(6) the tasking's "AddLineWizard + any Inbox dialogs" legacy-pin set — HALF EMPTY:
AddLineWizard pins enumerated and kept (§8); Inbox.tsx has zero remaining dialog
markup, so no Inbox pins exist to preserve;
(7) wave-2's forward claims for this wave — VERIFIED: `--panel-confirm` last consumer
is UpdateModal:335, `--panel-max-inline` last consumer is GroupDetailModal:761,
`--panel-wizard`/`--modal-min-h`/`--modal-max-h` correctly held back; "GroupDetailModal's
pairs are the last DD-15 sites" — TRUE (four pairs, all strict binaries);
(8) "nested-confirm stacking already proven" — VERIFIED mechanism (capture +
stopPropagation today; stack membership after) but only at the primitive level — the
consumer-level pin is new (§8);
(9) seg adoption preconditions — CORRECTED: the seg contract is missing `disabled`,
which the legacy pairs require (C-B3W3-2); without the prep commit the DD-15 migration
would silently regress double-fire protection;
(10) bucket arithmetic — counted per-rule from source (UpdateModal: 6 raw buttons, 13
legacy-token literals including the two conditional literals in the step-row template;
GroupDetailModal: 19 raw buttons of which 10 die) and flagged as expectation
(C-B3W3-5), including the explicit non-fall of GroupDetailModal's legacy-token bucket.
All other absolutes are file-line-cited or carried by a planned test.

## Verdict: **Ready with Constraints** (C-B3W3-2 prep commit and C-B3W3-6 new suite are hard prerequisites; C-B3W3-1 documented with inverted/fresh pins; C-B3W3-3/4 at the live checkpoint; C-B3W3-7 dispositioned to D7; C-B3W3-5 verified at regen; C-B3W3-8 is recorded parity). Implementation may begin.
