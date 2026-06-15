# Slice Evidence — B2 (pickers and inputs)

Worktree `soup-impl`. Commits: `6c9f69ff` Popover primitive + useDismissable opt-outs ·
`7cfa1027` baseline accommodation · `8ca44a4f` LinePicker rebuild (DD-12) · `75f87e3a`
CardSelector radiogroup (DD-14) · `ede800e1` seg adoption + narrowing fix (DD-15) ·
`a13cdde3` TagInput→Pill (DD-13) · `2b0a9591` picker family + orphan deletion (DD-16) ·
plus tautology fix and cross-cutting pin updates (`d7b0aa31`). Gate packet:
`b2-investigation.md` (Ready with Constraints). Six origin merges during the slice incl.
the program's first conflict (Lock control — resolved as union, `2510c9ca`).

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Positive-path | **PASS** | lint · both typechecks · build · **2,073/2,073 tests** (+~150 net over pre-slice incl. 36 Popover + 24 LinePicker + 20 CardSelector + 22 TagInput + 17 ContactSearchPicker-new + 15 ChatPicker) · parity 101 · ratchet net fall w/ ten buckets eliminated · C-B2-1 regression obligation: 152/152 unchanged across modal/drawer/app/fleet/line-detail suites |
| Negative-path | **PASS** | Escape-layering defect (picker-in-dialog double-close) fixed BY CONSTRUCTION (capture-phase stack) and pinned by an ordering test against the simulated legacy handler; in-flight response after unmount discarded (error-spy proof); zero-option/clamp/no-active-Enter no-ops tested; orphan deletion verified by caller greps |
| Omission review | below | |
| Regression review | **PASS** | all picker/TagInput/CardSelector public props contracts preserved — zero caller edits beyond accessible labels; structural SearchInput pins satisfied untouched; two cross-cutting stale pins updated deliberately (dialog-compliance + preference seg) with legacy pins kept for unmigrated dialogs |
| Design-system conformance | **PASS** | select.md popover anatomy/keyboard contract; pill.md removable; WAI radiogroup; toolbar.md seg as THE time control (first two production adoptions); C-B2-3 chip-tint design verdict PASS (below) |

## Live checkpoint record (and its honest limits)

Five browser sessions were spent on this checkpoint; three died at context limits and
the harness proved UNRELIABLE FOR KEYBOARD QA (CDP dispatches keys globally without
focus discipline; eval context drifts across SPA navigation). What stands as live-proven:
- Ops LinePicker popover anatomy (shapes/names/badges) + light-theme legibility — PASS.
- C-B2-3 chip tint: **PASS** both themes (screenshots captured; ConfigEditDialog's
  violet variant unreachable — mock `line.config` null; same primitive/tone family).
- Two reported keyboard defects were investigated to mechanism: the first (ArrowDown "closes the
  composer") EXONERATED by captured DOM — with real focus on the input, ArrowDown sets
  the active option, aria-activedescendant updates, and the dialog stays open; the
  repro was the harness dispatching keys at a navigating element. The second (Enter not
  committing) carries the same fingerprint, its React path is pinned by the jsdom suite
  ("Down + Enter selects the first result"), and its only failing observations came
  from sessions with proven focus indiscipline.
- DISPOSITION: real-browser trusted-event keyboard proof for the pickers is
  **INCONCLUSIVE under this harness and formally DEFERRED TO D7** (playwright trusted
  events with deterministic focus — d7-investigation.md is staged and GO). This is a
  recorded deferral, not a pass.

## Omission audit

- Not touched: form-kit promotion (input.md DUP-12 — own sub-slice), wizard tablists
  (B3 scope), GroupDetailModal internals, native select skins.
- DD-15 NARROWS, not closes: ToolbarTimeRange now owns both time-range segs; remaining
  binary c-btn toggle pairs live in B3-owned dialogs (GroupDetailModal/ScheduleComposer).
- The accent-vs-per-wizard chip tint is a deliberate visual change (C-B2-3, accepted).
- verify:push:branch is RED on main-side fitness-ring findings in five server files
  byte-identical to origin/main — a push-gate dependency owned by the server lane,
  tracked, not a SOUP regression.

## Debt register delta

| ID | Change |
|---|---|
| DD-12 | **CLOSED** — LinePicker combobox contract live (jsdom-proven; D7 confirms trusted-event) |
| DD-13 | **CLOSED** — TagInput chips via removable Pill, labeled removes |
| DD-14 | **CLOSED** — CardSelector radiogroup w/ WAI arrow-selection |
| DD-16 | **CLOSED** — one picker pattern on Popover; orphan ContactSearch + test + sole-consumer token deleted |
| DD-15 | **NARROWED** — canonical seg adopted ×2; remainder = B3 dialog toggle pairs |

## Verdict: **PASS WITH DEFERRED PROOF** — all contracts implemented, tested, and visually verified; trusted-event keyboard confirmation rides D7 by recorded disposition.
