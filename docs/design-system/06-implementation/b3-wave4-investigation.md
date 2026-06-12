# B3 Wave-4 Investigation Packet — legacy dialog burn-down, final shell (AddLineWizard) + the Stepper decision

Pre-implementation packet required by the working checklist (A0 gate). Implementation is
blocked until this packet carries a `Ready` or `Ready with Constraints` verdict — and this
wave additionally carries a **user-gated primitive decision** (§7) that must be resolved
first. Scope is WAVE 4, the LAST entry of the b3-survey.md inventory:
`console/src/components/AddLineWizard.tsx` (393 ln, 5-step wizard, creation side-effect at
step 0→1, exit-confirm flow) moves onto the Modal primitive + `useDismissable`. Targets:
the final `soup/no-adhoc-modal` file bucket to zero (8 of 8 shells migrated — the rule's
shadow set empties); the `role="dialog"`-on-backdrop defect dies; DD-18r's modal-sizing
SSOT leg CLOSES (`--panel-wizard`, `--modal-min-h` deleted); `.c-dialog-backdrop` loses its
last consumer and the CSS block dies; WVR-014's runtime `--wizard-accent` injection retires
in favor of static tokenized accents (the waiver's own replacement_plan names this wave).

## 1. Gate 0 output

Packet drafted read-only against the implementation tree @ `feat/soup-v3-foundation`
(`8c26fbb1`), 2026-06-12. B3 waves 1–3 are landed facts re-verified in source: UpdateModal
sits in the eslint M list (`eslint.config.js` 770–778); GroupDetailModal is Modal-based
(`GroupDetailModal.tsx` header, "Modal size=lg, 720px exact match to --panel-wizard");
RelinkModal/SaveContactDialog carry the wave-1 migration headers. Whole-src grep confirms
`c-dialog-backdrop` and `--panel-wizard`/`--modal-min-h` consumption survive ONLY in
AddLineWizard (255, 263). **A parallel lane is migrating the ConfigStep/ModelAuthStep
in-step tablists (DD-21r) right now** — those files still show hand-rolled `c-tab` tablists
in this checkout (`ConfigStep.tsx` 334–341, `ModelAuthStep.tsx` 68–75); this packet scopes
them OUT and is written against their post-migration state (Tabs primitive inside step
panels, §14). Standard gate 0 (worktree inventory, lint, full test run) executes at
implementation start and is recorded in the wave-4 evidence packet — this packet pins
source facts, not run results.

## 2. frontend-design pre-implementation checkpoint

- Modal anatomy per modal.md: scrim > shell > head / **[optional step strip — wizard
  only]** / body / foot. The wizard is the one consumer the spec's step-strip slot was
  written for (modal.md anatomy line; locked v2.html overlay stage 2356–2400 renders
  exactly this composition: `modal-head` > `wiz-steps` > `modal-body` > `modal-foot--split`
  with a note). Mapping: `ModalHeader` (static title) > step strip as a direct shell child
  (per the §7 decision) > `ModalBody` (step content) > conditional `ModalFooter` (hidden on
  the Link step, exact legacy condition at 325).
- **Visual changes recorded** (deliberate, to confirm at the live checkpoint):
  1. Width: `--panel-wizard` 720px → `size="lg"` 720px (exact; tokens-v3 §6.12 line 254
     says lg "carries the legacy wizard width"). Cap `max-w-[90%]` → law cap
     `calc(100% - var(--sp-8))` — wider below ~800px viewports, never narrower above 320px
     (same delta class every prior wave absorbed). NOTE: the v2 demo stages the wizard as
     `modal--md` (v2.html 2357); the tokens-v3 table is the spec authority and assigns lg —
     recorded so the checkpoint sees the tension; recommend lg (720 is the operating width
     today; ConfigStep's five-tab body needs it).
  2. **Height law:** legacy shell is FIXED-height — `min-h-[var(--modal-min-h)]
     h-[var(--modal-max-h)] max-h-[var(--modal-max-h)]` (263): always 85vh tall regardless
     of step content. The Modal shell is content-height with an 85vh cap (primitives.css;
     tokens-v3 §6.12 row 435 marks `--modal-min-h` rejected-superseded by "one modal sizing
     law … max-height 85vh"). Post-migration the wizard grows/shrinks per step and the
     footer rides up on short steps. This is the spec-mandated disposition and the
     condition for the `--modal-min-h` deletion (§6) — named checkpoint delta C-B3W4-8.
  3. Vertical anchor: `c-dialog-backdrop` centers (composites.css 696–705) →
     `soup-modal-backdrop` anchors top-center (primitives.css 318–328). Same ride-up delta
     every prior wave absorbed; combined with (2) the wizard's chrome sits visibly higher.
  4. Title: `c-heading-lg` h2 (272) → `soup-modal-title` span via default ModalHeader
     (13px heading ramp; heading role is lost — consistent with every migrated dialog).
     Header X (`c-btn c-btn-ghost`, 16px icon, `aria-label="Close wizard"`, 273–275) →
     ModalHeader's 18px ActionButton named `Close dialog`. Legacy title "Add New Line" is
     KEPT (the v2 demo's "Add line" casing is a copy question for the checkpoint, not this
     wave's scope).
  5. Step strip restyles per the §7 decision — under the recommended option the dot/check
     chrome (filled `--color-s-ok` circles sized by the chat `--badge-unread` token, 53–72)
     rebuilds to the locked v2 `.wiz-steps` anatomy (numbered 18px mono circles, accent
     active ring, ok-colored done state, 16×1px hairline separators — v2.html 1139–1150).
  6. Step-transition motion: the AnimatePresence fade+rise at `duration: 0.25, ease:
     [0.22, 1, 0.36, 1]` (284–289) is OUTSIDE the motion system — 250ms is not in the
     closed duration set and the literal easing is a P3-6 stray (motion.md §1/§2/§12).
     Recommend INSTANT step switch (step change is an operator-caused state change —
     motion.md §1 instant band; tabs switch instant for the same reason), which removes
     framer-motion from the file. Checkpoint veto path: a named motion.md entry
     (re-banded enter `--dur-base`/`--ease-enter`, exit `--dur-fast`/`--ease-exit`), not
     silent retention — C-B3W4-4.
  7. Footer: gains the `soup-modal-footer` hairline-top; the `createError` block leaves
     the footer for the body (§4, defect D2); under discard-option α (§4) the footer
     adopts the split variant with the v2 `wiz-note` copy via ModalFooter's `note` prop.
  8. Shell gains enter/exit animation + background inert (B5-era Modal); reduced-motion
     covered by the global rule.
- Density: ModalBody padding `--sp-5` vs legacy content `p-[var(--sp-6)]` (282) — −4px per
  side; step internals unchanged. Responsive note: at 320px the lg shell takes
  `100% − 32px`; the v2-anatomy strip wraps (`flex-wrap: wrap`, v2.html 1139) — five short
  labels fit two rows worst-case; live QA verifies 320/390/768.

## 3. Files inspected and classification

| File | Class | Current invariant | Wave-4 invariant | Changes? |
|---|---|---|---|---|
| `console/src/components/AddLineWizard.tsx` (393 ln — survey count re-verified exact) | consumer | backdrop div carries `role="dialog" aria-modal aria-labelledby="wizard-title"` + `onClick={handleClose}` (254–260) — THE role-on-backdrop defect; shell `wizard-accent-scope bg-d2 … w-[--panel-wizard] max-w-[90%] min-h/h/max-h` + runtime `--wizard-accent` inline injection from `TYPE_ACCENT` (261–267, 114–118); NO Escape handler anywhere (survey gap, verified); h2 `id="wizard-title"` + raw X (272–275); WizardStepper inline-styled dot/check strip (30–87); AnimatePresence step motion (283–321); footer hidden on step 1 (325), raw Back/Cancel + Next buttons (338–370), footer `createError` block (329–336); creation side-effect at step 0→1 (193–207), `lockedName` (182, 199), beforeunload guard (171–179); `handleClose` confirm-gating (212–221); `handleConfirmDiscard` → `api.deleteLine` (224–233); exit ConfirmDialog rendered INSIDE the backdrop div (377–388) | `Modal open size="lg" dismissable={false} onClose={handleClose}` + ModalHeader + step strip (§7) + ModalBody + conditional ModalFooter; `open` prop added to the component API (§10.1); accent via `data-line-type` static tokenization (§5); validation, creation pipeline, lockedName, beforeunload, confirm flow (per §4 decision) unchanged | YES |
| `console/src/pages/SoupKitchen.tsx` (351, 1022–1024) | consumer | lazy + Suspense + CONDITIONAL mount `{showAddWizard && <AddLineWizard onClose=…/>}` — unmount-on-close defeats focus restore and exit motion (§10.1) | latched mount + `open` prop (RelinkModal-in-LineDetail precedent, LineDetail.tsx 296–303) | YES |
| `console/src/components/primitives/Modal.tsx` | producer | full contract: `dismissable` default false (98), `labelledById` escape hatch (80, 105), size classes → `--modal-w-*` tokens (120–125, primitives.css 365–375), exit presence, background inert | unchanged — consumed. Line 59's `--panel-wizard` comment updates to `--modal-w-lg` when the token dies | YES (comment only) |
| `console/src/hooks/use-dismissable.ts` | producer | Escape always available; restore-on-`open→false` only (216–230) — drives the §10.1 mount-contract requirement | unchanged — consumed | NO |
| `console/src/components/ConfirmDialog.tsx` | producer/evidence | Modal-based `size="sm" dismissable={false}` (38–43) — the exit confirm is already a stack citizen | unchanged — consumed | NO |
| `console/src/components/wizard/IdentityStep.tsx` (200), `LinkStep.tsx` (222), `ModelAuthStep.tsx` (334), `ConfigStep.tsx` (951), `ReviewStep.tsx` (224), `WizardStep.tsx` (38), `form-primitives.tsx` (119), `link-step-events.ts` (35) | consumers (step internals) | step bodies; LinkStep owns SSE auth + cleanup (101–105) and its own controls (footer-hidden contract); ReviewStep back-edges `onEditPhase(0/2/3)` (127, 142, 168) + body error block (197–207) + Create button (209–219); ConfigStep/ModelAuthStep tablists are the DD-21r lane's live scope | UNTOUCHED by this wave except `var(--wizard-accent)` refs keep resolving (the tokenization preserves the variable name, §5). LinkStep is already proven inside a Modal — RelinkModal renders it in ModalBody since wave 1 | NO |
| `console/src/components/TagInput.tsx` (12, 27, 52) | evidence | maps the literal `'var(--wizard-accent)'` → accent channel | unchanged — variable name survives tokenization | NO |
| `console/src/styles/tokens.component.css` (37, 59; 53–54; 21) | producer | `--panel-wizard` 720px and `--modal-min-h` min(500px,85dvh) — each sole-consumed by AddLineWizard:263; `--stepper-line-w`/`--stepper-dot` consumed only by the legacy strip (44, 65); `--badge-unread` borrowed by the strip for circle sizing (54) | `--panel-wizard` + `--modal-min-h` DELETED (§6); stepper-token fate rides the §7 decision; `--badge-unread` stays (chat badge keeps it) | YES (deletions) |
| `console/src/styles/composites.css` (696–705; 855; 890–895; 898–906) | producer | `.c-dialog-backdrop` — LAST consumer AddLineWizard:255 (`background: var(--overlay)` is the token's only CSS use); `.c-tab` accent underline consumes `--wizard-accent` (DD-21r lane kills the consumers); `.wizard-accent-scope` focus-ring block recolors input focus with the MODE accent — violates interaction-patterns §1 ("status/mode colors never ring focus", the P2-12 law); `wizard-check-in` keyframe hardcodes `0.3s ease` (P3-6 stray) | `.c-dialog-backdrop` block deleted (grep-gated); accent focus-ring block deleted (law, C-B3W4-5); new static `data-line-type` accent definitions added (§5); `wizard-check-in` retokens to `--dur-base`/`--ease-enter` as a ride-along | YES |
| `console/src/styles/tokens.semantic.css` (289) | producer | `--overlay: var(--scrim)` alias — orphaned once `.c-dialog-backdrop` dies (whole-src verified: no other consumer) | alias deleted in the same commit after an in-commit grep proof; `--overlay-badge` (290) is separate and stays. Scrim single-source enforcement hook (modal.md) becomes satisfiable | YES (deletion) |
| `console/eslint-waivers.yaml` (205–225) | register | WVR-014: runtime-injected `--wizard-accent`, replacement_plan = THIS WAVE | entry removed; design-regression check 19 re-verified against the static definitions | YES |
| `console/eslint.config.js` (770–778) | enforcement | M list (Block 4a): 8 files, requires zero no-raw-button + no-adhoc-modal | gains `src/components/AddLineWizard.tsx` (§11) | YES |
| `tests/console/design-system-compliance-pages.test.ts` (57–64) | enforcement pin | pins the DEFECT: `role="dialog"`/`aria-modal`/`aria-labelledby="wizard-title"`/`id="wizard-title"` as source literals | FLIPS (§8) | YES |
| `tests/console/design-system-accessibility.test.tsx` (70–78) | fixture/consumer | the file's ONLY rendering coverage: renders the wizard, queries `dialog` by name + literal id pins + `heading` role | dialog-by-name query survives via Modal; literal/heading pins flip (§8) | YES |
| `tests/console/modal-workflows.test.ts` (11–16) | evidence | lazy-load default-export pin | survives verbatim | NO |
| `tests/console/design-token-classes.test.ts` (23) | enforcement pin | `toContain('.c-dialog-backdrop')` — pins the CSS block's EXISTENCE | flips: selector leaves the existence list (§8) | YES |
| `tests/console/design-lints.test.ts` (118–133, 657–672) | evidence | rule fixtures use `c-dialog-backdrop`/`role="dialog"` in SYNTHETIC strings | survive (they lint fixture text, not source); optionally gain an AddLineWizard M-list case | NO (optional add) |
| `tests/console/wizard-identity-step.test.tsx`, `wizard-link-step.test.tsx`, `wizard-step-shell.test.tsx`, `wizard-agent-cwd-*.test.*`, `form-primitives.test.tsx` | fixture/consumer | step-level suites; no shell dependency (verified: none imports AddLineWizard) | survive verbatim — re-run proof only | NO |
| **`tests/console/add-line-wizard.test.tsx` (NEW)** | fixture/consumer | does not exist — the shell's only behavioral render today is the single a11y assertion above; survey's "covered via app.test.tsx" is FALSE in the current tree (zero hits) | new dedicated suite (§8) — the wave's largest test cost (C-B3W4-6) | YES (new) |
| `docs/design-system/03-spec/components/modal.md`, `tabs.md`, `interaction-patterns.md` §2/§5/§6, `motion.md` §1–§5, `tokens-v3.md` §6.12, `02-directions/iterations/v2.html` 1139–1165 + 2322–2400 | spec/locked direction | normative; v2 overlay stage is the locked wizard composition | register/spec-note deltas per §7/§13 | register only |

**Exact new files:** `tests/console/add-line-wizard.test.tsx`, the wave-4 evidence packet,
this packet, plus (under §7 option a only) `03-spec/components/stepper.md` +
`console/src/components/primitives/Stepper.tsx` + `tests/console/primitives-stepper.test.tsx`.
Any file beyond this table is added here before commit.

## 4. Mapping to Modal anatomy

| Legacy piece | Modal anatomy |
|---|---|
| backdrop div with `role="dialog" aria-modal aria-labelledby` + `onClick={handleClose}` (254–260) | Modal scrim + `useDismissable` — the role-on-backdrop defect dies BY CONSTRUCTION (Modal puts the dialog role on the shell, Modal.tsx 138–140; the scrim is outside the dialog boundary) |
| shell div: `wizard-accent-scope bg-d2 c-border rounded-lg shadow-[--shadow-lg] … w-[--panel-wizard] max-w-[90%] min-h/h/max-h` + inline `--wizard-accent` style (261–267) | Modal shell `size="lg"`; an inner wrapper keeps the accent scope as `className="wizard-accent-scope" data-line-type={formData.type \|\| undefined}` — injection dies, scope class stays (its consumers live in step files) |
| header: h2 `id="wizard-title"` + raw X `aria-label="Close wizard"` (268–276) | `ModalHeader title="Add New Line" onClose={handleClose}` — **default header, NOT `labelledById`**: the title is a static string with no externally-controlled element; reaching for the escape hatch to preserve the `wizard-title` literal would abuse the documented contract (the exact wave-3 UpdateModal reasoning, b3-wave3-investigation.md §8). The step name never titled the dialog in legacy (it lives in the strip + WizardStep headings) — keep it that way |
| WizardStepper (30–87) between header and content (279) | step strip per §7, direct shell child between ModalHeader and ModalBody — the modal.md "[optional step strip — wizard only]" slot, the spec's only sanctioned fourth region (wave-3 C-B3W3-4 wording confirms: "the only sanctioned extra strip is wizard-only") |
| content div `flex-1 overflow-auto p-[--sp-6]` + AnimatePresence (282–322) | `ModalBody` (owns scroll + padding); step conditionals unchanged; motion per §2.6 / C-B3W4-4 |
| footer (`currentStep !== 1` gate, 325): createError block (329–336), Back/Cancel (338–349), Next/Creating (351–370) | conditional `ModalFooter` with the same step-1 gate (UpdateModal's conditional-footer precedent, wave-3 §2); Back/Cancel → `Button variant="ghost"` with chevron/X icons kept (footer-icon precedent), Next → `Button variant="primary"` with `disabled={creating}` + spinner verbatim; **the error block moves into ModalBody** as an interaction-patterns §6 body error (it is body anatomy, not foot anatomy — and this kills defect D2, the DOUBLE error render on Review: footer 329–336 AND ReviewStep 197–207 both display the same `createError` today) |
| exit ConfirmDialog rendered inside the backdrop div (377–388) | sibling under a fragment — it is already a portal'd Modal; structurally it leaves the dialog subtree it never belonged in |

**Dismissable posture mid-wizard (the wave's central question #2):** `dismissable={false}`,
constant. The wizard carries unsaved form state from the first keystroke (isDirtyRef, 156,
160–165) and a PROVISIONED INSTANCE from step 0→1 (193–207) — a stray scrim click must
never reach `handleClose`'s discard path by accident. Escape and the header X remain
available at every step (hook contract, use-dismissable.ts 14–17) and route through the
SAME `handleClose` confirm gate (212–221): pristine step 0 → closes immediately; dirty
pre-creation → "Discard changes?" confirm; any step after creation → the abandon confirm.
This is a strict UPGRADE, not parity: legacy has NO Escape at all (the survey's named gap,
verified — zero keydown handlers in the file) and the legacy backdrop click (256) goes
straight to `handleClose`. Escape per step is therefore uniform at the Modal layer; all
per-step differentiation lives in `handleClose`, exactly one onClose target. With the exit
confirm open, the confirm is topmost on the stack → first Escape closes only it, second
re-raises it (P1-2 single-fire; pinned at the consumer level in the new suite). No
runtime-varying `dismissable` — same rejection rationale as wave 3 §4.1.

**The discard flow (defect D1 — spec conflict, user-gated within the checkpoint):**
`handleConfirmDiscard` (224–233) calls `api.deleteLine` (api.ts 375–376, a DELETE), but the
confirm copy says "Abandoning will stop it. You can reconfigure it later from the
dashboard" (385–387) — **the copy promises stop-and-keep; the code deletes.** The spec is
unambiguous and on the other side of the code: interaction-patterns §5 line 70 — "Closing a
wizard after partial creation offers 'save unlinked — link later', never silent deletion" —
and the locked v2 wizard footer bakes the same sentence into the wiz-note slot (v2.html
2393). Options:

- **(α) spec-aligned (RECOMMENDED):** post-creation close keeps the instance — the confirm
  becomes "Save and close — link later" (safe verb; no `deleteLine` call), the ModalFooter
  adopts the split variant with the v2 note copy, and deletion remains where it already
  lives with full consequence copy: the dashboard's delete confirm (LineDetail.tsx
  290–294). `handleConfirmDiscard` shrinks to `onClose()` for the created case;
  the dirty-pre-creation case is unchanged (nothing provisioned, nothing to keep).
- **(β) parity + truthful copy:** keep the deletion, fix the lying copy ("Abandoning will
  DELETE the instance and its configuration"). Contradicts the spec law; survives only as
  an explicit user override recorded in the debt register.

α is a deliberate behavior change on an operator flow — named delta C-B3W4-2, confirmed at
the checkpoint, with the new suite pinning whichever lands.

`initialFocus` — NONE (Modal default: first focusable = header close X). Legacy has no
autofocus; step 0's primary input is a candidate but modal.md's wave-1 `initialFocus`
precedent (C-B3W1-1) was for single-form dialogs — on a multi-step shell the header X is a
stable, non-destructive target across all five steps. Deliberate; pinned; revisitable at
the checkpoint.

## 5. Patterns to replace (what dies) + WVR-014 replacement design (question #3)

Dies in AddLineWizard.tsx: the backdrop div + role-on-backdrop + `onClick` +
`stopPropagation` pair (254–262); the `bg-d2` raised-shell class string and `max-w-[90%]`
cap (263); the `--panel-wizard`/`--modal-min-h`/`--modal-max-h` consumption (263); ALL
THREE raw buttons (273 X, 338 Back/Cancel, 352 Next); the footer error block with its
inline `flexShrink` (329–336); the `TYPE_ACCENT` map + `CSSProperties` cast + inline
`--wizard-accent` injection (114–118, 264–266); framer-motion (under the recommended
C-B3W4-4) including the `AnimatePresence` import (2–3, 283–321); the stepper's six inline
legacy-token styles (46, 57, 67, 76) under any §7 rebuild option. What the wizard GAINS:
Escape (first time ever), stacking single-fire, pointerdown outside-click semantics
(inert, since dismissable=false), focus trap, focus restoration (§10.1), portal rendering,
background inert, enter/exit motion.

**WVR-014 tokenized replacement** (waiver replacement_plan: "retires the runtime injection
in favor of tokenized step accents"). Today: TSX injects `--wizard-accent` per
`formData.type` at runtime (264–266); static scanning cannot see it (design-regression.sh
561–564, check 19). Replacement — static component-tier definitions keyed off a data
attribute; runtime flips only the attribute:

```css
/* composites.css — wizard accent scope (static; design-regression check 19 sees these) */
.wizard-accent-scope                        { --wizard-accent: var(--color-s-ok); }  /* pre-selection (legacy runtime fallback, 265) */
.wizard-accent-scope[data-line-type="passive"] { --wizard-accent: var(--color-m-pas); }
.wizard-accent-scope[data-line-type="chat"]    { --wizard-accent: var(--color-m-cht); }
.wizard-accent-scope[data-line-type="agent"]   { --wizard-accent: var(--color-m-agt); }
```

- Every downstream consumer keeps resolving unchanged — the variable NAME survives, only
  its definition moves from a JS inline style to CSS: step-file inline refs (ConfigStep
  85/353/366/373/382/398/431/636/723/880/892/929, ModelAuthStep 173, IdentityStep
  124/161/187, form-primitives 6), TagInput's accent-channel map (12/27/52), the
  `wizard-check` icon rule (composites 904), and `.c-tab`'s underline (855 — dying
  separately with the DD-21r lane). Their existing `var(--wizard-accent, --color-m-cht)`
  CSS fallbacks become unreachable but harmless; leave them.
- Pre-selection default unification: the runtime fallback is `--color-s-ok` (265) while the
  CSS fallbacks say `--color-m-cht` — the static base rule picks ONE; recommend `s-ok`
  (exact visual parity at step 0). Checkpoint may re-decide.
- **The accent focus-ring block DIES with the waiver** (composites 890–895): it recolors
  input focus borders/rings with the mode accent — precisely the "status/mode colors never
  ring focus" P2-12 law (interaction-patterns §1). Inputs fall back to the standard focus
  recipe. Named delta C-B3W4-5; a veto routes to a debt entry + spec-conflict user
  decision, not silent retention.
- Ride-along while the block is open: `wizard-check-in`'s `0.3s ease` (898–906) retokens
  to `var(--dur-base) var(--ease-enter)` (opacity+scale — already allowlist-compliant;
  the literal is a named P3-6 stray class, motion.md §12).
- Waiver entry WVR-014 (eslint-waivers.yaml 205–225) is removed in the same commit;
  design-regression check 19 re-run is the proof.

## 6. Sizing decision — DD-18r SSOT leg CLOSES + token endgame (question #4)

Mapping per tokens-v3 §6.12 (sizing law `min(Wpx, calc(100% - 32px))`, max-height 85vh):
`size="lg"` = `min(var(--modal-w-lg) /* 720px */, calc(100% - var(--sp-8)))`
(primitives.css 373–375) — exact width match to `--panel-wizard` 720px. Height: the law
(85vh cap, body scrolls) replaces the legacy fixed-height triplet; `--modal-min-h` is
rejected-superseded by name (tokens-v3 §6.12 row 435). Responsive: §2 note.

Token/CSS retirement (each verified sole-consumer via whole-src grep, this packet §1):

| Item | Last consumer | Deletion condition | Dies in |
|---|---|---|---|
| `--panel-wizard` (tokens.component.css 37) | AddLineWizard:263 (Modal.tsx:59 + GroupDetailModal.tsx:11 hits are comments; the Modal.tsx comment updates to `--modal-w-lg`) | shell adopts `size="lg"` | commit 2 |
| `--modal-min-h` (tokens.component.css 59) | AddLineWizard:263 | the height law lands (C-B3W4-8 checkpoint delta) — a veto resurrects nothing silently; it routes to debt + user decision | commit 2 |
| `.c-dialog-backdrop` (composites.css 696–705) | AddLineWizard:255 | pre-edit grep proof in-commit; **the legacy dialog CSS family is then extinct** (waves 2–3 killed `.c-dialog`, `.c-dialog-header`, `.c-dialog-footer`, `.c-dialog-body`) | commit 2 |
| `--overlay` alias (tokens.semantic.css 289) | composites.css 703 (the backdrop block above) | orphaned by the block deletion; in-commit grep proves zero other consumers; `--overlay-badge` survives | commit 2 |
| `--stepper-line-w`, `--stepper-dot` (tokens.component.css 53–54) | WizardStepper 44, 65 | ride the §7 decision: v2-anatomy rebuild replaces them (new strip dims tokenize as `--wiz-step-n` ring 18px / `--wiz-step-sep` 16px or reuse spacing tokens — named in the §7 outcome); keep-legacy keeps them | commit 3 (or stays) |

After this wave DD-18r's modal-sizing-SSOT leg has ZERO remaining scope — register delta §13.
`--modal-max-h` stays: it is primitive-owned since wave 3 (the Modal shell consumes it).

## 7. THE STEPPER DECISION (user-gated — framed and recommended here, NOT decided)

The wizard's step navigation needs a primitive-level answer before migration. Ground
truth about the flow the chrome must express: **linear and gated, not free navigation.**
Step 1 (Link) is reachable ONLY through the step-0→1 creation side-effect (193–207); step 2
only via LinkStep's `onComplete` (302, fired on SSE `connected`); the only back-edges are
the footer Back button (sequential, 341–343) and Review's explicit edit links to phases
0/2/3 — never 1 (ReviewStep 127, 142, 168). The strip itself is non-interactive today
(plain divs/spans, 30–87) and in the locked direction (v2.html 2362–2368: `<span
class="wstep">` — no buttons, container `aria-label="Wizard progress"`).

### Option (a) — net-new Stepper primitive (`primitives/Stepper.tsx` + `03-spec/components/stepper.md`)

- **Anatomy** (projected from locked v2, 1139–1150): flex strip, gap `--sp-1`, padding
  `--sp-3 --sp-5`, hairline bottom; per step a numbered 18px circle (mono 10.5px ≈
  `--type-label` mono) + label; states upcoming (`--text-3`, `--border-strong` ring),
  active (`--text-1`, `--accent` ring+number), done (`--ok` ring+number); 16×1px
  `--border-subtle` separators; wraps on narrow viewports.
- **Spec cost:** a NEW file in the locked `03-spec/components/` set (13 components today,
  none named stepper) — that is a spec amendment to G2-locked direction, which
  program-directives §2 routes through a user gate by definition. The content would be a
  faithful projection of v2.html, so the amendment is low-risk but still a gate.
- **Code cost:** primitive + strict-tier cleanliness + a `primitives-stepper.test.tsx`
  contract suite + this spec section — for exactly ONE consumer in the entire console
  (whole-src grep: no second multi-step flow exists; UpdateModal's six phases are a state
  machine, not user-navigable steps, and stayed body-rendered through its own migration).
  A primitive with a permanent single consumer is speculative generality — the same
  economy argument the program used AGAINST renaming/extracting the seg in wave 3 §7.1.
- **A11y:** container `aria-label="Wizard progress"`, active step `aria-current="step"`,
  separators `aria-hidden` — identical under (a) and (c).

### Option (b) — compose from existing primitives

- **(b1) Tabs in a constrained mode — REJECTED on contract evidence.** tabs.md's keyboard
  contract is roving tabindex + Arrow/Home/End + **manual activation on Enter/Space**
  (tabs.md Accessibility; Tabs.tsx header) — manual activation governs *when selection
  fires relative to focus*, not *whether* a tab is activatable. Every tab in a tablist is
  an activation target; the wizard's steps are NOT (forward steps are unreachable until
  the create/link side-effects fire; Link is never re-enterable from Review). Modelling
  gating as `disabled` tabs fails tabs.md explicitly: disabled tabs require a
  `disabledReason` and stay focusable ("A disabled tab without a reason is a defect") —
  "you haven't gotten there yet" is progress semantics, not unavailability semantics, and
  five mostly-disabled focusable tabs is keyboard noise. The anti-pattern list also bans
  tabs whose semantics don't match tablist behavior. Post-DD-21r there are REAL tablists
  inside the step panels (ConfigStep's five sections, ModelAuthStep's providers) — a
  tablist-shaped stepper would nest tablist > tabpanel > tablist, ambiguous for AT users.
  Cite-able conclusion: Tabs' contract is orthogonal to gated linearity; constraining it
  would fork the primitive's one contract — the drift the program forbids.
- **(b2) Plain heading + progress text** ("Step 2 of 5 — Link" under the title; restraint
  composition, zero chrome). Cheapest and fully spec-legal — modal.md marks the strip
  *optional*. But the locked v2 overlay stage RENDERS the wiz-steps strip as the wizard's
  signature region (2362–2368), and deleting a locked-direction element is direction
  reopening (user gate) just as adding one is. Viable only as an explicit
  checkpoint-level reduction; not recommended — operators get real scan value from
  see-all-five-steps progress in a flow that provisions infrastructure mid-way.

### Option (c) — wizard-local composition, documented as a composite (RECOMMENDED)

Keep the step chrome inside AddLineWizard.tsx as a non-interactive status strip, REBUILT
to the locked v2 `.wiz-steps` anatomy via component-tier CSS classes (a `soup-wiz-steps`
block in composites.css consuming semantic tokens — kills all six inline legacy-token
styles at 46/57/67/76 and the `--badge-unread` borrowing), with the (a)-grade a11y
treatment (`aria-label="Wizard progress"`, `aria-current="step"`, `aria-hidden`
separators). Document it as the named filler of modal.md's "[optional step strip — wizard
only]" slot — a clarifying sentence in the spec's existing anatomy line, recorded as a
spec-tension note (the C-B3W3-4 pattern) rather than a new spec file. No primitive, no
spec amendment, no second consumer invented. Extraction to option (a) stays cheap forever:
the markup is one component, the CSS is already centralized, and the spec section can be
lifted from this packet's option-(a) anatomy if a second wizard ever materializes.

**Recommendation: (c).** It honors the locked direction (v2 anatomy, faithfully), the
spec's restraint economics (no single-consumer primitive), and the operator flow
(non-interactive progress indication for a gated linear flow). (a) is the documented
escalation path; (b1) is rejected with the contract evidence above; (b2) is the documented
reduction path. **The choice is the operator's** — this packet's remaining sections are
decision-independent (the shell migration is identical under (a)/(c); (b2) only deletes
the strip and its tokens earlier).

## 8. Test changes per file

**`tests/console/add-line-wizard.test.tsx` (NEW — C-B3W4-6):** the shell's first behavioral
suite. Fixtures: api module mock (`createLine`, `updateConfig`, `deleteLine`,
plus the IdentityStep name-check endpoint), EventSource stub for LinkStep (or step-2 entry
via mocked onComplete), hygiene-safe fixture values per the established JID conventions.
Minimum pins: renders nothing until opened (open-prop gate); dialog role + accessible name
"Add New Line" with aria-labelledby RESOLVING to the title element (no literal id);
backdrop pointerdown does NOT dismiss (fresh protective pin — the legacy click-to-close
was never tested); Escape on pristine step 0 closes; Escape with dirty form raises the
discard confirm; Escape after creation raises the abandon confirm; **Escape with the exit
confirm open closes ONLY the confirm, second Escape re-raises** (consumer-level P1-2 pin);
X close routes through the same gate; step walk: invalid step 0 blocks with the
validateStep messages (97–102), valid step 0 fires `createLine` exactly once and locks the
name (193–207, 182); Back from step 0 = Cancel; footer absent on step 1; Review edit links
land on phases 0/2/3; create-error renders ONCE (the D2 duplicate is dead); discard-flow
outcome per the §4 decision (α: no `deleteLine` on save-and-close / β: deleteLine +
truthful copy); focus lands inside on open; focus restores to the SoupKitchen opener on
close (§10.1). `beforeunload` is not jsdom-testable — live QA script.

`tests/console/design-system-compliance-pages.test.ts` 57–64: the defect pin block
('adds dialog ARIA to AddLineWizard' — it pins role/aria literals ON THE BACKDROP) flips
to the migrated shape: `toContain('<Modal')`, `not.toContain('c-dialog-backdrop')`,
`not.toContain('role="dialog"')` (Modal owns it). The form-primitives blocks (66–68,
169–175) survive untouched.

`tests/console/design-system-accessibility.test.tsx` 70–78: `getByRole('dialog', { name:
'Add New Line' })` SURVIVES (Modal wires it); the literal `aria-labelledby="wizard-title"`
and heading-id pins (76–77) flip to a resolution assertion (attribute points at the
element whose text is the title — ModalHeader renders a span, not a heading; same flip
every migrated dialog took).

`tests/console/design-token-classes.test.ts` 23: `.c-dialog-backdrop` leaves the
CSS-existence selector list (the block is deleted). The not-contains pins at 51–53 survive.

`tests/console/modal-workflows.test.ts` 11–16: survives verbatim (default export stays).

`tests/console/design-lints.test.ts`: synthetic-fixture suites survive by construction;
optionally add the Group-M case 'no-adhoc-modal fires as error at AddLineWizard.tsx'
mirroring 657–663.

Step-level suites (`wizard-identity-step`, `wizard-link-step`, `wizard-step-shell`,
`wizard-agent-cwd-*`, `form-primitives`): survive verbatim — none imports the shell;
re-run is the proof. Under §7 option (a) add `primitives-stepper.test.tsx` (roles, states,
aria-current, no interactivity).

Weak-terminal-assertion rule honored; typecheck across the full workspace plus the console
build before any DONE claim.

## 9. Fixture and data review

The new suite builds the shell's fixture set fresh (§8) — the only fixture machinery added.
LinkStep's SSE machinery already has dedicated coverage (`wizard-link-step.test.tsx` +
`link-step-events.ts` unit tests) — the shell suite stubs the step boundary rather than
re-proving SSE. ConfirmDialog, Modal, useDismissable contracts are pinned at the primitive
level (primitives-modal stack/trap/restore suites) — consumed, not re-proven, except the
consumer-level Escape-stack pin (§8). Long-content sanity (ConfigStep's tallest tab under
the new content-height shell), the §2 visual deltas, both themes, and 320/390/768 widths
ride the live QA script. Trusted-event keyboard proof remains the D7 lane's.

## 10. Reliability answers

1. **Focus restore + exit motion vs the conditional mount (TRAP FOUND):** SoupKitchen
   conditionally mounts the wizard (1022–1024) and the component has no `open` prop —
   close unmounts it with `open` effectively still true. `useDismissable` restores focus
   ONLY on the `open→false` effect re-run (use-dismissable.ts 216–230, no cleanup-time
   restore), and Modal's exit presence is bypassed by parent unmount — so a naive shell
   swap would silently lose BOTH focus restoration and exit motion. Resolution
   (C-B3W4-3): add `open: boolean` to AddLineWizardProps; SoupKitchen latches the lazy
   chunk on first open and keeps the component mounted thereafter
   (`{wizardEverOpened && <AddLineWizard open={showAddWizard} …/>}`), preserving the lazy
   chunk until first use (the always-mounted RelinkModal-under-Suspense precedent,
   LineDetail.tsx 296–303). Companion requirement: a reset-on-open effect (the UpdateModal
   `prevOpenRef` pattern) so a reopened wizard starts at step 0 with fresh state — legacy
   got this for free from unmount. Honest baseline: legacy restores nothing (no trap, no
   restore, ever), so even a parity miss here would not regress — but the wave's premise
   is the full contract.
2. **Escape during LinkStep's live SSE:** close → confirm → discard unmounts LinkStep,
   whose effect cleanup closes the EventSource and clears the QR timer (LinkStep.tsx
   101–105, `cancelled` guard at 25/39). No leaked stream; verified.
3. **Mid-create Escape (`creating === true`):** footer buttons disable (344, 356) but
   Escape/X stay live (hook contract) → confirm path. If `createLine` resolves after the
   discard, the instance exists with the wizard gone — under §4 option α this converges
   with the kept-instance design (benign); under β the discard's `deleteLine` races the
   create (pre-existing legacy hazard, byte-identical, observed at live QA). The scrim
   click that could trigger this accidentally today (256) is REMOVED.
4. **Exit-confirm stack:** ConfirmDialog is Modal-based (`dismissable=false`) — confirm
   topmost ⇒ single-fire Escape; outside-click cannot double-dismiss either layer.
   Mechanism pinned at the primitive level (primitives-modal stacked-Escape suite),
   consumer-level pin new in §8. `handleConfirmDiscard`'s deleteLine failure swallow
   (228–230, console.warn) can strand an instance under option β — pre-existing, recorded;
   dies under α.
5. **Discard correctness:** §4 D1 — the copy/behavior contradiction is resolved by the
   gated decision, never silently shipped.
6. **State while closed:** under the latched mount the component stays mounted with
   `open=false` — Modal returns null; no wizard hook runs network work while closed
   (the only fetches live in steps, which unmount with the body; the beforeunload guard
   correctly de-registers when `instanceCreated` resets, 171–179).
7. **Step-height variance (post fixed-height removal):** ModalBody owns scroll; the 85vh
   cap engages on ConfigStep's tallest tab; shorter steps shrink the shell (C-B3W4-8
   checkpoint delta). No nested scroll areas are introduced (modal.md anti-pattern held:
   body is the single scroll surface, exactly as the legacy content div was).
8. **Reduced motion / repeated open-close:** global rule covers shell enter/exit; the
   recommended instant step switch removes the only JS-driven motion; Escape listener
   lifecycle is hook-owned; the new suite adds an unbound-when-closed pin.

## 11. Enforcement plan (question #5)

Shadow ratchet (`console/eslint.config.shadow.mjs` + `lint-shadow-baseline.json`),
regenerated once at the wave's final commit. Current values read from the baseline JSON
and **verified per-line by running the shadow config against the file** (exact attribution
below); expectations only — final numbers read off the regen and must only fall (C-B3W4-7):

| Bucket | Now | After | Dying hits |
|---|---|---|---|
| `soup/no-adhoc-modal :: src/components/AddLineWizard.tsx` | 2 | 0 | 255 (backdrop class), 257 (role on backdrop) — **the rule's shadow set goes EMPTY console-wide** |
| `soup/no-raw-button :: src/components/AddLineWizard.tsx` | 3 | 0 | 273 (X → ModalHeader ActionButton), 338, 352 (→ Button primitives) |
| `soup/no-legacy-tokens :: src/components/AddLineWizard.tsx` | 8 | 0 | 46, 57, 67×2, 76×2 (stepper inline styles — die under any §7 rebuild), 263 (`bg-d2`, dies with shell), 331 (`bg-d3`, dies as the error block moves to body anatomy). Floor 6 if the checkpoint freezes the legacy stepper untouched |
| `soup/no-utility-smell :: src/components/AddLineWizard.tsx` | 1 | 0 | 263 (`max-w-[90%]`) |
| `no-restricted-syntax :: src/components/AddLineWizard.tsx` | 1 | 0 | 333 (inline `flexShrink`, dies with the footer error block) |
| ALL `… :: src/components/wizard/*` buckets (ConfigStep 21/10/3, ModelAuthStep 6/4/3/1, IdentityStep 4/2, LinkStep 5/2, ReviewStep 6/2, form-primitives 2/5, WizardStep 1) | — | **unchanged by THIS wave's commits** | step internals are DD-21r-lane and form-kit scope; any movement in this wave's regen is a scope violation |

**Baseline regen sequencing (C-B3W4-7):** `lint-shadow-baseline.json` is a single shared
artifact and the DD-21r lane regenerates it too. The lanes are file-disjoint in source but
COLLIDE on the baseline. Rule: each lane regens at its own final commit, second lane
rebases on the first's counts; integrator verifies every bucket moved only by the owning
lane (counts fall-only).

**M-list addition:** `eslint.config.js` Block 4a (770–778) gains
`'src/components/AddLineWizard.tsx'` — eligibility is the block's own criterion (header
764–767: zero no-raw-button + no-adhoc-modal in the baseline), satisfied at commit 2. Step
files are NOT eligible (raw buttons remain by design until their own tracks). With the
no-adhoc-modal shadow set empty, rule promotion out of shadow becomes possible — but no
promotions ride this wave (lint-plan lifecycle, wave-3 precedent); recorded as a lint-plan
delta for the enforcement stage.

Structural pins that flip vs stay — named exactly in §8: compliance-pages 57–64 FLIP;
accessibility 76–77 FLIP (70–75 survive); design-token-classes 23 FLIPS;
modal-workflows 11–16 STAY; design-lints fixtures STAY; all wizard step suites STAY.

## 12. Rollback strategy

Three commits, each independently revertible:

1. **WVR-014 retirement (prep):** static accent block in composites.css +
   `data-line-type` attribute on the LEGACY shell div + `TYPE_ACCENT`/inline-injection
   deletion + accent focus-ring block deletion + `wizard-check-in` retoken + waiver entry
   removal + design-regression check 19 proof. Zero step-file changes (the variable name
   survives); revert restores the runtime injection and the waiver together.
2. **Shell migration:** Modal adoption (+`open` prop API + SoupKitchen latched mount +
   reset-on-open) + footer/error/discard reshape per §4 + the NEW test suite + all §8 pin
   flips + deletions: `--panel-wizard`, `--modal-min-h`, `.c-dialog-backdrop` block,
   `--overlay` alias (each grep-proven in-commit) + M-list addition. The legacy stepper
   markup rides along UNCHANGED in this commit (its inline styles still resolve).
3. **Step strip rebuild** per the §7 decision (+ stepper-token retirement/renames + the
   remaining legacy-token bucket falls) + baseline regen (sequenced per C-B3W4-7).

Token and CSS deletions ride the commit that kills their last consumer, so any revert
restores a self-consistent set. Commits 2 and 3 touch the same component file but disjoint
regions (shell vs strip); commit 3 reverts cleanly to a migrated-shell-with-legacy-strip
state that is itself shippable.

## 13. Debt register deltas planned

- **DD-18r modal-sizing leg: CLOSES.** `--panel-wizard` + `--modal-min-h` deleted; the
  five legacy panel tokens and both min/max-h legacy tokens are fully resolved
  (`--modal-max-h` reclassified primitive-owned in wave 3). Closure cites this packet §6.
- **DD-21r: untouched here** — ConfigStep/ModelAuthStep legs belong to the parallel lane;
  this packet's §7 rejection of tabs-as-stepper is recorded so the two never cross.
- **DD-19 unchanged** (exit motion landed in B5; inert landed; the note about instant step
  switching routes to motion.md, not DD-19).
- **New entries only if:** the checkpoint rejects a §2 delta; option β wins §4 (records
  the spec-law override); or the §7 outcome demands its spec note become a modal.md
  amendment proposal.
- WVR-014 leaves `eslint-waivers.yaml` (10 entries remain); the waiver-count line in the
  yaml header updates.

## 14. Out of scope (owned elsewhere)

- **ConfigStep/ModelAuthStep in-step tablists and ALL step-file internals** — the DD-21r
  parallel lane (live now). This packet assumes their post-migration state: Tabs primitive
  inside step panels; `.c-tab`'s CSS block and its `--wizard-accent` underline consumer
  (composites 855) die in THAT lane. Coordination point: baseline regen sequencing
  (C-B3W4-7) and the shared composites.css file — region-disjoint edits, integrator
  verifies no overlap at merge.
- Step-file raw buttons/inputs (LinkStep retry + View Line, ReviewStep EditBtn + Create,
  ConfigStep/ModelAuthStep controls) and `form-primitives` raw controls — P2 raw-button
  burn-down / form-kit track.
- Radio-card mode picker upgrade (v2.html 2347–2352 vs current CardSelector) — already
  migrated surface; any v2-fidelity polish is C3 territory.
- Brand/copy strings ("Add New Line" vs v2 "Add line"; "Line is live!") — C5 cutover /
  copy review.
- `--wizard-accent` consumers inside step files — they keep resolving; their inline-style
  hygiene is form-kit scope.
- The beforeunload guard, name-lock mechanism, `withDefaultAgentWorkspace` normalization,
  and creation API contract — preserved verbatim, not redesigned.
- All previously migrated dialogs — precedents, untouched.

## 15. Constraints / open items

- **C-B3W4-1 (BLOCKING, user decision):** the Stepper decision §7 — (a) new primitive +
  spec section, (b2) strip deletion, or (c) wizard-local composite (recommended). (b1)
  Tabs-as-stepper is rejected on contract evidence and is not offered. Until the operator
  picks, this packet's verdict is Blocked(decision); every other section is
  decision-independent.
- **C-B3W4-2 (checkpoint, named behavior change):** discard-flow resolution §4 — recommend
  α (spec law: "save unlinked — link later, never silent deletion", interaction-patterns
  §5:70 + v2.html 2393); β requires recording a spec-law override in the register. The
  current copy/behavior contradiction (copy promises keep, code deletes) ships in NEITHER
  option.
- **C-B3W4-3:** mount-contract change — `open` prop + SoupKitchen latched mount +
  reset-on-open effect. Required for focus restoration and exit motion (§10.1); preserves
  lazy chunking until first open.
- **C-B3W4-4:** step-transition motion → instant (motion.md §1 instant band; removes
  framer-motion and the 250ms/custom-bezier P3-6 strays). Checkpoint veto = a named
  motion.md entry via version bump, never silent literal retention.
- **C-B3W4-5:** WVR-014 replacement deletes the accent focus-ring block (interaction-
  patterns §1 P2-12 law) and unifies the pre-selection accent default. Confirmed at the
  checkpoint; veto routes to debt + spec-conflict decision.
- **C-B3W4-6:** the new `add-line-wizard.test.tsx` suite is a hard prerequisite of the
  migration commit, not a follow-up — the 393-line shell has a single rendered assertion
  today. Its Escape-gate, confirm-stack, and discard-outcome pins are the wave's
  acceptance evidence.
- **C-B3W4-7:** baseline-regen and composites.css sequencing with the DD-21r lane (§11,
  §14); step-file buckets must not move in this wave's regen; counts fall-only.
- **C-B3W4-8:** fixed-height → content-height visual delta (and the `--modal-min-h`
  deletion riding it) confirmed at the live checkpoint, both themes, 320–1440.
- **C-B3W4-9:** remaining §2 visual deltas (top anchor, cap law, title ramp/span, 18px X,
  strip restyle, footer hairline, body padding −4px) — confirmed or reverted at the live
  frontend-design checkpoint.

## 16. Strong-claim audit

Claims verified or corrected against current source:
(1) survey line counts — AddLineWizard 393 EXACT; survey's structure line ("5-step stepper
+ framer-motion transitions + creation side-effect at step 0→1 + exit-confirm-deletes-
instance") verified at 27/283–321/193–207/224–233 respectively;
(2) survey's "NONE (gap)" Escape claim — TRUE (zero keydown handlers in the file; the
console's hand-rolled document-Escape count stayed zero after wave 3 — this wave ADDS
Escape support rather than migrating it);
(3) survey's "covered via app.test.tsx" — FALSE in the current tree: app.test.tsx has zero
AddLineWizard references; the only rendering coverage is design-system-accessibility
70–78. New suite required (C-B3W4-6);
(4) wave-3's forward claims — VERIFIED: `--panel-wizard` last consumer 263,
`--modal-min-h` last consumer 263, `.c-dialog-backdrop` last consumer 255, the named pin
set (compliance-pages 57, accessibility 70–72, modal-workflows 11–13) all present at the
cited lines; `--modal-max-h` correctly primitive-owned;
(5) bucket arithmetic — NOT estimated: the shadow config was executed against the file
and every hit line-attributed (§11); totals match the committed baseline exactly
(2/3/8/1/1);
(6) the tasking's premise "Tabs in a constrained mode" as a live option — DEVELOPED AND
REJECTED with contract citations (tabs.md disabled-needs-reason + manual-activation
semantics; nested-tablist hazard post-DD-21r) rather than dismissed;
(7) WVR-014's replacement_plan ("retires the runtime injection … tokenized step accents")
— confirmed as this wave's obligation (eslint-waivers.yaml 213–217); the full consumer
set of `--wizard-accent` was enumerated by whole-src grep (5 step files + TagInput + 3
composites.css blocks) and each dispositioned (§5);
(8) **defects newly found by this packet:** D1 discard copy/behavior contradiction
(385–387 vs 224–233 + api.ts 375) sitting on top of a spec law; D2 duplicate createError
render on Review (footer 329–336 + ReviewStep 197–207); the accent-focus-ring P2-12
violation (composites 890–895); the v2-demo `modal--md` vs tokens-v3 lg assignment
tension (dispositioned: spec table wins);
(9) the locked v2 wizard composition (head > wiz-steps > body > split-foot-with-note,
2356–2400) and the `.wiz-steps` anatomy (1139–1150) — read directly from v2.html, the
program's locked-direction reference, and used as the §7 option-(a)/(c) anatomy source;
(10) the conditional-mount focus-restore trap (§10.1) — derived from use-dismissable.ts
216–230 (restore only on open→false) plus the SoupKitchen mount shape (1022–1024), and
checked against the RelinkModal always-mounted precedent (LineDetail.tsx 296–303).
All other absolutes are file:line-cited or carried by a planned test.

## Verdict: **Blocked(decision)** — solely on C-B3W4-1, the user-gated Stepper decision (§7: recommend option (c), wizard-local composite to the locked v2 anatomy). Every other answer is settled and decision-independent; the moment the operator picks, this packet upgrades in place to **Ready with Constraints** (C-B3W4-2 discard-flow resolution at the checkpoint; C-B3W4-3 mount contract and C-B3W4-6 new suite as hard prerequisites; C-B3W4-4/5/8/9 at the live checkpoint; C-B3W4-7 regen sequencing with the DD-21r lane) with no further investigation required.
