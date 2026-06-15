# Duplication Register — WhatSoup Console DRY Audit

Input to SOUP Design System v3 (primitive -> semantic -> component token consolidation).

Scope: `console/src` (React 19 + Tailwind v4), tokens and composite `c-*` classes in `console/src/index.css` (1236 lines), lint guardrails in `console/eslint.config.js` (~106 `no-restricted-syntax` selectors split between a global set at `console/eslint.config.js:76-584` and a stricter scheduled/groups ratchet at `console/eslint.config.js:586-656` applied only to the file list at `console/eslint.config.js:689-702`).

Conventions:

- Every occurrence cites repo-relative `file:line`. Items that could not be pinned to evidence are marked Inconclusive.
- "Classification" is the consolidation target type: `primitive` | `composite` | `token` | `helper` | `docs rule` | `lint rule` | `deferred`.
- "Guarded" cites the eslint selector line(s) that already block the drift, or "unguarded". A recurring theme: design-system selectors historically matched only `Literal` values or `JSXAttribute[name.name="style"]`, so ternaries, identifiers, template-literal classNames, and non-`style` props all evaded the lint wall. Closed evasion paths are flagged per entry.

---

## DUP-01 — Button variant sprawl + reveal-on-hover label mechanic (4 copies)

**Pattern.** 11 `c-btn*` classes plus a structurally separate `.fc-action` button family. Within them, the "icon button that expands to reveal a text label on hover" mechanic (max-width 0 -> N + opacity 0 -> 1 transition on a child label span) is implemented four times with near-identical declarations, and the long per-variant `transition` property list is copy-pasted four times.

**Occurrences.**

- Base + variants: `.c-btn` `console/src/index.css:955-968`, `.c-btn-primary` `:970-971`, `.c-btn-danger` `:972-973`, `.c-btn-success` `:974-975`, `.c-btn-ghost` `:976-977`, `.c-btn-warning` `:978-979`, disabled `:982-983`, `.c-btn-sm` `:984`, `.c-btn-xs` `:985`, `.c-btn-nav` `:986-1008`, `.c-btn-send` `:1009-1036`, `.c-btn-add` `:1037-1069` (= 11 `c-btn*` classes at `console/src/index.css:954-1069`).
- Label-reveal copy 1: `.fc-action__label` `console/src/index.css:688-701` (max-width 0/opacity 0, hover -> `max-width: var(--feed-inst-max)`).
- Label-reveal copy 2: `.c-btn-nav-label` `console/src/index.css:994-1008` (hover -> `max-width: 60px` — magic number, not a token).
- Label-reveal copy 3: `.c-btn-send-label` `console/src/index.css:1020-1036` (hover -> `max-width: 50px` — magic number).
- Label-reveal copy 4: `.c-btn-add-label` `console/src/index.css:1052-1069` (hover -> `max-width: var(--feed-inst-max)`).
- Duplicated transition lists: `console/src/index.css:967`, `:992`, `:1018`, `:1050` (the `.fc-action` family relies on `:692` instead).
- TSX consumers of the reveal mechanic: `console/src/components/AddLineWizard.tsx:340-365`, `console/src/components/line-detail/HistoryTab.tsx:227-232`, `console/src/pages/SoupKitchen.tsx:423-427`, `console/src/pages/Inbox.tsx:455-462`, `console/src/components/FeedCard.tsx:322-398` (`.fc-action`/`.fc-action__label`).

**Classification.** composite.

**Proposed consolidation.** One `.c-btn--reveal` modifier (label span + shared transition custom property) replacing the four per-class copies; collapse `c-btn-send` into `c-btn-primary + c-btn--reveal` and fold `.fc-action` onto `c-btn c-btn-xs`.

**Guarded by lint?** Unguarded — all selectors target TSX AST; nothing inspects `index.css` for intra-CSS duplication. (`Literal[value=/\btransition-/]` rules at `console/eslint.config.js:122-136` only stop new TSX-side transitions.)

---

## DUP-02 — Pill/badge chrome re-rolled (8+ implementations, 6 distinct padding/font recipes)

**Pattern.** The "small mono pill: rounded-sm, tracking-pill, wash background" role is re-implemented per component with diverging font sizes, weights, and padding.

**Occurrences (actual declarations compared).**

| Copy | Evidence | Font | Padding |
|---|---|---|---|
| FilterPill | `console/src/components/FilterPill.tsx:22-29` | `text-sm` mono | `py sp-1(4px) px sp-2h(10px)`, tracking-pill, border via inline ternary |
| FilterPill count chip | `console/src/components/FilterPill.tsx:35-41` | `text-label` semibold | `px sp-1`, `rounded-xs`, inline bg/color ternary |
| TagInput tag | `console/src/components/TagInput.tsx:64-77` | `text-label` mono medium | `py sp-1 px sp-2(8px)`, no tracking, inline `color-mix` accent |
| LineTags tag | `console/src/components/LineTags.tsx:57-63` | `text-xs` mono medium | `py bw(1px) px sp-1h(6px)`, tracking-pill, inline color/bg |
| ModeBadge | `console/src/components/ModeBadge.tsx:35-41` | `text-label` mono medium | `padding: sp-0h(3px) sp-2h sp-0h sp-2` inline, tracking-pill |
| `.fc-inst` | `console/src/index.css:522-535` | `--text-label` mono semibold | `padding: bw sp-1h`, tracking-pill |
| `.fc-badge` | `console/src/index.css:537-562` | `--text-label` mono medium | `padding: 0 sp-1h`, tracking-pill, `--b2` border |
| ChartPanel warn pill | `console/src/components/ChartPanel.tsx:37-46` | `text-label` mono | `px sp-1h py sp-0h`, re-rolls `.fc-badge--warn` (`console/src/index.css:558`) with inline border triplet |
| AccessTab role pill | `console/src/components/line-detail/AccessTab.tsx:78` | `text-sm` mono medium | `py sp-0h px sp-2` |
| Log level badge | `console/src/components/line-detail/LogsTab.tsx:49` vs `console/src/pages/Ops.tsx:274` | `text-label` vs `text-xs` (inconsistent twins) | raw Tailwind `px-1.5 py-0.5 rounded` (off-token) |

**Classification.** primitive (a `Pill` component or single `.c-pill` composite with size + tone modifiers).

**Proposed consolidation.** One `.c-pill` base (mono, radius-sm, tracking-pill) + `--pill-pad`/`--pill-fs` size modifiers + tone modifiers reusing the `.fc-badge--*` tone set; migrate the 8 call sites.

**Guarded by lint?** Partially — raw hex/rgba inside these pills is blocked (`console/eslint.config.js:111-117`) and arbitrary px (`:227-229`), but nothing blocks re-rolling the pill recipe from approved tokens, and `px-1.5 py-0.5` (Tailwind numeric spacing utilities) is not covered by any selector. Unguarded for the structural duplication itself.

---

## DUP-03 — Custom dropdown/popover implementations + outside-click dismiss copies

**Pattern.** `.c-select` exists for native selects (`console/src/index.css:863-890`) but is consumed in exactly one place; meanwhile four custom popover dropdowns exist, two of which carry their own copy of the outside-click (`mousedown`) listener and two of which have no dismiss handling at all.

**Occurrences.**

- `.c-select` sole consumer: `console/src/components/wizard/form-primitives.tsx:72-74` (`SelectInput`).
- Native `<select>` NOT using `.c-select`: `console/src/components/line-detail/ConfigEditDialog.tsx:199-205` (bare select), `console/src/components/line-detail/GroupDetailModal.tsx:676-682` (select styled as `c-btn c-btn-xs c-btn-ghost` — a button class on a select).
- Custom popover 1: `console/src/components/LinePicker.tsx:64` and `:112` (two dropdown panels in one component) with `mousedown` outside-click at `console/src/components/LinePicker.tsx:29-30` and Escape at `:33-39`.
- Custom popover 2: `console/src/components/shared/ChatPicker.tsx:70` with `mousedown` at `console/src/components/shared/ChatPicker.tsx:27-28` and Escape at `:32`.
- Custom popover 3: `console/src/components/shared/ContactSearchPicker.tsx:67` (`absolute top-full z-50` results panel) — no `mousedown`/Escape dismiss (only a cleanup effect at `:21`); inconsistent with copies 1-2.
- Inline results list (non-popover, dismiss not required): `console/src/components/ContactSearch.tsx:65-75`.
- Note: CardSelector (`console/src/components/CardSelector.tsx:30-60`) and ChartPanel (`console/src/components/ChartPanel.tsx`) turned out NOT to be dropdowns (card grid / static panel) — the audit prompt's hypothesis there is disconfirmed. Nav (`console/src/components/Nav.tsx`) has no dropdown state (no `useState`/`mousedown`/`Escape` hits). LogsTab/Inbox filters use FilterPill rows, not popovers (`console/src/components/line-detail/LogsTab.tsx`, `console/src/pages/Inbox.tsx`).

**Classification.** helper (a `useDismissable(ref, onClose)` hook) + composite (`.c-dropdown` panel class; `.c-dropdown-item` already exists at `console/src/index.css:1222-1225`).

**Proposed consolidation.** Extract `useDismissable` (mousedown + Escape) consumed by LinePicker/ChatPicker/ContactSearchPicker, and a `.c-dropdown-panel` class unifying the `bg-d6 c-border-b2 shadow-[var(--shadow-md)]` vs `c-card` panel split (`console/src/components/LinePicker.tsx:64,112` vs `console/src/components/shared/ChatPicker.tsx:70`).

**Guarded by lint?** Unguarded — no selector covers event-handler or hook duplication.

---

## DUP-04 — Modal backdrop/shell/header split + Escape-to-close useEffect (9 copies)

**Pattern.** The identical `if (e.key === 'Escape') close()` keydown useEffect is hand-rolled nine times. Dialog shells split three ways: `.c-dialog` users, ad-hoc `bg-d2 rounded-lg shadow c-border` shells, and one hand-rolled backdrop.

**Occurrences.**

- Escape useEffect copies (9): `console/src/components/ConfirmDialog.tsx:28`, `console/src/components/RelinkModal.tsx:15`, `console/src/components/UpdateModal.tsx:129`, `console/src/components/LinePicker.tsx:37`, `console/src/components/shared/ChatPicker.tsx:32`, `console/src/components/line-detail/ScheduleComposerModal.tsx:103`, `console/src/components/line-detail/GroupDetailModal.tsx:731`, `console/src/components/line-detail/CreateGroupModal.tsx:34`, `console/src/pages/Inbox.tsx:205`.
- Modals with NO Escape handling (inconsistent): `console/src/components/AddLineWizard.tsx` (no `Escape` hit in file), `console/src/components/KeyboardShortcutsHelp.tsx` (backdrop click only; the global hook documents Escape as "browser-native for modals" at `console/src/hooks/use-keyboard-shortcuts.ts:21` but registers no Escape handler at `:29-60`).
- `.c-dialog-backdrop` (token home `console/src/index.css:915-924`) users (9): `console/src/components/ConfirmDialog.tsx:37`, `console/src/components/RelinkModal.tsx:24`, `console/src/components/UpdateModal.tsx:301`, `console/src/components/AddLineWizard.tsx:255`, `console/src/components/line-detail/GroupDetailModal.tsx:756`, `console/src/components/line-detail/ConfigEditDialog.tsx:264`, `console/src/components/line-detail/ScheduleComposerModal.tsx:174`, `console/src/components/line-detail/CreateGroupModal.tsx:65`, `console/src/pages/Inbox.tsx:620`.
- Hand-rolled backdrop (1): `console/src/components/KeyboardShortcutsHelp.tsx:20-22` (`fixed inset-0 ... bg-[var(--overlay)] z-[var(--z-overlay)]` — re-states `.c-dialog-backdrop` inline).
- `.c-dialog` shell (`console/src/index.css:925-931`) users (5): `console/src/components/KeyboardShortcutsHelp.tsx:24`, `console/src/components/line-detail/GroupDetailModal.tsx:761`, `console/src/components/line-detail/ConfigEditDialog.tsx:271`, `console/src/components/line-detail/ScheduleComposerModal.tsx:179`, `console/src/components/line-detail/CreateGroupModal.tsx:70`.
- Ad-hoc shells re-rolling it with `bg-d2` instead of `--color-d1` (5): `console/src/components/ConfirmDialog.tsx:44`, `console/src/components/RelinkModal.tsx:32`, `console/src/components/UpdateModal.tsx:309`, `console/src/components/AddLineWizard.tsx:263`, `console/src/pages/Inbox.tsx:625`.
- `.c-dialog-header` (`console/src/index.css:1111-1117`) used 4x (e.g. `console/src/components/line-detail/GroupDetailModal.tsx:765`, `console/src/components/line-detail/ConfigEditDialog.tsx:275`) while the same header recipe is re-rolled at `console/src/components/ConfirmDialog.tsx:49`, `console/src/components/RelinkModal.tsx:36`, `console/src/components/UpdateModal.tsx:313`, `console/src/pages/Inbox.tsx:628` (`flex items-center justify-between c-border-b py-[var(--sp-4)] px-[var(--sp-5)]` — byte-for-byte the `.c-dialog-header` declarations).

**Classification.** helper (`useEscapeClose`/`Modal` wrapper) + composite (finish `.c-dialog`/`.c-dialog-header` adoption; decide d1-vs-d2 dialog surface once).

**Proposed consolidation.** One `Modal` component (backdrop + shell + header + Escape + click-outside) consumed by all 11 modal surfaces; delete the nine keydown effects.

**Guarded by lint?** Unguarded — no selector covers modal structure or duplicated effects. The `<button type>` rule (`console/eslint.config.js:556-558`) incidentally guards modal buttons only.

---

## DUP-05 — Card/panel shell variants

**Pattern.** Three CSS shells plus JS-object and inline re-rolls of "dark panel with 1px border and radius".

**Occurrences.**

- `.c-card` `console/src/index.css:940-945` (d2 + `--b1` + radius-lg + card-shadow) vs `.c-section` `console/src/index.css:1103-1108` (identical surface/border/radius, adds `padding: sp-7`, drops shadow) — two names for one shell differing only in padding/shadow.
- Ad-hoc `bg-d2 + c-border + rounded-*` combos: `console/src/components/ConfirmDialog.tsx:44`, `console/src/components/RelinkModal.tsx:32`, `console/src/components/UpdateModal.tsx:309`, `console/src/components/AddLineWizard.tsx:263`, `console/src/pages/Inbox.tsx:507` (`bg-d2 rounded-md ... c-border`), `console/src/pages/Inbox.tsx:625`, `console/src/pages/LineDetail.tsx:138` (`c-toolbar ... bg-d2 c-border rounded-lg`).
- Third shell recipe: `console/src/components/ChartPanel.tsx:31` (`rounded-[var(--radius-md)] bg-d3 p-[var(--sp-3)] c-border` — d3 + radius-md, neither c-card nor c-section).
- JS style-object shell: `console/src/components/wizard/ReviewStep.tsx:17-22` (`cardStyle`: d1 + `--b2` + radius-md + sp-4 padding) — a fourth recipe living in TS.
- For contrast, `.c-card` legitimate consumers: `console/src/components/MessageBubble.tsx:27`, `console/src/components/shared/ChatPicker.tsx:70`, `console/src/components/line-detail/AccessTab.tsx` (3 uses), `console/src/components/line-detail/MetricsTab.tsx` (4 uses), etc.

**Classification.** composite.

**Proposed consolidation.** Single `.c-card` with `--card-surface`/`--card-pad` modifier hooks (`c-card--section`, `c-card--chart`, `c-card--dialog`); retire `.c-section` and the four ad-hoc recipes.

**Guarded by lint?** Unguarded — class-string combinations of approved utilities are invisible to all selectors; `border` shorthand-in-style is blocked (`console/eslint.config.js:523-529`) which pushed ReviewStep to longhand triplets (`console/src/components/wizard/ReviewStep.tsx:19`) but did not prevent the shell re-roll.

---

## DUP-06 — Status dot/badge visual variants

**Pattern.** "Render a status as colored dot/badge" exists as at least seven visual implementations, with one remaining radius-as-size misuse.

**Occurrences.**

- `StatusDot`: `console/src/components/StatusDot.tsx` is now a thin `StatusCell` wrapper; the former `sizePx`/`colorMap`/`glowMap` copy and template-literal px sizing path are closed.
- `ModeBadge` dot: `console/src/components/ModeBadge.tsx:42-44` (`--dot-badge` token, separate dot recipe).
- Re-rolled status dot: `console/src/components/line-detail/ScheduledMessageRow.tsx:92-98` — dot sized with `w-[var(--radius-md)] h-[var(--radius-md)]` (a border-radius token used as a width) and colored by `statusColor(...)` inline.
- Line-header mode dot: `console/src/pages/LineDetail.tsx:247` (`background: var(--color-m-${modeColor})` inline).
- Badge tone sets in CSS: `.fc-inst--passive/chat/agent` `console/src/index.css:533-535`, `.fc-badge--ok/warn/crit/recv/sent/agent` `console/src/index.css:556-562`, `.fc-headline--ok/warn/crit/...` `console/src/index.css:579-584`.
- Scheduled status badge: `console/src/components/line-detail/scheduled-utils.ts:6-15` (`statusColor`) rendered at `console/src/components/line-detail/ScheduledMessageRow.tsx:88-100`.
- Health status icon tones: `console/src/components/FeedIcon.tsx:44` (`online -> text-s-ok : unreachable -> text-s-crit : text-s-warn` ternary).
- Role badges: `console/src/components/line-detail/groups-utils.ts:7-11` (`roleBadgeStyle` wash/color pairs).

**Classification.** token (semantic status tier: `status.ok/warn/crit/neutral` with `fg/wash/border/glow` slots) + primitive (`StatusBadge`/`StatusDot` consuming it).

**Proposed consolidation.** Define one semantic status token map in CSS, make StatusDot/Pill consume it, and replace the six per-domain color tables with domain->semantic-status adapters.

**Guarded by lint?** Partially — inline `color: var(--color-s-*)` in style is pushed to classes (`console/eslint.config.js:202-204`) and hex/hsl blocked (`:115-117`, `:577-583`), while `soup/no-component-local-palette` now reaches all `console/src/**` TS/TSX files except the canonical `console/src/lib/color-semantics.ts` helper. Remaining gaps include component-specific status maps and the token-misuse (`w-[var(--radius-md)]` as a size).

---

## DUP-07 — Mode/status -> color mapping logic in TS (8 copies)

**Pattern.** The `Mode -> 'pas'|'cht'|'agt'` mapping and its color-variable derivatives are re-implemented across the tree despite a canonical helper existing.

**Occurrences (every copy).**

1. Canonical: `getModeColor` at `console/src/components/line-detail/types.ts:8-10` (consumed correctly at `console/src/components/line-detail/SummaryTab.tsx:25`).
2. Inline re-roll: `console/src/pages/LineDetail.tsx:117` (`line.mode === 'passive' ? 'pas' : ... 'agt'` — identical expression).
3. Inline re-roll: `console/src/components/line-detail/ModeSwitchDialog.tsx:48` (`modeKey` local fn, identical expression).
4. Identity re-map: `console/src/components/line-detail/PipelineTab.tsx:20` (`color === 'pas' ? 'pas' : ...` — maps an already-mapped value).
5. Identity re-map duplicate: `console/src/components/line-detail/PipelineTab.tsx:147` (same expression again in the same file).
6. Mode -> class/wash table: `console/src/components/ModeBadge.tsx:9-29` (`config` record).
7. Color-var -> wash-var table: `console/src/components/CardSelector.tsx:18-28` (`colorToWash`).
8. Reverse class -> color-var table: `console/src/components/KpiCard.tsx:13-21` (`colorMap`).

Related single-purpose tables counted under DUP-06: `console/src/components/line-detail/scheduled-utils.ts:6-15`, `console/src/components/LineTags.tsx:16-33`.

**Classification.** helper.

**Proposed consolidation.** One `mode-theme.ts` module exporting `getModeColor` plus derived accessors (`modeTextClass`, `modeWashVar`, `washFor(colorVar)`); delete copies 2-8 and import.

**Guarded by lint?** Unguarded — no selector inspects TS logic duplication.

---

## DUP-08 — Inline-style spacing one-offs and lint-evasion paths

**Pattern.** 125 `style={{ ... }}` occurrences across TSX (volume measured by `grep -c "style={{"`). Most now carry tokens (the lint wall works), but hardcoded values survive through AST shapes the selectors cannot see.

**Occurrences (quantified + sampled).**

- Volume: 125 `style={{` across `console/src` TSX; top files: `console/src/components/wizard/ConfigStep.tsx` (9), `console/src/components/ActiveHoursHeatmap.tsx` (8), `console/src/pages/Inbox.tsx` (6), `console/src/components/AddLineWizard.tsx` (6), `console/src/components/MessageContent.tsx` (5), `console/src/components/ChartPanel.tsx` (5).
- Inline `padding:` keys: only 8 remain, 7 tokenized (e.g. `console/src/components/MessageBubble.tsx:140`, `console/src/components/wizard/ReviewStep.tsx:22`, `console/src/components/line-detail/PipelineTab.tsx:22`). Conditional string branches with hardcoded px are now pinned by ESLint.
- Identifier-passed numerics: closed for observed dimensional consts — `ChartPanel.tsx` now uses `--chart-panel-h` / `--chart-panel-h-expanded`, and ESLint rejects dimensional consts initialized from raw numeric conditional branches before they flow into `style={{ height }}`.
- Template-literal classNames: closed for utility-size payloads — `HeartbeatStrip.tsx` now uses `w-[var(--heartbeat-bar-w)] rounded-[var(--bw)]`, and `soup/no-utility-smell` scans `TemplateLiteral` quasis for non-`var()` arbitrary utility payloads.
- Template-literal hardcoded px formulas in style: closed for numeric-literal formulas — `Skeleton.tsx` now uses tokenized `TABLE_SKELETON_WIDTHS`, and `eslint.config.js` rejects dimensional style template literals that combine `px` quasis with numeric literals. Measured runtime layout values such as virtualizer heights remain allowed.

**Classification.** lint rule (close remaining evasion shapes) + tokens for surviving hardcoded geometry.

**Proposed consolidation.** Template-literal utility px, hardcoded px-formula, conditional hardcoded-px, and observed dimensional-const re-entry are now pinned. Broader identifier dataflow stays out of scope until a concrete source pattern appears.

**Guarded by lint?** Mostly guarded for `Literal` values (`console/eslint.config.js:157-191`, `:227-229`) plus the newly covered `TemplateLiteral` class/style shapes, conditional raw-px branches, and dimensional const numeric branches. Remaining unguarded path is Recharts wrapper props.

---

## DUP-09 — Typography one-offs vs composite roles

**Pattern.** The composite typography utilities (`c-col-header`/`c-label`/`c-section-label`/`c-data`/`c-meta`/`c-heading`/`c-body`/`c-kpi-value` at `console/src/index.css:741-823`) have largely won — but a recharts-shaped hole and one JS style object remain.

**Occurrences.**

- Chart legend fontSize duplicated 4x through a non-`style` prop: closed — the four `<Legend wrapperStyle={{ fontSize: 'var(--text-xs)' }} />` copies now consume `LEGEND_STYLE` from `console/src/lib/chart-utils.ts`, and the fontSize-token rule covers inline `style`/`wrapperStyle`/`contentStyle` objects.
- JS heading role re-roll: `console/src/components/wizard/ReviewStep.tsx:32-36` (`headingStyle` = tracking-label + t2 — restates the `c-label`/`c-section-label` role as a style object).
- Ad-hoc mono+text-size+text-color combos duplicating `c-data`/`c-meta`: only 1 regex hit tree-wide (`font-mono text-* ... text-tN`), e.g. the recipe is effectively migrated. Residual mixed-role strings: `console/src/pages/Inbox.tsx:629` (`font-sans font-semibold text-lg` instead of `c-heading-lg`).
- `fontSize: 'inherit'` at `console/src/lib/format-wa-text.tsx:60,66` — benign (escape hatch, not a one-off scale value).

**Classification.** helper + lint rule.

**Proposed consolidation.** Remaining: replace `ReviewStep` `headingStyle` with `c-section-label`. Closed: `LEGEND_STYLE` now lives beside `AXIS_TICK` and is consumed by all four charts.

**Guarded by lint?** Hardcoded fontSize is guarded (`console/eslint.config.js:81-87`); token-in-style props are guarded for inline `style`/`wrapperStyle`/`contentStyle` objects; JS style objects assigned outside JSX attributes remain waiver-tracked (`WVR-007`).

---

## DUP-10 — Table / log-viewer implementations

**Pattern.** One spec-compliant table (`c-cell` = `padding: sp-2h sp-4`, `console/src/index.css:829`) and three re-rolled cell-padding schemes, including two near-identical log viewers with different paddings and different badge font sizes.

**Occurrences.**

- Canonical: SoupKitchen table — headers `console/src/pages/SoupKitchen.tsx:439` (`c-col-header c-cell`), cells `console/src/pages/SoupKitchen.tsx:467-500` (13 `c-cell` tds), column-width tokens at `console/src/pages/SoupKitchen.tsx:33-44`.
- Log viewer A: `console/src/components/line-detail/LogsTab.tsx:43-62` — raw Tailwind `px-3 py-1` / `px-2 py-1` cell padding (12/8px x 4px, off the `c-cell` spec) with level badge `text-label` at `:49`.
- Log viewer B (structural twin of A): `console/src/pages/Ops.tsx:258-289` — same columns and `--log-col-*` width tokens but different padding (`py-[var(--sp-2)] px-[var(--sp-3)]` at `:266`, `p-[var(--sp-2)]` at `:271`) and level badge `text-xs` at `:274` (vs A's `text-label`). Two whole-component copies that have already drifted.
- AccessTab list: row padding `py-[var(--sp-2h)] px-[var(--sp-4)]` at `console/src/components/line-detail/AccessTab.tsx:56` — the exact `c-cell` values re-typed as utilities; headers re-roll via `c-toolbar c-border-b c-col-header` at `:135`, `:147`, `:155` (`c-toolbar` happens to share `c-cell` padding, `console/src/index.css:830`).
- ScheduledTab/HistoryTab are card/chat lists, not tables (`console/src/components/line-detail/ScheduledTab.tsx:105` uses `c-col-header`; `console/src/components/line-detail/HistoryTab.tsx:128` transcript) — no cell duplication beyond DUP-02's badges.

**Classification.** composite (adopt `c-cell`) + primitive (shared `LogViewer` component for LogsTab/Ops).

**Proposed consolidation.** Extract one `LogViewer` (columns, level badge, row hover) used by both LogsTab and Ops; replace AccessTab's re-typed padding with `c-cell`.

**Guarded by lint?** Unguarded — `px-3 py-1` Tailwind numeric utilities and re-typed token combos are not covered by any selector (the px rules target inline style and `[Npx]` arbitraries only).

---

## DUP-11 — Empty / error / loading states

**Pattern.** A capable `EmptyState` component exists (icon/title/description/error-variant/retry at `console/src/components/EmptyState.tsx:20-83`) alongside five ad-hoc empties, one CSS-class empty, ten hand-placed spinners, and a skeleton used by exactly one page.

**Occurrences.**

- `EmptyState` consumers (8 files): `console/src/components/line-detail/GroupsTab.tsx:60`, `console/src/components/line-detail/ScheduledTab.tsx:121`, `console/src/components/line-detail/HistoryTab.tsx:285`, `console/src/components/line-detail/MetricsTab.tsx:77`, `console/src/components/line-detail/ModeTab.tsx`, `console/src/components/line-detail/GroupDetailModal.tsx`, `console/src/pages/Inbox.tsx:410`, `console/src/components/ErrorBoundary.tsx`.
- Ad-hoc empties: `console/src/components/ActivityFeed.tsx:201-203` (uses `.feed-empty` CSS at `console/src/index.css:435-443` — a second empty-state implementation in CSS), `console/src/components/ChartPanel.tsx:79-86` ("No data yet" with its own icon/typography), `console/src/components/ChartPanel.tsx:58-77` (own error + retry block re-rolling EmptyState's `variant="error"` + `onRetry`), `console/src/pages/Inbox.tsx:245` ("No chats found" span), `console/src/components/line-detail/HistoryTab.tsx:150` ("No more messages"), `console/src/components/ContactSearch.tsx:59-63` ("No contacts found").
- Spinners: ad-hoc `Loader2 + animate-spin` at `console/src/components/ContactSearch.tsx:55`, `console/src/components/UpdateModal.tsx:292`, `:362`, `:413`, `console/src/components/AddLineWizard.tsx:360`, `console/src/components/wizard/IdentityStep.tsx:127`, `console/src/components/wizard/ReviewStep.tsx:217`, `console/src/components/wizard/LinkStep.tsx:179`, `:206` — no shared `Spinner` primitive.
- Skeletons: `TableSkeleton` (`console/src/components/Skeleton.tsx:12`) consumed only at `console/src/pages/LineDetail.tsx:112`; ChartPanel rolls `animate-shimmer` directly at `console/src/components/ChartPanel.tsx:53-57`.

**Classification.** primitive (Spinner) + composite (route ChartPanel/feed empties through EmptyState with a `size="compact"` variant).

**Proposed consolidation.** Add a compact EmptyState variant + `Spinner` primitive; retire `.feed-empty` CSS and ChartPanel's three hand-rolled states.

**Guarded by lint?** Unguarded.

---

## DUP-12 — Wizard form primitives vs re-rolled dialog fields

**Pattern.** `console/src/components/wizard/form-primitives.tsx` exports a full field kit — `Field` (`:20`), `TextInput` (`:44`), `NumberInput` (`:57`), `SelectInput` (`:71`), `TextArea` (`:87`), `CheckboxField` (`:106`) — but it is consumed only inside the wizard, so every line-detail dialog re-rolls label+input+helper by hand from the raw `c-field-label`/`c-input` classes.

**Occurrences.**

- Kit consumers (wizard only): `console/src/components/wizard/ConfigStep.tsx:5`, `console/src/components/wizard/ModelAuthStep.tsx:3`.
- Re-rolled field pattern: `console/src/components/line-detail/CreateGroupModal.tsx:91-106` (label `c-field-label` + `c-input`, hand-built required-marker), `console/src/components/line-detail/ScheduleComposerModal.tsx:201-292` (6 `c-field-label` labels with bespoke inputs), `console/src/components/line-detail/ConfigEditDialog.tsx:199-205` (bare `<select>`, no kit, no `.c-select`; file imports no form primitives — see imports at `console/src/components/line-detail/ConfigEditDialog.tsx:1-21`), `console/src/pages/Inbox.tsx:635-640` (save-contact field).
- Helper/error text re-rolls vs `.c-helper`/`.c-error` (`console/src/index.css:897-907`): `Field` renders them internally (`console/src/components/wizard/form-primitives.tsx:20-40`); dialogs hand-place spans.

**Classification.** primitive (promote to `console/src/components/shared/`).

**Proposed consolidation.** Move form-primitives to `shared/`, swap the four dialog surfaces onto `Field`/`TextInput`/`SelectInput` (also closes DUP-03's `.c-select` underuse).

**Guarded by lint?** Unguarded — though the strict ratchet file list (`console/eslint.config.js:689-702`) already covers CreateGroupModal/ScheduleComposerModal/ConfigEditDialog for style drift, it cannot mandate component reuse.

---

## DUP-13 — Time formatting: canonical lib vs raw `toLocale*` bypasses

**Pattern.** `console/src/lib/format-time.ts` is the documented canonical surface ("All user-facing timestamps should use these", `console/src/lib/format-time.ts:1-4`) with `formatRelative` (`:17`), `formatTime` (`:35`), `formatTimeWithSeconds` (`:44`), `formatChatTime` (`:57`), `formatFullTime` (`:76`). It only accepts ISO strings, so epoch-seconds call sites bypass it with raw `toLocale*`.

**Occurrences (bypasses).**

- `console/src/components/line-detail/ScheduledMessageRow.tsx:107`, `:195`, `:198`, `:204` — `new Date(epochSeconds * 1000).toLocaleString()` four times in one file.
- `console/src/components/line-detail/GroupDetailModal.tsx:115` — `new Date(detail.creation * 1000).toLocaleDateString(...)`.
- `console/src/components/ActiveHoursHeatmap.tsx:26` — `toLocaleDateString([], { month: 'short', day: 'numeric' })`, duplicating `console/src/lib/chart-utils.ts:32` exactly; the same month-short/day-numeric recipe also appears at `console/src/lib/chart-utils.ts:45`, `:47`, `:49-50` and `console/src/lib/format-time.ts:72` (6 copies of one date recipe across 3 files).
- Chart family kept separate by design: `formatBucketLabel`/`formatTooltipLabel` at `console/src/lib/chart-utils.ts:29`, `:40` (bucket-range aware) — acceptable split, but should share the date-recipe constants with format-time.

**Classification.** helper.

**Proposed consolidation.** Add epoch-second overloads (`formatFullTime(epoch: number)`) and a shared `DATE_SHORT` options constant; then a lint rule banning `toLocale(Date|Time)?String` outside `console/src/lib/`.

**Guarded by lint?** Unguarded — no selector mentions `toLocale`.

---

## DUP-14 — Number formatting: compact vs locale strings

**Pattern.** `formatCompact` (`console/src/lib/text-utils.ts:61-64`) and raw `.toLocaleString()` are mixed ad hoc for the same "big count" role, sometimes in the same expression.

**Occurrences.**

- `formatCompact` consumers: `console/src/components/FleetSessionChart.tsx:44`, `:66`, `console/src/components/FleetTokenChart.tsx:56`, `:119`, `console/src/pages/SoupKitchen.tsx:485`.
- Raw `.toLocaleString()` for counts: `console/src/pages/SoupKitchen.tsx:239`, `:247`, `:270`, `:485` (same line uses both: compact in cell, locale in title attr — intentional but undocumented), `console/src/components/line-detail/MetricsTab.tsx:146`, `:153`, `:160`, `console/src/components/line-detail/PipelineTab.tsx:104-105`, `console/src/components/line-detail/SummaryTab.tsx:67`, `console/src/pages/LineDetail.tsx:181`, `console/src/components/wizard/ReviewStep.tsx:175`, `console/src/components/FleetTokenChart.tsx:62`, `:125`.
- Bytes: `console/src/components/MessageContent.tsx:18-20` (`formatBytes`-style inline, single copy — fine where it is, candidate for `text-utils`).

**Classification.** helper + docs rule (when to use compact vs full).

**Proposed consolidation.** `formatCount(n, { compact })` in `console/src/lib/text-utils.ts` with a documented rule: compact in cells/axes, locale in tooltips/titles.

**Guarded by lint?** Unguarded.

---

## DUP-15 — `cronToHuman` duplicated across client and server

**Pattern.** Browser copy of a server function, with a comment promising manual sync.

**Occurrences.**

- Client: `console/src/components/line-detail/scheduled-utils.ts:42` with the admission at `console/src/components/line-detail/scheduled-utils.ts:38-41`: "Canonical implementation: src/core/cron.ts cronToHuman(). Keep both in sync."
- Server: `src/core/cron.ts` (cited by the comment above; not independently verified in this audit — Inconclusive on exact line).

**Classification.** docs rule + deferred (cross-package extraction needs a shared module or generated artifact; "keep in sync" comments are the documented interim control).

**Proposed consolidation.** Shared `cron-human` module (or a contract test pinning both outputs) so the sync promise is enforced, not remembered.

**Guarded by lint?** Unguarded.

---

## DUP-16 — Copy-to-clipboard handlers (2 independent implementations)

**Pattern.** Clipboard write + user feedback wired twice with different feedback contracts.

**Occurrences.**

- Flow 1 (callback-plumbed): `console/src/components/FeedCard.tsx:324-331` (`navigator.clipboard.writeText(...).then/catch -> onCopyResult`) feeding `console/src/components/ActivityFeed.tsx:129-132` (`handleCopyResult` -> toast).
- Flow 2 (inline): `console/src/components/line-detail/GroupDetailModal.tsx:98` (`navigator.clipboard.writeText(inviteLink).then(() => toast.success(...))` — no catch branch, unlike flow 1).

**Classification.** helper.

**Proposed consolidation.** `copyToClipboard(text): Promise<boolean>` in `console/src/lib/` with toast handled by callers; gives flow 2 its missing failure path.

**Guarded by lint?** Unguarded.

---

## DUP-17 — Em-dash empty-value placeholder (5+ copies)

**Pattern.** The "—" placeholder for missing values is independently declared across the tree in three encodings.

**Occurrences.**

- `console/src/lib/format-time.ts:6` (`EMPTY_TIME = "—"`).
- `console/src/components/FeedCard.tsx:48` (`EMPTY_TEXT = "—"`).
- `console/src/lib/format-wa-text.tsx:14` (`EMPTY_TEXT = '—'`).
- `console/src/pages/SoupKitchen.tsx:486`, `:491`, `:502` (`String.fromCharCode(0x2014)` — third encoding).
- `console/src/lib/text-utils.ts` returns literal `'—'` in `displayInstanceName`/`resolveDisplayName`/`formatPhone` (e.g. `console/src/lib/text-utils.ts:18`, occurrences throughout the file).

**Classification.** helper (single `EMPTY_VALUE` export in `console/src/lib/text-utils.ts`).

**Proposed consolidation.** Export `EMPTY_VALUE` once and import it; replace the `String.fromCharCode` calls.

**Guarded by lint?** Unguarded.

---

## Disconfirmed / Inconclusive

- CardSelector, ChartPanel, Nav, LogsTab, Inbox as "custom dropdowns" (audit prompt item 3): disconfirmed — no popover open-state in those components (`console/src/components/CardSelector.tsx:30-60` card grid; `console/src/components/ChartPanel.tsx` static; no `useState`/`mousedown` in `console/src/components/Nav.tsx`). The real dropdown set is LinePicker/ChatPicker/ContactSearchPicker (DUP-03).
- Avatar-hue hashing copies (audit prompt item 14): disconfirmed as duplication — exactly one implementation, `avatarColor` at `console/src/components/line-detail/groups-utils.ts:37-42`, consuming the `--avatar-hue-0..7` tokens (`console/src/index.css:119-126`). No second copy found (`charCodeAt` appears nowhere else).
- Sort-logic duplication: no meaningful copies — `console/src/components/line-detail/ScheduledTab.tsx:39`, `:42` are two intentionally different sorts (upcoming asc / history desc); SoupKitchen's column sort is single-sited (`console/src/pages/SoupKitchen.tsx:33-44`).
- `src/core/cron.ts` server-side line number for DUP-15: Inconclusive (outside `console/`; cited from the client comment only).
- Existing scoped lint-suppression escape hatches are documented in source (`console/src/lib/chart-utils.ts:10`, `:14`; `console/src/components/QrDisplay.tsx:17`) — not counted as drift.

---

## Summary

| ID | Pattern | Copies | Classification | Guarded by lint? |
|---|---|---|---|---|
| DUP-01 | Button sprawl + reveal-label mechanic | 11 variants; 4 mechanic copies (index.css:688-701, 994-1008, 1020-1036, 1052-1069) | composite | unguarded (CSS-side) |
| DUP-02 | Pill/badge chrome re-rolls | 8+ implementations, 6 padding/font recipes | primitive | partial (colors/px only: eslint.config.js:111-117, 227-229) |
| DUP-03 | Custom dropdowns + outside-click dismiss | 3 popovers; 2 dismiss copies; 2 missing dismiss; .c-select used 1x | helper + composite | unguarded |
| DUP-04 | Modal backdrop/shell/header + Escape effect | 9 Escape copies; 5 vs 5 shell split; 4 header re-rolls | helper + composite | unguarded |
| DUP-05 | Card/panel shells | 4 recipes (.c-card/.c-section/ChartPanel/ReviewStep) + 7 ad-hoc combos | composite | unguarded |
| DUP-06 | Status dot/badge visuals | 7 visual implementations; 2 token misuses | token + primitive | partial (style-prop colors: eslint.config.js:202-204) |
| DUP-07 | Mode/status->color TS maps | 8 copies | helper | unguarded |
| DUP-08 | Inline-style spacing one-offs | 125 style={{ }}; observed lint-evasion shapes closed | lint rule + token | guarded for observed evasion shapes |
| DUP-09 | Typography one-offs | Legend fontSize copies closed; 2 JS role re-rolls remain | helper + lint rule | partial (inline wrapperStyle guarded; JS style-object helpers waiver-tracked) |
| DUP-10 | Table/log-viewer cells | 4 padding schemes; 2 whole-component log viewers | composite + primitive | unguarded |
| DUP-11 | Empty/error/loading states | 6 ad-hoc empties; 9 ad-hoc spinners; skeleton used 1x | primitive + composite | unguarded |
| DUP-12 | Form field kit vs dialog re-rolls | kit used by 2 wizard files; 4 dialog surfaces re-roll | primitive | unguarded |
| DUP-13 | Time formatting bypasses | 6 raw toLocale call sites; date recipe x6 | helper | unguarded |
| DUP-14 | Number formatting mix | formatCompact x5 vs toLocaleString x13 | helper + docs rule | unguarded |
| DUP-15 | cronToHuman client/server | 2 (cross-package) | docs rule + deferred | unguarded |
| DUP-16 | Copy-to-clipboard | 2 implementations | helper | unguarded |
| DUP-17 | Em-dash placeholder | 5+ declarations, 3 encodings | helper | unguarded |
