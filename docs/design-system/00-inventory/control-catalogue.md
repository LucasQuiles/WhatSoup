# Control Catalogue — Form & Interactive Control Variant Matrix

Design-system audit of the WhatSoup console (`console/src`). Every claim carries repo-relative
`file:line` evidence. Counts are exact-token greps over `console/src/**/*.tsx` (word-boundary
matching, so `c-btn` does not double-count `c-btn-primary`). Line numbers verified against the
tree at audit time.

**Status note, 2026-06-14:** the class-count and line-anchor sections are historical
pre-primitive-migration census data. Live TSX usage of `c-btn*` is now zero; use
`lint-shadow-baseline.json`, `design-burndown-queue.json`, and the adoption audit for current
burndown counts until this catalogue is fully regenerated.

Canonical composite classes now live in `console/src/styles/composites.css`. Historical anchor points:

| Class | Defined at |
|---|---|
| `.c-input` | `console/src/index.css:834` |
| `.c-input-search` | `console/src/index.css:857` |
| `.c-select` | `console/src/index.css:863` |
| `.c-input-number` | `console/src/index.css:892` |
| `.c-helper` / `.c-error` | `console/src/index.css:897` / `console/src/index.css:903` |
| `.c-checkbox-row` | `console/src/index.css:909` |
| `.c-dialog-backdrop` / `.c-dialog` / `.c-dialog-body` | `console/src/index.css:915` / `:925` / `:932` |
| `.c-card` / `.c-card--detail` | `console/src/index.css:940` / `:946` |
| `.c-btn` family | `console/src/index.css:955-1069` |
| `.c-tab` | `console/src/index.css:1072` |
| `.c-kbd` | `console/src/index.css:1092` |
| `.c-section` | `console/src/index.css:1103` |
| `.c-dialog-header` / `.c-dialog-footer` | `console/src/index.css:1111` / `:1120` |
| `.c-toggle` | `console/src/index.css:1162` |
| `.c-chat-item` / `.c-msg-bubble` / `.c-kpi-hover` | `console/src/index.css:1190` / `:1197` / `:1203` |
| `.c-nav-link` / `.c-dropdown-item` / `.c-row-hover` | `console/src/index.css:1217` / `:1222` / `:1228` |
| `.c-cell` / `.c-toolbar` / `.c-kpi-pad` | `console/src/index.css:829` / `:830` / `:831` |

Note: the brief cited `.c-btn` at `:954`; the selector itself opens at `console/src/index.css:955`
(`:954` is the section comment). All other cited line numbers were confirmed accurate.

---

## 1. Buttons

### 1a. Class usage counts (exact-token grep, `*.tsx`)

| Class | Count | Representative call sites |
|---|---|---|
| `c-btn` (base) | 104 | `console/src/components/line-detail/SummaryTab.tsx:206`, `console/src/pages/Ops.tsx:177` |
| `c-btn-primary` | 33 | `console/src/components/ConfirmDialog.tsx:88`, `console/src/components/UpdateModal.tsx:336`, `console/src/components/EmptyState.tsx:66`, `console/src/components/line-detail/GroupsTab.tsx:50`, `console/src/components/line-detail/MetricsTab.tsx:45` |
| `c-btn-ghost` | 59 | `console/src/components/ConfirmDialog.tsx:58`, `console/src/components/Toast.tsx:53`, `console/src/components/MessageBubble.tsx:74`, `console/src/pages/LineDetail.tsx:197` |
| `c-btn-sm` | 41 | `console/src/components/line-detail/ScheduledMessageRow.tsx:147`, `console/src/components/line-detail/AccessTab.tsx:93`, `console/src/pages/Inbox.tsx:533` |
| `c-btn-xs` | 14 | `console/src/components/wizard/ConfigStep.tsx:559`, `console/src/components/line-detail/GroupDetailModal.tsx:561` |
| `c-btn-danger` | 10 | `console/src/components/ConfirmDialog.tsx:86`, `console/src/components/line-detail/AccessTab.tsx:100`, `console/src/pages/Inbox.tsx:576`, `console/src/components/line-detail/SummaryTab.tsx:230` |
| `c-btn-success` | 3 | `console/src/components/line-detail/AccessTab.tsx:93`, `:120`, `console/src/pages/Inbox.tsx:557` |
| `c-btn-warning` | 1 | `console/src/components/ConfirmDialog.tsx:87` (variant ternary; only reachable via `confirmVariant="warning"`) |
| `c-btn-nav` | 2 | `console/src/components/AddLineWizard.tsx:340`, `:354` (labels `c-btn-nav-label` at `:347`, `:361`, `:365`) |
| `c-btn-send` | 2 | `console/src/components/line-detail/HistoryTab.tsx:227`, `console/src/pages/Inbox.tsx:455` (labels at `HistoryTab.tsx:232`, `Inbox.tsx:462`) |
| `c-btn-add` | 1 | `console/src/pages/SoupKitchen.tsx:423` (label at `:427`) |

### 1b. Buttons NOT using `c-btn`

Tag-level audit (parsing each `<button` opening tag including multiline JSX): **135 `<button>`
elements across 42 files; 111 carry `c-btn` or `c-tab`; 24 are raw** with ad-hoc classes/inline
styles:

| Call site | What it is | Styling approach |
|---|---|---|
| `console/src/components/Nav.tsx:159` | update-available chip | ad-hoc `c-hover` + wash bg |
| `console/src/components/FilterPill.tsx:18` | filter pill primitive | own pill styling (see §5) |
| `console/src/components/KpiCard.tsx:29` | KPI card-as-button | `c-kpi-pad c-kpi-hover` + inline border/bg |
| `console/src/components/ContactSearch.tsx:68` | contact result row | ad-hoc `c-hover` row |
| `console/src/components/FeedCard.tsx:319`, `:341`, `:363`, `:383` | feed hover actions | `fc-action` family (`console/src/index.css:670-710`) |
| `console/src/components/TagInput.tsx:74` | tag remove "X" | inline `background:none;border:none` |
| `console/src/components/LinePicker.tsx:46`, `:71`, `:94`, `:115` | dropdown trigger + items (2 variants) | ad-hoc + `c-dropdown-item` |
| `console/src/components/CardSelector.tsx:36` | card radio option | inline border/bg per selection |
| `console/src/components/AlertBanner.tsx:37` | alert chip | ad-hoc crit-wash chip |
| `console/src/components/ActivityFeed.tsx:148` | feed pause/resume | `feed-toolbar__pause` (`console/src/index.css:386-400`) |
| `console/src/components/wizard/ModelAuthStep.tsx:176` | password visibility eye | absolute-positioned bare button |
| `console/src/components/shared/ChatPicker.tsx:73` | dropdown item | ad-hoc `c-hover` row |
| `console/src/components/shared/ContactSearchPicker.tsx:70` | dropdown item | ad-hoc `c-hover` row |
| `console/src/components/line-detail/ModeSwitchDialog.tsx:70` | mode radio card | inline border/bg/wash |
| `console/src/components/line-detail/GroupCard.tsx:23` | group card-as-button | `c-card c-hover` (card class on a button) |
| `console/src/pages/Inbox.tsx:302` | clear-search "X" | ad-hoc absolute `c-hover` |
| `console/src/pages/LineDetail.tsx:140` | back arrow | bare `c-hover` icon button |
| `console/src/pages/LineDetail.tsx:228` | main tab buttons | custom tab styling (see §6) |

### 1c. Visual/behavioral differences and inconsistencies

- Variant scheme is consistent where `c-btn` is used: filled primary (`console/src/index.css:970`),
  outline danger/success/warning (`:972-979`), borderless ghost (`:976`), shared disabled state
  (`:982-983`).
- **Ad-hoc size overrides instead of `c-btn-sm`:** `console/src/pages/Ops.tsx:177`, `:185`, `:199`
  use `c-btn py-[var(--sp-1)] px-[var(--sp-3)] text-label`;
  `console/src/components/line-detail/SummaryTab.tsx:160` uses
  `c-btn c-btn-ghost py-[var(--sp-0h)] px-[var(--sp-2)] text-label`. Both reinvent the sm/xs
  paddings (`console/src/index.css:984-985`).
- **`c-btn` classes applied to a `<select>`:** `console/src/components/line-detail/GroupDetailModal.tsx:680`
  (`className="font-mono text-t2 c-btn c-btn-xs c-btn-ghost bg-d1"`). A select dressed as a button.
- Three separate "icon button that expands a label on hover" mechanisms exist with the same
  animation idea but different classes: `c-btn-nav`/`c-btn-send`/`c-btn-add`
  (`console/src/index.css:986-1069`) vs `fc-action`/`fc-action__label`
  (`console/src/index.css:670-701`).
- `console/src/components/line-detail/HistoryTab.tsx:186` composes `c-btn c-btn-sm` with inline
  `color-mix` background + backdrop blur — a one-off "floating" variant.

## 2. Text Inputs

### 2a. `.c-input` consumers

29 exact-token uses across `*.tsx`. Direct (non-primitive) users:
`console/src/components/ContactSearch.tsx:47` (with padding overrides),
`console/src/components/TagInput.tsx:54`,
`console/src/components/wizard/ModelAuthStep.tsx:171` (password, manual `pr-[var(--sp-8)]`),
`console/src/components/wizard/IdentityStep.tsx:120`, `:158`,
`console/src/components/line-detail/ScheduleComposerModal.tsx:248`, `:266`, `:282`, `:301`, `:347`,
`console/src/components/line-detail/ConfigEditDialog.tsx:148`, `:175`, `:211`, `:226`, `:239`, `:251`,
`console/src/components/line-detail/GroupDetailModal.tsx:134`, `:153`,
`console/src/components/line-detail/CreateGroupModal.tsx:104`,
`console/src/pages/Inbox.tsx:639`, plus the search trio (§2c) and the wizard primitives (§2b).

### 2b. Wizard form primitives — `console/src/components/wizard/form-primitives.tsx`

Complete export list (the brief guessed names; actual exports differ — there is no `FieldLabel`
or `CheckboxRow` export):

| Export | Line | Renders |
|---|---|---|
| `Field` | `console/src/components/wizard/form-primitives.tsx:20` | label + error/helper wrapper (`c-heading c-field-label`, `c-error`, `c-helper`), render-prop `children(id)` |
| `TextInput` | `console/src/components/wizard/form-primitives.tsx:44` | `<input>` with `c-input font-mono` + inline `borderColor` from error/confirmed (`:4-8`) |
| `NumberInput` | `console/src/components/wizard/form-primitives.tsx:57` | `type="number"`, `c-input c-input-number font-mono` |
| `SelectInput` | `console/src/components/wizard/form-primitives.tsx:71` | `<select>` with `c-input c-select` |
| `TextArea` | `console/src/components/wizard/form-primitives.tsx:87` | `<textarea>` with `c-input font-mono`, inline minHeight/resize |
| `CheckboxField` | `console/src/components/wizard/form-primitives.tsx:106` | `label.c-checkbox-row` + native checkbox + helper |

Consumers: only the wizard — `console/src/components/wizard/ConfigStep.tsx:5` (all six) and
`console/src/components/wizard/ModelAuthStep.tsx:3` (`SelectInput`). **Nothing outside the wizard
uses these primitives**; line-detail dialogs hand-roll equivalent inputs (§2a list), duplicating
the error-border and label patterns (e.g. `console/src/components/line-detail/ConfigEditDialog.tsx:144-149`
re-implements NumberInput without `c-input-number`).

### 2c. Raw `<input>` census (27 hits, classified)

- **Text + `c-input` (canonical):** 16 of the §2a list above.
- **Search inputs:** shared primitive `SearchInput` (`console/src/components/shared/SearchInput.tsx:17-21`,
  `c-input c-input-search` + icon) used by `ChatPicker` (`console/src/components/shared/ChatPicker.tsx:61`)
  and `ContactSearchPicker` (`console/src/components/shared/ContactSearchPicker.tsx:58`). However
  `console/src/pages/Inbox.tsx:287-294` and `console/src/pages/SoupKitchen.tsx:411-418` hand-roll
  the identical icon+`c-input c-input-search` pattern instead of using `SearchInput` — duplicate
  implementation of an existing primitive.
- **Checkboxes (raw, no `c-checkbox-row`):** `console/src/components/UpdateModal.tsx:401-407`
  (overrides accent: `accent-[var(--color-m-cht)]` at `:406`),
  `console/src/components/wizard/ConfigStep.tsx:604-612`,
  `console/src/components/line-detail/ConfigEditDialog.tsx:128-133` (`accent-current` at `:132`).
- **Radios:** `console/src/components/wizard/ModelAuthStep.tsx:266-272`, `:276-282` (unstyled native).
- **File:** `console/src/components/wizard/ConfigStep.tsx:392-397` and `:664-667` — bare, no shared style.
- **Datetime-local:** `console/src/components/line-detail/ScheduleComposerModal.tsx:296-303`
  (`c-input` + inline `colorScheme: 'dark'`).
- **Number (raw):** `console/src/components/line-detail/ConfigEditDialog.tsx:144-149` (`c-input` but
  not `c-input-number`, so left-aligned full-width vs the primitive's right-aligned fixed width
  `console/src/index.css:892-895`).
- **Password:** `console/src/components/wizard/ModelAuthStep.tsx:166-175` with custom eye toggle at `:176`.

### 2d. Textareas

`TextArea` primitive used 3 times, all in `console/src/components/wizard/ConfigStep.tsx:368`, `:399`,
`:684`. Raw `<textarea>` with `c-input` classes:
`console/src/components/line-detail/GroupDetailModal.tsx:147`,
`console/src/components/line-detail/ConfigEditDialog.tsx:172`, `:236`,
`console/src/components/line-detail/ScheduleComposerModal.tsx:242`, `:276`.
The two chat composers bypass `c-input` entirely with a different look (bg-d1, auto-grow, no focus
border token): `console/src/components/line-detail/HistoryTab.tsx:204-224` and
`console/src/pages/Inbox.tsx:432-451` — near-identical duplicated code in two files.

## 3. Selects / Dropdowns

### 3a. Native `<select>` (3 instances)

| Site | Classes | Notes |
|---|---|---|
| `console/src/components/wizard/form-primitives.tsx:72-76` | `c-input c-select` | only consumer of `.c-select`; gets custom chevron (`console/src/index.css:874-877`) |
| `console/src/components/line-detail/ConfigEditDialog.tsx:199-219` | `c-input ... pr-[var(--sp-8)]` | **no `c-select`** — keeps native arrow, manually re-adds the right padding |
| `console/src/components/line-detail/GroupDetailModal.tsx:676-685` | `c-btn c-btn-xs c-btn-ghost bg-d1` | select styled as a ghost button |

`.c-select` has exactly 1 consumer; the other two selects drift.

### 3b. Custom dropdowns (popover + open-state), 4 implementations

| Implementation | Trigger / list | Outside click | Escape | Keyboard nav | ARIA |
|---|---|---|---|---|---|
| `LinePicker` toolbar variant (`console/src/components/LinePicker.tsx:43-88`) | button `:46` + absolute panel `:62-86` with `c-dropdown-item` items `:71` | yes (`:22-31`, mousedown on document) | yes (`:34-41`) | none (no arrow-key handling) | none — no `aria-expanded`, `aria-haspopup`, or listbox roles |
| `LinePicker` compact variant (`console/src/components/LinePicker.tsx:92-131`) | button `:94` + absolute panel `:110-129` | yes (shared ref `:22-31`) | yes (`:34-41`) | none | none |
| `ChatPicker` (`console/src/components/shared/ChatPicker.tsx:59-86`) | `SearchInput` `:61` + absolute `c-card` panel `:68-83` | yes (`:23-29`) — listener attached even when closed | yes (`:31-35`) — also always attached | none | none |
| `ContactSearchPicker` (`console/src/components/shared/ContactSearchPicker.tsx:57-83`) | `SearchInput` `:58` + absolute `c-card` panel `:65-81` | **no** | **no** | none | none |

Adjacent but not popovers: `ContactSearch` renders results as an inline (non-overlay) list
(`console/src/components/ContactSearch.tsx:65-88`); `CardSelector` is a card-style radio group
(`console/src/components/CardSelector.tsx:30-61`); Nav, ChartPanel, Inbox filter bars, and the
LogsTab level filter contain no dropdowns — LogsTab/Ops/SoupKitchen/ActivityFeed filters are
`FilterPill` rows (`console/src/components/line-detail/LogsTab.tsx:20-28`,
`console/src/pages/Ops.tsx:241-249`, `console/src/pages/SoupKitchen.tsx:286-292`, `:387-400`,
`console/src/components/ActivityFeed.tsx:166-170`).

Inconsistency: dropdown panel chrome differs — LinePicker panels use `bg-d6 c-border-b2 shadow-md`
(`console/src/components/LinePicker.tsx:64`, `:112`); ChatPicker/ContactSearchPicker panels use
`c-card` (bg-d2, b1 border) (`console/src/components/shared/ChatPicker.tsx:70`). Item hover uses
`c-dropdown-item` only in LinePicker; the pickers use generic `c-hover`.

## 4. Toggles / Checkboxes / Radios

- **`.c-toggle` (`console/src/index.css:1162-1168`) has ZERO consumers** — grep over all of
  `console/src` finds only the definition. Dead class; there is no switch control anywhere in the UI.
- Checkboxes: global accent styling at `console/src/styles/composites.css:22`
  (`input[type="checkbox"], input[type="radio"] { accent-color: var(--accent); }`). Four raw
  checkbox sites (§2c) of which two override the global accent differently
  (`console/src/components/UpdateModal.tsx:406` → m-cht; `console/src/components/line-detail/ConfigEditDialog.tsx:132`
  → `accent-current`). `CheckboxField`/`.c-checkbox-row` has a single registration point
  (`console/src/components/wizard/form-primitives.tsx:106-119`) used only via ConfigStep.
- Radios: 2 native (`console/src/components/wizard/ModelAuthStep.tsx:266`, `:276`) plus two
  hand-built radio-like controls that do not use `role="radio"`/`aria-checked`:
  ModeSwitchDialog's painted radio dot (`console/src/components/line-detail/ModeSwitchDialog.tsx:82-90`,
  uses `aria-pressed` semantics implicitly via button) and CardSelector cards
  (`console/src/components/CardSelector.tsx:36-46`, no checked state exposed to AT).

## 5. Pills / Tags

At least 9 visually distinct pill recipes:

| Implementation | Font / size | Padding | Radius | Border | Evidence |
|---|---|---|---|---|---|
| `FilterPill` | `text-sm font-mono`, tracking-pill | `py-sp-1 px-sp-2h` | `rounded-sm` | `bw solid b4/b1` (inline) | `console/src/components/FilterPill.tsx:22-30` |
| `FilterPill` count chip | `text-label font-semibold` | `px-sp-1`, `min-w-sp-4` | `rounded-xs` | none (bg b3/b2) | `console/src/components/FilterPill.tsx:35-42` |
| `TagInput` tag | `text-label font-mono font-medium` | `py-sp-1 px-sp-2` | `rounded-sm` | `bw solid` accent or b2, `color-mix` bg | `console/src/components/TagInput.tsx:64-71` |
| `LineTags` tag | `text-xs font-mono font-medium` | `py-bw px-sp-1h` | `rounded-sm` | none (wash bg) | `console/src/components/LineTags.tsx:57-61` |
| `ModeBadge` | `text-label font-mono font-medium` | `sp-0h sp-2h sp-0h sp-2` (asymmetric, inline) | `rounded-sm` | none (soft bg) + dot | `console/src/components/ModeBadge.tsx:34-43` |
| `fc-inst` (feed mode chip) | `text-label`, **semibold** | `bw sp-1h` | `radius-sm` | none (wash bg) | `console/src/index.css:522-535`, used `console/src/components/FeedCard.tsx:454` |
| `fc-badge` (feed badge) | `text-label font-mono medium` | `0 sp-1h` | `radius-sm` | `bw solid b2` + d4 bg, 7 tone modifiers | `console/src/index.css:537-562`, used `console/src/components/FeedCard.tsx:133` |
| `ContactSearchPicker` selected chip | `c-label` | `py-bw px-sp-2` | `rounded-sm` | `bw solid b1`, d1 bg | `console/src/components/shared/ContactSearchPicker.tsx:45-48` |
| `AlertBanner` count badge | `text-sm font-mono medium` | **`px-2.5 py-0.5` (raw Tailwind units, off the token grid)** | `rounded` | none (crit-soft bg) | `console/src/components/AlertBanner.tsx:26-29` |
| `GroupCard` role badge | `c-meta` | `py-bw px-sp-1` | `rounded-sm` | none (inline bg) | `console/src/components/line-detail/GroupCard.tsx:45-51` |

Drift: same conceptual control (small mono label chip) rendered with at least 5 padding recipes
(`sp-1/sp-2h`, `sp-1/sp-2`, `bw/sp-1h`, `0/sp-1h`, raw `2.5/0.5`), 3 font sizes (`text-sm`,
`text-label`, `text-xs`) and 2 weights (medium, semibold). `ModeBadge` vs `fc-inst` render the same
semantic (instance mode) with different weight, padding, and dot-vs-no-dot.

## 6. Tabs

`.c-tab` (`console/src/index.css:1072-1089`, active via `aria-selected` or `.active`) consumers:

- Wizard config tabs: `console/src/components/wizard/ConfigStep.tsx:292-298` (5 tabs, `role="tab"`).
- Wizard model/auth tabs: `console/src/components/wizard/ModelAuthStep.tsx:69-77` (incl. disabled "Local" tab).
- Group detail modal tabs: `console/src/components/line-detail/GroupDetailModal.tsx:790-800` (`role="tablist"` at `:787`).

**The main LineDetail tab bar does NOT use `.c-tab`:** `console/src/pages/LineDetail.tsx:228-252`
hand-rolls tab buttons with a mode-colored absolute underline `<div>` (`:246-251`) instead of the
`.c-tab` border-bottom mechanism — correct ARIA (`role="tab"`, `aria-selected`, `aria-controls`
`:231-234`) but a parallel visual system (underline inset `left-2 right-2` + `rounded-t` vs c-tab's
full-width `--bw-accent` border).

Other range selectors are toolbar controls by semantics, not tabs: MetricsTab and SoupKitchen
use `ToolbarTimeRange`. The MetricsTab Tokens/Sessions content switcher uses the Tabs primitive
(DD-15 closed), so it is no longer a segmented-control residual.

## 7. Cards

- **`.c-card` (canonical, `console/src/index.css:940-945`):** 31 token uses in 14 files —
  `console/src/pages/SoupKitchen.tsx:280`, `:378`, `console/src/components/line-detail/SummaryTab.tsx:152`,
  `:197`, `console/src/components/line-detail/MetricsTab.tsx` (4), `console/src/pages/Ops.tsx:215`,
  `console/src/pages/Inbox.tsx` (3), `console/src/components/line-detail/AccessTab.tsx:133`, `:145`,
  `:153`, `console/src/components/ActiveHoursHeatmap.tsx` (3),
  `console/src/components/line-detail/LogsTab.tsx:12`,
  `console/src/components/line-detail/ScheduledMessageRow.tsx:68`,
  `console/src/components/line-detail/GroupCard.tsx:25` (on a `<button>`),
  `console/src/components/shared/ChatPicker.tsx:70` and
  `console/src/components/shared/ContactSearchPicker.tsx:67` (as dropdown panels),
  `console/src/components/MessageBubble.tsx:27` (with the sole `c-card--detail` use),
  `console/src/components/ErrorBoundary.tsx`.
- **`.c-section` (`console/src/index.css:1103-1108`):** 5 uses — `console/src/components/line-detail/ModeTab.tsx:20`,
  `:43`, `console/src/components/line-detail/PipelineTab.tsx:195`, `:212`, `:234`. Same bg/border as
  `.c-card` but `--sp-7` padding and no shadow; two near-identical panel primitives coexist.
- **Reimplementations:** `KpiCard` builds its own card (inline bg/border/shadow swap,
  `console/src/components/KpiCard.tsx:33-38`) using `c-kpi-pad`/`c-kpi-hover` but not `c-card`;
  `ChartPanel` uses `bg-d3 p-sp-3 c-border rounded-[var(--radius-md)]`
  (`console/src/components/ChartPanel.tsx:30-32`) — different bg (d3 vs d2), radius (md vs lg), and
  border application; `FeedCard` has an entirely separate `fc`/feed CSS family
  (`console/src/index.css:449-710`).

## 8. Nav Elements

- `.c-nav-link` used 3 times, all in `console/src/components/Nav.tsx:46`, `:69`, `:104`
  (`Link`/`NavLink` with active state `text-t1 bg-d4` + a hand-positioned absolute underline span,
  `console/src/components/Nav.tsx:54-63`, `:87-96`, `:115-124` — the underline is duplicated 3x inline).
- Update chip button: `console/src/components/Nav.tsx:159-168` (raw button, §1b).
- Unread count badge in nav: `console/src/components/Nav.tsx:80-86` (warn bg, `rounded-md`) vs the
  Inbox chat-list unread badge which is circular `bg-m-cht` (`console/src/components/ChatListItem.tsx:64-70`)
  — two unread-badge styles for the same concept.
- Back link: `console/src/pages/LineDetail.tsx:140-146` — bare icon button, no shared "back" pattern.
- Breadcrumbs: none found (no breadcrumb component or `breadcrumb` string in `console/src`).

## 9. Modals / Dialogs

11 dialog surfaces; 9 use `.c-dialog-backdrop`, 1 rolls its own backdrop, 1 composes ConfirmDialog.
**No focus trap exists anywhere** (no focus-trap code found in `console/src`; only `autoFocus` at
`console/src/components/line-detail/CreateGroupModal.tsx:105` and `console/src/pages/Inbox.tsx:644`).

| Component | Backdrop | Shell | Header | Footer | Escape | aria role/modal | Width token |
|---|---|---|---|---|---|---|---|
| `ConfirmDialog` (`console/src/components/ConfirmDialog.tsx`) | `c-dialog-backdrop` `:37` | own (`bg-d2 c-border rounded-lg` `:44`) | own (`:48-49`, same paddings as `.c-dialog-header`) | own (`:72-73`, same values as `.c-dialog-footer`) | yes `:26-31` | yes `:41-43` | `--panel-confirm` `:44` |
| `RelinkModal` (`console/src/components/RelinkModal.tsx`) | `c-dialog-backdrop` `:24` | own (`bg-d2 c-border` `:32`) | own `:36-37` | none | yes `:13-18` | yes `:28-30` | `--panel-confirm` `:32` |
| `UpdateModal` (`console/src/components/UpdateModal.tsx`) | `c-dialog-backdrop` `:301` | own (`bg-d2 c-border` `:309`) | own `:313-314` | inline per-phase | yes `:126-131` | yes `:305-307` | `--panel-confirm` `:309` |
| `AddLineWizard` (`console/src/components/AddLineWizard.tsx`) | `c-dialog-backdrop` `:255` | own (`bg-d2 c-border` `:263`) | own (`c-toolbar c-border-b` `:269-270`) | own | **no Escape handler** (no `Escape` match in file) | role/aria on the **backdrop**, not the panel (`:257-259`) | `--panel-wizard` `:263` |
| `KeyboardShortcutsHelp` (`console/src/components/KeyboardShortcutsHelp.tsx`) | **own** `fixed inset-0` `:20` | `c-dialog` `:24` | none | none | **no Escape handler** — UI text claims "Press ? or Esc to close" (`:53`) but only `?` works (toggle via `console/src/hooks/use-keyboard-shortcuts.ts:49-52`; the hook explicitly does not handle Escape, `:21`). App wires only `onClose` to backdrop click (`console/src/App.tsx:71`) | yes `:25-27` | `--panel-shortcuts` `:24` |
| `ConfigEditDialog` (`console/src/components/line-detail/ConfigEditDialog.tsx`) | `c-dialog-backdrop` `:264` | `c-dialog` `:271` | `c-dialog-header` `:275` | `c-dialog-footer` `:319` | **no Escape handler** (no `Escape` match in file; backdrop-click only `:265`) | yes `:268-269` | `--panel-config-edit` `:271` |
| `CreateGroupModal` (`console/src/components/line-detail/CreateGroupModal.tsx`) | `c-dialog-backdrop` `:65` | `c-dialog` `:70` | `c-dialog-header` `:74` | `c-dialog-footer` `:134` | yes `:32-37` | yes `:67-68` | `--panel-composer` `:70` |
| `GroupDetailModal` (`console/src/components/line-detail/GroupDetailModal.tsx`) | `c-dialog-backdrop` `:756` | `c-dialog` `:761` | `c-dialog-header` `:765` | none (inline actions) | yes `:728-734` | yes `:758-759` | `--panel-wizard` `:761` |
| `ScheduleComposerModal` (`console/src/components/line-detail/ScheduleComposerModal.tsx`) | `c-dialog-backdrop` `:174` | `c-dialog` `:179` | `c-dialog-header` `:183` | `c-dialog-footer` `:363` | yes `:100-106` | yes `:176-177` | `--panel-composer` `:179` |
| Inbox save-contact dialog (`console/src/pages/Inbox.tsx:620-660`) | `c-dialog-backdrop` `:620` | own (`bg-d2 c-border` `:625`) | own `:628` | own `:648` | yes `:205` | yes `:622-623` | `--panel-confirm` `:625` |
| `ModeSwitchDialog` (`console/src/components/line-detail/ModeSwitchDialog.tsx:52`) | inherits ConfirmDialog | inherits | inherits | inherits | inherits | inherits | inherits |

Key drift:

- **Two shell recipes:** `.c-dialog` = `bg d1, border b1` (`console/src/index.css:925-931`); the
  hand-rolled shells = `bg-d2 + c-border (b1)`. Dialog backgrounds differ by one surface step
  depending on which modal you open.
- `.c-dialog-body` (`console/src/index.css:932-937`) has **zero consumers**; every dialog hand-rolls
  body padding (`py-[var(--sp-4)] px-[var(--sp-5)]` vs `p-[var(--sp-5)]` variants).
- Escape coverage is inconsistent: 7 of 10 surfaces close on Escape via copy-pasted identical
  `useEffect` blocks (no shared `useEscape` hook); AddLineWizard, KeyboardShortcutsHelp, and
  ConfigEditDialog do not.
- ConfirmDialog header close button uses `c-btn-sm` (`console/src/components/ConfirmDialog.tsx:58`)
  while RelinkModal/UpdateModal use unsized ghost (`console/src/components/RelinkModal.tsx:45`,
  `console/src/components/UpdateModal.tsx:322`) and ScheduleComposerModal uses `c-btn-xs`
  (`console/src/components/line-detail/ScheduleComposerModal.tsx:190`).

## 10. Alerts / Toasts / Banners

- `AlertBanner` (`console/src/components/AlertBanner.tsx:17-50`): crit-wash banner, inline
  border style, raw-unit count badge (`:27`), chip buttons (`:37-47`).
- `Toast` (`console/src/components/Toast.tsx:39-58`): `role="alert" aria-live="polite"` (`:41-42`),
  variant via inline borderColor map (`:19-23`), self-dismiss timer (`:34-37`), ghost close button.
  Stack container: `console/src/hooks/use-toast.tsx:44` — `fixed z-[110]` with a **hard-coded
  z-index** instead of a `--z-*` token (the dialog layer uses `var(--z-overlay)`,
  `console/src/index.css:923`).
- Inline banners (each a one-off):
  - Restart warning bar in ConfigEditDialog (`console/src/components/line-detail/ConfigEditDialog.tsx:284-289`):
    `bg-s-warn-wash` row, `py-sp-3 px-sp-5`.
  - Restart warning in ModeSwitchDialog (`console/src/components/line-detail/ModeSwitchDialog.tsx:109-116`):
    `bg-s-warn-wash rounded-sm py-sp-2 px-sp-3` — same semantic, different padding/radius.
  - Wizard create-error box (`console/src/components/AddLineWizard.tsx:330-335`): `text-s-crit bg-d3
    rounded-sm` — error banner without crit wash.
  - ChartPanel degraded badge (`console/src/components/ChartPanel.tsx:37-48`): warn wash + border.

No shared `Banner`/`Callout` primitive exists.

## 11. Badges / Status Dots

- `StatusDot` (`console/src/components/StatusDot.tsx:28-54`): sm=6px / md=8px, glow shadow map
  (`:22-26`), animated breathe ring when online (`:43-51`), `aria-label`.
- **LineDetail header re-implements StatusDot inline** instead of using the component:
  `console/src/pages/LineDetail.tsx:149-161` (`--dot-header` size + duplicated glow ternary).
- `ModeBadge` (`console/src/components/ModeBadge.tsx:30-47`) vs feed `fc-inst`
  (`console/src/index.css:522-535`, `console/src/components/FeedCard.tsx:454`): two mode-badge systems (§5).
- `fc-badge` tone system: 7 modifiers (`console/src/index.css:556-562`), applied via map in
  `console/src/components/FeedCard.tsx:31-37`, `:133`.
- Log level badge: `console/src/components/line-detail/LogsTab.tsx:48-53` — raw `px-1.5 py-0.5
  rounded` with color maps from `console/src/components/line-detail/LogsTab.tsx:1`
  (`lib/log-theme`); not shared with `fc-badge` tones.
- Unread badges: Nav pill (`console/src/components/Nav.tsx:80-86`) vs ChatListItem circle
  (`console/src/components/ChatListItem.tsx:64-70`) — different shape/color for the same metric.
- Access status badge: `console/src/components/line-detail/AccessTab.tsx:80-84` (inline
  `statusBadge` map at `:46`).
- Scheduled status: colored dot + `c-meta` label (`console/src/components/line-detail/ScheduledMessageRow.tsx:87-100`),
  colors from `scheduled-utils` — a fourth status-color mapping alongside StatusDot, log-theme, and fc-badge.

## 12. Tables

- **Real `<table>` (1):** SoupKitchen fleet table — `console/src/pages/SoupKitchen.tsx:433-455`:
  `<table>`/`<thead>` with sticky header row (`:435`), `th.c-col-header.c-cell` with sort affordance
  + `aria-sort` (`:437-441`), `tr.c-row-hover.c-border-b` rows (`:462-465`), `td.c-cell` cells (`:467+`).
- **Div-grid/flex "tables":**
  - LogsTab log rows: flex rows with fixed col-width tokens, `c-row-hover c-border-b`
    (`console/src/components/line-detail/LogsTab.tsx:36-65`) — no `c-cell`, ad-hoc `px-3 py-1` cells.
  - AccessTab: three `c-card` lists with `c-toolbar c-border-b c-col-header` section headers
    (`console/src/components/line-detail/AccessTab.tsx:133-158`) and flex rows (`:56`).
  - ScheduledTab: stacked `c-card` rows via `ScheduledMessageRow`
    (`console/src/components/line-detail/ScheduledTab.tsx:124-130`).
  - HistoryTab: chat list + virtualized message list, no tabular header
    (`console/src/components/line-detail/HistoryTab.tsx:160-180`).
  - Ops: line cards with embedded action rows (`console/src/pages/Ops.tsx:172-205`).
- `c-col-header` (14 uses) doubles as a generic section-label outside any table context:
  `console/src/pages/Inbox.tsx:505`, `:528`, `console/src/components/line-detail/SummaryTab.tsx:155`,
  `:200`, `console/src/components/line-detail/ModeTab.tsx:47`,
  `console/src/components/line-detail/GroupDetailModal.tsx:347` — semantic drift between "table
  column header" and "panel heading" (which also has competing classes `c-heading`,
  `c-section-label`, e.g. `console/src/components/ChartPanel.tsx:35`).

## 13. Menus (context / kebab)

None found. No `onContextMenu` handlers, no kebab icons (`MoreVertical`/`MoreHorizontal` unused) in
`console/src` (grep over `*.tsx`). Closest equivalents: hover-revealed `fc-action` buttons on feed
cards (`console/src/components/FeedCard.tsx:319-403`) and always-visible inline action buttons on
scheduled rows (`console/src/components/line-detail/ScheduledMessageRow.tsx:140-186`). Row actions
therefore have two patterns (hover-reveal vs always-visible) and no menu primitive.

---

## Summary Matrix

| Control family | # distinct implementations | Canonical primitive exists? | Drift severity |
|---|---|---|---|
| Buttons | 1 class family + ~8 raw recipes (24 raw buttons; fc-action, FilterPill, feed pause, card-buttons, bare icon buttons) | Yes — `.c-btn` family (`console/src/index.css:955-1069`), 82% adoption (111/135) | Medium |
| Text inputs | `.c-input` + wizard primitives + 2 duplicated search bars + 2 duplicated composers | Yes — `.c-input` + `form-primitives.tsx`, but primitives are wizard-only | Medium |
| Selects/dropdowns | 3 native (3 different stylings) + 4 custom popovers (2 chrome styles, inconsistent dismiss handling) | Partial — `.c-select`/`SelectInput` (1 consumer); no dropdown/popover primitive | High |
| Toggles/checkboxes/radios | 1 unused toggle class, 4 checkbox sites (3 accent styles), 2 native + 2 hand-built radio patterns | Nominal — `.c-toggle` dead, `CheckboxField` single-consumer | High |
| Pills/tags | >=9 recipes (FilterPill, TagInput, LineTags, ModeBadge, fc-inst, fc-badge, picker chip, AlertBanner badge, GroupCard badge) | No shared pill primitive | High |
| Tabs | 2 systems (`.c-tab` x3 sites; LineDetail custom underline) + 2 other segmented mechanisms | Yes — `.c-tab`, not used by the largest tab bar | Medium |
| Cards | `.c-card` (14 files) + `.c-section` + 3 reimplementations (KpiCard, ChartPanel, FeedCard) | Yes — `.c-card`; overlapping `.c-section` | Medium |
| Nav elements | 1 (`.c-nav-link` x3, underline duplicated inline x3) | Yes | Low |
| Modals/dialogs | 11 surfaces; 2 shell recipes; 5/11 on `.c-dialog`; 4/11 on `.c-dialog-header`; 3/11 on `.c-dialog-footer`; `.c-dialog-body` unused; 3 missing Escape; 0 focus traps | Yes — `.c-dialog*` set, partially adopted | High |
| Alerts/toasts/banners | Toast (1) + AlertBanner (1) + 4 one-off inline banners; hard-coded toast z-index | Partial — Toast yes, no banner primitive | Medium |
| Badges/status dots | StatusDot + 1 inline re-implementation; 4 independent status-color maps; 2 unread-badge styles | Partial — StatusDot/ModeBadge exist but are bypassed | High |
| Tables | 1 real table + 4 div/flex list styles; `c-cell` only in the real table; `c-col-header` repurposed as section label | Partial — token classes exist, single full adopter | Medium |
| Menus | 0 (no menu primitive; 2 row-action patterns) | No | Low (nothing to drift yet) |

### Top consolidation candidates (by leverage)

1. Dialog shell unification: migrate the 5 `bg-d2 c-border` shells to `.c-dialog` +
   `.c-dialog-header/-footer/-body`, add a shared `useEscape`/focus-trap hook (fixes 3 missing-Escape
   surfaces incl. the false "Esc to close" copy in `console/src/components/KeyboardShortcutsHelp.tsx:53`).
2. A `Pill`/`Badge` primitive absorbing FilterPill/TagInput/LineTags/ModeBadge/fc-inst/fc-badge variants.
3. A popover/dropdown primitive with built-in outside-click + Escape + ARIA (4 current
   implementations, 1 with no dismiss handling at all).
4. Promote `SearchInput` to the two pages that re-implement it
   (`console/src/pages/Inbox.tsx:287`, `console/src/pages/SoupKitchen.tsx:411`).
5. Delete or adopt dead classes: `.c-toggle` (`console/src/index.css:1162`), `.c-dialog-body`
   (`console/src/index.css:932`).
