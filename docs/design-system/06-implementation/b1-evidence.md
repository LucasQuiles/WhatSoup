# Slice Evidence — B1 (LineDetail: Tabs / header buttons / overflow / DD-11)

Worktree `soup-impl`. Commits: `048a26f7` CONNECTION_MAP fold (DD-11) · `d7feb2a4` Tabs
primitive · `3f4e4d0b` LineDetail tablist migration · `92deece2` header Button/ActionButton
+ truncation · `883a13b4` live-QA responsive fixes · `2121ad34` ratchet regen 602→594.
Gate packet: `b1-investigation.md` (Ready with Constraints). Task plan: worktree-local
`docs/superpowers/plans/2026-06-12-soup-b1-linedetail.md` (subagent-driven, one commit per
task). origin/main merged at Gate 0 and twice mid-slice (zero console overlap each time).

## Five reviews

| Review | Verdict | Evidence |
|---|---|---|
| Positive-path | **PASS** | lint · console + repo typecheck · build · **1,904/1,904 tests** (126 files; +16 over pre-slice) · parity 101 · ratchet **602→594** · `verify:push:branch` PASS · live browser QA (4 measurement rounds, both themes) |
| Negative-path | **PASS** | disabled tab: aria-disabled, arrow-reachable, not selectable, reason via aria-describedby (tested); unknown connection state fail-visible (raw value + neutral ink, tested); focus-alone never switches panels (tested + live); Escape/stacking untouched (Drawer/Modal suites still green) |
| Omission review | below | |
| Regression review | **PASS** | LineDetail behavior preserved (same tabs, same actions, same panel mounting); no existing test pinned the removed mode-color underline or old tab classes; summary-tab tests unaffected by the connection fold (none pinned the old ink); plan's /Restart/ selector collision fixed with exact-name queries (justified — a tab panel renders "Restart Instance") |
| Design-system conformance | **PASS** | tabs.md anatomy/keyboard/manual-activation exact; underline = `--accent` (the mode-colored treatment was the spec's named anti-pattern); button.md §variants drives the Delete choice; frontend-design verdicts recorded below |

## Contract proof

- **Tabs primitive** (`primitives/Tabs.tsx`): roving tabindex (selected only in tab
  order), ArrowLeft/Right with wrap, Home/End, Enter/Space manual activation, tablist
  label, aria-controls/labelledby wiring, hidden-attr panels, disabled-with-reason.
  6 primitive tests + 7 page tests + 2 header tests. Live-verified at 1440×900 incl.
  wrap-at-ends and focus-vs-selection separation.
- **LineDetail adoption**: bar replaced (38→10 lines); 9 tabs MCP / 7 otherwise — real
  condition is `passive || (agent && !sandboxPerChat)` (packet's guess corrected and
  pinned by three fixtures); conditional panel mounting kept with correct tabpanel aria.
- **DD-11**: `CONNECTION_MAP`/`resolveConnection` in status-map (fail-visible); SummaryTab
  consumes it. Deliberate change: `disconnected` ink neutral→crit (a disconnected line is
  a problem), pinned by test.
- **Header**: back = ActionButton (reveal-label, live-verified); Re-link/Restart = ghost;
  **Delete = `danger` variant** — button.md maps danger to destructive (crit-wash fill,
  not solid); the legacy ghost+manual-crit-ink was the anti-pattern. **C-B1-1 resolved by
  live design review: "sits calmly in the header… communicates danger without
  dominating"** (both themes).

## Live QA matrix (4 rounds, mock fleet)

| Check | Result |
|---|---|
| 9/7 tab counts, accent underline 2px, instant switch (dark+light) | PASS |
| Keyboard: roving tabindex, arrows+wrap, Home/End, Enter-activates, focus ring | PASS |
| Header anatomy + degraded line (amber diamond + label, both themes) | PASS |
| 1440×500 short-height usable; log panel scrolls | PASS |
| 768×1024: meta hidden, nothing clipped | PASS after fix (md→**lg** threshold — Tailwind md fires AT 768) |
| 390×844: no viewport overflow; actions wrap; tab bar x-scrolls in place | PASS after fix (`flex-wrap md:flex-nowrap`) |
| 390×844: line name visible at full word width | PASS after THREE-stage fix — see below |
| 1440×900 desktop layout unchanged after all fixes | PASS (single row, h1 570px) |

**The name-collapse chase (recorded as a lesson):** truncation classes were present and
unit-asserted from the start, yet the name rendered at 12px. Stage 1: heartbeat strip ate
row width (hidden below md — meta-tier). Stage 2: name-row siblings squeezed the h1
(row wraps + h1 flex-1). Stage 3 (root cause): the identity COLUMN's own `min-w-0` told
flex it could collapse to zero, so the action buttons never wrapped. Fix: tokenized
`--header-identity-min: 160px` floor. Final measurements: identity 207px, h1 93px
("personal" fully visible), Delete right edge 212 ≤ 390, scrollWidth 390. Class-contract
tests cannot see flex allocation — only live measurement caught this; it is the
standing argument for the binding live checkpoint and for D7 computed-box tests.

## Omission audit

- Not touched: ConfigStep/ModelAuthStep/GroupDetailModal tablists (DD-21r remainder,
  B2/B3 owners); wizard surfaces; pickers; MetricsTab/HistoryTab internals; protocol.
- **D3 disposition:** SummaryTab ACTIONS sidebar still uses legacy `c-btn` (low contrast
  in dark) — outside this slice's header/tabs scope, counted by the existing
  `soup/no-raw-button` + legacy-token ratchet buckets, burns down with the SummaryTab
  leg of the per-surface migrations. Not new debt; already-tracked.
- Ratchet note: status-map.ts gained a 2-count legacy-ink bucket — RELOCATED literals
  from SummaryTab's deleted ternary, documented interim in `ConnectionEntry`'s doc
  (these surfaces move to semantic ink with the legacy-token slice). Total still fell 8.
- jsdom limits: flex allocation, scroll behavior, computed underline — class contracts
  only (labeled), proven live instead; D7 owns deterministic proof.
- Plan deviation: sort/regex test selectors tightened to exact names (collision with a
  panel's "Restart Instance" button); breakpoint spec tightened md→lg per live QA.

## Debt register delta

| ID | Change |
|---|---|
| DD-11 | **CLOSED** — connection taxonomy lives in status-map, tested, consumed |
| DD-21r LineDetail leg | **CLOSED** — keyboard tablist live; remainder (wizard/modal tablists) stays DD-21r with B2/B3 owners |
| DD-18r LineDetail header/tabs leg | **CLOSED** — truncation + wrap + identity floor + governed tab x-scroll, live-measured at 390/768/1440×500; remainder (Inbox collapse, modal sizing, nav pressure, MessageBubble, D7 tests) stays DD-18r |

## Verdict: **PASS.** Next: B2 (pickers/inputs — Popover primitive net-new, LinePicker/ChatPicker/ContactSearchPicker rebuilds, TagInput→Pill, CardSelector radiogroup, ToolbarTimeRange first adoption; survey at `b2-survey.md`) with its own A0 packet.
