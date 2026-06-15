# B1 Investigation Packet — LineDetail slice (Tabs / buttons / overflow / DD-11)

Pre-implementation packet required by the working checklist (A0 gate). Implementation is
blocked until this packet carries a `Ready` or `Ready with Constraints` verdict.
Companion task plan: `docs/superpowers/plans/2026-06-12-soup-b1-linedetail.md` (worktree-
local working artifact). Targets: DD-11 (connection map), DD-21r LineDetail leg (tablist
keyboard), DD-18r LineDetail leg (header/tabs overflow), 5 raw buttons.

## 1. Gate 0 output

Worktree `soup-impl`, branch `feat/soup-v3-foundation`, clean; origin/main advanced one
commit (#750, zero console files), merged → ahead 60 / behind 0; post-merge: lint clean,
1,888/1,888 tests. Worktree inventory unchanged from C2.3 acceptance (soup-design = docs
SSOT; all other worktrees UNRELATED lanes). No agent worktrees.

## 2. frontend-design pre-implementation checkpoint

- Tabs anatomy per tabs.md: hairline baseline rule, label-tier type, 2px `--accent`
  underline on the selected tab. **Visual change recorded:** LineDetail's current
  mode-colored underline is a tabs.md anti-pattern ("custom underline treatments") and
  becomes the accent underline. PASS (spec-driven).
- Header rhythm: ActionButton back affordance + ghost actions keep the header quiet;
  Delete treatment (danger vs ghost-danger) is decided against button.md at the Task 5
  live checkpoint — flagged, not guessed. INCONCLUSIVE until live review.
- Both themes ride semantic tokens; tabs add no new tokens. PASS pending live review.
- Density: tab row stays one line with a governed x-scroll valve (no wrap) — consistent
  with the table region's governed-overflow idiom. PASS (design intent).

## 3. Files inspected and classification

| File | Class | Current invariant | B1 invariant | Changes? |
|---|---|---|---|---|
| `console/src/pages/LineDetail.tsx` (351 ln) | consumer | hand-rolled tablist (role attrs present, NO keyboard, mode-color underline), 5 raw buttons, no truncation/overflow handling | Tabs primitive bar; Button/ActionButton header; truncate + governed scroll | YES (Tasks 3–4) |
| `console/src/components/line-detail/SummaryTab.tsx` | consumer | inline connection ternary (line 38) duplicates status taxonomy | consumes `resolveConnection` from status-map | YES (Task 1) |
| `console/src/lib/status-map.ts` | producer | single status/mode rendering driver | + CONNECTION_MAP / resolveConnection (fail-visible) | YES (Task 1) |
| `console/src/components/primitives/{Button,ActionButton}.tsx` | producer | 6×3 Button w/ `icon`/`iconEnd`, icon-only⇒aria-label; ActionButton `label` required | unchanged — consumed | NO |
| `console/src/components/primitives/index.ts` | producer (barrel) | exports through Drawer/LogStream | + Tabs, Tab, TabPanel | YES (Task 2) |
| `console/src/styles/primitives.css` | producer | soup-* bands through drawer | + `soup-tabs*` band | YES (Task 2) |
| `tests/console/summary-tab.test.tsx` (290 ln) | fixture/consumer | KPI card assertions incl. CONNECTION colors | updated if it pinned old `disconnected` ink | MAYBE (Task 1) |
| `tests/console/line-detail-history-metrics.test.ts` | evidence | structural barrel assertions only | unchanged | NO |
| `tests/console/{badge-components,primitives-*}.test.tsx` | evidence | primitive contracts | badge file gains CONNECTION_MAP block; new primitives-tabs + line-detail-tabs files | YES (additive) |
| `docs/design-system/03-spec/components/{tabs,button}.md` | spec | normative | unchanged | NO |
| `console/{eslint.config.shadow.mjs,lint-shadow-baseline.json}` | enforcement | ratchet 602 | baseline regen at Task 6 — LineDetail buckets must FALL | YES (Task 6) |

**Exact new files:** `primitives/Tabs.tsx`, `tests/console/primitives-tabs.test.tsx`,
`tests/console/line-detail-tabs.test.tsx`, `b1-evidence.md`, this packet. Any file beyond
this table is added here before commit.

## 4. Patterns to replace

Hand-rolled tablist (zero keyboard handling — no roving tabindex, no arrows/Home/End);
mode-colored underline (anti-pattern → `--accent`); raw back button + 3 `c-btn` ghost
actions; inline connection-state ternary; un-truncated h1/phone/meta; tab row with no
overflow valve (wraps/overflows at narrow widths).

## 5. Fixture and data review

`makeLine` factories exist in summary-tab and soup-kitchen tests (per-file, no shared
module — convention kept). **Gap:** no page-level LineDetail render harness exists
anywhere (current tests are structural import checks only) — Task 3 builds one by
copying the soup-kitchen hoisted-mock pattern; `useParams` must yield the line name and
every `use-fleet` hook the page calls gets a stub (discoverable from the page's imports:
useLine, useChats, useMessages, useLogs, useAccess + use-metrics). Long-name fixture
(40+ chars) required for the truncation contract. MCP-capable line fixture (mode agent)
required for the 9-tab case.

## 6. Reliability answers

1. Active tab id vanishes (MCP tabs toggle off while `scheduled` active) → selection
   falls back to `summary`; guard in page state derivation → code + test if cheap,
   else documented rule in the evidence packet.
2. Arrow at list ends → wraps (tabs.md) → code + test.
3. Enter/click on disabled tab → no-op; reason exposed via aria-describedby → code + test.
4. Focus alone must not switch panels (9 data-loading panels; manual activation) →
   code + test.
5. Panel data errors stay panel-level (existing per-tab error handling unchanged) →
   non-goal this slice.
6. Reduced motion → tabs are instant by construction (no transitions added) → code.
7. Very long tab labels / narrow widths → nowrap + governed x-scroll, focus-visible ring
   stays visible inside scroll region → code + manual QA (Task 5).

## 7. Responsive decision note

Header: identity block `min-w-0` + h1 `truncate`; meta spans `hidden md:flex`; action
buttons keep fixed intrinsic width (they are the last flex children and short). Tab row:
single-line, `overflow-x: auto`, scrollbar hidden — an intentional scroll region per the
layout-density governed-overflow idiom (tabs.md is silent on overflow; this
interpretation is recorded here, mirroring the table region's valve). No page-level
horizontal overflow at 390/768/1024/1280/1440. jsdom cannot prove scroll/truncation
boxes — class contracts + Task 5 live QA; computed proof remains D7.

## 8. Targeted test plan

Per plan Tasks 1–4: CONNECTION_MAP values + fail-visible resolve; Tabs roles/aria wiring;
roving tabindex (selected only in tab order); ArrowRight moves focus without selecting;
Enter selects; Home/End; wrap at ends; disabled-with-reason; hidden attr on unselected
TabPanels; LineDetail 7/9 tab counts; page-level keyboard activation; accent-underline
and soup-tabs class contracts (labeled class-only); header button roles/names/classes;
h1 truncate contract. Weak-terminal-assertion rule honored (end on value/attribute
asserts).

## 9. Observability plan

Accessible state only (`aria-selected`, `aria-disabled`, `aria-describedby`, roving
`tabIndex`); no `console.*`; no new data attributes needed (role queries suffice).

## 10. Enforcement plan

No new shadow selectors this slice (raw-button and legacy-class counters already cover
the migrated patterns; tab-specific lint would be premature with three unmigrated
tablists remaining). Task 6 regenerates the baseline — LineDetail buckets
(`soup/no-raw-button :: src/pages/LineDetail.tsx`, legacy token classes) must FALL;
any rise is a regression to fix, never a bump.

## 11. Rollback strategy

One commit per task (map fold · primitive · tablist migration · header), each
independently revertible; no cross-commit coupling. The Tabs primitive commit is purely
additive.

## 12. Debt register deltas planned

Close at acceptance with proof: DD-11; DD-21r LineDetail leg (remainder = ConfigStep +
ModelAuthStep + GroupDetailModal tablists, owners B2/B3); DD-18r LineDetail header/tabs
leg. New debt: none anticipated; anything discovered lands as a DD entry, not prose.

## 13. Constraints / open items

- **C-B1-1:** Delete button treatment (solid `danger` vs ghost-danger per button.md) —
  resolved at the Task 5 frontend-design checkpoint; both options coded in the plan.
- **C-B1-2:** tabs.md has no overflow rule — governed x-scroll interpretation recorded
  (§7); spec note can be added at evidence time if the checkpoint confirms it.
- **C-B1-3:** `disconnected` connection ink changes neutral→crit (taxonomy correctness);
  recorded as a deliberate behavior change for the evidence packet.

## 14. Strong-claim audit

This packet's absolutes are spec-cited or test-planned; "the ONE tablist mechanic"
claim in Tabs.tsx is true only for migrated surfaces until B2/B3 land — the header
comment must say tabs.md-canonical, with the three remaining sites tracked in the
register (checked at Task 6's diff audit).

## Verdict: **Ready with Constraints** (C-B1-1 resolved at live checkpoint; C-B1-2/3 documented). Implementation may begin.
