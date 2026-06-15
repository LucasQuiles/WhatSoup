# B3 Wave-2 Investigation Packet — legacy dialog burn-down, form-dialog tier (ConfigEditDialog · ScheduleComposerModal)

Pre-implementation packet required by the working checklist (A0 gate). Implementation is
blocked until this packet carries a `Ready` or `Ready with Constraints` verdict. Scope is
WAVE 2 of the b3-survey.md inventory: `console/src/components/line-detail/ConfigEditDialog.tsx`
and `console/src/components/line-detail/ScheduleComposerModal.tsx` move onto the Modal
primitive + `useDismissable`, plus the DD-15 remainder owned by this file pair
(ScheduleComposerModal's two binary `c-btn` toggle pairs → the canonical seg). Targets:
2 more `soup/no-adhoc-modal` file buckets to zero (5 of 8 shells migrated cumulative);
DD-18r modal-sizing-SSOT leg reaches its FIRST token deletions; DD-15 composer leg closes.

## 1. Gate 0 output

Packet drafted read-only against `soup-impl` @ `feat/soup-v3-foundation` (`6f0e9289`,
HEAD ≥ `8555c306`, so B2 + B3 wave-1 are landed facts: Modal has `--modal-w-*` size
tokens + `initialFocus`; ChatPicker is Popover-based; TagInput renders Pill chips),
2026-06-12. Survey and wave-1 forward-claims re-verified by reading every wave-2 source
file (§3); corrections recorded (§16). Standard gate 0 (worktree inventory, lint, full
test run) executes at implementation start and is recorded in the wave-2 evidence packet —
this packet pins source facts, not run results.

## 2. frontend-design pre-implementation checkpoint

- Modal anatomy per modal.md: scrim > shell > head/body/foot. ScheduleComposerModal maps
  1:1. ConfigEditDialog does NOT map 1:1 — it has a fourth region, the restart-warning
  strip between header and body (`ConfigEditDialog.tsx` 285–290, `flex-shrink-0`, does
  not scroll with the body). Survey's "c-dialog maps 1:1" is corrected (§16); the strip
  composes as a direct shell child between `ModalHeader` and `ModalBody` (C-B3W2-6).
- **Visual changes recorded** (deliberate, to confirm at the live checkpoint):
  1. Widths adopt the modal sizing law: ConfigEditDialog `--panel-config-edit` 560px →
     `size="md"` 560px (exact match, zero width delta); ScheduleComposerModal
     `--panel-composer` 540px → `size="md"` 560px (+20px, CreateGroupModal precedent).
  2. Caps collapse into the law `min(560px, calc(100% - var(--sp-8)))`: ConfigEditDialog
     loses `max-w 90%` (slightly WIDER on viewports 320–622px), ScheduleComposerModal
     loses `max-w 95vw` (≈12px narrower at 390px). Max-heights: ConfigEditDialog 80vh →
     85vh (taller, more fields visible); ScheduleComposerModal 90vh → 85vh (shorter; the
     body scrolls by contract).
  3. Decorative header icon (Clock in ScheduleComposerModal) is dropped — wave-1
     convention (ConfirmDialog precedent, KSH body-labelled fallback recorded).
     ConfigEditDialog's header has no icon. The AlertTriangle in the warning strip and
     the Clock/Save icons on footer primary buttons are KEPT (CreateGroupModal kept its
     footer Users icon).
  4. Title typography normalizes to `soup-modal-title`: ConfigEditDialog drops
     `font-sans font-semibold text-lg`, ScheduleComposerModal drops `c-heading-lg`.
  5. The two binary toggle pairs in ScheduleComposerModal (Text/Media, Recurring/One-shot)
     become `ToolbarTimeRange` segs (§7): 24px seg buttons replace `c-btn c-btn-sm`,
     their MessageSquare/FileText/RefreshCw icons drop, `font-mono` → seg type ramp.
     PASS pending live review.
- Density: no layout changes inside bodies; both keep body scroll; ConfigEditDialog's
  field list and ScheduleComposerModal's five field groups become direct `ModalBody`
  grid children (`soup-modal-body` already provides `gap: var(--sp-4)` — the legacy
  `flex flex-col gap-[var(--sp-4)]` wrapper divs die with no spacing change).

## 3. Files inspected and classification

| File | Class | Current invariant | Wave-2 invariant | Changes? |
|---|---|---|---|---|
| `console/src/components/line-detail/ConfigEditDialog.tsx` (336 ln — survey count re-verified exact) | consumer | NO `open` prop (mount-gated by LineDetail); NO Escape handler anywhere in file (re-verified; control-catalogue concurs); backdrop `onClick={onClose}` 263–266 destroys the whole `patch` on a scrim click; X already labelled `Close dialog` (279); consumes TagInput (160–166: `accentColor='var(--color-m-agt)'`, `displayLabels`, `validate`/`normalizeValue` — contract preserved by B2, verified against `TagInput.tsx` 46–55) | `Modal size="md" dismissable={false}` + Header/strip/Body/Footer; NEW required `open` prop + reset-on-open (C-B3W2-1); field rendering, dirty tracking, validation, save pipeline unchanged | YES |
| `console/src/components/line-detail/ScheduleComposerModal.tsx` (380 ln — re-verified exact) | consumer | own bubble-phase Escape effect 101–106; backdrop pair 174–180; `if (!open) return null` 169; X labelled `Close` (190); 7 raw `c-btn` sites; sizing `--panel-composer`/`--panel-max-inline-wide`/`--modal-max-h-lg` (179); consumes rebuilt ChatPicker (props contract unchanged per `ChatPicker.tsx` header, verified) | `Modal size="md" dismissable={false}` + Header/Body/Footer; toggle pairs → seg (§7); reset-on-open, submit pipeline, validation toasts unchanged | YES |
| `console/src/pages/LineDetail.tsx` | consumer | mount-gates the dialog: `{showConfigEditor && line.config && <ConfigEditDialog …>}` (304–309); openers in SummaryTab (167, 222) and ModeTab (53) via `onEditConfig` | always-mounts gated on `line.config`, passes `open={showConfigEditor}` (C-B3W2-1) | YES |
| `console/src/components/line-detail/ScheduledTab.tsx` (138–144) | consumer | already passes `open`/`onClose`/`onCreated`/`editMessage` | unchanged — zero breakage | NO |
| `console/src/components/primitives/Modal.tsx` | producer | full contract incl. `initialFocus` + `--modal-w-*` size classes (wave-1 prep landed) | unchanged — consumed | NO |
| `console/src/hooks/use-dismissable.ts` | producer | stack-aware capture-phase Escape; outside-dismissal on `pointerdown`; focus restoration fires ONLY on the open→false transition (218–230) — NOT on unmount (drives C-B3W2-1) | unchanged — consumed | NO |
| `console/src/components/primitives/Toolbar.tsx` (`ToolbarTimeRange`, 73–108) | producer | canonical seg: `role="group"` + label, `aria-pressed` exactly-one, `{label, value}` string options (no icon slot); exported from `primitives/index.ts` (67) | unchanged — consumed by the toggle migration (§7) | NO |
| `console/src/components/shared/ChatPicker.tsx` (174 ln) | evidence | Popover-based; registers on the `useDismissable` overlay stack; SearchInput `onFocus={() => setOpen(true)}` (150) auto-opens the panel on focus (drives the initialFocus decision, §4.2) | unchanged — B2 owns internals | NO |
| `console/src/styles/tokens.component.css` | producer | `--panel-composer` 540 / `--panel-config-edit` 560 / `--panel-max-inline-wide` 95vw / `--modal-max-h-sm` 80vh / `--modal-max-h-lg` 90vh — each has its LAST consumer in this wave's two dialogs (verified: zero other TSX or CSS consumers) | five token DELETIONS, split per dialog commit (§6, §12) | YES (deletions) |
| `tests/console/config-edit-dialog.test.tsx` (926 ln, 51 tests — count re-verified exact) | fixture/consumer | renders without `open`; pins literal `aria-labelledby="config-edit-dialog-title"` (126); backdrop-click-closes (677–689) via `container.querySelector('.c-dialog-backdrop')`; `getReactClickHandler` reaches the Save onClick directly (57–63, used at 559) | updated (§8) | YES |
| `tests/console/schedule-composer-modal.test.tsx` (1042 ln, 58 tests) | fixture/consumer | ChatPicker stubbed (mock at 41–76); header doc lists pinned source surprises 8 (backdrop closes) and 9 (own Escape) which flip; X queried as `/Close/i` (940) — matches `Close dialog`, survives | updated (§8) | YES |
| `tests/console/line-detail-ds-compliance-round2.test.ts` (156 ln) | enforcement pin | scheduleComposer pinned LEGACY in the `[scheduleComposer, groupDetail]` loop (58–62: `c-dialog-backdrop`/`c-dialog`/`c-dialog-header`) + `c-dialog-footer` (64); NO ConfigEditDialog pins exist in this file (correction, §16) | scheduleComposer moves to the migrated pin set (§8) | YES |
| `tests/console/design-system-scheduled-groups-primitives.test.ts` (81 ln) | enforcement pin | SECOND structural pin file: 57–59 pin scheduleComposer `c-dialog-backdrop`/`-header`/`-footer`; 60 pins `c-input font-mono text-t2` (survives — body inputs unchanged) | 57–59 flip (§8) | YES |
| `tests/console/chat-picker.test.tsx` (237–260) + `tests/console/primitives-popover.test.tsx` (532–600) | evidence | BOTH prove the capture-phase Escape protection for a picker panel inside a bubble-phase legacy dialog, naming ScheduleComposerModal in comments | behavior tests unchanged; comments updated (the named legacy pattern no longer exists after this wave) | YES (comments only) |
| `console/{eslint.config.shadow.mjs,lint-shadow-baseline.json}` | enforcement | buckets at §11 values (read from the baseline JSON) | baseline regen — named buckets must FALL | YES |
| `docs/design-system/03-spec/components/modal.md`, `03-spec/tokens-v3.md` §6.12, `06-implementation/design-debt-register.md` (DD-15, DD-18r) | spec/register | normative | register deltas at wave close (§13) | register only |

**Exact new files:** wave-2 evidence packet, this packet. No new source or test files. Any
file beyond this table is added here before commit.

## 4. Per-dialog mapping to Modal anatomy

### 4.1 ConfigEditDialog

| Legacy piece | Modal anatomy |
|---|---|
| `c-dialog-backdrop` div + `onClick={onClose}` (263–266) + inner `stopPropagation` (272) | Modal scrim + `useDismissable` (dies entirely) |
| `role="dialog" aria-modal aria-labelledby="config-edit-dialog-title"` shell, `w-[var(--panel-config-edit)] max-h-[var(--modal-max-h-sm)] max-w-[var(--panel-max-inline)]` (267–273) | Modal shell, `size="md"` (560px exact match) |
| header (275–282: title span + raw `c-btn` X already labelled `Close dialog`) | `ModalHeader title="Edit Configuration" onClose` (accessible name UNCHANGED — the one wave-2 dialog where the close-name test survives verbatim) |
| restart-warning strip (285–290, non-scrolling, between header and body) | direct shell child between `ModalHeader` and `ModalBody`, classes kept (AlertTriangle stays) — C-B3W2-6 |
| body scroll div + `flex flex-col gap-[var(--sp-4)]` wrapper (293–294) | `ModalBody` (grid `gap --sp-4`, scrolls by contract); both wrapper divs die; per-field divs become direct children; `renderField` internals UNTOUCHED (all raw form controls stay — no form primitives exist, §11 note) |
| footer (319–332: Cancel `c-btn-ghost`; Save `c-btn` with `hasChanges ? 'c-btn-primary' : 'c-btn-ghost'` switch, count badge, `disabled={saving \|\| !hasChanges \|\| hasErrors}`) | `ModalFooter` with `Button variant="ghost"` / `Button variant={hasChanges ? 'primary' : 'ghost'} icon={Save}`; label + gating preserved verbatim |
| no Escape handler (verified gap) | GAINS stacking-aware Escape — this is the wave where b3-survey's "gains Escape it never had" framing (carried by wave-1 §5) actually lands |
| mount-gating in LineDetail — no `open` prop | NEW required `open: boolean` prop; LineDetail always-mounts gated on `line.config`; reset-on-open effect clears `patch` + `customEnumFields` (CreateGroupModal precedent, its 42–47). See C-B3W2-1 rationale below |

`dismissable={false}` — CORRECTED semantics, exactly as b3-survey already assigned
("explicit Save/Cancel"). Today a backdrop click silently discards every pending edit in
`patch`. Escape and the X remain available and cancel.

`initialFocus` — NONE (Modal default: first focusable = header close X). The legacy
dialog has no autofocus to preserve (no `autoFocus` in the file), and the field list is
config-driven — there is no stable "primary input" to target. Deliberate; pinned by a
"focus lands inside the dialog" test.

**Why the `open` prop is required (C-B3W2-1):** `useDismissable` restores focus only on
the open→false transition (`use-dismissable.ts` 218–230 — the restoration effect
early-returns while open and registers no cleanup, so an unmount-while-open never
restores). Keeping LineDetail's mount-gating would silently drop the focus-restoration
gain that wave-1 made a per-dialog test. Always-mounted + `open` is also the contract of
every sibling (RelinkModal, CreateGroupModal, ScheduleComposerModal, ConfirmDialog).
Bonus: the save pipeline's post-close `setSaving`/`invalidateQueries` now lands on a
mounted component instead of legacy's unmount-mid-async.

### 4.2 ScheduleComposerModal

| Legacy piece | Modal anatomy |
|---|---|
| `c-dialog-backdrop` div + `onClick={onClose}` (174) + `stopPropagation` (180) | Modal scrim + `useDismissable` |
| shell `w-[var(--panel-composer)] max-w-[var(--panel-max-inline-wide)] max-h-[var(--modal-max-h-lg)]` (175–181) | Modal shell, `size="md"` (§6 — no new size, no override mechanism) |
| header (183–193: Clock icon + dynamic title + raw `c-btn` X labelled `Close`) | `ModalHeader title={isEditing ? 'Edit Scheduled Message' : 'Schedule Message'} onClose` (icon dropped; X name `Close` → `Close dialog`) |
| own bubble-phase Escape effect (101–106) | dies — `useDismissable` stacking-aware capture-phase Escape |
| `if (!open) return null` (169) | dies — Modal owns the open gate (CreateGroupModal precedent); `cronPreview` then computes while closed, which is safe: `cronToHuman` is a pure string function (`scheduled-utils.ts` 42) |
| body scroll div + gap wrapper (196–197) | `ModalBody`; five field groups become direct children |
| ChatPicker field group (200–211) | passes through UNTOUCHED (B2 owns internals) |
| content-type toggle pair (218–231) + recurring/one-shot pair (308–324) | `ToolbarTimeRange` segs — §7 decision |
| recurrence presets (329–340) + cron input + preview | unchanged (§7 — presets are out of DD-15 scope) |
| stray empty `style={{ }}` on the datetime input (302) | dropped in passing |
| footer (363–376: Cancel/Submit raw `c-btn`, both `submitting`-gated, submit also `!selectedChat`) | `ModalFooter` with Button primitives; Clock icon kept on the primary; all gating preserved |
| reset-on-open effect (74–98), `handleSubmit` validation + API pipeline (108–167), toasts | unchanged |

`dismissable={false}` — CORRECTED semantics, same form-dialog rule the wave-1 packet
stated and applied to SaveContact/CreateGroupModal. Today a backdrop click destroys
eight fields of state (chat, content type, text, media path, caption, datetime,
recurrence flag, cron) and the reset-on-open effect makes the loss unrecoverable.
Explicit Cancel/Schedule verbs exist. Inverts a tested behavior (C-B3W2-2).

`initialFocus` — NONE, for a composer-specific reason: the first input is ChatPicker's
SearchInput, whose `onFocus={() => setOpen(true)}` (`ChatPicker.tsx` 150) would auto-open
the suggestion panel the instant the modal opens — an invented behavior. The legacy
dialog has no autofocus; Modal's default (header close X) is the spec-sanctioned
fallback. Deliberate; pinned, revisitable at the live checkpoint.

## 5. Patterns to replace (what dies)

Per dialog: own backdrop div + `onClick` + `stopPropagation` pair; hand-wired
`role="dialog" aria-modal aria-labelledby`; raw `c-btn` header X and footer buttons;
per-dialog width/max utility classes (`--panel-config-edit`, `--panel-composer`,
`--panel-max-inline`(-`wide`), `--modal-max-h-sm`/`-lg`); body gap-wrapper divs.
ScheduleComposerModal additionally loses: its bubble-phase document Escape effect (the
last hand-rolled Escape among the wave-1/2 dialogs), the `if (!open) return null` gate,
the two raw-`c-btn` toggle pairs, and the now-unused imports (`X`, `MessageSquare`,
`FileText`, `RefreshCw`, `capitalize`). ConfigEditDialog loses its `X` import and — its
distinct gain — acquires Escape, focus trap, and focus restoration where it previously
had NONE of the three. What both gain beyond parity: stacking single-fire Escape,
pointerdown outside-click semantics, focus trap, focus restoration, portal rendering.

## 6. Sizing decision — DD-18r SSOT leg: first deletions

**The "95vw wide" question, answered:** ScheduleComposerModal is NOT a 95vw-wide dialog.
Verified at `ScheduleComposerModal.tsx:179` + `tokens.component.css:39,42,67`: its WIDTH
is `--panel-composer` 540px; 95vw is only `--panel-max-inline-wide`, a small-viewport
cap that binds below ~568px; 90vh is `--modal-max-h-lg`. Mapping per tokens-v3 §6.12
(all of `--panel-max-inline/-wide` and `--modal-max-h/-sm/-lg` are rejected-superseded
into the single sizing law `min(Wpx, calc(100% - 32px))`, max-height 85vh):

- `size="md"` — 540 → 560, identical to the CreateGroupModal disposition (both consumed
  the same token). **No new size is needed and no width-override mechanism is added** —
  inventing either would contradict the §6.12 collapse (5 widths → 3) for a 20px delta
  and a sub-568px cap difference of ~12px. The 90vh→85vh max-height delta is absorbed by
  the scrolling body. All three deltas ride the live checkpoint (C-B3W2-3).
- ConfigEditDialog: `--panel-config-edit` IS 560px — `size="md"` is an exact width
  match; only the caps change (80vh→85vh, 90%→law).

Token retirement (each verified to have zero remaining consumers after its dialog
migrates — no CSS-internal consumers exist for any of the five):

| Token | Last consumer | Dies in |
|---|---|---|
| `--panel-config-edit` (sole consumer) | ConfigEditDialog | commit 1 |
| `--modal-max-h-sm` (other consumer died in wave 1) | ConfigEditDialog | commit 1 |
| `--panel-composer` (other consumer died in wave 1) | ScheduleComposerModal | commit 2 |
| `--panel-max-inline-wide` (sole consumer) | ScheduleComposerModal | commit 2 |
| `--modal-max-h-lg` (sole consumer) | ScheduleComposerModal | commit 2 |

NOT deletable this wave: `--panel-max-inline` (GroupDetailModal:761 remains, wave 3),
`--panel-confirm` (UpdateModal, wave 3), `--panel-wizard` (GroupDetailModal +
AddLineWizard), `--modal-min-h` (AddLineWizard), `--modal-max-h` (the shell's own
max-height var + GroupDetailModal pin). No test pins any of the five dying tokens
(grepped `tests/` — zero hits), so deletion is regression-safe at the suite level.

## 7. DD-15 remainder — toggle-pair decision: MIGRATE BOTH PAIRS THIS WAVE

Decision: ScheduleComposerModal's Text/Media content-type pair AND its
Recurring/One-shot pair move onto `ToolbarTimeRange` in the composer commit. Rationale:

1. **The register already commits this.** DD-15's path-to-zero reads "B3 waves 2-3
   migrate the dialogs and their toggles" — composer is the wave-2 dialog, so its
   toggles are wave-2 scope by the register's own text. Deferring to wave 3 would
   double-touch the file and contradict the recorded plan.
2. **Both pairs fit the seg contract exactly.** `ToolbarTimeRange` is exactly-one-pressed
   (`aria-pressed`); content type is `'text' | 'media'`, recurrence mode is a boolean
   rendered as two options. Today neither pair exposes ANY pressed state to assistive
   tech (active styling is `c-btn-primary` class only) — the seg is an accessibility
   fix, not just a styling swap, and each group gains `role="group"` + a label
   ("Content type" / "Recurrence mode").
3. **Bucket effect:** `soup/no-raw-button` on the file falls 7 → 1 instead of 7 → 4.

What does NOT migrate: the three recurrence preset buttons (Daily/Weekly/Monthly,
329–340). They are not a binary toggle pair (DD-15's stated scope) and they violate the
seg's exactly-one contract — a custom cron expression puts the group in a none-active
state that `aria-pressed` exactly-one cannot represent. They remain raw `c-btn`
(the file's last raw-button bucket entry), tracked by the P2 raw-button burn-down, not
DD-15.

Costs, recorded: option labels are string-only (`TimeRangeOption {label, value}`), so
the toggle icons drop (§2.5, icon-drop precedent); the seg is toolbar-namespaced
(`soup-toolbar-seg`, 24px buttons) living inside a modal body — accepted as the DD-15
"canonical seg", with the rename/extraction question deferred to wave 3 when
GroupDetailModal's pairs (the last DD-15 sites) migrate (C-B3W2-4).

## 8. Test changes per file

`tests/console/config-edit-dialog.test.tsx` (51 tests; harness, `BASE_CONFIG`, toast and
query wrappers all keep):
- All 51 renders add `open` (mechanical — C-B3W2-1).
- Portal: queries that relied on the render container move to `screen`/document level;
  the only structural one is the backdrop locator (677–689)
  `container.querySelector('.c-dialog-backdrop')` → document-level `.soup-modal-backdrop`.
- 'renders the dialog with correct role and aria attributes' (120): the literal
  `expect(dialog.getAttribute('aria-labelledby')).toBe('config-edit-dialog-title')`
  becomes a resolution assertion — the attribute points at the element whose text is
  `Edit Configuration` (Modal generates the id).
- **'calls onClose when the backdrop is clicked' (677) INVERTS** → "backdrop pointerdown
  does NOT dismiss (`dismissable=false`)" — mirror the CreateGroupModal/confirm-dialog
  inverted assertion verbatim (C-B3W2-2).
- 'does not call onClose when clicking inside the dialog panel' (691): same outcome, new
  mechanism — assert via `fireEvent.pointerDown` on the shell (the legacy
  `stopPropagation` it pinned no longer exists).
- 'renders close button with accessible label' (139) survives VERBATIM — the legacy X
  is already `Close dialog`, matching ModalHeader's ActionButton.
- 'calls onClose through the empty-patch save path' (549–569) keeps working only if
  `getReactClickHandler` still finds an `onClick` on the rendered `<button>`; the Button
  primitive forwards onClick to the underlying element, but this is verified at
  implementation, not assumed (C-B3W2-7).
- NEW: closed-state renders nothing (`open=false`); Escape closes via the stack and is
  unbound when closed (the dialog's FIRST Escape coverage); `patch`/`customEnumFields`
  reset on reopen (pins the C-B3W2-1 effect); initial focus lands inside the dialog;
  focus restores to the opener.
- Everything else (field types, dirty tracking, enum/custom-enum, sessionScope
  serialization, adminPhones TagInput wiring, save success/error, empty config) is
  behavior-preserved and carries over unchanged.

`tests/console/schedule-composer-modal.test.tsx` (58 tests; ChatPicker stub mock and all
fixtures keep):
- Header "SOURCE SURPRISES" doc: items 8 (backdrop closes) and 9 (own Escape handler)
  are rewritten to the migrated contract.
- **'calls onClose when the backdrop is clicked' (960) INVERTS** (`dismissable=false`,
  C-B3W2-2). Its locator `screen.getByRole('dialog').parentElement` still resolves to
  the backdrop post-portal; the event becomes `pointerDown`.
- 'does NOT call onClose when clicking inside the dialog panel (stopPropagation)' (970):
  outcome preserved, retitled — pointerdown-inside, no stopPropagation mechanism.
- 'calls onClose when the Escape key is pressed while the modal is open' (944) and
  'does NOT call onClose on Escape when the modal is closed' (952) carry over — the
  dispatch on `document` reaches the capture-phase stack handler (wave-1 proved this
  pattern for CreateGroupModal).
- X close test (936) queries `/Close/i` — matches the new `Close dialog` name, survives;
  tighten to the exact name while touching it.
- 'renders null when open=false' (186) survives (Modal returns null).
- Toggle tests (404–478) survive by construction: seg buttons keep the accessible names
  `Text`/`Media`/`Recurring`/`One-shot` and the tests assert field swaps, not classes
  (verified: zero `c-btn-primary` assertions in the file). NEW: `aria-pressed`
  exactly-one pins for both segs + `role="group"` labels (the DD-15 contract).
- NEW: initial focus lands inside the dialog (and the ChatPicker panel is NOT
  auto-opened on modal open — pins the §4.2 decision); focus restores to the opener.

`tests/console/line-detail-ds-compliance-round2.test.ts` — the structural pins that MUST
flip (named exactly):
- `scheduleComposer` leaves the legacy loop at 58–62 — `expect(modal).toContain('c-dialog-backdrop')`,
  `expect(modal).toContain('c-dialog')`, `expect(modal).toContain('c-dialog-header')`
  iterate over `[groupDetail]` only.
- Line 64 `expect(scheduleComposer).toContain('c-dialog-footer')` is REPLACED by the
  migrated set mirroring the createGroup block (53–56): `toContain('Modal')`,
  `toContain('ModalHeader')`, `toContain('ModalFooter')`, `not.toContain('c-dialog-backdrop')`.
- Line 66 `expect(scheduleComposer).toContain('className="c-input font-mono text-t2')`
  SURVIVES — body inputs are untouched.
- **Correction to the tasking assumption:** this file contains NO ConfigEditDialog pins
  (it is absent from `lineDetailFiles` and from every assertion) — nothing to flip there
  for ConfigEditDialog.
- `tests/console/design-system-scheduled-groups-primitives.test.ts` 57–59 is the SECOND
  pin site: `expect(scheduleComposer).toContain('c-dialog-backdrop')` / `('c-dialog-header')`
  / `('c-dialog-footer')` flip to the migrated equivalents; line 60's `c-input` pin
  survives.

Comment-only updates: `chat-picker.test.tsx` ~242 and `primitives-popover.test.tsx` ~537
describe ScheduleComposerModal as the live example of the bubble-phase legacy pattern;
after this wave that example no longer exists — comments reworded, fixtures and
assertions untouched (they test the Popover/stack contract, which stays).

Weak-terminal-assertion rule honored (end on value/attribute asserts); `typecheck`
across the full workspace before any DONE claim.

## 9. Fixture and data review

No new fixture machinery. The composer suite keeps its ChatPicker stub, chat fixtures
(1555-prefix + short group JID hygiene forms), far-future timestamp helper, and toast
wrapper; the config suite keeps `BASE_CONFIG`, the api/toast/query mocks, and the
TagInput integration (real TagInput renders — its B2 Pill internals are already covered
by its own suite). Because ChatPicker is stubbed here, the stacked-Escape interaction is
NOT exercised in the composer suite — it is owned by `chat-picker.test.tsx` +
`primitives-popover.test.tsx` (both verified present and passing pins) and by the D7
live keyboard deferral (wave-1 precedent). Long-content sanity (40+ field config, long
captions) rides the live QA script, not jsdom.

## 10. Reliability answers

1. **Escape while the ChatPicker panel is open inside the composer — now stack-ordered:**
   verified mechanism. The rebuilt ChatPicker's Popover registers on the `useDismissable`
   overlay stack; post-migration the Modal registers too. Panel open ⇒ Popover is
   topmost ⇒ first Escape closes ONLY the panel (Modal's capture handler runs but
   no-ops on the `peekTopmost() !== stableClose` guard, `use-dismissable.ts` 201–207);
   second Escape closes the modal. The prompt's claim that the picker-in-dialog case is
   ALREADY protected under the legacy shell is VERIFIED true — capture-phase +
   `stopPropagation` beats the composer's bubble-phase handler, and two test suites pin
   it (`chat-picker.test.tsx` 'Escape closes panel only…', `primitives-popover.test.tsx`
   'capture-phase Popover Escape stops propagation…'). The migration upgrades the
   protection from phase-ordering (fragile, capture-vs-bubble) to stack membership
   (both layers registered, single-fire by construction), and the composer's hand-rolled
   handler dies with it.
2. **Unsaved state on outside click:** both dialogs destroy form state on a scrim click
   today (composer: eight fields; config: the whole `patch`). `dismissable=false`
   removes the path on both (§4). Pointerdown semantics add the wave-1 bonus: a
   text-drag that starts inside an input and releases over the scrim can no longer
   dismiss anything.
3. **Cron preview state:** `cronPreview` is derived per-render from `cronExpr` via
   `cronToHuman` (pure, `scheduled-utils.ts` 42–44 — no timers, no subscriptions, no
   side effects). Reset-on-open restores `cronExpr`; closing mid-preview loses exactly
   what legacy close loses. Removing the `if (!open) return null` gate means the
   expression evaluates while closed — safe by purity.
4. **Escape during in-flight saves:** composer — legacy Escape during `submitting`
   closes the dialog without canceling the API call while footer Cancel is disabled;
   preserved verbatim (modal.md loading-state note; wave-1 §9.4 parity precedent).
   ConfigEditDialog — Escape-during-save is NEW behavior (it gains Escape), but it is
   parity with the legacy header X, which is NOT disabled while saving (279); and under
   the C-B3W2-1 always-mounted wiring, the post-close `setSaving`/`toast`/`invalidateQueries`
   sequence completes on a mounted component — strictly better than legacy's
   unmount-mid-async. Parity-plus, noted, not redesigned this wave.
5. **Focus restore targets:** ConfigEditDialog → the `onEditConfig` opener that was
   focused (SummaryTab 167 or 222, ModeTab 53 — all stay mounted under LineDetail's
   active tab after close). ScheduleComposerModal → ScheduledTab's composer opener /
   row Edit/Duplicate actions; after `onCreated` the scheduled query refetch may
   re-render rows — `useDismissable` drops restoration if the captured element left the
   document (guarded); accepted edge, observe at live QA (same disposition as wave-1's
   Ops-invalidation edge).
6. **Reduced motion / repeated open-close:** global `prefers-reduced-motion` rule covers
   the gained enter animation; Escape listener lifecycle is hook-owned and the
   closed-state unbind test (composer 952) carries over, with the config suite gaining
   its equivalent.

## 11. Enforcement plan

Shadow ratchet (`console/eslint.config.shadow.mjs` + `lint-shadow-baseline.json`),
regenerated once at the wave's final commit. Buckets (current values read from the
baseline JSON):

| Bucket | Now | After |
|---|---|---|
| `soup/no-adhoc-modal :: src/components/line-detail/ConfigEditDialog.tsx` | 2 | 0 |
| `soup/no-adhoc-modal :: src/components/line-detail/ScheduleComposerModal.tsx` | 2 | 0 |
| `soup/no-raw-button :: src/components/line-detail/ConfigEditDialog.tsx` | 3 | 0 |
| `soup/no-raw-button :: src/components/line-detail/ScheduleComposerModal.tsx` | 7 | 1 (presets stay, §7) |
| `soup/no-legacy-tokens :: src/components/line-detail/ScheduleComposerModal.tsx` | 6 | 5 (only the header Clock's `text-t4` dies; the 5 `text-t2` body inputs stay) |
| `soup/no-legacy-tokens :: src/components/line-detail/ConfigEditDialog.tsx` | 1 | 1 — does NOT fall (the hit is `text-t3` on the read-only JSON textarea, 175 — body-internal, untouched by a shell migration). Correction to the tasking assumption that both legacy-token buckets fall. |
| `soup/no-raw-form-control` both files | 7 / 5 | unchanged — `renderField` and the composer's five field groups keep raw controls (no form primitives exist); unlike wave-1 there is no relocation, so any form-control bucket movement is a regression |

`soup/no-adhoc-modal` remaining after wave 2: AddLineWizard, GroupDetailModal,
UpdateModal (3 file buckets — waves 3–4). Expected counts are expectations, not
guarantees — final numbers are read off the regen and must only fall (C-B3W2-5).

## 12. Rollback strategy

One commit per dialog, each independently revertible — no prep commit is needed this
wave (the Modal `initialFocus`/sizing prep landed in wave 1):

1. ConfigEditDialog migration + `open` prop + LineDetail wiring + its test updates +
   deletion of `--panel-config-edit` and `--modal-max-h-sm`;
2. ScheduleComposerModal migration + toggle-pair seg adoption + its test updates + both
   structural-pin file flips + deletion of `--panel-composer`,
   `--panel-max-inline-wide`, `--modal-max-h-lg`; baseline regen rides this commit.

Token deletions ride the commit that kills their last consumer, so reverting either
commit restores a self-consistent token set. The two commits share no files; order is
chosen easy-first (config is the simpler shell despite its size — no toggles, no
internal overlay consumer).

## 13. Debt register deltas planned

- **DD-18r modal-sizing leg: first DELETIONS land.** 5 of 8 ad-hoc shells migrated
  cumulative; five legacy sizing tokens deleted (§6). Remaining for the leg: wave 3
  retires `--panel-confirm` (UpdateModal) + GroupDetailModal's
  `--panel-wizard`/`--panel-max-inline`/`--modal-max-h` usage; wave 4 (AddLineWizard)
  finishes `--panel-wizard` + `--modal-min-h`. The leg closes only then.
- **DD-15: composer leg CLOSES; register narrows to GroupDetailModal.** Both binary
  pairs in ScheduleComposerModal land on the canonical seg (§7); DD-15's remaining
  scope is GroupDetailModal's pairs (wave 3). The preset buttons are explicitly NOT
  DD-15 scope (none-active state, §7) — they ride the P2 raw-button burn-down.
- New debt candidates: the seg rename/extraction question (toolbar-namespaced primitive
  used in a modal body — C-B3W2-4) lands as a register entry if wave 3 confirms it;
  any live-checkpoint rejection of a §2 visual delta lands as a DD entry, not prose.

## 14. Out of scope (owned elsewhere)

- UpdateModal, GroupDetailModal — wave 3 (per-phase actions; nested confirms + internal
  tablist + the last DD-15 pairs).
- AddLineWizard — wave 4, blocked on the Stepper decision; its role-on-backdrop defect
  is wave-4 scope.
- **ChatPicker and TagInput INTERNALS — B2 owns those.** This wave consumes both
  unchanged (props contracts verified preserved, §3); no keydown, Popover, Pill, or
  SearchInput changes.
- Migrating raw `c-input`/`select`/`textarea` field controls to form primitives (none
  exist yet) — `renderField` and the composer field groups are untouched.
- Recurrence preset buttons (§7) and the composer's cron text input UX.
- ConfirmDialog, KeyboardShortcutsHelp, SaveContactDialog, RelinkModal,
  CreateGroupModal — already migrated (precedents, untouched).
- DD-19 (background inert/aria-hidden) — primitive-level, unchanged by this wave.

## 15. Constraints / open items

- **C-B3W2-1:** ConfigEditDialog's public contract changes (NEW required `open` prop) and
  LineDetail's mount-gating becomes always-mounted-while-`line.config` — required because
  `useDismissable` only restores focus on the open→false transition, never on unmount
  (verified in source, §4.1). This is wave 2's one deliberate consumer change; 51 test
  renders update mechanically; reset-on-open preserves the fresh-state-per-open
  semantics that mount-gating provided.
- **C-B3W2-2:** `dismissable=false` inverts a currently TESTED backdrop-close on BOTH
  dialogs (config test 677, composer test 960). Deliberate correction per modal.md's
  protective default; the inverted assertions pin it.
- **C-B3W2-3:** visual deltas (§2: widths/caps/max-heights, Clock icon drop, title
  typography normalization, toggle pairs → 24px segs without icons) — confirmed or
  reverted at the live frontend-design checkpoint.
- **C-B3W2-4:** the canonical seg is `ToolbarTimeRange` (toolbar-namespaced name and
  `soup-toolbar-seg` class) used inside a modal body. Accepted for this wave per DD-15;
  the rename/extraction decision belongs to wave 3 with the last DD-15 sites.
- **C-B3W2-5:** §11 expected counts are expectations — final numbers read off the regen,
  must only fall.
- **C-B3W2-6:** the restart-warning strip is a fourth anatomy region (modal.md names only
  head/body/foot plus a wizard-only step strip). Placing it as a direct shell child
  between `ModalHeader` and `ModalBody` preserves its non-scrolling behavior; folding it
  into the scrolling body would let the warning scroll away (rejected). Recorded as a
  spec-tension item for the live checkpoint; if the checkpoint wants it spec-blessed, it
  lands as a modal.md amendment proposal, not silent drift.
- **C-B3W2-7:** the empty-patch save-path test reaches the Save button's React `onClick`
  prop directly (`getReactClickHandler`, config test 57/559); verify the Button
  primitive's rendered element still exposes it, else rewrite that one test against an
  enabled path.

## 16. Strong-claim audit

Claims this packet verified or corrected (each by reading the current source):
(1) survey's "`--panel-composer` (95vw wide)" framing — MISLEADING: the composer is
540px wide; 95vw is only the small-viewport cap (`--panel-max-inline-wide`), so the
sizing answer is `size="md"` with NO new size and NO override mechanism (§6);
(2) survey's "ConfigEditDialog Escape: NONE (gap)" — TRUE (unlike wave 1's SaveContact
correction, this gap is real: no keydown handler anywhere in the file);
(3) survey's "c-dialog maps 1:1" for ConfigEditDialog — INCOMPLETE: the restart-warning
strip is a fourth region requiring an anatomy decision (C-B3W2-6);
(4) tasking assumption that line-detail-ds-compliance-round2 holds c-dialog pins "for
these two" — HALF TRUE: it pins ScheduleComposerModal (with groupDetail) but contains NO
ConfigEditDialog assertions; and a SECOND pin file exists
(design-system-scheduled-groups-primitives.test.ts 57–59) that the tasking did not name;
(5) the claim that ChatPicker's capture-phase Escape already protects the
picker-in-legacy-dialog case — VERIFIED in source (capture + stopPropagation vs the
composer's bubble handler) and pinned by two suites;
(6) old survey line counts 336/380 and test counts 51/58 — re-verified exact;
(7) TagInput and ChatPicker prop contracts consumed by these dialogs — verified
preserved by B2 (header contracts + props read);
(8) "legacy-token buckets fall" — CORRECTED to partial: composer 6→5, config 1→1 (§11).
All other absolutes are file-line-cited or carried by a planned test; bucket arithmetic
is flagged as expectation (C-B3W2-5).

## Verdict: **Ready with Constraints** (C-B3W2-1 is the one consumer-contract change, executed in commit 1 with its tests; C-B3W2-2 documented with inverted pins; C-B3W2-3/6 at the live checkpoint; C-B3W2-4 deferred to wave 3; C-B3W2-5/7 verified at implementation). Implementation may begin.
