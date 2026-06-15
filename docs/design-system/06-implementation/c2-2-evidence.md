# Slice Evidence — C2.2 (Pill + Modal/useDismissable) + oversight waves 5–7

Worktree `soup-impl`, commit `59ceeb4f`. Closes DD-7 (modal focus restoration). The implementing
agent died at its context limit after writing all files; the integrator verified, then remediated
the wave-6 findings against the uncommitted work before landing — no defective intermediate commit
exists. Worktree-sprawl risk closed earlier this session (3 superseded agent worktrees verified
zero-unique-commits and removed with operator approval).

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Positive-path | **PASS** | lint clean · build green · **1,736/1,736 tests** (117 files; +62) · parity 101 · baseline ratcheted **635→614** · live: "?" opens migrated shortcuts modal with `aria-labelledby` resolving to "Keyboard Shortcuts", focus enters dialog, Escape closes single-fire |
| Negative-path | **PASS (scoped)** | stacked modals: one Escape closes only the top (tested + stack-aware outside-click); KSH previously had NO Escape despite its copy — real bug fixed by migration; backdrop click closes only when `dismissable`; unknown-status fail-visible unchanged |
| Omission review | below | |
| Regression review | **PASS** | FilterPill/ConfirmDialog/KSH public contracts preserved; zero-count badge omission contract pinned; LogsTab error/warn toning preserved through the sanctioned `tone` mechanism (not silently dropped); test updates each justified (helper topology, soup-pill class contract, delegation pin) |
| Design-system conformance | **PASS** | pill.md tone×size×variant; modal.md anatomy + scrim token + sizes; label-then-count order per v2 control sheet; one reveal-label mechanic reused (remove button = ActionButton) |

## Wave-5 (14) and wave-6 (16) dispositions — fixed this slice

- Modal `aria-labelledby` default path **FIXED** (title-id context; verified resolving live).
- ConfirmDialog invariant contradiction **RESOLVED by correcting the doc**: Escape/X always available —
  they CANCEL (safe action, WAI dialog pattern); `dismissable` governs outside-click only. Durable note
  in use-dismissable + ConfirmDialog headers.
- Outside-click now stacking-aware (topmost-only, same stack as Escape).
- FilterPill legacy `activeColor` strings now MAP to Pill tones (crit/warn/ok/mode channels) — semantic
  toning preserved at Ops/ActivityFeed/LogsTab/SoupKitchen callers until each migrates to `tone`.
- sm interactive pill: visual 20px + invisible expanded hit area to the 24px floor (pseudo-element).
- Counts reach assistive tech via `aria-describedby` → aria-hidden badge (name stays = label).
- Barrel imports enforced (PillTone exported; ConfirmDialog/KSH/FilterPill import from barrel).
- `color-scheme: dark/light` added per theme scope; forced `colorScheme:'dark'` removed from the
  datetime input (light-parity violation gone).
- StatusDot double-announce (wave-5.6): shape `role="img"` + visible label — accepted as-is for now;
  flagged for the StatusCell polish pass (DD-12 note) rather than churning the fresh primitive twice.
- ActionButton aria-label spread order, --status-shape-size token, barrel bypass in wrappers (wave-5
  7/8/9): folded into this slice's files where touched; remaining instances tracked by ratchet.

## Wave-7 responsive audit — quick fixes + scheduled backlog

Fixed now: AddLineWizard `min-w` defeating `max-w` (P1, removed); App shell `h-screen`→`h-dvh`;
`transition: all` on KPI hover → transform/box-shadow only.
Scheduled (the **responsive hardening backlog**, owned by the per-surface C2/C3 slices and pinned
in the debt register): Fleet KPI/chart/table stacking + table squeeze (Table/Toolbar slice),
Inbox three-pane collapse path (Inbox slice), LineDetail header/tabs overflow (LineDetail slice),
modal sizing SSOT for legacy dialogs (their Modal migrations), nav width-pressure beyond label
hiding, log column wrap policy (LogStream slice), MessageBubble hover-card positioning,
fixed side-panel law (drawer slice), chart-expand layout transitions, deterministic viewport tests
(D7). Responsive status remains **INCONCLUSIVE** until that backlog lands — recorded, not claimed.

## Debt register delta
| ID | Change |
|---|---|
| DD-7 | **CLOSED** — focus trap + restoration + stacking law live and tested |
| DD-12..17 | **NEW**: LinePicker combobox semantics; TagInput → removable Pill; CardSelector radio-group; segmented-control primitive; search-picker family combobox; Inbox listbox arrow-nav. (Wave-5/6 structural items, each owned by a named upcoming slice) |
| DD-18 | **NEW**: responsive hardening backlog (wave-7 P1/P2 items, per-surface) |

## Verdict: **PASS**. Next: Table/Toolbar/LogStream primitives + Drawer (squeeze rule), converging on the Fleet pilot rehearsal (dense leg), with the responsive backlog landing per-surface.
