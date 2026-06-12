# Slice Evidence — B3 wave 1 (Modal prep + SaveContact / Relink / CreateGroup)

Worktree `soup-impl`. Commits: `41952604` Modal size tokens --modal-w-sm/md/lg +
additive initialFocus (DD-18r sizing-SSOT leg STARTED) · `7585eb8f` SaveContactDialog
extracted from Inbox (dismissable=false) · `7e5c9399` RelinkModal (dismissable=true) ·
`0064d8ad` CreateGroupModal (dismissable=false, inverted backdrop assertion). Gate
packet: `b3-wave1-investigation.md` (Ready with Constraints — its corrections to the
survey held: SaveContact HAD Escape; Modal size classes never consumed --panel-*).

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Positive-path | **PASS** | dialog suite 93→117 tests (+24); full battery green at every commit point; Modal initialFocus regression: primitives-modal 25→27 with defaults unchanged |
| Negative-path | **PASS** | backdrop-click DESTRUCTION removed on both form dialogs (deliberate inversions, pinned); Escape single-fire via the stack replaces three hand-rolled handlers; stacked-confirm ordering unchanged |
| Omission review | below | |
| Regression review | **PASS** | every test change justified old→new→why (portal queries, auto-generated label ids, Close-dialog names, pointerdown semantics); app.test unchanged 22/22 |
| Design-system conformance | **PASS** | modal.md anatomy; Escape-cancels law; per-dialog dismissable decisions from the packet implemented exactly |

## Live checkpoint record

Salvaged from the (context-killed) dialog QA session — all observed live, dark theme:
CreateGroup focus-in-subject PASS · CreateGroup backdrop-inert PASS · CreateGroup Escape
PASS · SaveContact focus PASS · backdrop-inert PASS · Escape PASS · field-reset-on-reopen
PASS · Relink backdrop-closes PASS · Relink Escape PASS. One ambiguous observation —
Relink appearing to auto-close once during an auth-error render — dispositioned:
LinkStep's SSE/auth behavior is UNTOUCHED by this slice (shell-only migration); the
behavior pre-exists and belongs to the Relink/LinkStep surface backlog if real.
Relink focus-restore-to-opener: jsdom-pinned; live confirmation lost to harness limits —
rides the D7 deferral with the picker keyboard checks.

## Omission / deltas

- Widths: SaveContact/Relink 420→480, CreateGroup 540→560 + 85vh — tokens-v3 §6.12
  disposition; live screenshots show no broken layouts.
- --panel-confirm consumers 3→1, --panel-composer 2→1; tokens die fully with waves 2–3.
- Remaining waves: 2 (ConfigEditDialog, ScheduleComposerModal) · 3 (UpdateModal,
  GroupDetailModal + its tablist) · 4 (AddLineWizard, needs the Stepper decision).
- Modal initialFocus (C-B3W1-1) shipped additively — Drawer/Modal defaults untouched.

## Verdict: **PASS.**
