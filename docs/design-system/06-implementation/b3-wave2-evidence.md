# Slice Evidence — B3 wave 2 (ConfigEditDialog + ScheduleComposerModal → Modal primitive; DD-15 composer leg; DD-18r sizing-SSOT first deletions)

Worktree `soup-impl`, branch `feat/soup-v3-foundation`. Gate packet: `b3-wave2-investigation.md`
(`7145769d`, Ready with Constraints C-B3W2-1…7). Verification for this packet performed
2026-06-12 at branch tip `244518c6`; the two dialog sources and `LineDetail.tsx` are untouched
since the migration commit, and the dedicated suites are untouched except one integrity
strengthening (table below — verified via
`git -C <soup-impl worktree> log 71d77108..244518c6 -- <wave-2 files>`).

| Commit | What |
|---|---|
| `71d77108` | The wave: both dialogs onto `Modal` + `useDismissable`, ConfigEditDialog `open` prop + LineDetail wiring, both toggle pairs → `ToolbarTimeRange`, five sizing tokens deleted, pin files flipped, ratchet regen **563→533**, "2,120 console tests green" (commit record) |
| `45bd03ea` | Post-wave: integrity guard flagged two composer seg-group assertions as weak terminals; strengthened to exact button-composition asserts (immediately caught a wrong assumed DOM order — Recurring before One-shot) |
| Later waves touching shared files only | `d73bef54` (w3) + `061986ee` (w4) + `68a7beda` (B4) touch `tokens.component.css` and the two structural pin files for THEIR surfaces; zero edits to the wave-2 dialog sources or their dedicated suites |

**Deviation from the packet's rollback plan (§12):** one combined commit instead of two
per-dialog commits. The dialogs share no source files, so per-dialog revert remains possible
via path-scoped revert, but the planned commit granularity was not delivered. Recorded; no action.

## Test run (this packet's own evidence, 2026-06-12 at `244518c6`)

`cd <soup-impl worktree> && npx vitest run --root . tests/console/<7 files> --pool=forks`
→ **7 files, 201/201 passed, 0 failed, 0 skipped, 0 todo** (JSON reporter; per-file):

| File | Result |
|---|---|
| `tests/console/config-edit-dialog.test.tsx` | **57/57** (51 pre-wave + 6 new: closed-state null, Escape-open, Escape-unbound-closed, reset-on-open, initial-focus-inside, backdrop inversion) |
| `tests/console/schedule-composer-modal.test.tsx` | **65/65** (58 pre-wave + 7 new: seg aria contracts ×6, initial-focus/no-auto-open) |
| `tests/console/line-detail-ds-compliance-round2.test.ts` | 5/5 (scheduleComposer on migrated pin set) |
| `tests/console/design-system-scheduled-groups-primitives.test.ts` | 5/5 (second pin site flipped) |
| `tests/console/scheduled-tab.test.tsx` | 18/18 (consumer unchanged; close-button locator → `Close dialog`) |
| `tests/console/chat-picker.test.tsx` | 15/15 (Escape-layering proof retained; comment updated) |
| `tests/console/primitives-popover.test.tsx` | 36/36 (stack-contract proof retained; comment updated) |

Harness notes, honestly: vitest prints an oxc/esbuild option notice and a vitest-4
`poolOptions` deprecation — config noise, not test signal. Full-suite context: 10,148 green
at `76012b68` per the program record (not re-run here; this packet ran the wave-relevant files).

## Constraint-by-constraint verification (current code, absolute-path file:line)

| Constraint | Verdict | Evidence |
|---|---|---|
| **C-B3W2-1** `open` prop + always-mounted + reset-on-open | **PASS** | `console/src/components/line-detail/ConfigEditDialog.tsx:45,51` (required `open: boolean`), `:66-71` (reset effect clears `patch`/`customEnumFields` on open); `console/src/pages/LineDetail.tsx:304-311` (`{line.config && <ConfigEditDialog open={showConfigEditor} …>}` — mount-gate removed). Pinned: config tests 716 (open=false renders nothing), 754 (reset on reopen), 744 (Escape unbound when closed) |
| **C-B3W2-2** `dismissable=false` inverts tested backdrop-close on BOTH | **PASS** | `ConfigEditDialog.tsx:300`, `ScheduleComposerModal.tsx:204`; inverted pins: config test 681 "backdrop pointerdown does NOT dismiss (dismissable=false)", composer test 1033 (C-B3W2-2 named in the test); both assert the backdrop exists before asserting no-dismiss (not vacuous) |
| **C-B3W2-3** visual deltas at the live checkpoint | **PASS for the seg delta / INCONCLUSIVE-with-compensation for ConfigEditDialog** | see Visual/live-QA review — matrix rows 3 and 4 |
| **C-B3W2-4** seg = ToolbarTimeRange in a modal body, rename deferred to wave 3 | **VERIFIED, residue open** | `ScheduleComposerModal.tsx:231,314` consume `ToolbarTimeRange` with `label="Content type"`/`"Recurrence mode"`; wave 3 kept the name (added a `disabled` prop, `6500b7f3`) and adopted it for GroupDetailModal — the rename/extraction decision was never recorded as a register entry or ruling. Proposed below |
| **C-B3W2-5** bucket counts only fall, read off the regen | **PASS** | Baseline at `71d77108~1` vs `71d77108` (read from `console/lint-shadow-baseline.json` at each SHA): no-adhoc-modal config 2→absent, composer 2→absent; no-raw-button config 3→absent, composer 7→1; no-legacy-tokens composer 6→5, config 1→1 (predicted no-fall); no-raw-form-control 7/5 unchanged (predicted) — **all eight at exactly packet-§11 expected values**; total 563→533. Current baseline (post w3/w4/B4): total 486, `soup/no-adhoc-modal` has ZERO buckets repo-wide — only-fall held |
| **C-B3W2-6** restart-warning strip as fourth anatomy region | **PASS, spec-tension item still open** | `ConfigEditDialog.tsx:304-312`: strip is a direct shell child between `ModalHeader` (:302) and `ModalBody` (:313), `flex-shrink-0`, AlertTriangle kept, comment cites C-B3W2-6. The modal.md amendment proposal has not been filed — routed below |
| **C-B3W2-7** `getReactClickHandler` empty-patch save path | **PASS** | config test 553-567 'calls onClose through the empty-patch save path without invoking api' still reaches the Button primitive's `onClick` via `getReactClickHandler` (:57, :563) and passed in this packet's run — the Button primitive forwards `onClick` as the packet required verifying |

Token deletions re-verified at tip: `grep -rn "panel-config-edit|panel-composer|panel-max-inline-wide|modal-max-h-sm|modal-max-h-lg"` over `console/src` + `tests` returns only doc-comment mentions in the two dialog headers (and CreateGroupModal's header) — zero functional references, zero test pins, definitions gone from `console/src/styles/tokens.component.css`.

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Spec fidelity | **PASS** | modal.md anatomy (scrim>shell>head/body/foot) on both; `size="md"` per the tokens-v3 §6.12 sizing-law collapse — no new size, no override mechanism (the packet's falsified-95vw finding held: composer is 560px wide, not 95vw); `dismissable=false` per the form-dialog protective default; title typography via `ModalHeader` (legacy `c-heading-lg`/`font-sans font-semibold text-lg` gone); decorative header Clock dropped, functional AlertTriangle/footer icons kept (wave-1 convention); the one deliberate spec tension (fourth region) is explicit in code comment + C-B3W2-6 routing |
| Code quality | **PASS** | Both ad-hoc shells fully deleted (backdrop div, stopPropagation, hand-rolled aria wiring, composer's bubble-phase Escape effect and `if (!open) return null` gate); imports cleaned — composer's lucide imports reduced to `Clock` (`ScheduleComposerModal.tsx:25`; X/MessageSquare/FileText/RefreshCw/capitalize gone); stray empty `style={{ }}` dropped; both file headers document the wave's decisions with constraint IDs; lint-config guidance strings updated alongside the token deletions (`console/eslint.config.js` in `71d77108`) so the FIX hints never point at dead tokens |
| Test integrity | **PASS with one recorded gap** | Both assertion inversions trace to C-B3W2-2 (packet-sanctioned, named in test titles); zero skips/masking in this packet's run (0 pending, 0 todo); the integrity guard's post-wave audit (`45bd03ea`) strengthened two weak seg terminals to composition asserts and caught a real wrong assumption — evidence the audit lane works. Gap: the packet's planned per-dialog "focus restores to the opener" tests (§8 NEW lists, both suites) were NOT written — see omission audit |
| A11y / keyboard | **PASS** | Segs: `role="group"` + accessible label + exactly-one `aria-pressed` pinned for both pairs incl. exact button composition (composer tests 525-575); ConfigEditDialog gains Escape, focus trap, and focus restoration where it had none — first-ever Escape pins at config tests 734/744; initial focus lands inside the dialog on both (config 776, composer 203 — which also pins the §4.2 decision that ChatPicker's panel must NOT auto-open on modal open); close buttons uniformly `Close dialog` (Modal.tsx:175), consumer locator tightened in scheduled-tab. Trusted-event keyboard proof remains the D7 lane's property (since delivered — d7-evidence.md); per-dialog focus-restore pins missing (below) |
| Visual / live-QA | **PASS for the composer leg, environment-INCONCLUSIVE for ConfigEditDialog, with compensation** | `visual-qa-b-stages.md` **row 3**: composer Text/Media + Recurring/One-shot render as joined segs — PASS (C-B3W2-3's seg delta confirmed live; the same frame is the composer-on-Modal live confirmation). **Row 4**: ConfigEditDialog open-on-Modal — INCONCLUSIVE (environment): no mock line carries `config`, so the `{line.config && …}` gate never opens it against mock data. Compensating evidence per the matrix row: the shell is the same Modal primitive live-confirmed in rows 3/5/6, behavior is pinned by the 57-test jsdom suite (count matches this packet's run), and the fixture improvement is routed to C3. ConfigEditDialog's §2 visual deltas (80vh→85vh, 90%→law caps) therefore rest on token/code evidence + the shared-primitive frames, not a dialog-specific live frame — carried, not overclaimed |

## Omission audit

- **Planned tests not delivered:** "focus restores to the opener" (packet §8 NEW, both suites)
  exists in neither suite (grep: zero restoration asserts in either file). Compensating
  coverage: the restoration mechanism is pinned at the primitive level
  (`tests/console/primitives-modal.test.tsx`) and per-dialog in the wave-1 siblings
  (`relink-modal`, `save-contact-dialog`); the wiring that MAKES restoration reachable for
  ConfigEditDialog (always-mounted + `open`) is what C-B3W2-1's delivered pins cover. Still a
  gap against the packet's own plan — proposed as test debt below.
- **File-table deviations (§3 "added here before commit" rule not honored):**
  `console/eslint.config.js` (guidance strings) and `tests/console/scheduled-tab.test.tsx`
  (one locator) were touched without a packet addendum. Both benign and in-scope; recorded as
  process drift. Conversely `console/eslint.config.shadow.mjs` was named but needed no change
  (only the baseline JSON regenerates) — accurate, no drift.
- **One-commit landing** vs the §12 two-commit rollback plan (header table).
- Not touched, owned elsewhere (verified still true at tip): recurrence preset buttons stay raw
  `c-btn` (the composer's surviving no-raw-button bucket of 1 — P2 burn-down, not DD-15);
  `renderField`/composer field controls stay raw (form-control buckets 7/5 byte-stable across
  the wave, as the packet demanded); ChatPicker/TagInput internals (B2's); ConfigEditDialog's
  `text-t3` JSON-textarea legacy-token hit (predicted no-fall, confirmed).
- jsdom limits, labeled: the real-picker stacked-Escape interaction is not exercised in the
  composer suite (ChatPicker stubbed) — owned by `chat-picker.test.tsx` +
  `primitives-popover.test.tsx`, both green in this run; long-content behavior rides live QA;
  computed-box proof is D7's (delivered).
- `execution-log.md`'s wave-2 entry verdict reads "Inconclusive — committed; acceptance
  evidence packet outstanding." This packet is that outstanding evidence; the log flip is the
  integrator's write, not this packet's.

## Debt register delta — PROPOSAL ONLY (register not edited by this packet)

| Item | Proposed change |
|---|---|
| DD-15 composer leg | Confirm CLOSED by `71d77108` (both binary pairs on the canonical seg, aria contract pinned). Already absorbed into the register's 2026-06-12 narrowed DD-15 text — no further edit needed beyond citing this packet as the composer-leg evidence |
| DD-18r modal-sizing-SSOT leg | Record the leg's FIRST deletions: `--panel-config-edit`, `--modal-max-h-sm`, `--panel-composer`, `--panel-max-inline-wide`, `--modal-max-h-lg` deleted at `71d77108` with zero functional references (waves 3-4 continued at `d73bef54`/`061986ee`); re-audit the leg's remaining-text at B3 closeout |
| NEW (P3, component-naming) | C-B3W2-4 residue: `ToolbarTimeRange`/`soup-toolbar-seg` is now the canonical seg inside modal bodies across waves 2-3, and the deferred rename/extraction decision was never registered or ruled. Propose a register entry (owner: C3 component pass) or an explicit accepted-naming ruling |
| NEW (P3, test) | Per-dialog focus-restoration pins for ConfigEditDialog + ScheduleComposerModal (planned in packet §8, not delivered); owner: C3 LineDetail screen pass or the D7 follow-up suites |
| C-B3W2-6 routing | If the C3 live pass blesses the restart-warning strip, file the modal.md fourth-region amendment proposal it requires; until then the code comment + this packet are the record |

## Verdict: **PASS WITH DEFERRED DEBT** — all seven constraints verified against current code with 201/201 wave-relevant tests green and every ratchet bucket at packet-expected values; deferred: the seg-naming register entry, the missing per-dialog focus-restore pins, and ConfigEditDialog's live confirmation riding the C3 mock-`config` fixture (matrix row 4's compensated INCONCLUSIVE).
