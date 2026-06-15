# C2.3 Investigation Packet — Table / Toolbar / LogStream / Drawer adoption slice

Pre-implementation packet required by the working checklist (A0). Implementation is
blocked until this packet carries a `Ready` or `Ready with Constraints` verdict.
Pilot surface: Fleet (`console/src/pages/SoupKitchen.tsx`). Absorbs DD-21 and the Fleet
legs of DD-18. Out of scope: Inbox, LineDetail buttons/tabs, pickers, legacy dialogs.

## 1. Gate 0 output (source-of-truth preflight)

- Worktree `soup-impl`, branch `feat/soup-v3-foundation`, tree clean.
- origin/main advanced by one commit since the prior snapshot (`66d2760f`, eslint
  fitness ring, zero `console/` files); merged → now **ahead 39 / behind 0**.
- Post-merge verification: lint clean, **1,753/1,753 tests** (120 files).
- Worktree inventory: `soup-design` = docs SSOT (zero unique commits, fully merged);
  main checkout + ff038-eslint-ring / eslint-ring-rebase / credential-write /
  infra-audit-fixnow / ring-boundaries / systemd-unit-reconciliation / tmp g10 checkout
  = UNRELATED lanes, never used for acceptance. No agent worktrees remain.
- New fact superseding a T7 finding: `eslint-rules/index.mjs` now EXISTS at repo root
  (fitness ring from the merged commit). It is a repo-level quality ring, SEPARATE
  DOMAIN from the console design shadow lint; C2.3 must not modify it.

## 2. frontend-design pre-implementation checkpoint

Planned anatomy reviewed against the locked v2 Blend (`02-directions/iterations/v2.html`)
and the four component specs. Checkpoint answers:

- **Dense but not cramped:** compressed 28px rows with `--type-data-sm` lanes match the
  v2 dense leg; KPI strip and charts stay above the table; toolbar is 28px controls so
  the control band does not visually outweigh data rows. PASS (design intent).
- **Calm industrial rhythm:** hairline rules, surface ladder raised→inset, overline
  headers, no new chrome. The drawer head reuses status shape + title + mode badge —
  no new visual vocabulary introduced. PASS.
- **No generic SaaS drift:** no card-ification of the table, no floating action
  buttons, no avatar/gradient idioms; the toolbar anatomy is the C-graft pattern locked
  at G1. PASS.
- **Drawer = operator inspector:** kv block + remedy actions + scoped last-N log mirrors
  the v2 drill-in specimen; squeeze (not obscure) is the law on wide containers. PASS.
- **Both themes:** all surfaces use semantic tokens only; the level tags and severity
  washes already have per-theme values from C1. Verify live in both themes at QA. PASS
  (pending live review).
- **Motion clarifies state:** drawer translateX enter/exit (exit faster), everything
  else snaps; the chart-expand layout transition is REMOVED, not re-animated. PASS.
- **Risk flagged:** the spec column-drop order (drawer.md) names Provider/Phone/Last/
  Uptime/Tokens/Today, but the live Fleet table renders mode · name · chats · count ·
  msg · tokens · sessions · provider. See constraint C-1 below. INCONCLUSIVE until
  reconciled in-slice.

Verdict for this checkpoint: PASS with one INCONCLUSIVE row (C-1).

## 3. Files inspected and classification

| File | Class | Current invariant | C2.3 invariant | Changes now? |
|---|---|---|---|---|
| `console/src/pages/SoupKitchen.tsx` (543 ln) | consumer | raw `<table>`, ad-hoc toolbar, row click = navigate, fixed `--sk-col-*` | adopts Table/Toolbar/Drawer; row click/Enter = drawer; zero local equivalents | YES (pilot) |
| `console/src/pages/Ops.tsx` | consumer | local 4-lane log clone (lines ~213–308) | log pane renders via LogStream | YES |
| `console/src/components/line-detail/LogsTab.tsx` | consumer | local 4-lane log clone | renders via LogStream (filter state stays parent-controlled) | YES |
| `console/src/components/LinePicker.tsx` | consumer | custom dropdown (DD-12) | unchanged; DD-12 stays B2 | NO |
| `console/src/components/StatusDot.tsx` | consumer (compat wrapper) | delegates to StatusCell | unchanged | NO |
| `console/src/components/ModeBadge.tsx` | consumer (compat wrapper) | delegates to primitive | unchanged | NO |
| `console/src/lib/status-map.ts` | producer | single status/mode rendering driver | unchanged — Table consumes StatusCell which consumes it | NO |
| `console/src/components/primitives/{Button,Badge,Pill,Modal}.tsx` | producer | C2.1/C2.2 contracts | unchanged; Table/Toolbar/Drawer compose them | NO |
| `console/src/components/primitives/index.ts` | producer (barrel) | exports all primitives | + Table, Toolbar, LogStream, Drawer | YES |
| `console/src/hooks/use-dismissable.ts` | producer | THE dismissal hook (stack, trap, restore) | Drawer builds on it unmodified; restore already no-ops safely when origin node is gone | NO (rule 6.8) |
| `console/src/styles/primitives.css` | producer | tokenized primitive styles | + table/toolbar/log/drawer blocks | YES |
| `console/src/styles/tokens.component.css` | producer | component tokens (modal, btn) | + `--drawer-w`, row-density, log-lane, toolbar-search tokens (names per tokens-v3 disposition) | YES |
| `console/src/styles/tokens.semantic.css` | producer | dual-theme canonical values | unchanged unless a missing semantic surfaces (then parity-checked) | LIKELY NO |
| `console/src/styles/composites.css` | producer (legacy) | `c-*` classes incl. `--sk-col-*` consumers and `.c-chart-expand-col` layout transition | `--sk-col-*` deleted with the pilot; chart-expand transition removed (snap) | YES |
| `tests/console/soup-kitchen.test.tsx` (825 ln) | fixture/consumer | asserts nav-on-row-click, sort via th click | updated: drawer-on-activate, keyboard sort, drawer contract | YES |
| `tests/console/logs-tab.test.tsx` | fixture/consumer | asserts pill filters + row rendering | updated to LogStream contract (roles, lanes) | YES |
| `tests/console/badge-components.test.tsx`, `primitives-*.test.tsx` | evidence | pin shape law / primitive contracts | untouched; new primitives get sibling files | NO (additive) |
| `console/eslint.config.shadow.mjs` + `lint-shadow-baseline.json` | enforcement | superset shadow run, rule×file fall-only ratchet | + new selectors (see §10); baseline regenerated, must FALL | YES |
| `console/scripts/{design-regression.sh,check-shadow-baseline.mjs,check-theme-parity.mjs}` | enforcement | 15 report-only checks / ratchet / parity | regression may gain a `--sk-col` absence check; others unchanged | MAYBE |
| `eslint-rules/index.mjs` (repo root) | enforcement (foreign) | repo fitness ring (new on main) | SEPARATE DOMAIN — untouched | NO |

**Exact new files:** `primitives/{Table,Toolbar,LogStream,Drawer}.tsx`;
`tests/console/primitives-{table,toolbar,log-stream,drawer}.test.tsx`; this packet and
`c2-3-evidence.md`. Any file outside this table and list must be added here before commit.

## 4. Patterns to replace

Raw Fleet `<table>` + sticky thead built inline; `<th onClick>` sorting; mouse-first
row `onClick` navigation; fixed `--sk-col-*` column widths; ad-hoc Fleet filter/search
row; LogsTab and Ops four-lane log clones (`--log-col-*` flex rows); absent drawer law
(row drill-in currently leaves the list).

## 5. Fixture and data review

**Runtime sources:** `use-fleet.ts` React Query hooks (`getLines/getLogs/getFeed`),
poll fallback 5s/3s, WebSocket invalidation when connected. `LineInstance` carries all
columns the table needs incl. optional subtrees per mode. `LogEntry` =
timestamp/level(info|warn|error|debug)/msg/source.

**Mock data (`mock-data.ts`):** 8 lines — 5 online, 1 degraded (sales, with error
copy), 1 unreachable (intern, health null, auth expired), 1 unlinked (archive, zero
activity). 3 modes, 3 providers, token usage present/absent, missing-optional cases
real. ADEQUATE for live review.

**Test fixtures:** per-file inline factories (`makeLine`, `makeLogs`); no shared
fixture module. Coverage today: all four statuses, all modes, zero-row, null-health,
filtered-empty logs. **Gaps → fixture plan (extend the local factories, no new shared
module this slice):**
- long values: line name ≥40 chars, provider ≥24, phone with country format, log
  message ≥300 chars single-token and multi-word (wrap policy proof);
- one-row and many-row (≥25) table sets for density/scroll checks;
- drawer retarget pair (two rows with distinct kv values so the swap is assertable);
- log set large enough to exercise the scoped last-N cut in the drawer;
- a status-transition case (same line rendered with changed status → head updates).

## 6. Reliability answers (each becomes code, test, rule, DD, or non-goal)

1. **Selected row disappears (data refresh):** drawer keys on line `name`; if the name
   is no longer in the dataset, body renders the error state with Retry/Close
   (drawer.md states no empty drawer on failure). → code + test.
2. **Data refresh while open:** content re-derives from the query cache by name; swap
   in place, no re-animation, no focus disturbance. → code + test (rerender with new
   data, assert no remount via stable element identity).
3. **Selected row status changes:** head status shape + row wash update live. → code +
   test (covered by the status-transition fixture).
4. **Sort/filter hides the selected row:** selection survives visibility; `aria-current`
   simply isn't rendered while hidden; drawer stays open. → code + documented rule.
5. **Logs update while focus is inside drawer:** poll replace must not steal focus;
   rows keyed stably; not a live region. → code + test (focus stays on focused element
   across a log-list rerender).
6. **Rapid retarget:** content swap is synchronous state, no enter re-animation, no
   focus move (pointer focus stays on the clicked row). → code + test.
7. **Nested Escape:** Drawer registers on the same useDismissable stack as Modal;
   a confirm dialog opened from a remedy action closes first. → existing stack tests +
   one drawer-over-modal ordering test.
8. **Origin focus target missing on close:** useDismissable already no-ops when the
   captured element left the document (verified in the hook). Documented rule: focus
   then remains where the browser leaves it; a table-container fallback is a possible
   later enhancement, NOT taken now. → documented rule (non-goal this slice).
9. **Drawer open during resize:** container query flips squeeze↔overlay declaratively;
   open state persists; no transition on the mode flip. jsdom cannot prove this →
   manual QA evidence + note; deterministic proof lands with D7 viewport tests.
10. **Toolbar wraps while focused:** flex wrap preserves DOM order, so focus and tab
    order survive. → manual QA note.
11. **Huge / empty logs:** drawer log is scoped last-N by contract; LogsTab/Ops render
    poll snapshots (bounded today). Virtualization for unbounded streams is NOT built
    this slice → new DD entry (see §12). Empty and filtered-empty states are built and
    tested.
12. **Reduced motion:** drawer enter/exit instant under the global CSS policy (it is
    CSS-transition driven, so the existing off-and-instant block already covers it);
    log appends and sort glyphs never animate; chart-expand transition is deleted
    outright. → code + manual check.

## 7. Responsive layout decision note (frontend-design lens)

- **Density:** Fleet table is `compressed` (28px) always — operator surface per
  table.md. `default` density exists in the primitive for form/wizard tables later.
- **KPI strip:** wraps to multiple rows at narrow widths (flex-wrap / auto-fit), never
  drives horizontal page scroll.
- **Charts:** stack vertically below the md breakpoint; the expand interaction becomes
  an instant state change (transition on flex/width/min-width REMOVED from
  `.c-chart-expand-col` — this is the DD-18 chart leg).
- **Drawer:** decision driven by a CONTAINER query on the Fleet main area
  (`container-type: inline-size`; first container-query use in the codebase, native in
  Tailwind v4/modern CSS): ≥1080px container = squeeze (flex sibling, content
  `flex:1 1 auto; min-width:0`, no scrim); <1080px = absolute overlay + scrim.
- **Table under squeeze:** content-sized columns after `--sk-col-*` removal; horizontal
  scroll within the table region is the governed overflow valve; column-drop order per
  constraint C-1 below. Never dropped: Line, Mode, Status, row actions.
- **Toolbar:** filter group wraps first; search shrinks to its token min; primary stays
  visible and last in keyboard order.
- **Logs:** time/level/source lanes fixed; message wraps (multi-word) and breaks
  (long-token) by rule; source truncates with title attr.
- **Short-height:** page scrolls; sticky table header keeps context; drawer body is the
  scroll area, head pinned.
- **Intentional scroll regions:** table region (x), drawer body (y), log list (y).
  Unacceptable: page-level horizontal overflow at 390/768/1024/1280/1440.

## 8. Targeted test plan

Table: sort cycle asc→desc→none via click AND keyboard on the header button;
`aria-sort` per state; row Enter activation; row focus class/ring contract (class-level
— does NOT prove visual ring, noted); StatusCell presence in column 1; empty/loading/
error states; severity wash classes.
Toolbar: `role="group"` + label; pill `aria-pressed`; search label; DOM order matches
the anatomy; primary reachable by keyboard.
LogStream: `role="list"/"listitem"`; level letter + class (not color-only); filter
pills operate by keyboard; filtered-empty copy; long-message wrap policy class
contract; focus survives list refresh.
Drawer: opens on row click and keyboard activation; Escape closes exactly once
(stacked with a modal: modal first); focus enters close-X; focus restores to origin
row; retarget swaps content without remount; missing-line error state; `aria-current`
on origin row.
Pages: SoupKitchen nav test rewritten — activation opens drawer; explicit "Open line"
action navigates; LogsTab/Ops keep their public filter contracts through LogStream.
Enforcement: negative fixtures for any shadow selector promoted beyond report-only.
jsdom limits (squeeze flip, computed boxes, real focus ring) are named INCONCLUSIVE in
unit tests and covered by manual QA now, D7 later.

## 9. Observability plan

No production `console.*` (repo guard bans it). Observability = deterministic
accessible state: `aria-sort`, `aria-pressed`, `aria-current`, `aria-expanded`,
`data-state="open|closed"` and `data-density` attributes on Table/Drawer roots for
test/QA inspection; role/name queries in tests; manual QA observations recorded in the
evidence packet. Live log streaming/SSE instrumentation is a product decision OUT OF
SCOPE (logs are poll snapshots today — confirmed in use-fleet.ts).

## 10. Enforcement plan

| Candidate rule | Classification | Note |
|---|---|---|
| raw sortable `th[onClick]` | shadow WARN now; scoped-error for `pages/` at D6 | negative fixture required at promotion |
| raw `<table>` outside primitives | shadow WARN (selector on JSX table element in pages/) | Fleet goes to zero this slice; ratchet holds it |
| legacy `--sk-col-*` usage | design-regression check (report-only) asserting zero occurrences post-slice | cheap grep check |
| duplicate log lanes (`--log-col-*` outside LogStream) | shadow WARN | LogsTab/Ops migration drives to zero |
| drawer-like markup outside Drawer | NOT PRACTICAL as lint | review + ratchet culture |
| mouse-only row activation | NOT PRACTICAL as lint | enforced by behavioral tests |
| status without StatusCell | already report-only via status-map discipline | unchanged |
| filter pills outside Pill | existing ratchet buckets | unchanged |
| unlabelled row actions | enforced at type level (ActionButton aria contract) | existing |
| uncontrolled horizontal overflow | NOT LINTABLE | manual QA now, D7 viewport tests |

Shadow baseline regenerates after the pilot; counts must FALL (Fleet legacy classes
leave). Design-regression remains report-only and is described as such.

## 11. Rollback strategy

Commit order: (1) tokens + CSS + four primitives + their tests (purely additive —
single revert restores status quo); (2) LogsTab/Ops LogStream migration; (3) Fleet
pilot migration + `--sk-col-*` deletion + chart-transition removal + test rewrites;
(4) enforcement selectors + baseline + docs. Non-revertible coupling: none across
commits; within commit 3 the `--sk-col-*` deletion is coupled to the pilot (reverting
3 restores both).

## 12. Debt register deltas planned

- Close at acceptance (with proof): DD-21 table half; DD-18 Fleet legs (KPI/chart
  stacking, table squeeze, chart layout-animation). DD-21 tablist half stays (B1).
- New: **DD-22 log virtualization** — LogStream renders bounded poll snapshots;
  virtualization required by spec for unbounded streams is deferred until a streaming
  log source exists (owner: LogStream maturity slice; expiry: before any live-tail
  feature ships; blocks final acceptance: no).
- Possible new entry if Ops migration proves entangled (named slice + expiry) — only
  if hit.

## 13. Constraints / open items

- **C-1 (INCONCLUSIVE → resolve in-slice):** reconcile drawer.md's column-drop order
  (Provider/Phone/Last/Uptime/Tokens/Today) with the live Fleet column set (mode ·
  name · chats · count · msg · tokens · sessions · provider). Resolution path: map by
  intent — identity columns never drop; provider drops first; numeric activity columns
  drop next; record the mapped order in the Table spec note + evidence. No user gate
  needed (spec interpretation, not direction change).
- **C-2:** Fleet toolbar omits the time-range segment (no temporal filter exists on the
  table; spec allows omission, never reorder). Chart range pills are a chart-scoped
  control on a separate surface — documented, satisfying the one-time-control law.
- **C-3:** live-tail = poll-refresh append semantics only; streaming is out of scope
  (see §9, DD-22).

## 14. Strong-claim audit

This packet avoids unproven absolutes: every "enforced" above is classified
(type-level, test, shadow WARN, report-only); design-regression is stated report-only;
jsdom-unprovable behaviors are marked manual-QA/INCONCLUSIVE. At slice end, grep the
diff for done/complete/enforced/canonical/single/only/never/guaranteed/final/live/
no-raw/accessible/responsive/reduced-motion and verify each against code, tests, or
evidence before commit (A0 requirement carried into A6).

## Verdict: **Ready with Constraints** (C-1 resolved in-slice; C-2/C-3 documented). Implementation may begin.
