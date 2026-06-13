# Slice Evidence — B3 wave 3 (UpdateModal · GroupDetailModal → Modal; Tabs adoption; DD-15 dialog legs)

Worktree `soup-impl`, branch `feat/soup-v3-foundation`, evidence captured at HEAD
`76012b68` (origin/main merged through the vitest-4 bump; tree clean at capture).
Gate packet: `b3-wave3-investigation.md` (`fab8a11c`, Ready with Constraints).
Live-QA source: `visual-qa-b-stages.md` (shared B-stage matrix, 2026-06-12), rows 5, 6, 13.
Constraint-falsification source: `d7-evidence.md` (C-B3W3-7 → DD-27).

## Scope and commits

Wave-3 scope per the investigation packet §0/§3: UpdateModal and GroupDetailModal move
onto the Modal primitive + `useDismissable`; GroupDetailModal's hand-rolled tablist
adopts the Tabs primitive and its four binary settings pairs adopt the canonical seg
(the dialog DD-15 legs); ToolbarTimeRange gains disabled support as prep; a new
dedicated GroupDetailModal suite is a hard prerequisite (C-B3W3-6); `--panel-confirm`
and `--panel-max-inline` retire (DD-18r modal-sizing leg narrows); the console's last
two hand-rolled document-level Escape handlers die.

| Commit | Role | Content |
|---|---|---|
| `fab8a11c` | gate | investigation packet committed (with the B5 packet) |
| `6500b7f3` | wave 3 — prep (C-B3W3-2) | `ToolbarTimeRange` additive optional `disabled` prop; 3 new pins in `primitives-toolbar.test.tsx` (+44 ln); zero consumer changes |
| `d73bef54` | wave 3 — migration | both dialogs onto Modal; Tabs + 4 segs in GroupDetailModal; NEW `tests/console/group-detail-modal.test.tsx` (498 ln, 21 tests); both structural-pin files flipped; `update-modal{,-a11y}.test.tsx` updated; token + zero-consumer CSS deletions; UpdateModal joins the eslint scoped-error list; ratchet baseline 533→511; commit battery per its record: 2,193 green, typecheck:all clean |
| `2d829a64` | adjacent (test-integrity) | one weak terminal in the NEW suite strengthened (bare `toBeDefined` → `getAttribute('aria-label')).toBe('Messaging')`); baseline driven to zero |
| `d80e9726` / `cc3058f4` | adjacent (D7 lane) | trusted-event keyboard suite falsified C-B3W3-7's self-healing claim; DD-27 filed. Recorded here as the constraint's real outcome |

**Deviation from the packet's §12 rollback plan:** three planned commits landed as two —
the UpdateModal and GroupDetailModal migrations (planned commits 2 and 3, deliberately
file-disjoint) were folded into the single `d73bef54`. Each landed commit is still
independently revertible, but the per-dialog revert granularity the packet designed is
gone. Recorded; no action (both dialogs are accepted below).

Current-state note: later waves have since landed on this branch (wave 4 `061986ee`
completed the dialog burn-down; D7/B5/B4 lanes). Where a wave-3 claim was true at
`d73bef54` but the surface has since moved further (e.g. `.c-dialog-backdrop`,
`soup/no-adhoc-modal :: AddLineWizard`), both states are cited.

## Constraint verification (C-B3W3-1 … C-B3W3-8)

| Constraint | Status | Evidence (current code/tests at `76012b68` unless noted) |
|---|---|---|
| C-B3W3-1 — `dismissable=false` inverts the tested backdrop-close on UpdateModal; fresh protective pin on GroupDetailModal | **VERIFIED** | `UpdateModal.tsx:354` `dismissable={false}`; inverted pin `tests/console/update-modal.test.tsx:224` ('does NOT call onClose when backdrop is pointerdown-ed (dismissable=false, C-B3W3-1)'); `GroupDetailModal.tsx:765` `dismissable={false}`; fresh pin `tests/console/group-detail-modal.test.tsx:247` ('does NOT close on backdrop pointerdown (dismissable=false, fresh pin)') |
| C-B3W3-2 — additive `disabled` on ToolbarTimeRange, default-undefined, prep commit + pins | **VERIFIED** | `primitives/Toolbar.tsx:88–111` (`disabled?: boolean`, attribute on every segment button, `onClick` guarded); pins `primitives-toolbar.test.tsx:361–395` (all-disabled attribute, onChange-not-fired, default-undefined unchanged); consumed with the legacy saving-key guard at `GroupDetailModal.tsx:611/630/649/668` (`disabled={saving === '<key>'}`); consumer-level pin `group-detail-modal.test.tsx:412` (in-flight save disables the pair) |
| C-B3W3-3 — visual deltas confirmed at the live checkpoint | **PARTIALLY DISCHARGED** | GroupDetailModal confirmed: matrix row 5 PASS (anatomy: avatar, two-line header, tab strip, labeled X — dark) and row 6 PASS (light theme designed-first-class). **UpdateModal has NO live-QA matrix row** — its §2 deltas (420→480 width, top anchor, Download header-icon drop, footer hairlines) have no recorded live confirmation. Residue routed to the omission audit / integrator |
| C-B3W3-4 — custom header + in-shell tab strip as spec tension; amendment proposal if the checkpoint demands it | **VERIFIED, accepted at checkpoint** | composed exactly as specified: `GroupDetailModal.tsx:766` `labelledById="group-detail-dialog-title"`, `:771` header as direct shell child `soup-modal-header`, `:779` title id preserved on `soup-modal-title truncate`, `:787` X = ActionButton `label="Close dialog"`, `:797–805` `Tabs label="Group detail sections" inset` between header and `ModalBody` (`:810`). Live checkpoint row 5 PASSed this exact anatomy; no veto raised, so no modal.md amendment proposal is triggered |
| C-B3W3-5 — ratchet bucket numbers are expectations; final values read off the regen, fall-only | **VERIFIED** | `d73bef54` baseline diff: total 533→511 (−22); per-bucket exactly at packet §11 expectations: no-adhoc-modal UpdateModal 2→0 (key deleted), GroupDetailModal 2→0 (deleted); no-raw-button UpdateModal 6→0 (deleted), GroupDetailModal 19→9; no-legacy-tokens UpdateModal 13→12, GroupDetailModal 17 unchanged (the packet's explicit non-fall); no-utility-smell UpdateModal 1→0 (deleted); no-brand-regression UpdateModal 1 stays; no-raw-form-control 1/3 unchanged. At wave-3 close `soup/no-adhoc-modal` remainder = AddLineWizard 2 only (7 of 8 shells), as targeted. Current HEAD baseline (post-later-waves) total 486 with the wave-3 buckets holding (GroupDetailModal raw-button 9, legacy-tokens 17) |
| C-B3W3-6 — new dedicated GroupDetailModal suite as hard prerequisite of the migration commit | **VERIFIED** | `tests/console/group-detail-modal.test.tsx` (498 ln) landed IN `d73bef54`, not as a follow-up; 21 tests covering every packet-§8 minimum: closed-state ×2, aria-labelledby resolution (id preserved via `labelledById`), backdrop non-dismiss, Escape stack, **nested-confirm double-Escape (`:279` — first Escape closes only the Leave confirm, second closes the modal; the P1-2 regression pin at consumer level for the first time)**, X close, labelled tablist + roving tabindex + ArrowRight-focuses-without-selecting + Enter-selects + tabpanel aria wiring, seg group labels + exactly-one `aria-pressed` + in-flight disabled, admin gating, tab reset on group change. Fresh run below: 21/21. One terminal subsequently strengthened by `2d829a64` |
| C-B3W3-7 — focus-trap loading-body edge "transient, self-healing", owned by the D7 lane | **FAILED — falsified, then rescoped (DD-27)** | The D7 trusted-event proof (`tests/browser/keyboard-proofs.test.tsx`, header lines 13–33 and the C-B3W3-7 case; `d7-evidence.md` "THE FALSIFICATION") ran the edge under real Chromium Tab: the escape occurs and the next Tab does **not** recapture — `use-dismissable.ts`'s recapture branch re-focuses, but native traversal completes after the handler and overrides it. The packet's "self-healing" disposition was WRONG. Disposition: DD-27 filed (`cc3058f4`; register row present, P2, owner C3, fix direction = intercept Tab before traversal), the wave-3 disposition formally revised, and the browser suite carries a characterization test pinning the actual escape behavior (written to flip to the strengthened-trap assertion when the fix lands). This constraint is recorded as FAILED-then-rescoped, not as passing |
| C-B3W3-8 — Escape/X dismissal kept at every phase with `handleClose` cleanup; reopen-resets-to-confirm is recorded parity | **VERIFIED** | `UpdateModal.tsx:329–338`: `handleClose` aborts the in-flight fetch stream, clears poll interval + timeout, then delegates to `onClose`; it is the single Modal `onClose` target (`:352`) and every footer verb routes through it (`:462–476`), so Escape, X, Cancel, Close, and Skip share one cleanup path. Pinned: `update-modal.test.tsx:343–357` ('Escape during updating phase calls onClose (abort cleanup — C-B3W3-8)' — asserts the fetch mock's `signal.aborted` flips true). The reopen-resets-to-confirm hazard remains byte-identical parity per the packet; no live observation recorded (folded into the C-B3W3-3 residue) |

## Fresh test runs (2026-06-12, this packet, integrator-independent)

`cd <soup-impl worktree> && npx vitest run --root . tests/console/<file> --pool=forks`, vitest 4.1.8:

| Suite | Result |
|---|---|
| `tests/console/group-detail-modal.test.tsx` | **21/21** |
| `tests/console/update-modal.test.tsx` | **39/39** |
| `tests/console/update-modal-a11y.test.tsx` | **3/3** |
| `tests/console/update-modal-sse-error.test.tsx` | **2/2** (survives verbatim, as the packet predicted — re-run is the proof) |
| `tests/console/primitives-toolbar.test.tsx` | **29/29** (incl. the 3 C-B3W3-2 pins) |
| Combined single invocation (5 files) | **94/94**, 2.7s |

Full-suite context: 10,148 green at `76012b68` is the operator record from the wave-3
tasking (vitest-4 bump merge), not re-run by this packet; the migration commit's own
battery recorded 2,193 green + typecheck:all clean at `d73bef54` (commit record).

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Spec fidelity | **PASS** | Modal anatomy per modal.md: conditional `ModalFooter` only in the three action-bearing phases (`UpdateModal.tsx:459–476` — confirm/error/restart-instances; updating/restarting-fleet/done omit the foot region); sizing law adopted (sm 480 / lg 720 per tokens-v3 §6.12; the +60px UpdateModal width is the recorded RelinkModal precedent, file header `:14–15`); `dismissable=false` is the destructive/form rule both dialogs' headers document; `labelledById` is the documented escape hatch, used only where an externally-controlled title exists (GroupDetailModal yes, UpdateModal deliberately no — packet §8). Tabs per tabs.md: manual activation, roving tabindex, labelled tablist (pinned in the new suite). Seg ownership per toolbar.md/tabs.md upheld — C-B3W2-4 closed as KEEP `ToolbarTimeRange`, no rename, no extraction. The one spec tension (C-B3W3-4 fourth-region header) was declared in advance, composed on the wave-2 precedent, and accepted at the live checkpoint |
| Code quality | **PASS** | single-cleanup-path close wiring (C-B3W3-8 row above); additive prep prop is default-undefined with guarded onClick (`Toolbar.tsx:88–111`) — existing consumers byte-identical; `if (!group) return null` guard kept while Modal owns the open gate (`GroupDetailModal.tsx:745–747`); SSE pipeline/reducer/query/confirm internals untouched per the packet's invariant column; deletions grep-gated: zero non-comment `--panel-confirm`/`--panel-max-inline` references remain in `console/src` (only header-comment provenance notes + the surviving NOT-contains pin `design-token-classes.test.ts:53`); zero `document.addEventListener` keydown handlers remain outside hooks/primitives (the three remaining hits are file-header comments recording the death); enforcement advanced with the migration (UpdateModal added to the eslint scoped-error list in `d73bef54`); both file headers record every disposition (width, icon drop, labelledById, wrapper death) |
| Test integrity | **PASS with findings** | 94/94 fresh; the inverted pin is constraint-traced (C-B3W3-1) and mirrors the wave-1/2 wording; the abort-cleanup pin asserts a real terminal (`signal.aborted === true`); the new suite's one weak terminal was caught and strengthened by the integrity baseline drive (`2d829a64`). **Finding 1 (name/assertion mismatch):** `update-modal.test.tsx:262` 'focus lands inside the dialog on open' asserts only DOM containment of the close button (`dialog.contains(closeBtn)`), not focus — it would pass if focus never moved. Mitigation: the actual mechanism is pinned at the primitive level (`primitives-modal.test.tsx:491` omitted-initialFocus → close X receives focus). **Finding 2 (header overclaim):** `group-detail-modal.test.tsx:20` header lists "Focus restore to opener" but no test in the file exercises restore (the only `activeElement` assertions are tablist roving, `:342–357`). Mitigation: restore is pinned at `primitives-modal.test.tsx:317` and the inert-aware variant at `:777`. Both findings are comment/consumer-level gaps over primitive-level coverage — routed to the omission audit, not blockers |
| A11y / keyboard | **PASS with rescoped constraint** | gained over legacy and pinned at consumer level: labelled tablist with roving tabindex, arrow-move-without-select, Enter-activates, correct tabpanel aria wiring (suite `:313–364`); seg pairs gain `role="group"` labels (Messaging / Edit group info / Who can add members / Join approval — `GroupDetailModal.tsx:611–668`) + `aria-pressed` exactly-one (`:403`) + a visible/AT disabled affordance during saves (`:412`) — legacy was class-only active styling, invisible to AT; stack-aware single-fire Escape incl. the nested-confirm double-Escape ordering (`:279`); header X buttons are named `Close dialog` with no collision against the error-phase text "Close" button (`update-modal-a11y.test.tsx:88–106`); Escape + X stay live at every SSE phase (hook contract + C-B3W3-8 pin). The one negative: the focus-trap loading-body edge is a real, NOT self-healing escape under trusted Chromium Tab — C-B3W3-7 FAILED and lives on as DD-27 (P2, owner C3) with a characterization test pinning the actual behavior |
| Visual / live QA | **PASS for GroupDetailModal; UpdateModal unconfirmed** | matrix row 5 PASS — GroupDetailModal anatomy (avatar, two-line header title + participant count, Info/Participants/Settings strip under the header, calm labeled-field density, labeled X; dark, `/tmp/soup-qa2-check-a.png`); row 6 PASS — light theme designed-first-class (white modal, green RA avatar, tab strip, kv fields, invite-link + Copy; `gdm-light.png`); row 13 PASS — the B5 inert-by-design observation used GroupDetailModal as its live surface (nav theme toggle suppressed while the modal is open, fires after close) — corroborating the migrated shell's stack/inert integration live. No matrix row exercises UpdateModal; its C-B3W3-3 deltas rest on jsdom pins + the shared Modal shell visually confirmed on three sibling surfaces (rows 3/5/6). Honest residue, below |

## Omission audit (each item triaged, none silent)

- **UpdateModal live checkpoint missing.** The shared B-stage QA matrix has no UpdateModal
  row, so C-B3W3-3's confirm-or-revert was never executed for that dialog (width 420→480,
  top anchor, Download header-icon drop, footer hairlines unobserved live; same for the
  C-B3W3-8 reopen-parity observation and the packet's long-fleet checklist note).
  Compensating evidence: 44 jsdom tests across three suites + the same Modal shell
  live-PASSed on rows 3/5/6. Triage: a one-row UpdateModal addition to the live matrix
  (reachable against mock data from the Nav update button) owned by the integrator /
  C3 screen passes — proposed below, not silently dropped.
- **Rollback-plan deviation.** Two commits instead of the packet's three (§ Scope);
  per-dialog revert granularity lost. Recorded only.
- **Consumer-level focus-restore pins not delivered** in either dialog suite despite
  packet §8 naming them; the GDM suite header overclaims one ("Focus restore to opener")
  and `update-modal.test.tsx:262` is name/assertion mismatched. Mechanisms covered at
  the primitive level (`primitives-modal.test.tsx:317/491/777`). Triage: comment-level
  header fix + either add the two consumer pins or rename the tests — routed to the
  test-integrity lane alongside D7's honesty-label follow-ups.
- **C-B3W3-7's disposition was wrong** — the packet shipped a falsifiable claim
  ("self-healing") that D7 falsified. The failure mode worked as designed (claim →
  trusted-event proof → DD-27), but this packet records plainly that wave 3's
  reliability answer §10.5 was incorrect as written.
- **Execution-log artifact-map drift.** program-directives §6 places the execution log
  at `06-implementation/execution-log.md`; the file actually lives at
  `docs/design-system/execution-log.md`. Pointer fix owed to the directives file
  (integrator edit, not this packet).
- The execution log's wave-3 entry verdict reads "Inconclusive — committed; acceptance
  evidence packet outstanding". This packet is that acceptance evidence; the log entry's
  verdict line is the integrator's to flip.
- Out-of-scope items confirmed untouched per packet §14: body-internal raw buttons/form
  controls (P2/form-kit tracks; ratchet buckets 9 and 1/3 hold), brand string (C5),
  ConfirmDialog/ContactSearchPicker internals, exit-motion/inert (delivered later by B5,
  not by this wave).

## Debt register delta (PROPOSAL ONLY — no register edits made by this packet)

| ID | Current register state | Proposed |
|---|---|---|
| DD-15 | already NARROWED (2026-06-12): both dialog toggle sets migrated waves 2–3; residual MetricsTab pair ruled tab semantics → C3 | **no edit.** Wave-3's four pairs are confirmed landed on the canonical seg with the C-B3W2-4 keep-the-name decision honored. The packet's planned "DD-15 CLOSES" was superseded by the coverage-refresh survey's MetricsTab finding — correct as it stands |
| DD-18r | row's remaining legs still list "legacy modal sizing SSOT" | **propose striking the modal-sizing leg.** Wave 3 deleted `--panel-confirm` + `--panel-max-inline` (verified zero non-comment consumers); wave 4 (`061986ee`) has since retired the wizard's `--panel-wizard`/`--modal-min-h` (zero hits in `tokens.component.css` at HEAD); `--modal-max-h` is primitive-owned per the packet's reclassification. Evidence: this packet + the wave-4 record. Integrator to verify the wave-4 leg before editing |
| DD-21r | already CLOSED citing the wave-3 GroupDetailModal migration (21-test suite incl. tablist roving) | **no edit** — this packet is the named acceptance evidence for that closure's wave-3 leg |
| DD-27 | open, P2, owner C3 | **no edit** — stands as C-B3W3-7's rescope target; this packet cross-references it as the constraint's outcome |
| (new, optional) | — | **UpdateModal live-QA row**: propose either a matrix row addition at the next QA round or an explicit integrator ruling that the three-sibling-surface shell evidence suffices; if neither, file a small P3 debt entry so the C-B3W3-3 residue has an owner and expiry rather than prose |

## Verdict: **PASS WITH DEFERRED DEBT.**

The wave's scope landed whole and is independently re-proven here: both dialogs on the
Modal primitive with the correct dismissal posture, the tablist's full keyboard contract
gained, all four DD-15 dialog pairs on the canonical seg with double-fire protection
preserved through the additive prep prop, the console's last two hand-rolled document
Escape handlers gone, two sizing tokens and four zero-consumer CSS blocks retired
grep-gated, the ratchet down 533→511 with every bucket at packet-expected values, and
the dialog's first-ever rendering suite (21/21 fresh) carrying the wave's acceptance
pins — 94/94 across the five wave-relevant suites at HEAD. The deferred set is explicit
and owned: C-B3W3-7 FAILED under trusted-event proof and lives on as DD-27 (owner C3) —
recorded here as a falsified disposition, not a pass; the UpdateModal live-checkpoint
residue (C-B3W3-3/8 observations) needs a matrix row or an integrator ruling; two
consumer-suite test-honesty nits (mislabeled focus test, header overclaim) are routed to
the test-integrity lane with primitive-level coverage compensating. No constraint is
silently dropped; no claim above exceeds what was re-run or file-line-verified.
