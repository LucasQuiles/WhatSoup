# Design-System Adoption Audit — SOUP v3 (pre-cutover, 2026-06-12)

Operator mandate: 100% design-system adoption before cutover. This audit inventories every
console surface, maps primitive adoption vs legacy remnants with file:line evidence, and
produces the burndown that stands between the current tree and 100%.

Audited tree: `<soup-impl worktree>` (implementation branch `feat/soup-v3-foundation`),
console app at `console/`. Design authority: `03-spec/` in this repo. Static analysis only —
no build, no test run, no install (package.json was mid-merge and ignored per brief).

Post-audit current-state note: this file is a dated snapshot. Current raw form-control counts are
mechanically generated in `console/design-raw-form-control-inventory.json` and checked by
`npm --prefix console run design:raw-form-control-inventory`. As of D4.3a/D4.3b/D4.3c,
`SearchInput`, `UnlockScreen`, and `TagInput` render through `TextInput`; do not use the
2026-06-12 raw-form counts below as the live source of truth. As of the 2026-06-14
UnlockScreen restyle slice, `UnlockScreen` also has zero `soup/no-legacy-tokens` findings:
the caller no longer overrides `TextInput`/`Button` with legacy utility classes. As of the
2026-06-14 FileInput slice, raw form-control inventory is zero.

## 1. Methodology

1. **File census.** Every `.tsx/.ts/.css` under `console/src` enumerated (4 pages, 63 leaf
   component/util TSX surfaces, 12 primitives, 6 style-tier CSS files, lib/, hooks/).
2. **Pattern scan.** Scripted regex scan per file for: raw `<button|input|select|textarea|table|th>`,
   `role="dialog"`, `outline-none`, legacy utilities (`bg-d*`, `text-t*`, `border-t*`), legacy vars
   (`var(--color-[dt]N)`, `var(--b1..4)`), half-step spacing (`--sp-0h/1h/2h`), arbitrary px
   (`[Npx]`), raw hex.
3. **Primitive-import map.** Scripted multi-line, both-quote-style import extraction from
   `components/primitives` and the wizard form kit — corrected after the first pass missed
   double-quoted multi-line imports (SoupKitchen).
4. **Per-file interactive-site counts.** Primitive JSX tags (`<Button|ActionButton|Modal*|Pill|
   Table*|Toolbar*|LogStream|Drawer*|Tabs|Tab|Popover|StatusCell|ModeBadge|TextInput|SelectInput|
   NumberInput|TextArea|CheckboxField|Field>`) vs raw interactive elements, outside
   `components/primitives/**`.
5. **Ground truth cross-check.** `console/lint-shadow-baseline.json` (486 falls) decomposed
   rule×file and reconciled against the scans; `console/eslint.config.js` blocks read to verify
   carve-outs; `console/eslint-waivers.yaml` read for sanctioned exceptions.
6. **Binding docs read first:** program-directives.md, conformance-manifest.md,
   design-debt-register.md, 03-spec/components/*, 04-enforcement/lint-plan.md.

Counting conventions: "primitive sites" counts every primitive JSX element including Modal
sub-elements (Header/Body/Footer) — stated so the % is reproducible, not flattering. "Legacy
sites" counts raw interactive elements outside primitives and outside the form kit's own
renders. Ad-hoc *patterns* (hover-cards, ad-hoc toolbar bands, hand-rolled radio cards) are
called out qualitatively and in the burndown; they are not double-counted in the site math.

## 2. Headline numbers

- **Interactive/structural primitive adoption: 184 / 285 sites = 64.6%**
  (184 primitive JSX sites vs 101 raw interactive elements: 70 raw `<button>` across 29 files +
  31 raw form controls across 14 files, excluding the form kit's own 5 renders).
- **Fully-conformant surfaces: 8 / 67 = 12%** (zero legacy patterns in-file):
  AddLineWizard, RelinkModal, LogsTab, ChatList, ErrorBoundary, StatusDot, ModeBadge,
  QrDisplay (waivered WVR-002). **Pages fully clean: 0 / 4.**
- **Legacy token vocabulary still live:** 327 TSX-side shadow falls across 56 files
  (soup/no-legacy-tokens), plus ~153 legacy `var()` occurrences in `src/styles/composites.css`
  (97 lines — invisible to ESLint by design, lint-plan §1), plus 28 half-step spacing
  consumption lines (DD-9). TSX consumers reference the new semantic vocabulary directly only
  3 times — virtually all styling rides the C1 alias layer or composite classes.
- **Dialog/table/log/picker families: 100% on primitives.** Buttons: 30%. Form controls: 58%
  by site count.
- **Blocking-cutover burndown items: 14** (§8).

## 3. Full surface inventory

Adoption % = in-file primitive sites / (primitive + raw interactive sites); "—" = no
interactive sites in-file (token-only surface). "Blocks" = blocks the 100%-adoption cutover
gate. Legacy file:line lists are from the scan of the current tree; legacy-token (LT) counts
are the shadow-baseline falls for that file.

### 3.1 Pages

| Surface | Spec source | Primitives used | Legacy remnants (file:line) | Adopt % | Blocks |
|---|---|---|---|---|---|
| pages/SoupKitchen.tsx (Fleet) | table.md, toolbar.md, drawer.md, badge.md, log-stream.md | Table family, Toolbar(+Search/Filters/Spring/TimeRange), StatusCell, ModeBadge, Button, Drawer(+Layout/Header/Body), LogStream, EM_DASH | 0 raw elements; LT×8: 592, 739, 749, 927, 932, 942, 960, 999 (text-t*, var(--b4)) | 27/27 = 100% | yes (token refs only) |
| pages/LineDetail.tsx | tabs.md, button.md, badge.md | Tabs/Tab, Button, ActionButton, StatusCell | 0 raw elements; LT×7: 139, 154, 160, 166, 195, 202, 279 | 8/8 = 100% | yes (token refs only) |
| pages/Ops.tsx | log-stream.md, toolbar.md, pill.md | LogStream, Toolbar, ToolbarFilters, Pill | raw `<button>`×3 (c-btn recipes — Re-link 195, Restart 203, Delete 217); LT×8: 102, 137, 141, 149, 156, 168, 240, 292; sp-half 292 | 5/8 = 63% | yes |
| pages/Inbox.tsx | input.md, button.md, toolbar.md (none adopted in-file) | none in-file (composes LinePicker/ChatList/SaveContactDialog/EmptyState/SearchInput) | raw `<button>`×8: 280, 350, 395, 432, 510, 534, 553, 573; raw `<textarea>` composer 411; `c-btn-primary` send 434; ad-hoc header band (search+filters, 244-283); LT×25 (largest single file) incl. 244-256, 264-283, 354, 408-413, 464-475, 486-512, 575, 591; legacy vars 408, 512, 575 | 0/9 = 0% | yes |

### 3.2 App shell

| Surface | Spec source | Primitives used | Legacy remnants | Adopt % | Blocks |
|---|---|---|---|---|---|
| components/Nav.tsx (top bar) | brand.md §1 (nameplate+tick), tokens-v3 chrome glass | none | split "What"+"Soup" wordmark (brand-regression fall); active underlines + unread badge closed to `--accent`/`--accent-fg`; raw `<button>`×3: 139 (theme toggle, DD-5), 174, 193; LT×15: 39-196; sp-half×6; no-restricted-syntax×6 | 0/3 = 0% | yes (C4 nameplate slice + DD-5 buttons) |
| components/UnlockScreen.tsx | input.md, button.md | TextInput, Button | closed 2026-06-14: no raw controls; no LT findings; caller uses semantic surface classes and primitive-owned input/button styling | 2/2 = 100% | no |
| App.tsx | tokens-v3 | MotionConfig reducedMotion (DD-20 closure) | LT×2: 25, 60 | — | yes (token refs) |
| components/ErrorBoundary.tsx | state-taxonomy | composes EmptyState; tokenized | none | — | no |

### 3.3 Dialog family (all 11 dialog shells on Modal — shell adoption 100%)

| Surface | Primitives used | Legacy remnants inside the shell | Adopt % | Blocks |
|---|---|---|---|---|
| AddLineWizard.tsx | Modal kit, Button | none in-file; WizardStepper composite local (extraction documented optional, composites.css:905-909) | 6/6 | no |
| ConfirmDialog.tsx | Modal kit, Button | LT×1: 46 | 6/6 | yes (token ref) |
| RelinkModal.tsx | Modal kit | none | 3/3 | no |
| SaveContactDialog.tsx | Modal kit, Button | raw `<input>` 69 | 6/7 | yes |
| KeyboardShortcutsHelp.tsx | Modal, ModalBody | LT×4: 36, 37, 45, 57; sp-half 42; kbd styling unspecced (M7) | 2/2 | yes (token refs) |
| UpdateModal.tsx | Modal kit, Button | raw checkbox `<input>` 421-422; "Update WhatSoup" title (brand fall, flips P4); LT×12: 341-453; hex 215; sp-half 419 | 11/12 | yes |
| line-detail/ConfigEditDialog.tsx | Modal kit, Button | raw `<input>`×4: 161, 177 (162 checkbox), 254, 280; raw `<select>` 232; raw `<textarea>`×2: 205, 269 — all c-input recipes, none on form kit; LT×1: 208 | 6/13 = 46% | yes |
| line-detail/CreateGroupModal.tsx | Modal kit, Button | raw `<input>` 89; LT×2: 96, 104 | 6/7 | yes |
| line-detail/GroupDetailModal.tsx | Modal, ModalBody, Tabs/Tab, ActionButton, ToolbarTimeRange | raw `<button>`×9: 230, 238, 249, 367, 389, 396, 445, 453, 702 (incl. ghost-styled select trigger family); raw `<input>` 164; raw `<select>` 687; raw `<textarea>` 182; LT×17; legacy vars 225, 596 | 11/23 = 48% | yes |
| line-detail/ScheduleComposerModal.tsx | Modal kit, Button, ToolbarTimeRange | raw `<input>`×3: 266, 302 (datetime-local 304), 338; raw `<textarea>`×2: 248, 282; raw `<button>` 327; LT×5 | 8/14 = 57% | yes |
| line-detail/ModeSwitchDialog.tsx | shell via ConfirmDialog (Modal) | hand-rolled radio-card list: raw `<button>` 70 with inline mode-color styles (legacy vars 76, 77, 86, 88, 92 — `var(--color-m-*)`, `var(--m-*-wash/soft)`); should be CardSelector radiogroup; LT×3: 62, 96, 102 | 0/1 in-file | yes |

### 3.4 Line-detail tabs

| Surface | Primitives used | Legacy remnants | Adopt % | Blocks |
|---|---|---|---|---|
| LogsTab.tsx | LogStream, Toolbar, ToolbarFilters, Pill | none | 4/4 = 100% | no |
| SummaryTab.tsx | Button (×5) | LT×16: 40-212 (largest tab token debt); sp-half 181, 191 | 5/5 | yes (tokens) |
| MetricsTab.tsx | ToolbarTimeRange, Button, Tabs/Tab | LT×13; chart ratio style remains inline for the token-usage split bar | controls 4/4 = 100% | yes (tokens) |
| HistoryTab.tsx | TextArea, Button (×2), ActionButton | focus suppression closed: composer routes through `TextArea` with zero `outline-none`; load-older, jump-to-newest, and send controls route through button primitives; LT×9; legacy var 188; sp-half 206 | controls 4/4 = 100% | yes (tokens) |
| AccessTab.tsx | none | raw `<button>`×4: 90, 97, 107, 117; LT×10: 42-160; sp-half 56, 78 | 0/4 = 0% | yes |
| ModeTab.tsx | none | raw `<button>`×3: 27, 51, 58; LT×4; legacy vars 74, 103 | 0/3 = 0% | yes |
| PipelineTab.tsx | none | raw `<button>` 35; LT×8: 43-172; legacy vars 24, 25; sp-half 22; former DUP-08 conditional hardcoded-px branch now tokenized | 0/1 = 0% | yes |
| GroupsTab.tsx | none | raw `<button>` 47 (c-btn-primary 50); LT×1: 44 | 0/1 | yes |
| GroupCard.tsx | none | raw `<button>` 23 (whole-card click target); LT×1: 30; utility-smell fall ×1 | 0/1 | yes |
| ScheduledTab.tsx | none | raw `<button>` 108 (c-btn-primary 111); LT×1: 105 | 0/1 | yes |
| ScheduledMessageRow.tsx | none | raw `<button>`×4: 143, 151, 164, 175; LT×4; legacy var 192; sp-half 104, 132 | 0/4 | yes |
| ProvidersKeysCard.tsx | none | LT×9: 83-179; sp-half×4: 64, 79, 100, 161 | — | yes (tokens) |
| scheduled-utils.ts / types.ts / config-helpers.ts / groups-utils.ts | n/a (logic) | scheduled-utils legacy vars 12, 13 (LT×2) | — | yes (tokens) |

### 3.5 Wizard family

| Surface | Primitives used | Legacy remnants | Adopt % | Blocks |
|---|---|---|---|---|
| wizard/ConfigStep.tsx | form kit (TextInput/SelectInput/NumberInput/TextArea/CheckboxField/FileInput/Field), Tabs/Tab | raw `<button>`×5 remains; raw form controls closed (enabled-plugin checkbox routes through `CheckboxField`; file uploads route through `FileInput`); LT×21 (largest wizard debt); legacy vars; sp-half | controls partial (buttons remain) | yes (buttons/tokens) |
| wizard/ModelAuthStep.tsx | SelectInput, Tabs/Tab | raw `<button>` 171; raw `<input>`×3: 161, 261 (radio 262), 271 (radio 272); LT×6; legacy var 168 | 6/10 = 60% | yes |
| wizard/IdentityStep.tsx | none (form kit NOT used) | raw `<input>`×2: 116, 154; LT×4; legacy vars 124, 161 | 0/2 = 0% | yes |
| wizard/LinkStep.tsx | none | raw `<button>`×2: 134, 160 — legacy recipe sites were accent-safe by the F1 close; LT×5; hex 95 | 0/2 = 0% | yes |
| wizard/ReviewStep.tsx | Field (×1) | raw `<button>`×2: 55, 211 (c-btn-primary 213); LT×1; legacy vars×5: 19, 20, 34, 45, 49 | 1/3 = 33% | yes |
| wizard/WizardStep.tsx | none | LT×1: 26 | — | yes (token) |
| components/primitives/FormControl.tsx (the kit itself) | — | renders raw controls by design inside the primitive exemption; wizard/form-primitives.tsx is a shim; ConfigStep+ModelAuthStep now import the primitive barrel | kit | no (DUP-12 promotion done; consumer migrations remain) |

### 3.6 Pickers / shared

| Surface | Primitives used | Legacy remnants | Adopt % | Blocks |
|---|---|---|---|---|
| LinePicker.tsx | Popover kit, StatusCell, ModeBadge | raw trigger `<button>`×2: 136, 181 (the register's "LinePicker raw buttons ×2" — confirmed still present); LT×4: 147, 156, 192, 201 | 9/11 = 82% | yes |
| shared/ChatPicker.tsx | Popover kit | raw `<button>` 127 (c-btn); LT×6; legacy var 120 | 1/2 = 50% | yes |
| shared/ContactSearchPicker.tsx | Popover kit, Pill | LT×1: 90 | 2/2 | yes (token) |
| shared/SearchInput.tsx | none — local recipe, not a primitive | raw `<input>` 17; LT×1: 15; sp-half 15, 24. A SearchInput exists in spec vocabulary only as ToolbarSearch; this shared one is a parallel non-primitive implementation | 0/1 = 0% | yes |
| TagInput.tsx | Pill (removable) | raw `<input>` 89 (the tag entry field — not on form kit) | 1/2 | yes |
| CardSelector.tsx | radiogroup pattern (DD-14 closed) | LT×1: 101; legacy vars 29, 89, 92 | — | yes (tokens) |
| LineTags.tsx | none | legacy vars 25, 29; sp-half 57, 91 (LT×4) | — | yes (tokens) |

### 3.7 Fleet/feed/chart components

| Surface | Primitives used | Legacy remnants | Adopt % | Blocks |
|---|---|---|---|---|
| KpiCard.tsx | none | raw `<button>` 29 (clickable KPI card); LT×5 incl. legacy vars 20, 35, 36; sp-half 48 | 0/1 | yes |
| ChartPanel.tsx | none | raw `<button>` 67 (expand control); LT×3: 31, 55, 78; sp-half 38; body heights now tokenized via `--chart-panel-h*` | 0/1 | yes |
| FleetMetricsChart / FleetSessionChart / FleetTokenChart / MetricsChart | recharts (no chart spec exists — M4) | legacy vars in axis/series colors: FleetMetricsChart 24, 29; FleetSessionChart 42, 43, 64, 65; FleetTokenChart 41, 46, 104, 109; MetricsChart 23, 28; lib/chart-utils.ts legacy vars 7, 16, 17, 20 (+WVR-001 margins) | — | yes (tokens) |
| ActivityFeed.tsx | none | raw `<button>` 155; LT×2: 177, 180 | 0/1 | yes |
| FeedCard.tsx | none | raw `<button>`×4: 344, 366, 388, 408 (feed actions); LT×4 incl. legacy vars 80, 88, 92 | 0/4 | yes |
| FeedIcon.tsx | none | LT×5: 23-53 | — | yes (tokens) |
| AlertBanner.tsx | none | raw `<button>` 37 (alert chips); LT×2: 44, 45 (s-crit wash/soft inline) | 0/1 | yes |
| ActiveHoursHeatmap.tsx | none | LT×19 (largest component token debt): 31-237 incl. legacy vars 8, 11, 12, 13, 86 | — | yes (tokens) |
| FilterPill.tsx | Pill | LT×1: 16 | 1/1 | yes (token) |
| HeartbeatStrip.tsx | none | template-literal px evasion closed: `w-[var(--heartbeat-bar-w)] rounded-[var(--bw)]`; sp-half 12 | — | no (polish) |
| StatusDot.tsx | StatusCell wrapper | none | 1/1 | no |
| ModeBadge.tsx | ModeBadge wrapper | none | 1/1 | no |

### 3.8 Inbox/message components

| Surface | Primitives used | Legacy remnants | Adopt % | Blocks |
|---|---|---|---|---|
| ChatList.tsx | listbox roving contract implemented (DD-17 traversal + visible row focus proof closed) | none in-file | — | no (in-file) |
| ChatListItem.tsx | none | `.c-chat-item:focus-visible` now provides a visible ring under trusted Tab focus; LT×3: 33, 43, 63; sp-half 41, 55; typing-dot animationDelay literals 0/150/300ms | — | yes (tokens) |
| MessageBubble.tsx | none | raw `<button>`×2: 81 (retry, c-btn recipe), 186; hand-rolled hover detail card via `c-card--detail` composite (40; DD-18r positioning leg, M1); LT×8; sp-half 215 | 0/2 | yes |
| MessageContent.tsx | none | LT×15: 44-258 (second-largest component token debt); sp-half 163; no-restricted-syntax×5 | — | yes (tokens) |
| EmptyState.tsx | none (TableEmpty exists separately in Table primitive) | LT×3: 38, 47, 56 (text-t5/t4 essential-text tiering — DD-8 names empty-state tiering); c-btn-primary retry 66; framer-motion entrance | — | yes (DD-8) |
| Skeleton.tsx | none | TableSkeleton widths tokenized via `TABLE_SKELETON_WIDTHS`; shimmer waivered WVR-005 | — | no (polish, M3) |
| Toast.tsx (+hooks/use-toast.tsx) | none — Toast is its own renderer per toast.md | raw dismiss `<button>` 50; LT×2: 43, 49; sp-half 43; hardcoded `z-[110]` (use-toast, no-restricted-syntax fall ×1); DD-25 motion literals | 0/1 | yes |

### 3.9 Primitives layer (reference)

12 files in `components/primitives/`: Badge (StatusCell+ModeBadge), Button, ActionButton, Modal,
Pill, Table, Toolbar, LogStream, Drawer, Tabs, Popover, index. Raw elements inside primitives are
by design (canonical renderers). Primitive tier CSS (`styles/primitives.css`) is born clean of
legacy color tokens; it still consumes half-step spacing at 55, 247, 294, 306, 552 (DD-9).
Known primitive-layer defects (register): DD-23 Popover no collision flip, DD-22 LogStream no
virtualization. DD-10, DD-27, DD-30, and DD-42 are closed in the current register.

### 3.10 Non-UI files carrying design vocabulary

lib/format-wa-text.tsx (LT×4), lib/providers.ts (LT×2 + hex 5 — provider brand colors),
lib/status-map.ts (LT×3: 150, 159, 165 — inside the canonical status driver), lib/chart-utils.ts
(above), lib/type-guards.ts + lib/api.ts + lib/realtime-events.ts (hex hits are JID/ID strings
and escape sequences — false positives, verified by reading), mock-data.ts (hex×5 +
no-restricted-syntax×5 — mock fixtures). hooks/use-toast.tsx (above). The former
lib/log-theme.ts row was removed with the color-semantics helper-scope hardening.

NOT AUDITED: `tests/` (out of scope — code surfaces only), `console/index.html` beyond the title
check noted in lint-plan, `console/public/`, runtime behavior of any surface (§9), and the
24 no-restricted-syntax baseline selectors' individual identities inside files where the baseline
groups them (the file-level counts are reported; per-selector attribution inside e.g. Nav.tsx×6
was not decomposed).

## 4. Missed-surface findings

| # | What | Where | Spec / primitive gap | Proposed disposition |
|---|---|---|---|---|
| M1 | Hover-cards & tooltips: 63 native `title=` attributes (unthemed native browser tooltips) + one hand-rolled hover detail card (`c-card--detail`) | title= across components/pages (63 occurrences); MessageBubble.tsx:40 | interaction-patterns.md §"Tooltips never carry sole information" is the ONLY tooltip law; no tooltip/hover-card component spec in 03-spec/components/, no primitive | Spec decision at C3: either a Tooltip/HoverCard spec+primitive or an explicit ruling that native titles are sanctioned redundant affordances; MessageBubble card rides DD-18r positioning leg |
| ~~M2~~ | **DONE** — ChatListItem rows (`div role="option" tabIndex`) now receive `.c-chat-item:focus-visible`, with an inset tokenized ring and a real-browser trusted-Tab proof that the focused option has non-`none` `box-shadow`. | ChatListItem.tsx; composites.css `.c-chat-item:focus-visible`; `tests/browser/a11y-contracts.test.tsx` | focus-visible-required rule remains shadow/primitives-first; this closes the known keyboard-visible consumer gap for the chat list row family. | Closed; DD-17 is no longer half-stale on the focus-visibility leg. |
| M3 | Loading/skeleton states: TableSkeleton widths are tokenized; no skeleton component spec | Skeleton.tsx (`TABLE_SKELETON_WIDTHS`) | state-taxonomy covers loading as a state; no skeleton spec/primitive; shimmer waivered WVR-005 pending C5 motion disposition | Decide whether skeleton geometry gets a component spec or stays a local loading-state recipe; fold into C5 shimmer disposition |
| M4 | Charts family unspecced: 4 chart wrappers + ChartPanel render recharts with legacy-token axis/series/tooltip styling | FleetMetricsChart/FleetSessionChart/FleetTokenChart/MetricsChart, chart-utils.ts:7-20 | no chart spec in 03-spec/components/; WVR-001 covers margins only, not the legacy color refs | C3 chart surface slice (already named as WVR-001's cleanup_trigger): chart token adapter + retoken axis/tooltip styles |
| ~~M5~~ | **DONE** — UnlockScreen is sliced onto `TextInput` + `Button`, with semantic surface wrappers and no caller legacy-token overrides. | UnlockScreen.tsx; `tests/console/unlock-screen.test.tsx` | input.md/button.md specs adopted; focused test pins primitive-owned styling. | Closed 2026-06-14; shadow ratchet lowered `soup/no-legacy-tokens :: src/components/UnlockScreen.tsx` 3→0. |
| ~~M6~~ | **DONE / RE-NARROWED** — HistoryTab cursor controls now route through `Button` (`Load older messages`, `Jump to newest`); no raw pagination buttons remain. | HistoryTab.tsx (cursor state ~35-40, load-more controls) | No standalone pagination primitive is needed until a reusable cursor-pagination family exists. | Closed for the raw-control gap; future reusable pagination is a product-pattern trigger, not current debt. |
| M7 | kbd hints: KeyboardShortcutsHelp renders `<kbd>` with legacy tier classes; no kbd treatment in typography spec | KeyboardShortcutsHelp.tsx:36-57 | no spec home for kbd chips | Token pass + one-line typography.md amendment at C3 |
| M8 | Scrollbar theming uses legacy vars: global webkit scrollbar thumb `var(--b2)`/`var(--b3)` | composites.css:73-76 | tokens exist (`--border-*`); CSS-side, unguarded by ESLint (lint-plan §1) | Mechanical retoken with the composites.css burndown (B1) |
| ~~M9~~ | **DONE** — native control theming now uses `accent-color: var(--accent)`, aligning checkbox/radio/range/progress accent with the locked electric-blue action channel instead of OK-GREEN. | composites.css:22; consumers: UpdateModal.tsx:422, ConfigStep.tsx:692, form-primitives.tsx:110, ModelAuthStep.tsx:262/272, ConfigEditDialog.tsx:162 | select.md/input.md exist; the global rule now carries the action-accent channel. | Closed; same law family as F1, with no remaining `accent-law` burndown findings. |
| M10 | Date/time input: `datetime-local` native picker chrome unthemed and unspecced (file inputs, by contrast, hold a named waiver) | ScheduleComposerModal.tsx:304 | input.md has no date/time section; no waiver | Either waiver it like file inputs or spec the treatment at C3 |
| M11 | Menus/dropdowns/context-menus/switches/breadcrumbs: NONE EXIST in the console (`role="menu"`, `aria-haspopup="menu"`, breadcrumb, `role="switch"` — zero hits). All popup pickers are listbox Popovers | n/a | no gap — confirmed absence | No action; note in spec that menu patterns are out-of-vocabulary until a consumer exists |
| M12 | Empty/error states: EmptyState on ghost-tier legacy classes (DD-8 explicitly names empty-state tiering); AlertBanner error chips are raw buttons with inline crit washes; ErrorBoundary clean | EmptyState.tsx:38-66; AlertBanner.tsx:37-45 | state-taxonomy + DD-8 decision package cover it | Already owned by DD-8 per-screen corrections — listed here so the surfaces are named, not just the rule |
| M13 | Hand-rolled mode radio-cards in ModeSwitchDialog duplicate the CardSelector pattern with inline legacy mode-color styles | ModeSwitchDialog.tsx:70-92 | CardSelector (DD-14 radiogroup) exists and is unused here | Migrate to CardSelector in the C3 LineDetail pass |
| M14 | Local SearchInput recipe parallel to ToolbarSearch | shared/SearchInput.tsx | toolbar.md owns search-in-toolbar; standalone search input has no primitive | Promote into the form kit (or absorb into ToolbarSearch) during B-residue work |

## 5. Shadow-baseline rollup (ground truth: console/lint-shadow-baseline.json, total 8)

| Rule | Falls | Files | Top files |
|---|---|---|---|
| ~~soup/no-legacy-tokens~~ | 0 | 0 | closed: Nav and UpdateModal migrated to v3 semantic tokens; pages + wizard + shared + App surfaces fully migrated |
| no-restricted-syntax (base wall) | 5 | 1 | mock-data 5 (`#NNNN` order/build numbers in mock message text — false-positive hex match, not colors; left for rule-scope review). Nav, MessageContent, PipelineTab, ModeTab inline-style falls migrated to className utilities (value-identical). |
| soup/no-brand-regression | 2 | 2 | Nav (split wordmark) · UpdateModal ("Update WhatSoup") — both flip at the P4/C4 brand slice by design |
| ~~soup/no-raw-form-control~~ | 0 | 0 | closed: `ConfigStep` file uploads route through `FileInput`; generated raw-form inventory is empty |
| ~~soup/no-focus-suppression~~ | 0 | 0 | closed: zero TSX `outline-none` sites; former Inbox and HistoryTab composer carve-outs retired |
| soup/no-utility-smell | 1 | 1 | GroupCard |

Reconciliation: the live shadow baseline is 8 (= 5 + 2 + 1) and the live
burndown queue is 657/592 with `focus-suppression` and `raw-form-control` absent. Focus
suppression now reads zero in two independent checks: `design-regression` check 12 and
whole-tree `outline-none` grep over `console/src`; both former chat composers route
through `TextArea`, the HistoryTab send/load/jump actions route through button primitives,
and the last file uploads route through `FileInput`.

## 6. Legacy-token census

Alias layer (the legal definitions — tokens.semantic.css:219-300 + tokens.primitive.css @theme
inline block): `--color-d0..d6`, `--color-t1..t5`, `--b1..b4`, `--color-m-{pas,cht,agt}`,
`--color-s-{ok,warn,crit}`, `--m-*-wash/-soft`, `--s-*-wash/-border/-soft/-ring/-glow`,
`--overlay-badge`, `--card-shadow`, `--shadow-lg/md/inset`, `--ease`, `--dur-norm`,
`--sp-0h/1h/2h` (tokens.primitive.css:76-79). Register says aliases "removed at C4".

Consumption outside the token tier (current tree):

| Vocabulary | TSX/TS occurrences | CSS occurrences | Notes |
|---|---|---|---|
| Strict legacy utilities `bg-d*`/`text-t*`/`border-t*` | 313 | composites.css class definitions generate them | shadow rule counts 327 nodes total for its scope (utilities+vars, per-node) |
| Strict legacy vars `var(--color-[dt]N)`, `var(--b1..4)` | 75 | 97 lines in composites.css | composites.css is ESLint-invisible (lint-plan §1 — rg-script territory) |
| Mode/status shorthand utilities `text-s-*`, `text-m-*`, etc. | 130 | throughout composites.css | semantically fine, names ride the alias map |
| Extended legacy vars (washes/softs/shadows/ease) + above, total legacy var() in composites.css | — | 153 occurrences | includes `--card-shadow`, `--m-*-wash`, `--s-*-soft` etc. |
| Half-step spacing `--sp-0h/1h/2h` (DD-9) | 26 TSX lines | composites.css 19 lines, **primitives.css 6 lines** (55, 247, 294, 306, 522, 562), defs ×3 | DD-9 marked non-blocking, but note the born-clean primitives tier consumes them |
| Direct semantic-vocabulary var() refs in TSX | **3** | n/a | screens style via aliases + composite classes, not the v3 names — the alias layer currently carries essentially the whole TSX surface |

Component CSS defining its own colors: tokens.semantic.css hex literals are the sanctioned
per-theme token tier; composites.css does not introduce raw hex but does keep one literal
`rgba(0,0,0,0.6)` as `--overlay-badge` inside the alias block (alias-tier literal — dies with
the aliases). `c-btn-primary` (composites.css:733) now binds primary buttons to
`var(--accent)` / `var(--accent-fg)`.

**F1 — accent-law violation in the legacy button recipe (closed; C4 brand residue remains):**
`.c-btn-primary` now binds to `--accent`/`--accent-fg`, native `accent-color` binds to
`--accent`, and Nav active-route underlines / unread badges now use the action accent. The
remaining green in Nav is the legacy split wordmark ("Soup"), which is tracked by the C4
SOUP nameplate / brand-regression lane rather than the action-accent lane.

## 7. Adoption scorecard

Per pattern family (primitive-rendered / total sites):

| Family | Adoption | Evidence |
|---|---|---|
| Dialog shells | 11/11 = 100% | all on Modal (+ ModeSwitchDialog via ConfirmDialog); zero `role="dialog"`/backdrop recipes outside Modal.tsx |
| Tables / sortable headers | 1/1 = 100% | Fleet table on Table family; zero raw `<table>`/`<th>` outside primitives (Group S global-error holds) |
| Log streams | 3/3 = 100% | LogsTab, Ops, SoupKitchen drawer |
| Drawers | 1/1 = 100% | SoupKitchen |
| Popover pickers | 3/3 = 100% | LinePicker, ChatPicker, ContactSearchPicker (LinePicker trigger buttons still raw) |
| Tabs / panel switchers | 5/5 = 100% | LineDetail, GroupDetailModal, ConfigStep, ModelAuthStep, and MetricsTab Tokens/Sessions on Tabs |
| Toolbars | 6 primitive bands; ad-hoc bands remain on Inbox header, HistoryTab composer row, tab-header action rows (GroupsTab/ScheduledTab/AccessTab) | qualitative |
| Buttons | 30/100 = 30% | 30 Button/ActionButton JSX vs 70 raw `<button>` |
| Form controls | generated inventory 0 raw consumers | all consumer `input`/`select`/`textarea` sites route through promoted primitives; original 2026-06-12 site ratio is historical |
| Status/badge rendering | high but not total | status-map driver + 18 StatusCell/ModeBadge uses; residual inline mode/status styling in ModeSwitchDialog, AlertBanner, KpiCard, FeedCard/FeedIcon, providers.ts |
| Token vocabulary | far behind | §6: 327 TSX shadow falls + 153 composites.css refs; 3 direct semantic refs |

Per page (in-file sites): SoupKitchen 100% (27/27) · LineDetail 100% (8/8) · Ops 63% (5/8) ·
Inbox 0% (0/9). Per family dir: wizard 54/64 = 84% sites but 0/7 files token-clean ·
line-detail 41/64 = 64% · top-level components 36/26-legacy ≈ 58% · shared 3/3 files partial.

**OVERALL: interactive/structural primitive adoption 64.6% (184/285 sites). Fully-conformant
surfaces 8/67 = 12%. Token-vocabulary migration is the long pole: 327 TSX + ~153 CSS legacy
references must reach zero before the C4 alias removal can land. By the operator's 100%-adoption
bar, the program is roughly two-thirds done on controls and at the beginning of the
final token/brand burn.**

## 8. Prioritized burndown (blocks-100% first)

Blocking items (14 tracked; B12 now closed):

1. **B1 — Legacy token vocabulary burn** (327 TSX falls ×56 files; 153 composites.css refs;
   scrollbar M8; `--overlay-badge` literal). Largest debts first: Inbox 25, ConfigStep 21,
   ActiveHoursHeatmap 15, GroupDetailModal 17, SummaryTab 16, MessageContent 15, Nav 15.
   Mechanical alias rewrite is the sanctioned codemod (lint-plan soup/no-legacy-tokens).
2. **B2 — Raw `<button>` elimination** (70 ×29 files → Button/ActionButton). Top: GroupDetailModal 9,
   Inbox 8, ConfigStep 5, FeedCard 4, AccessTab 4, ScheduledMessageRow 4.
3. ~~**B3 — Form-control kit completion**~~ — **DONE**: all consumer raw form controls route
   through promoted primitives; generated raw-form-control inventory is empty after `FileInput`
   absorbed the last `ConfigStep` file uploads.
4. ~~**B4 — F1 accent-law fix**~~ — **DONE / RE-NARROWED**: `c-btn-primary`, native
   `accent-color`, Nav active underlines, and unread badges now use `--accent`; the
   remaining green wordmark is C4 brand/nameplate work.
5. **B5 — Nav/brand slice (C4)**: nameplate + teal tick, split-wordmark + UpdateModal title
   flips, theme toggle (DD-5), Nav's 3 raw buttons + 15 token refs (Nav's 6 base-wall
   inline-style falls migrated to `left-[var(--sp-3)]`/`right-[var(--sp-3)]` className utilities).
6. **B6 — Inbox completion**: composer (textarea+send), header band → Toolbar, 8 raw buttons,
   25 token refs, DD-24 narrow-width action path, DD-8 meta-lane tiering.
7. ~~**B7 — HistoryTab composer (C-B4-6)**~~ — **DONE / RE-NARROWED**: HistoryTab
   composer uses `TextArea`; load-older, jump-to-newest, and send controls use
   `Button`/`ActionButton`; no focus-suppression or raw-button remainder stays in this slice.
8. **B8 — Dialog internals wave**: ConfigEditDialog, ScheduleComposerModal, GroupDetailModal,
   CreateGroupModal, SaveContactDialog, UpdateModal raw controls/buttons inside Modal shells
   (overlaps B2/B3; named because shells being green hides red interiors).
9. **B9 — Wizard residue**: IdentityStep/LinkStep/ReviewStep onto the kit + Button;
   ConfigStep's 5 raw buttons; ModelAuthStep radios.
10. ~~**B10 — UnlockScreen slice (M5)**~~ — **DONE** 2026-06-14: `TextInput` + `Button`, semantic wrappers, no legacy-token shadow findings, focused primitive-ownership test.
11. ~~**B11 — MetricsTab Tokens/Sessions → Tabs (DD-15)**~~ — **DONE**: panel switcher moved to Tabs; keyboard manual activation and Sessions-only default pinned.
12. ~~**B12 — M2 focus ring on ChatListItem rows**~~ — **DONE** with `.c-chat-item:focus-visible` and trusted browser proof.
13. ~~**B13 — DD-10 sort-button 24px floor fix**~~ — **DONE**: sort buttons, sm interactive
    pills, and removable-X are proven by `tests/browser/target-size.test.tsx`; DD-10 is closed.
14. **B14 — DD-18r remaining responsive legs** (Inbox viewport rows, drawer-flip case, legacy
    modal sizing SSOT, nav width pressure, MessageBubble hover-card positioning, non-Fleet
    side-panel law) (register: blocks final acceptance).

Polish (non-blocking): M1 tooltip/hover-card spec ruling · M3 skeleton spec · M4 chart token
adapter (WVR-001 expiry 2026-12-31) · M7 kbd · M10 datetime ruling · M13 ModeSwitchDialog →
CardSelector (could be folded into B8) · ChatListItem animationDelay literals · DD-9 half-steps
(incl. primitives.css's 6 lines) · DD-22/23/25/26/27/28/29/30 per
register · WizardStepper extraction · type-ramp definition (DD-26).

## 9. Strong-claim audit and limits of static analysis

Claims re-verified before publication:
- "348 = 327+18+2+1" — recomputed from the live `console/lint-shadow-baseline.json`;
  sums match the declared total.
- "zero TSX outline-none sites" — independent whole-tree grep plus `design-regression`
  check 12; the retired Inbox and HistoryTab sites now read as `TextArea`/button primitives.
- "zero raw form controls" — live shadow baseline and generated raw-form inventory now list no
  consumer raw `input`/`select`/`textarea` sites.
- "former c-btn-primary ok-green sites" — closed before this snapshot; definition now reads
  `background: var(--accent); border-color: var(--accent); color: var(--accent-fg);` at
  composites.css:733, and the live burndown queue reports `accent-law: 0`.
- "3 direct semantic var() refs in TSX" — single regex over a name subset (surface/text-1..3/
  border-*/status-*/mode-*/accent/focus-ring/scrim); a consumer using another semantic name
  (e.g. `--row-hover`) would be missed. Treat as "order of magnitude: screens don't use the
  v3 names directly", not an exact census.
- "184/285 = 64.6%" — counts Modal sub-components as sites and counts JSX *elements*, not
  rendered instances (a mapped row renders one JSX site many times). A different defensible
  counting rule would move this number; the formula is stated so it can be recomputed.
- DD-17 "half-stale" — based on reading ChatList.tsx's documented roving implementation; I did
  not run its tests.
- hex hits in api.ts/realtime-events.ts/type-guards.ts dismissed as false positives after
  reading the lines (ID/JID strings) — mock-data.ts hex are fixture values, judged out of UI scope.

What static analysis CANNOT prove: visual fidelity (no rendering, no theme screenshots — light/
dark parity, AA contrast, the actual green-vs-blue button appearance are inferred from CSS, not
observed); runtime behavior (focus traps, roving tabindex, Escape stacks, reduced-motion,
24px effective hit areas — these belong to the jsdom/browser suites and D7 trusted-event QA);
Tailwind generation specifics (whether every legacy utility class still emits CSS after config
changes); and completeness of the "missed surface" sweep beyond the patterns I greppped — a
hand-rolled pattern using novel class names with no raw elements would evade both the lint wall
and this audit.

---
Audit produced 2026-06-12. Read-only against code; this file is the only write.

## 10. Self-feeding burndown layer (mechanization of this audit)

The violation taxonomy above is mechanized by a fail-closed scanner + ratchet so the
burndown queue regenerates itself on every run, new violations block, and fixes shrink
the queue. **The queue JSON is the canonical machine-readable burndown; this document
remains the human analysis.**

Artifacts (all committed):

| Artifact | Role |
|---|---|
| `console/scripts/check-design-burndown.mjs` | scanner + ratchet (deterministic, fail-closed: parse errors and missing inputs RAISE — never silently empty) |
| `console/design-burndown-queue.json` | the live queue — items `{id, category, severity, count, files[{path,count,lines}], owner}` + summary `{total, blocking, byCategory}` |
| `console/design-burndown-baseline.json` | per-category ceiling `{category: count}` (fall-only ratchet) |
| `console/design-shadow-frozen-inventory.json` | exact file:line/message inventory for frozen shadow categories whose same-count movement should not pass silently |

Sources, by category:
- **Consumed from `lint-shadow-baseline.json`** (never re-counted — the shadow ratchet
  owns TSX enforcement; `lines` are `null`, line detail lives in the ESLint shadow run):
  `legacy-token-tsx` (B1), `brand-regression` (B5), `base-wall` (B5/B6),
  `utility-smell` (polish).
- **Frozen shadow line-shape inventory:** `check-shadow-frozen-inventory.mjs` reuses the
  same shadow ESLint JSON and pins exact file/line/message shape for `base-wall` and
  `brand-regression` (current total 22 = 20 + 2), closing the same-count drift gap left by
  rule×file ceilings.
- **CSS-side scans** (what ESLint cannot see, §6 census mechanized, with file:line):
  `legacy-var-css` (B1 — legacy-name list DERIVED from the tokens.semantic.css
  "Legacy aliases" block, same derivation as §6), `accent-law` (B4 — F1 action-control
  selectors binding status-channel colors + M9 `accent-color:` status tokens; current
  committed queue is zero; the status-semantic `-danger/-success/-warning` variants are excluded by name),
  `raw-color-css` (raw hex/rgb/hsl/oklch outside the value-owning tiers
  tokens.primitive.css/tokens.semantic.css; zero ceiling),
  `raw-font-size-css` (raw non-token `font-size:` literals outside the primitive type scale;
  zero ceiling), `transition-all-css` (CSS `transition` / `transition-property` declarations
  targeting `all`; zero ceiling),
  `raw-dimension-css` (direct raw length units in layout/spacing/radius CSS declarations outside
  token files, with `var()` fallbacks ignored; current total 34 = 8 composites + 26 primitives),
  `half-step` (DD-9 — CSS *and* TSX/TS, since no ESLint rule covers the half-steps).
  Note: accent-law hits using alias names also count under legacy-var-css —
  intentional overlap, two remediation lenses (B4 law fix vs B1 vocabulary burn).

Regen / check commands:
- `npm --prefix console run design:burndown` — check (default; never writes). Exit 1 on:
  any category above its ceiling (message names category, delta, new file:lines);
  any category below it ("ratchet fall — run with `--update` to lower the baseline");
  queue drift (counts equal but violations moved → committed queue no longer byte-matches
  the live scan); or any malformed/missing input.
- `npm --prefix console run design:burndown -- --update` — rewrites baseline AND queue
  together (ride the same commit as the fix, with justification — same discipline as
  the shadow ratchet).

Wired unconditionally (fail-open forbidden) into: `.husky/pre-push`, root
`verify:push:branch` / `verify:release` (after `design:metrics`), and the
"Console design burndown" step in `.github/workflows/quality.yml`. Tests (negative
fixtures proving every scan fires, ratchet rise/fall/drift, fail-closed raises):
`tests/scripts/design-burndown-check.test.ts`.

Counting-rule notes vs this audit's original census (initial queue, 2026-06-12): the ESLint-side
categories reconciled with the original §5 snapshot (486 = 354+70+36+22+2+1+1). `legacy-var-css` counts
260 occurrences over 183 lines of composites.css — the §6 strict-vars subset agrees
exactly (97 lines), and the surplus over the "~153" extended figure is per-occurrence
counting (multiple `var()` per line) plus the motion aliases `--ease` (64) and
`--dur-norm` (18), which the derived alias list legitimately includes. `half-step`
counts occurrences (CSS 27/25 lines — composites 19 + primitives 6 lines, exact match
with §6; TSX/TS 41 occurrences/35 lines vs the census's 26-28 lines: occurrence
counting + .ts files included). `accent-law` previously counted CSS binding declarations
where F1 listed TSX consumer *sites*; the live queue now reports `accent-law: 0`, so that
historical basis mismatch is closed.
