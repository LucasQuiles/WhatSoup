# Slice Evidence — B3 wave 4 (AddLineWizard onto Modal; dialog burn-down COMPLETE)

Worktree `<soup-impl worktree>`, branch `feat/soup-v3-foundation`. Verification ran fresh
2026-06-12 against impl HEAD `244518c6`, pinned at verification start and re-read at end —
HEAD did not move during this packet's runs (the concurrent enforcement lane deposited
nothing mid-verification). Gate packet: `b3-wave4-investigation.md` (`6be734a6`,
Blocked(decision) → upgraded in place to Ready with Constraints by the operator decisions
at `b970a138`). Docs live in `<design worktree>` `docs/design-system/`.

## Scope and commits

| Commit | What | Notes |
|---|---|---|
| `6be734a6` | docs: B3 wave-4 investigation packet | A0 gate artifact; verdict Blocked(decision) solely on C-B3W4-1 |
| `b970a138` | docs: wave-4 decisions recorded | operator approved option (c) wizard-local step composite + option α save-unlinked discard; packet verdict upgraded in place |
| `061986ee` | feat(console): AddLineWizard → Modal primitive | the migration commit — 12 files, +749/−241: AddLineWizard.tsx, SoupKitchen.tsx, composites.css, tokens.component.css, tokens.semantic.css, eslint-waivers.yaml, eslint.config.js, lint-shadow-baseline.json, the NEW `tests/console/add-line-wizard.test.tsx` (427 lines), three flipped pin suites. Zero wizard step files in the diff (scope discipline held; DD-21r lane untouched) |
| `76012b68` | fix(test): inert EventSource stub in the wizard suite + browser-motion collection exclusion (F-B5-1) | EXPECTED, not drift — jsdom has no EventSource; LinkStep mounts when tests advance past step 0; real SSE behavior stays covered by `wizard-link-step.test.tsx` (32 tests) |
| `a65ca387` | docs: B-stage live visual QA matrix | `visual-qa-b-stages.md` — rows 8–12 are this wave's live checkpoint evidence |

**Lane history (cited from the execution log's "B3 wave 4" entry):** the first
implementation lane was killed by a session limit; the resumed lane drove the migration
to its written-first suite and the integrator verified end to end. This packet is the
independent acceptance verification that entry left outstanding ("Inconclusive —
committed; acceptance evidence packet outstanding").

**Fresh verification battery (this packet, impl HEAD `244518c6`):**

- `cd <soup-impl worktree> && npx vitest run --root . tests/console/add-line-wizard.test.tsx tests/console/wizard-step-shell.test.tsx tests/console/wizard-identity-step.test.tsx tests/console/wizard-link-step.test.tsx tests/console/wizard-agent-cwd-default.test.ts tests/console/wizard-agent-cwd-display.test.tsx tests/console/form-primitives.test.tsx tests/console/design-system-compliance-pages.test.ts tests/console/design-system-accessibility.test.tsx tests/console/design-token-classes.test.ts tests/console/modal-workflows.test.ts --pool=forks`
  → **11 files, 179/179 PASS** (vitest 4.1.8). Per file: add-line-wizard **23**,
  wizard-step-shell 8, wizard-identity-step 54, wizard-link-step 32,
  wizard-agent-cwd-default 11, wizard-agent-cwd-display 7, form-primitives 14,
  design-system-compliance-pages 14, design-system-accessibility 4,
  design-token-classes 4, modal-workflows 8. No skips, no masking — raw vitest exit.
- Consumed-contract suites (`tests/console/primitives-modal.test.tsx`,
  `use-dismissable-dark.test.tsx`, `confirm-dialog.test.tsx`): **61/61 PASS**.
- `cd <soup-impl worktree>/console && npx eslint src/components/AddLineWizard.tsx src/pages/SoupKitchen.tsx` → **exit 0** (the M-list scoped-error promotion holds live, not just at commit time).
- `bash <soup-impl worktree>/console/scripts/design-regression.sh` → blocking set
  `1 2 6 8 10 13 14 16` all PASS; **check 19 PASS count=0** (no dangling var() refs —
  the WVR-014 replacement's named proof, reproduced fresh post-commit for the first time;
  the D6 packet's check-19 run predated `061986ee`).
- Whole-src greps (`<soup-impl worktree>/console/src/`): `c-dialog-backdrop`,
  `--panel-wizard`, `--modal-min-h`, `--stepper-line-w`, `--stepper-dot`,
  `framer-motion`, `AnimatePresence`, `var(--overlay)` — **zero functional hits**.
  Two comment-only mentions of `--panel-wizard` survive: `Modal.tsx:59` (stale — see
  omission audit) and `GroupDetailModal.tsx:11` (historical migration note, packet-sanctioned).

## Constraint-by-constraint verification (C-B3W4-1 … 9)

| Constraint | Verdict | Evidence |
|---|---|---|
| **C-B3W4-1** Stepper decision (user-gated) | **RESOLVED → option (c), executed** | Operator approval recorded in the packet §15 (`b970a138`). Executed as the wizard-local composite: `WizardStepper` non-interactive strip `AddLineWizard.tsx:59–95` (spans, never buttons); component-tier CSS block `composites.css:900–981` (`soup-wiz-steps`); the six inline legacy-token styles and the `--badge-unread` borrowing are gone with the legacy strip. New strip dims tokenized exactly as the packet named: `--wiz-step-circle: 18px` + `--wiz-step-sep: 16px` in `tokens.component.css`; `--stepper-line-w`/`--stepper-dot` deleted in the same commit. The option-(a) extraction path is documented in the CSS block header. Spec-tension recorded per the C-B3W3-4 pattern (packet §7 + code comment; no modal.md edit — the precedent waves 2–3 set), and the live checkpoint accepted the strip (rows 8/10/12), so no amendment proposal is triggered |
| **C-B3W4-2** discard flow (named behavior change) | **RESOLVED → option α, executed** | `handleConfirmDiscard` `AddLineWizard.tsx:279–284` is `onClose()` only — **no `api.deleteLine` call exists in the file** (whole-file grep; the legacy D1 copy/behavior contradiction is dead). Confirm branches at `:401–412`: post-creation → title "Abandon new line?", confirm "Save and close" (**primary** variant, not danger), copy promises keep-unlinked + points deletion at the explicit dashboard action; pre-creation dirty → "Discard changes?" / Discard (danger). ModalFooter adopts the note slot when an instance exists (`:366–371`). Test pins: "confirm abandon after creation does NOT call deleteLine (option α)" + "discard before creation … does NOT call deleteLine" (`add-line-wizard.test.tsx:358–383`), both fresh-green. Spec law honored (interaction-patterns §5: save unlinked, never silent deletion) |
| **C-B3W4-3** mount contract | **VERIFIED** | `open: boolean` added to the props contract (`AddLineWizard.tsx:32–36`); reset-on-open via `prevOpenRef` effect (`:165–209` — full form/step/error/lock/confirm state restored to initial on `false→true`); SoupKitchen latches: `wizardEverOpened` state (`SoupKitchen.tsx:354`) gates `{wizardEverOpened && <AddLineWizard open={showAddWizard} …/>}` (`:1028–1030`) — lazy chunk preserved until first open, component stays mounted thereafter so `useDismissable`'s `open→false` focus restore and Modal exit presence both run. ConfirmDialog exits the dialog subtree as a sibling fragment (`:400–412`). Reset pinned by test ("reopening after close resets to step 0") |
| **C-B3W4-4** instant step transitions | **VERIFIED** | framer-motion/AnimatePresence: zero hits in the file (sole mention is the migration-header comment `:9`); step rendering is plain conditionals (`:332–360`). No checkpoint veto recorded in the QA matrix, so no motion.md entry was owed |
| **C-B3W4-5** WVR-014 replacement + focus-ring law | **VERIFIED** | Static accent definitions `composites.css:880–886` — base `.wizard-accent-scope { --wizard-accent: var(--color-s-ok) }` (exact legacy pre-selection parity, the packet's recommended unification) + `[data-line-type="passive"/"chat"/"agent"]` mode accents; runtime delivery is attribute-only (`AddLineWizard.tsx:304–306, :323`). The accent focus-ring block (the P2-12 law violation) is GONE — the file's only remaining `wizard-accent-scope` selectors are the four accent definitions plus `svg.wizard-check` (`:894`). `wizard-check-in` retokened to `var(--dur-base) var(--ease-enter)` (`:889–897`). Waiver retired: `eslint-waivers.yaml` changelog line 30 ("WVR-014 RETIRED — … grep-verified; B3 wave 4"), **10 entries remain**, matching the D6 metrics expectation (11→10). Proof reproduced fresh: design-regression check 19 PASS count=0 |
| **C-B3W4-6** written-first behavioral suite | **VERIFIED (with a named pin-delta, see test-integrity review)** | `tests/console/add-line-wizard.test.tsx`: exactly **23 tests** (the execution-log count is correct), all fresh-green. The constraint's named acceptance pins are all present: Escape gate ×4 (pristine-closes / dirty-raises-discard / post-creation-raises-abandon via `getByRole('dialog', { name: /abandon/i })` / **P1-2 single-fire** — first Escape closes only the confirm, second re-raises), backdrop-pointerdown-inert, X-close-through-gate ×2, step-0 validation block, createLine-exactly-once, createLine-failure fail-visible, Back-as-Cancel, footer-absent-on-Link, D2 createError-renders-once, both option-α no-deleteLine pins, open-prop gate ×2, aria-current pin, reset-on-open. The "written-first" sequencing claim rests on the commit record and execution log (not independently re-provable from tree state) |
| **C-B3W4-7** baseline regen sequencing | **VERIFIED** | The `061986ee` baseline diff is surgical: `"total": 501 → 486` plus removal of exactly the five AddLineWizard buckets the packet line-attributed — no-restricted-syntax 1, no-adhoc-modal 2, no-legacy-tokens 8, no-raw-button 3, no-utility-smell 1 (sum 15 = 501−486, matching §11's prediction including the full 8-count legacy-token fall). **No step-file bucket moved** (the DD-21r-lane collision rule held). Current baseline still totals 486; `soup/no-adhoc-modal` bucket list is **EMPTY console-wide** — the dialog burn-down that began at C2.2 is complete. M-list addition live at `eslint.config.js:771` and proven by the fresh eslint exit 0 |
| **C-B3W4-8** height law / fixed→content height | **VERIFIED, accepted at checkpoint** | `--modal-min-h` deleted (`061986ee` token diff; whole-src grep zero); the shell now takes Modal's content-height-with-85vh-cap law (`--modal-max-h` stays, primitive-owned since wave 3). Live: rows 8/10 render the shell correctly in both themes; row 12 measures the 390×844 fit (no clipping, footer reachable). No veto recorded → the deletion's condition is satisfied |
| **C-B3W4-9** remaining §2 visual deltas | **VERIFIED at the live checkpoint** | Strip restyle to v2 anatomy: row 8 (active step in accent, later steps muted) + row 12 (two-row wrap at 390px, "1-3 / 4-5", legible). Light theme designed-first-class: row 10 (verified frame — white surface, legible strip, clean type cards, labeled fields). Discard confirm: row 11. Top-anchor, lg-width cap law, title ramp/span, 18px header X, footer hairline, body padding −4px: the same delta class every prior migrated dialog absorbed; rows 8/10 show the composed result and the matrix records no veto |

## The two operator decisions, as executed

1. **Step strip — option (c), wizard-local composite** (C-B3W4-1, approved at `b970a138`):
   no new primitive, no spec file; the locked v2 `.wiz-steps` anatomy rebuilt as
   `soup-wiz-steps` component-tier CSS with (a)-grade a11y (container
   `aria-label="Wizard progress"`, `aria-current="step"` on the active step,
   `aria-hidden` separators) — all three test-pinned or source-verified
   (`AddLineWizard.tsx:63–95`). Extraction to a Stepper primitive stays cheap and
   documented if a second wizard ever materializes.
2. **Discard — option α, save unlinked** (C-B3W4-2, approved at `b970a138`): abandoning
   after creation keeps the instance, exactly as the confirmation copy always promised;
   deletion is no longer silent and lives solely at the dashboard's explicit delete
   action with consequence copy. The confirm's primary verb is the safe one ("Save and
   close"); danger styling is reserved for the genuinely destructive pre-creation
   discard branch. Pinned by the two no-deleteLine tests.

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Spec fidelity (vs the locked v2 wizard anatomy) | **PASS** | Composition matches the locked v2 overlay stage (v2.html 2356–2400): `ModalHeader` > step strip as direct shell child (modal.md's "[optional step strip — wizard only]" slot, its one intended consumer) > `ModalBody` > conditional split `ModalFooter` with the keep-unlinked note. Strip anatomy faithful to v2.html 1139–1150: numbered 18px mono circles (`--wiz-step-circle`), accent active ring, ok-colored done state, 16×1px hairline separators (`--wiz-step-sep`), wrap on narrow viewports (row 12 observed it live). `size="lg"` per tokens-v3 §6.12 — the v2-demo `modal--md` tension was dispositioned in the packet (spec table wins) and the checkpoint raised no veto. `dismissable={false}` per the form-dialog protective rule; default ModalHeader, no `labelledById` escape hatch (the wave-3 reasoning, honored). Legacy title casing kept (copy review is C5 scope) |
| Code quality | **PASS** | Fresh eslint exit 0 on both touched TSX files under the scoped-error M config; the migration deleted every named legacy pattern (backdrop div + role-on-backdrop, raw buttons ×3, TYPE_ACCENT + CSSProperties cast + inline injection, fixed-height triplet, footer error block with inline flexShrink, all six inline strip styles); commit diff confirms zero step-file edits (DD-21r lane boundary respected) and the token deletions ride the commit that killed their last consumer (revert-safe, per the packet's rollback design). The latched lazy mount preserves code-splitting until first open. design-regression blocking set all PASS at current HEAD |
| Test integrity | **PASS with a named pin-delta** | 23 written-first tests, fresh-green, no stderr masking, real terminal assertions (raw vitest run quoted above); the D2 fix is pinned by counting occurrences of the error text (renders once); deliberate pin flips all trace to packet §8 — compliance-pages 57–64 now asserts `<Modal` + not-`c-dialog-backdrop`; accessibility asserts aria-labelledby RESOLUTION to the title element and the heading-role loss explicitly; design-token-classes asserts `.c-dialog-backdrop` ABSENT from the committed CSS. The `76012b68` EventSource stub is inert-by-design and labeled in-file, with real SSE coverage intact in `wizard-link-step.test.tsx` (32/32 fresh). **Pin-delta vs the packet §8 minimum list — four pins absent at the consumer level:** focus-lands-inside-on-open, focus-restores-to-opener, Review-edit-links-land-on-phases-0/2/3, name-lock assertion. Compensations, each verified fresh: initial focus + restore pinned at the primitive level (`primitives-modal.test.tsx:462/:491` initial-focus contract, `:317/:777` restore-to-trigger incl. under inert — 61/61), and the consumer wiring each missing pin would exercise is a verified one-liner (`onEditPhase={(phase) => setCurrentStep(phase)}` `AddLineWizard.tsx:355`; `nameLocked={!!lockedName}` `:337`). One flag: the suite's header comment (line 19) lists the focus pin among its claims though no test asserts it — header overclaim, routed to the follow-up below. The constraint's own named acceptance bar (Escape-gate, confirm-stack, discard-outcome) is fully met |
| A11y / keyboard | **PASS** | The role-on-backdrop defect is dead by construction (Modal owns `role="dialog"` + `aria-modal` on the shell; pinned). Accessible name "Add New Line" resolves through generated ids — no literal `wizard-title` (pinned). Escape exists for the FIRST time on this surface (the survey's named gap; legacy had zero keydown handlers) and routes through the single `handleClose` confirm gate at every step — four Escape pins including the P1-2 stack single-fire at the consumer level on top of the primitive-level stacked-Escape proof. Backdrop click can no longer reach the discard path (pointerdown-inert pinned). Strip: `aria-current="step"` pinned, separators `aria-hidden`, non-interactive by construction (no keyboard noise from five mostly-unreachable steps — the packet's §7(b1) rejection rationale, upheld). Minor observation: the strip's `aria-label` sits on a role-less div — faithful to the locked v2 treatment and the approved option-(c) spec, but most AT ignores `aria-label` on generic containers; an optional `role="group"` nicety is routed to the C3 screen pass, non-blocking. Trusted-event keyboard proof remains the D7 lane's standing scope (its harness exists and runs in CI) |
| Visual / live QA | **PASS WITH ENVIRONMENT CAVEAT** | Matrix rows 8–12 (`visual-qa-b-stages.md`, `a65ca387`): **row 8 PASS** (dark wizard anatomy: Modal shell, 5-step strip with Identity active in accent, Name field, Cancel/Next footer); **row 9 environment-INCONCLUSIVE** — advancing fires `api.createLine` which 502s against the backendless mock dev server; the compensations are named in the row: the failure itself proved the fail-visible error banner with form state fully preserved (positive finding), and step transitions are pinned by the 23-test jsdom suite incl. the createLine-failure case; **row 10 PASS** (light theme designed-first-class, verified frame); **row 11 PASS** (discard confirm — observed branch is pre-instance with accurate discard copy; the post-instance option-α branch is unreachable live behind row 9's gap and is verified against source `AddLineWizard.tsx:403–411` + the two jsdom abandon pins, exactly as the row records); **row 12 PASS** (390×844 measured: modal 358px wide, zero horizontal overflow, strip wraps to two legible rows, both footer buttons ≥24px target floor inside the viewport). The matrix's microcopy finding (dangling-colon 502 banner) is routed to C3, not this wave |

## Omission audit

- **Not touched (owned elsewhere, verified untouched by the commit diff):** all wizard
  step-file internals and their raw buttons (P2 burn-down / form-kit track); the
  ConfigStep/ModelAuthStep tablists (DD-21r lane, landed separately at `ed6391e7`);
  radio-card picker polish (C3); brand/copy strings (C5); the beforeunload guard,
  name-lock mechanism, workspace normalization, and creation API contract — preserved
  verbatim (`AddLineWizard.tsx:223–231, :233–234, :237, :249`).
- **`Modal.tsx:59` stale comment** — the packet (§3/§6) said this `--panel-wizard`
  reference updates to `--modal-w-lg` when the token dies; it did not. Comment-only,
  zero runtime effect; one-line fix should ride the next console-touching commit.
- **Four §8 minimum pins absent at the consumer level** (focus-in, focus-restore,
  Review-edit-links, name-lock) plus the suite-header line that overclaims the focus
  pin — compensations named in the test-integrity review; propose a small follow-up
  (3–4 pins + header fix) riding any later wizard-file commit. Below the constraint's
  named acceptance bar; not blocking.
- **`--panel-shortcuts` orphan** (`tokens.component.css:36`) — the fifth of tokens-v3
  §6.12's five rejected-superseded panel tokens; whole-src grep shows ZERO consumers
  (sole hit is its own definition). Not this wave's named scope (the packet obligated
  only `--panel-wizard` + `--modal-min-h`), but it is the last survivor of the family —
  propose ride-along deletion (see debt delta).
- **beforeunload not live-proven** — jsdom cannot test it (packet-acknowledged) and no
  QA-matrix row exercises tab-close; the guard's code is verbatim-preserved legacy.
  Routes to the C3/D7 live script backlog.
- **Optional design-lints M-list fixture case** (§8 "optionally gain") — not taken;
  optional by packet text, and the live eslint run proves the same property directly.
- **Row 9's live gap generalizes:** no step beyond Identity has ever rendered in the
  live environment (LinkStep QR, Model/Config/Review in the migrated shell) — every
  post-creation behavior rests on the jsdom suite + the dedicated step suites (146
  step-level tests fresh-green this packet). A mock-mode `createLine` fixture would
  close this class; routed to C3 alongside the matrix's existing fixture note.
- **jsdom limits as in every prior packet:** flex allocation, real strip wrap geometry,
  computed heights — proven live (rows 8/10/12) instead; D7's deterministic-viewport
  pattern could add wizard rows later if regression pressure appears.

## Debt register delta (PROPOSAL ONLY — register edits belong to the integrator)

| ID | Proposed change | Verification carried by this packet |
|---|---|---|
| DD-18r modal-sizing SSOT leg | **RETIRE the leg** (the register row already flags "strike pending b3-wave4-evidence.md verification of the wave-4 half") | Wave-4 half verified: `--panel-wizard` + `--modal-min-h` deleted with last-consumer grep proofs; all four consumed legacy panel tokens (`--panel-confirm`, `--panel-composer`, `--panel-config-edit`, `--panel-wizard`) now deleted across waves 2–4; both legacy min/max-h one-offs (`--modal-max-h-sm/-lg`) and `--panel-max-inline/-wide` already dead; every modal shell sizes through `--modal-w-sm/md/lg` + the one sizing law; `--modal-max-h` correctly primitive-owned. **Caveat to record in the strike:** `--panel-shortcuts` (the fifth spec-named rejected-superseded token) survives as a zero-consumer orphan definition — recommend deleting it as a ride-along in the next tokens-touching commit so the family is extinct, or noting it as out-of-leg (it no longer sizes any modal) |
| DD-21r | no change | this wave verified its own diff is disjoint from the DD-21r lane's files and baseline buckets |
| DD-19 | no change (already CLOSED) | the wizard inherits exit motion + inert from the B5-era Modal by construction |
| New entry | **none required** | no checkpoint veto fired, option α won (no spec-law override to record), and the option-(c) outcome needed no modal.md amendment — the three "new entries only if" triggers from packet §13 all came up empty. The omission-audit follow-ups (stale comment, four pins, orphan token) are below debt-entry weight and are proposed as ride-alongs above |

## Verdict: **PASS WITH DEFERRED DEBT.**

All nine constraints verified — the two operator decisions executed exactly as approved
and test-pinned; the role-on-backdrop defect, the D1 silent-deletion contradiction, and
the D2 duplicate error render are all dead; WVR-014 retired with its replacement proof
reproduced fresh; the ad-hoc-modal shadow set is EMPTY console-wide and the ratchet fell
501→486 by exactly the predicted buckets; 179/179 wave-relevant tests + 61/61
consumed-contract tests green at HEAD `244518c6`; live QA rows 8/10/11/12 PASS with row
9's environment-INCONCLUSIVE compensated by named fail-visible and jsdom evidence. The
deferred items are small and named: four consumer-level §8 pins + one suite-header
overclaim, the `Modal.tsx:59` stale comment, the `--panel-shortcuts` orphan, and the
no-backend live gap for post-creation steps (C3 fixture). The execution log's wave-4
entry ("Inconclusive — acceptance evidence packet outstanding") can flip on this packet;
the DD-18r modal-sizing strike is proposed above for the integrator.
