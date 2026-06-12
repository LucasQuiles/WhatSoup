# Slice Evidence — C2.3 (Table / Toolbar / LogStream / Drawer + Fleet pilot)

Worktree `soup-impl`. Eight code commits: `701a7ff7` (Table+Toolbar primitives, 62 tests),
`1d27f116` (LogStream+Drawer primitives, 45 tests), `33a3788b` (LogsTab+Ops LogStream
adoption), `1f9bde39` (Fleet pilot migration, 15 new page tests), `a24d09e5` (enforcement),
`682558f7` (live-QA D2+D3 fixes), `311b3c9a` (structural TableRow ref type for dual
@types/react identity), `d451262c` + `85707997` (Fleet stacking/short-height fixes from QA
rounds 2–3), plus assertion-hardening `0ff73055`. Investigation packet (binding pre-work):
`c2-3-investigation.md` @ `bfe42920`, verdict Ready with Constraints. origin/main merged
three times during the slice (66d2760f fitness ring; #743/#744; #745/#746 dep bumps) —
zero conflicts with slice files; full battery re-run after each.

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Positive-path | **PASS** | lint clean · typecheck clean (console AND repo `typecheck:all`) · build green · **1,878/1,878 tests** (124 files; +125 over pre-slice) · parity 101 · ratchet **614→602** · `verify:push:branch` PASS end-to-end · live browser QA (3 rounds, both themes): toolbar anatomy, shape-law status cells, keyboard sort with aria-sort, 28px compressed rows, severity washes + 2px edges, drawer squeeze/retarget/Escape, log surfaces |
| Negative-path | **PASS** | unknown-status fail-visible unchanged; drawer missing-entity renders "Line not found" + Close (tested); Escape on stacked drawer+modal closes modal first (tested); filtered-empty log copy live-verified ("No warn logs."); zero-row table empty state tested; LogStream error state + Retry tested |
| Omission review | below | |
| Regression review | **PASS** | LogsTab public props contract (`logs/filter/onFilterChange`) preserved — parent untouched; Ops filter mechanics unchanged; KPI/chart/alert/feed behavior preserved; every soup-kitchen test change justified in-table (nav→drawer law, th-click→sort-button, column reorder); sort behavior deliberately changed legacy default-desc → spec asc/desc/none cycle (table.md authority) |
| Design-system conformance | **PASS** | frontend-design checkpoints at A0 (pre-impl, in investigation packet), table/log visual QA, drawer review, responsive review, pre-acceptance (QA round 3); v2 Blend fidelity confirmed live: "disciplined, dense operator console… no generic-SaaS drift… restrained motion" (QA round 1 §F) |

## Adoption proof (the point of this slice)

- Fleet renders via Table/Toolbar/Drawer primitives; LogsTab + Ops render via LogStream.
- Greps at final tree: raw `<table>` outside primitives = **0** · `th onClick` = **0** ·
  `--sk-col-*`/`--log-col-*` = **0** (tokens deleted) · three new shadow tripwires
  (raw sortable th, raw table, legacy log lanes) fire **0** console-wide and each was
  proven non-vacuous against a probe fixture before landing.
- Sort: real `<button>` in `<th>`, click/Enter, `aria-sort` cycle (tested both paths).
- Rows: focusable, Enter activates, severity wash + 2px inset edge, `aria-current` on the
  drawer's originating row (all tested; live-verified both themes).
- Drawer law: squeeze (flex sibling, no scrim) at ≥900px container / overlay+scrim below —
  live-measured flip at ~1050px viewport = 900px container exactly as designed. The spec's
  1080px figure was amended to 900px (drawer.md C2.3 amendment block) because it assumed a
  full-width container; Fleet's container shares the viewport with the activity feed
  (1044px @ 1440 window) and 1080 produced overlay on desktop, contradicting the rule's
  own intent (QA finding D2).
- Focus law: open → close-X; close → originating row; **close-after-retarget → CURRENT
  row** via the new `restoreFocus` override on useDismissable (QA finding D3; hook-level +
  page-level regression tests; live-verified).
- Navigation law: row activation opens the drawer (drill-in preserving list context);
  full LineDetail navigation moved to the drawer's explicit "Open line" action (tested;
  live-verified — the QA round-1 "LineDetail crash" was a harness artifact: the dev server
  had been piped through `head` and died on output; module serves 200 and loads fine).

## Live QA matrix (browser, mock fleet of 8 lines, all statuses)

| Surface / viewport | Dark | Light |
|---|---|---|
| Fleet toolbar anatomy + counts | PASS | PASS |
| Status shapes + labels, mode badges | PASS | PASS (contrast verified by computed styles) |
| Severity washes + edges | PASS | PASS |
| Keyboard: sort buttons, row focus ring, Enter | PASS | — (theme-independent) |
| Drawer squeeze @1440×900 (table 1042→684px, no scrim) | PASS | PASS |
| Drawer retarget + Escape + focus-to-current-row | PASS | — |
| 1280×800 (squeeze, 924px container) | PASS | — |
| 1024×768 / 768×1024 (overlay+scrim; toolbar wraps gracefully @768) | PASS | — |
| 390×844 (panes stack full-width, page scrolls, overlay drawer, KPI 2-col) | PASS (after `d451262c`) | spot-PASS |
| 1440×500 short-height (480px min pane, page scrolls, sticky thead) | PASS (after `85707997`) | — |
| Ops log pane: 4-lane grid, letter chips, pill filters w/ counts | PASS | PASS |
| LineDetail Logs tab: same + filtered-empty copy | PASS | PASS |
| No page-level horizontal overflow (all viewports) | PASS | — |

Notes: drawer scrim in overlay mode is scoped to the host frame (not full-viewport) —
this matches drawer.md ("scrim over the covered content"; non-modal inspector), recorded
as intended behavior. Chart expansion has no dedicated button — it is driven by KPI-card
clicks; its layout transition was deleted (`.c-chart-expand-col` now opacity-only), so
expand/collapse snaps per motion law (static proof; interaction pre-dates this slice).
Toolbar wrap at 768px costs ~32px height (P3, acceptable, recorded).

## Omission audit

- Not touched: Inbox (DD-17/DD-18r), LineDetail buttons/tabs (B1, DD-21r), pickers
  (DD-12/16), legacy dialogs (B3), MessageBubble, ActivityFeed internals, feed tone maps,
  charts beyond the transition fix, framer-motion entry fades (DD-20), protocol surfaces.
- `role="toolbar"` is used without WAI roving-tabindex arrow navigation — plain Tab order
  through controls. Recorded as a known deviation to assess in the a11y final QA (D7);
  if arrow-key navigation is mandated, it lands with the Tabs/keyboard slice.
- Column-drop order (C-1): resolved as identity-columns-never-drop + governed table
  x-scroll as the squeeze valve (content-sized columns; no per-column hide CSS this
  slice). Mapped order recorded in `1f9bde39`'s message and the drawer spec note.
- jsdom limits named honestly: container-query flip, computed boxes (DD-10), visual focus
  ring, CSS wrap — all class-contract assertions only, proven by live QA instead;
  deterministic viewport tests remain D7.
- Live-tail: poll-refresh append only; no streaming source exists (use-fleet.ts polls 3s).
  Virtualization deferred → **DD-22**.

## Enforcement delta

Shadow baseline **614 → 602** (rule×file buckets; Fleet legacy classes left the codebase;
new tripwire selectors contribute zero). Design-regression: 16 checks (new check 16 pins
zero legacy lane vars), **9 PASS / 7 WARN, report-only** — the 7 warns are pre-existing
burn-down counters (legacy tokens/buttons on unmigrated surfaces), unchanged in kind.
Test-integrity: 5 weak terminal assertions found by `verify:push:branch` were strengthened
(`0ff73055`), guard now clean with zero new findings.

## Debt register delta

| ID | Change |
|---|---|
| DD-18 Fleet legs | **CLOSED** (KPI wrap, chart stacking + layout-animation removal, table squeeze, log wrap, Fleet side-panel law, pane stacking + short-window scroll) — register row split; remainder lives as **DD-18r** |
| DD-21 Fleet table half | **CLOSED** (sort buttons + keyboard rows) — remainder lives as **DD-21r** (tablists, B1) |
| DD-22 | **NEW** — LogStream virtualization/live-tail deferred until a streaming log source exists (P3, non-blocking) |

## Verdict: **PASS.** Next slice: B1 (LineDetail — raw buttons, tabs keyboard DD-21r, header overflow DD-18r leg, SummaryTab health map DD-11).
