# B3 Wave-1 Investigation Packet — legacy dialog burn-down, easy tier (SaveContact extraction · RelinkModal · CreateGroupModal)

Pre-implementation packet required by the working checklist (A0 gate). Implementation is
blocked until this packet carries a `Ready` or `Ready with Constraints` verdict. Scope is
the EASY TIER of the b3-survey.md inventory only: the inline Inbox SaveContact dialog
(extract to a component, then migrate), `console/src/components/RelinkModal.tsx`, and
`console/src/components/line-detail/CreateGroupModal.tsx` — three of the eight remaining
ad-hoc dialog shells move onto the Modal primitive + `useDismissable`. Targets: 3 of 8
`soup/no-adhoc-modal` file buckets to zero; DD-18r modal-sizing-SSOT leg STARTED.

## 1. Gate 0 output

Packet drafted read-only against `soup-impl` @ `feat/soup-v3-foundation` (`c808b596`),
2026-06-12. Survey facts re-verified by reading every wave-1 source file (§3); three
b3-survey.md claims corrected (§14). Standard gate 0 (worktree inventory, lint, full test
run) executes at implementation start and is recorded in the wave-1 evidence packet —
this packet pins source facts, not run results.

## 2. frontend-design pre-implementation checkpoint

- Modal anatomy per modal.md: scrim > shell > head/body/foot. All three dialogs map 1:1
  (§4); none needs the step strip. PASS (spec-driven).
- **Visual changes recorded** (deliberate, to confirm at the live checkpoint):
  1. Widths adopt the modal sizing law: SaveContact and RelinkModal go
     `--panel-confirm` 420px → `size="sm"` `min(480px, calc(100% - var(--sp-8)))`;
     CreateGroupModal goes `--panel-composer` 540px → `size="md"` 560px, and max-height
     `--modal-max-h-sm` 80vh → shell `--modal-max-h` 85vh.
  2. Decorative header icons (Link2 in RelinkModal, Users in CreateGroupModal) are
     dropped — `ModalHeader` is title + close X per modal.md anatomy; ConfirmDialog is
     the no-icon precedent. (KeyboardShortcutsHelp shows the body-labelled escape hatch
     if the live checkpoint wants an icon back.)
  3. SaveContact's tinted footer (`bg-d1`) becomes the hairline-top `soup-modal-footer`
     — same treatment ConfirmDialog already has.
  4. Legacy `bg-d2` + `shadow-lg` shells become `--surface-overlay` + `--shadow-overlay`
     + `--scrim`, and gain the modal enter animation; both themes ride semantic tokens,
     no theme branches. PASS pending live review.
- Density: no layout changes inside bodies; CreateGroupModal body keeps its scroll.

## 3. Files inspected and classification

| File | Class | Current invariant | Wave-1 invariant | Changes? |
|---|---|---|---|---|
| `console/src/pages/Inbox.tsx` (663 ln) | consumer | inline SaveContact dialog at 619–660; document-level Escape effect at ~203–208; `contactName` state; opener button ~594–604 | dialog block + Escape effect + `contactName` state deleted; renders `<SaveContactDialog>`; `handleSaveContact(name)` takes the name as an argument | YES |
| `console/src/components/SaveContactDialog.tsx` (NEW) | consumer of Modal | — | owns name state (reset on open, CreateGroupModal precedent); `{ open, busy, onSave(name), onClose }`; Enter-to-save preserved | YES (new) |
| `console/src/components/RelinkModal.tsx` (58 ln) | consumer | own Escape effect (13–18, non-stacking), own backdrop + stopPropagation, raw `c-btn` close X, header + body only (no footer) | `Modal size="sm" dismissable` + `ModalHeader` + `ModalBody` wrapping `LinkStep` | YES |
| `console/src/components/line-detail/CreateGroupModal.tsx` (151 ln) | consumer | own Escape effect (32–37), own backdrop, `c-dialog` header/body/footer, 3 raw `c-btn` | `Modal size="md"` + Header/Body/Footer; footer buttons → Button primitives; reset-on-open and submit pipeline unchanged | YES |
| `console/src/components/primitives/Modal.tsx` | producer | props: `open onClose size dismissable children labelledById`; NO `initialFocus` pass-through | + optional `initialFocus` prop threaded to `useDismissable` (C-B3W1-1) | YES (additive) |
| `console/src/hooks/use-dismissable.ts` | producer | full contract incl. `initialFocus`/`restoreFocus` options (Drawer already consumes `initialFocus`) | unchanged — consumed | NO |
| `console/src/styles/primitives.css` | producer | `soup-modal-shell--sm/--md` hardcode 480/560; `--lg` consumes `--panel-wizard` | size classes consume new `--modal-w-sm/-md/-lg` (DD-18r SSOT start, §6) | YES |
| `console/src/styles/tokens.component.css` | producer | `--panel-confirm` 420 / `--panel-composer` 540 etc. (5 legacy dialog widths) | + `--modal-w-sm: 480px; --modal-w-md: 560px; --modal-w-lg: 720px`; legacy tokens stay until their last consumers die (§11) | YES (additive) |
| `console/src/components/shared/ContactSearchPicker.tsx` (86 ln) | evidence | NO keydown/Escape logic at all; dropdown is plain absolute-positioned div (z-50) inside the dialog subtree | unchanged — B2 owns internals; only the shell around it migrates | NO |
| `console/src/components/wizard/LinkStep.tsx` | evidence | SSE EventSource opened on mount, closed on unmount cleanup | unchanged; Modal's `open=false → null` preserves unmount semantics | NO |
| `pages/Ops.tsx` (~315), `pages/LineDetail.tsx` (~296), `components/line-detail/GroupsTab.tsx` (~85) | consumers | RelinkModal / CreateGroupModal call sites; props unchanged by migration | unchanged — zero consumer breakage (ConfirmDialog precedent) | NO |
| `tests/console/relink-modal.test.tsx` (153 ln) | fixture/consumer | pins `.c-dialog-backdrop`, label `Close`, literal labelledby id, click-based backdrop dismissal | updated (§7) | YES |
| `tests/console/create-group-modal.test.tsx` (497 ln) | fixture/consumer | same pins + backdrop-click-closes assertion | updated; backdrop assertion INVERTS (§7) | YES |
| `tests/console/save-contact-dialog.test.tsx` (NEW) | evidence | — | full contract for the new component (§7) | YES (new) |
| `tests/console/primitives-modal.test.tsx` | evidence | Modal contract incl. stacking, trap, restoration, single-owner outside-dismissal | + `initialFocus` prop block (additive) | YES (additive) |
| `console/{eslint.config.shadow.mjs,lint-shadow-baseline.json}` | enforcement | buckets at §10 values | baseline regen — named buckets must FALL | YES |
| `docs/design-system/03-spec/components/modal.md`, `03-spec/tokens-v3.md` | spec | normative | unchanged | NO |

**Exact new files:** `console/src/components/SaveContactDialog.tsx`,
`tests/console/save-contact-dialog.test.tsx`, wave-1 evidence packet, this packet. Any
file beyond this table is added here before commit.

## 4. Per-dialog mapping to Modal anatomy

### 4.1 SaveContact (extract from `pages/Inbox.tsx` 619–660 → `SaveContactDialog.tsx`)

| Legacy piece | Modal anatomy |
|---|---|
| `c-dialog-backdrop` div + `onClick` close + inner `stopPropagation` | Modal scrim + `useDismissable` (dies entirely) |
| `role="dialog" aria-modal aria-labelledby="save-contact-title"` shell div, `w-[var(--panel-confirm)] max-w-[90%]` | Modal shell, `size="sm"` |
| header div (`c-border-b`, title span + `c-btn` X "Close dialog") | `ModalHeader title="Save Contact" onClose` |
| body div (label + `c-input` with `autoFocus` + Enter-to-save `onKeyDown`) | `ModalBody`; input keeps `c-input` (no Input primitive exists — §10 relocation note) and Enter handling; `initialFocus` ref preserves autofocus (C-B3W1-1) |
| footer div (`bg-d1`, Cancel `c-btn-ghost` / Save `c-btn-primary` gated on `contactName.trim()` + `actionBusy`) | `ModalFooter` with `Button variant="ghost"` / `Button variant="primary" icon={UserPlus}`; gating preserved via `busy` prop |
| Inbox document-level Escape effect (~203–208) | dies — `useDismissable` stacking-aware Escape |

`dismissable={false}` — CORRECTED semantics. Today a backdrop click discards the typed
name. modal.md gives forms with explicit footer verbs the protective default (Modal's
own default is `false`; b3-survey already assigns the same reasoning to wave-2's
ConfigEditDialog "explicit Save/Cancel"). Escape and the X remain available and cancel.

### 4.2 RelinkModal

| Legacy piece | Modal anatomy |
|---|---|
| backdrop div + `onClick` close + `stopPropagation` | Modal scrim + `useDismissable` |
| shell div `w-[var(--panel-confirm)] max-w-[90%]` `bg-d2` | Modal shell, `size="sm"` |
| header (Link2 icon + "Re-link {lineName}" + raw `c-btn` X "Close") | `ModalHeader title={`Re-link ${lineName}`} onClose` (icon dropped, §2) |
| body wrapper around `LinkStep` | `ModalBody` |
| own Escape effect (13–18) | dies |
| no footer | none — header + body only (survey confirmed) |

`dismissable={true}` — PRESERVED semantics. Backdrop click closes today and the existing
test names it "a cancel action". Nothing destructive: closing unmounts `LinkStep`, whose
effect cleanup closes the SSE EventSource; a QR scan already in flight completes
server-side. No form state to lose. This is the KeyboardShortcutsHelp side of the
precedent pair.

### 4.3 CreateGroupModal

| Legacy piece | Modal anatomy |
|---|---|
| backdrop div + `onClick` close + `stopPropagation` | Modal scrim + `useDismissable` |
| `c-dialog` shell `w-[var(--panel-composer)] max-w-[var(--panel-max-inline)] max-h-[var(--modal-max-h-sm)]` | Modal shell, `size="md"` (shell owns 85vh max-height) |
| `c-dialog-header` (Users icon + "Create Group" + raw `c-btn` X "Close") | `ModalHeader title="Create Group" onClose` (icon dropped, §2) |
| body div `overflow-y-auto` (subject input `autoFocus` + ContactSearchPicker) | `ModalBody` (it scrolls by contract); subject keeps `c-input`; `initialFocus` ref preserves autofocus (C-B3W1-1); picker passes through UNTOUCHED |
| `c-dialog-footer` (Cancel `c-btn-ghost` / Create `c-btn-primary`, both gated on `submitting`, Create also on subject/participants) | `ModalFooter` with Button primitives; all gating preserved |
| own Escape effect (32–37) | dies |
| reset-on-open effect, `handleCreate` pipeline, toasts, query invalidation | unchanged |

`dismissable={false}` — CORRECTED semantics. Today a backdrop click silently destroys
the subject and every picked participant (and the reset-on-open effect guarantees the
loss is unrecoverable). Same rule as SaveContact: explicit Cancel/Create verbs exist;
scrim-click data destruction is the defect this wave removes.

## 5. Patterns to replace (what dies)

Per dialog: own backdrop div + `onClick` + `stopPropagation` pair; own document-level
Escape effect (all THREE wave-1 dialogs have one today — see §14 correction; what they
gain is stacking single-fire, focus trap, and focus restoration, none of which any of
them has); hand-wired `role="dialog" aria-modal aria-labelledby` attributes; raw `c-btn`
header X and footer buttons; per-dialog width/max-height utility classes consuming
`--panel-confirm` / `--panel-composer` / `--panel-max-inline` / `--modal-max-h-sm`. The
"gains Escape it never had" framing from b3-survey applies to later waves
(ConfigEditDialog, AddLineWizard), not to wave 1.

## 6. Sizing token pass-through — DD-18r modal-sizing-SSOT leg (STARTED)

Mechanism today: `Modal size` → `soup-modal-shell--sm/--md/--lg` classes
(`console/src/styles/primitives.css` 353–363). **Verified fact: the size mechanism does
NOT consume `--panel-confirm` or `--panel-composer` and never will** — sm/md are
literals (480/560), lg consumes `--panel-wizard`. tokens-v3 §6.12 marks all five legacy
dialog width tokens rejected-superseded → `--modal-w-sm/-md/-lg` (3 widths, not 5), and
collapses `--panel-max-inline/-wide` + `--modal-max-h/-sm/-lg` into the single sizing
law `min(Wpx, calc(100% - 32px))`, max-height 85vh.

Wave-1 SSOT start (additive, zero visual change):

1. Add `--modal-w-sm: 480px; --modal-w-md: 560px; --modal-w-lg: 720px` to
   `tokens.component.css`.
2. Rewrite the three shell size classes to consume them; the `--panel-wizard` reference
   in `--lg` becomes `--modal-w-lg`.
3. Migrating the three dialogs removes their `--panel-*` consumption: `--panel-confirm`
   consumers 3 → 1 (UpdateModal remains, wave 3); `--panel-composer` 2 → 1
   (ScheduleComposerModal remains, wave 2).

Token DELETION is owned by later waves (§11) — a token dies only with its last consumer.

## 7. Test changes per file

`tests/console/relink-modal.test.tsx` (keeps its LinkStep mock):
- Portal: Modal renders into `document.body`, so `container.querySelector(...)` /
  `container.childElementCount` assertions move to `screen`/document-level queries.
- `.c-dialog-backdrop` → `.soup-modal-backdrop` (or `[data-soup-backdrop]`).
- Close button accessible name `Close` → `Close dialog` (ModalHeader's ActionButton).
- Literal `aria-labelledby="relink-dialog-title"` → resolution assertion (the attribute
  points at the element whose text is `Re-link alpha`); Modal generates the id.
- Backdrop dismissal: `useDismissable` listens on `pointerdown`, not click —
  `fireEvent.click(backdrop)` becomes `fireEvent.pointerDown(backdrop)` and stays a
  PASSING close test (`dismissable=true`). Borrow the single-owner click-sequence
  pattern from `primitives-modal.test.tsx`.
- Escape suite (open fires, closed/unmount/rerender don't) carries over as-is.
- NEW: focus restoration to the opener; initial focus lands inside the dialog.

`tests/console/create-group-modal.test.tsx` (keeps alice/bob fixtures + toast/query wrap):
- Same portal/backdrop/close-name/labelledby updates as above.
- **Backdrop assertion INVERTS:** "invokes onClose when the backdrop is clicked" becomes
  "backdrop pointerdown does NOT dismiss (`dismissable=false`)" — mirror
  `confirm-dialog.test.tsx`'s C2-migration test verbatim.
- NEW: subject input holds initial focus after open (pins the C-B3W1-1 pass-through).
- Everything else (search/add/remove participants, submit gating, pipeline success/
  in-flight/failure, Cancel disabled while submitting, reset-on-reopen) is
  behavior-preserved and carries over unchanged.

`tests/console/app.test.tsx` — NO changes. **Correction to b3-survey:** it claims
SaveContact is "covered via app.test.tsx"; grep shows zero SaveContact/`contact-name-input`
assertions in any UI test (only `api-operations.test.ts` covers the `api.saveContact`
client method). The dialog is untested today; the extraction creates its coverage.

`tests/console/save-contact-dialog.test.tsx` (NEW, component is presentational — no API
mocks needed): open/closed gate; role/aria-modal/labelledby resolution; name input holds
initial focus; Save disabled until `name.trim()` and while `busy`; Enter on a non-empty
name calls `onSave` with the TRIMMED name; Cancel + header X call `onClose`; Escape
closes via the stack (and unbinds when closed); backdrop pointerdown does NOT dismiss
(`dismissable=false`); name resets when reopened; focus restores to the opener.

`tests/console/primitives-modal.test.tsx` — additive `initialFocus` block: provided ref
inside the shell receives initial focus; omitted → first focusable (existing behavior,
already pinned).

Weak-terminal-assertion rule honored (end on value/attribute asserts);
`typecheck` across the full workspace before any DONE claim.

## 8. Fixture and data review

No new fixture machinery. relink test keeps its mocked LinkStep; create-group keeps its
`ContactResult` fixtures and provider wrapper; the new SaveContactDialog test needs only
render + events (the api call stays in `Inbox.tsx`). Long-input sanity (40+ char group
subject / contact name) rides the live QA script, not jsdom. No page-level Inbox harness
exists (`inbox-*.test.ts` are logic tests) — building one is out of scope; Inbox wiring
is verified by typecheck plus the existing suites' behavior contracts.

## 9. Reliability answers

1. **Escape while the ContactSearchPicker dropdown is open inside CreateGroupModal:**
   the picker has ZERO keydown handling (verified, `ContactSearchPicker.tsx` — no
   Escape, no listener) and its dropdown is a plain `z-50` absolute div inside the
   dialog subtree, NOT an overlay-stack participant. Escape therefore reaches
   `useDismissable`'s capture-phase document handler and closes the WHOLE modal,
   dropdown included — exactly what the legacy document-level handler does today.
   Behavior preserved, not degraded. "Escape closes the dropdown first" would be a
   picker-internal feature and belongs to B2. Stacking order is also safe for clicks:
   the dropdown is inside the shell, so `container.contains(target)` is true and
   outside-click logic can never treat a dropdown click as a dismissal.
2. **Form state on accidental outside-click:** today both form dialogs destroy state on
   a scrim click. `dismissable=false` (§4.1/§4.3) removes the path. Bonus hardening:
   `useDismissable` keys on `pointerdown`, so even RelinkModal's preserved
   outside-click can no longer fire from a click whose pointerdown began INSIDE the
   shell (the legacy `onClick` backdrop pattern could, e.g. text-drag out of an input).
3. **Focus restore targets:** SaveContactDialog → the "Save Contact" button in the
   Inbox contact pane (`pages/Inbox.tsx` ~594–604; still mounted after close since the
   chat selection is unchanged). RelinkModal → the opening re-link action in
   `pages/Ops.tsx` (~315 region) or `pages/LineDetail.tsx` (~296 region); lazy-mount
   delay is safe because focus rests on the opener when the Modal mounts and captures
   `document.activeElement`. CreateGroupModal → the "Create Group" button in
   `components/line-detail/GroupsTab.tsx` (~85 region). Edge: after `onLinked`, Ops
   invalidates the lines query and the opener row may re-render; `useDismissable` drops
   restoration if the captured element left the document (guarded) — record as accepted
   edge, observe at live QA.
4. **Escape during an in-flight create:** legacy behavior (Escape closes the dialog
   without canceling the API call, while footer Cancel is disabled) is preserved
   verbatim by the migration; modal.md's loading-state note says the modal stays
   interactive for cancel until commit. Parity, noted, not changed this wave.
5. **Reduced motion:** the shells gain the modal enter animation, which the global
   `prefers-reduced-motion` rule in `primitives.css` already suppresses → off-and-instant
   by construction.
6. **Repeated open/close:** Escape listener registration/cleanup is owned by the hook;
   the existing rerender/unmount listener-leak tests carry over and keep pinning it.

## 10. Enforcement plan

Shadow ratchet (`console/eslint.config.shadow.mjs` + `lint-shadow-baseline.json`),
regenerated once at the wave's final commit. Buckets that must FALL:

| Bucket | Now | After |
|---|---|---|
| `soup/no-adhoc-modal :: src/pages/Inbox.tsx` | 2 | 0 |
| `soup/no-adhoc-modal :: src/components/RelinkModal.tsx` | 2 | 0 |
| `soup/no-adhoc-modal :: src/components/line-detail/CreateGroupModal.tsx` | 2 | 0 |
| `soup/no-raw-button :: src/components/RelinkModal.tsx` | 1 | 0 |
| `soup/no-raw-button :: src/components/line-detail/CreateGroupModal.tsx` | 3 | 0 |
| `soup/no-raw-button :: src/pages/Inbox.tsx` | 11 | expected −3 (dialog X/Cancel/Save become primitives) |
| `soup/no-legacy-tokens :: src/components/RelinkModal.tsx` | 2 | 0 |
| `soup/no-legacy-tokens` Inbox 29 / CreateGroupModal 3 | — | fall by the dialog's share; exact counts read off the regen, never bumped |

`soup/no-adhoc-modal` remaining after wave 1: AddLineWizard, ConfigEditDialog,
GroupDetailModal, ScheduleComposerModal, UpdateModal (5 file buckets — later waves).

**Allowed relocation (recorded so the regen diff is judged correctly):** the SaveContact
name input stays a raw `c-input` (no Input primitive exists yet), so
`soup/no-raw-form-control :: src/pages/Inbox.tsx` falls 3 → 2 while a NEW bucket
`soup/no-raw-form-control :: src/components/SaveContactDialog.tsx` appears at 1 —
net-zero move, not a regression. Any other new bucket is a regression to fix.

## 11. Rollback strategy

One commit per dialog, each independently revertible, in dependency order:

1. prep (additive, no visual change): `--modal-w-*` tokens + size classes consume them
   + Modal `initialFocus` pass-through + its primitives-modal test block;
2. SaveContactDialog extraction + migration (+ new test file, Inbox wiring);
3. RelinkModal migration (+ test update);
4. CreateGroupModal migration (+ test update);
5. baseline regen rides the last dialog commit.

Reverting any dialog commit restores its legacy shell with zero coupling to the others;
commit 1 is consumed-by but never depended-on-backwards.

## 12. Debt register deltas planned

- **DD-18r modal-sizing leg: STARTED, NOT closed.** Wave-1 delta: size classes become
  token-backed SSOT (`--modal-w-*`); 3 of 8 ad-hoc shells migrated; `--panel-confirm`
  3→1 consumers, `--panel-composer` 2→1. Still owned by later waves: wave 2 retires
  `--panel-config-edit` + the last `--panel-composer` consumer (+ its
  `--panel-max-inline-wide`/`--modal-max-h-lg` usage); wave 3 retires the last
  `--panel-confirm` consumer (UpdateModal) and GroupDetailModal's `--panel-wizard`
  usage; wave 4 (AddLineWizard) finishes `--panel-wizard`; token DELETION + the
  `--panel-max-inline*`/`--modal-max-h*` collapse close the leg only then.
- **No DD closures expected this wave.** Escape/trap/restoration gaps are P1-2 spec
  scope (modal.md), tracked through the `soup/no-adhoc-modal` burn-down, not a DD id.
- New debt: none anticipated. If the live checkpoint rejects a §2 visual delta or the
  picker dropdown clips against the scrolling ModalBody edge (legacy-parity geometry,
  but unproven in jsdom), it lands as a DD entry, not prose.

## 13. Out of scope (owned elsewhere)

- ConfigEditDialog, ScheduleComposerModal — wave 2 (sequencing vs B2's ChatPicker per
  b3-survey).
- UpdateModal, GroupDetailModal — wave 3 (per-phase actions; nested confirms + internal
  tablist).
- AddLineWizard — wave 4, blocked on the Stepper decision; its role-on-backdrop defect
  is wave-4 scope.
- **ContactSearchPicker INTERNALS — B2 owns those.** Only the dialog shell around the
  picker migrates here; no keydown, dropdown, or SearchInput changes.
- Migrating `c-input`/field labels to form primitives (none exist yet).
- ConfirmDialog, KeyboardShortcutsHelp — already migrated (precedents, untouched).

## 14. Constraints / open items

- **C-B3W1-1:** Modal lacks the `initialFocus` pass-through (modal.md lists it as a
  conceptual prop; `useDismissable` implements it; Drawer already consumes it). Without
  it, initial focus lands on the header close X and both form dialogs lose their
  input autofocus. Resolution: additive ModalProps change in the prep commit + test.
- **C-B3W1-2:** header icon drop + footer tint loss + width/max-h deltas (§2) —
  confirmed or reverted at the live frontend-design checkpoint; the KSH body-labelled
  pattern is the recorded fallback for icons.
- **C-B3W1-3:** `dismissable=false` on SaveContact and CreateGroupModal inverts a
  currently TESTED behavior (backdrop click closed). Deliberate correction per
  modal.md's protective default; the inverted assertions pin it (§7).
- **C-B3W1-4:** §10 expected counts for shared files (Inbox raw-button/legacy-token
  buckets) are expectations, not guarantees — final numbers are read off the regen and
  must only fall.

## 15. Strong-claim audit

Survey corrections this packet is built on (each verified by reading the source):
(1) b3-survey says SaveContact has "NONE (gap)" for Escape — FALSE: `pages/Inbox.tsx`
~203–208 binds a document-level Escape handler while the dialog is open, so the
"three dialogs with no Escape at all" count is wrong for wave 1; (2) b3-survey says
SaveContact is covered via app.test.tsx — FALSE: no UI test anywhere touches the dialog;
(3) the survey's "pass the token through Modal's size mechanism" framing is inverted —
the mechanism never consumes `--panel-confirm`/`--panel-composer`; per tokens-v3 §6.12
those tokens are rejected-superseded and the dialogs adopt `size` while their `--panel-*`
consumption dies (§6). All other absolutes in this packet are file-line-cited or carried
by a planned test; lint-bucket arithmetic is flagged as expectation (C-B3W1-4).

## Verdict: **Ready with Constraints** (C-B3W1-1 resolved in the prep commit; C-B3W1-2 at the live checkpoint; C-B3W1-3/4 documented). Implementation may begin.
