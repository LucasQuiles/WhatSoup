# Inconsistency Register — ranked drift synthesis

Audit date: 2026-06-11 (branch `design/soup-rebrand`). This register synthesizes the other five inventory documents:
`component-inventory.md`, `control-catalogue.md`, `ia-workflow-review.md`, `duplication-register.md`, `token-census.md` (all in `docs/design-system/00-inventory/`).

Ranking:

- **P1** — blocks design-system consistency: v3 cannot ship its primitive→semantic→component model or dual themes until resolved.
- **P2** — visible inconsistency: operators can see the drift today; consolidation is straightforward once P1 primitives exist.
- **P3** — polish debt: cleanup, hygiene, and guardrail gaps.

---

## P1 — blocks design-system consistency

### P1-1. Button sprawl: 11 CSS variants, 24 raw buttons, 4 copies of the hover-reveal mechanic

- **Description:** The `.c-btn` family has 11 variants (`console/src/index.css:955-1069`); 4 of them (`c-btn-warning`, `c-btn-nav`, `c-btn-send`, `c-btn-add`) total only 6 uses, and three carry private max-width/opacity label-reveal animation machinery that is also re-implemented a fourth time as `.fc-action__label` (`console/src/index.css:688-701`). Meanwhile 24 of 135 `<button>` elements bypass `.c-btn` entirely across ~8 ad-hoc recipes (control-catalogue.md §1), and pages override variant sizing inline instead of using `c-btn-sm` (e.g. `console/src/pages/Ops.tsx`, per control-catalogue.md §1).
- **Evidence:** `console/src/index.css:955-1069`, `console/src/index.css:670-707`; usage counts in token-census.md §16 (`c-btn` 104 refs/31 files, long tail of 4 variants with 6 combined uses); duplication-register.md DUP-01.
- **Affected files:** 31 files use `c-btn*`; 42 files contain `<button>`.
- **v3 direction:** One `Button` component primitive with `variant` (primary/neutral/danger/success/warning/ghost) and `size` (xs/sm/md) props; a single `reveal-label` behavior token/utility shared by nav/send/add/feed-action contexts; lint rule banning raw `<button>` without the primitive outside whitelisted files.

### P1-2. No modal primitive: 11 dialog surfaces, 9 hand-rolled Escape handlers, 0 focus traps

- **Description:** 11 components implement a dialog surface. Only 5 use `.c-dialog`, 4 use `.c-dialog-header`, 3 use `.c-dialog-footer`, and `.c-dialog-body` has zero consumers; the rest re-roll shells with `bg-d2` + border combos. Escape-to-close is duplicated as 9 near-identical `useEffect` blocks, 3 surfaces have no Escape at all — including `KeyboardShortcutsHelp`, whose own UI copy claims "Esc to close" (`console/src/components/KeyboardShortcutsHelp.tsx:53`) — and no surface implements a focus trap. Modal-over-modal stacking (GroupDetailModal + ConfirmDialog) double-closes on a single Escape (ia-workflow-review.md §5.1, §4j).
- **Evidence:** control-catalogue.md §9; duplication-register.md DUP-04; token-census.md §16 (backdrop 9 uses vs `c-dialog` 5, `c-dialog-body` 0); `console/src/index.css:915-937,1111-1128`.
- **Affected files:** 11 dialog components (enumerated in component-inventory.md, modal count section).
- **v3 direction:** A single `Modal`/`Dialog` composite (backdrop, shell, header, footer, width token prop) plus a shared `useDismissable` hook (Escape, outside-click, focus trap, stacking-aware); delete `.c-dialog-body` or adopt it; migrate all 11 surfaces.

### P1-3. Dark-only token values block the dual-theme mandate

- **Description:** The entire border ramp `--b1`..`--b4` is white-alpha rgba (`console/src/index.css:73-76`), card/overlay shadows are black-alpha against dark surfaces (`:78,94-95,106-108`), and all 14 status/mode tint tokens are hardcoded rgba duplicates of their base hexes rather than derived (token-census.md §4). Nothing in `console/src/index.css` provides a semantic indirection layer, so a light theme currently requires editing raw values, not switching a theme scope. Token placement is also split: only 50 of 180 tokens live in `@theme` (`:4-70`); 130 live in `:root` (`:72-222`) and generate no Tailwind utilities.
- **Evidence:** token-census.md §3, §4, §8, §17; `console/src/index.css:72-222`.
- **Affected files:** 1 definition file, consumed by effectively every component (e.g. `--bw`/`--b1` 65/35 var() refs).
- **v3 direction:** This is the core v3 deliverable: primitive palette (mode-agnostic values) → semantic aliases (`--surface-1`, `--border-subtle`, `--status-ok-bg` etc., redefined per `[data-theme]`) → component tokens. Derive tints via `color-mix` (precedent already in-repo at `console/src/index.css:1145-1146`) instead of 14 hand-copied rgba values.

### P1-4. Status/mode color logic duplicated in 8 TS maps and 7 visual implementations

- **Description:** Mode/status→color mapping exists as 8 separate TypeScript copies (including an inline duplicate of `getModeColor` in `console/src/pages/LineDetail.tsx` and two identity re-maps in `console/src/components/line-detail/PipelineTab.tsx`), and the status dot/badge visual is implemented 7 ways — `LineDetail`'s header even re-implements `StatusDot` inline (`console/src/pages/LineDetail.tsx:148-162`) and one copy sizes a dot with `w-[var(--radius-md)]` (a radius token used as a width).
- **Evidence:** duplication-register.md DUP-06, DUP-07; control-catalogue.md §11 (4 independent status-color maps); component-inventory.md (StatusDot consumers).
- **Affected files:** 8+ TS files with color maps; StatusDot/ModeBadge plus 5 bypass sites.
- **v3 direction:** One `status.ts`/`mode.ts` helper exporting the canonical map keyed to semantic tokens; `StatusDot`/`ModeBadge` as the only renderers; lint rule banning literal status hexes/classes outside the helper.

### P1-5. No pill/badge primitive: 9+ chrome recipes

- **Description:** At least nine pill/tag/badge implementations coexist — `FilterPill`, `TagInput` chips, `LineTags`, `ModeBadge`, `fc-inst`, `fc-badge`, picker chips, `AlertBanner` chips, `GroupCard` badges — across 6 distinct padding/typography recipes, with drifted twins (LogsTab level badge uses `text-label` while Ops uses `text-xs` for the same log-level concept).
- **Evidence:** control-catalogue.md §5 and summary matrix (pills: >=9 recipes, drift severity High); duplication-register.md DUP-02; `console/src/index.css:522-562` (fc-inst/fc-badge).
- **Affected files:** 9+ components.
- **v3 direction:** A `Pill`/`Badge` primitive (tone x size x interactive/static x removable) with component tokens; FilterPill and TagInput become compositions of it.

### P1-6. Token architecture: global namespace polluted by 60+ component constants, with orphans and grep-invisible usage

- **Description:** 180 custom properties are defined, but 60+ are single-consumer component dimensions (`--sk-col-*`, `--panel-*`, `--feed-*`, `--log-col-*`, `--qr-size`...) promoted into global `:root`; 7 are genuine orphans (`--radius-circle`, `--avatar-lg`, `--chat-name-max`, `--feed-col-time`, `--feed-indent`, `--z-dropdown`, `--opacity-disabled` — the latter hardcoded as `0.45` at its own intended use site `console/src/index.css:983`); and 8 `--avatar-hue-*` tokens are consumed only via a dynamic template string (`console/src/components/line-detail/groups-utils.ts:41`), invisible to static analysis. There is no tier separation, so "primitive vs semantic vs component" is currently undecidable from the file.
- **Evidence:** token-census.md §12, §13, §14, §15, §17.
- **Affected files:** `console/src/index.css` + every consumer.
- **v3 direction:** Three-tier token spec; component constants move to component-scoped blocks (or co-located CSS) with a naming convention; orphan deletion; document the dynamic avatar-hue contract.

---

## P2 — visible inconsistency

### P2-1. Select/dropdown duplication

- **Description:** 3 native `<select>`s with 3 different stylings (one disguised as `c-btn c-btn-xs c-btn-ghost`, `console/src/components/line-detail/GroupDetailModal.tsx:680`), `.c-select` with exactly 1 consumer, and 4 custom popover dropdowns with duplicated outside-click/Escape code — `ContactSearchPicker` has no dismiss handling at all.
- **Evidence:** control-catalogue.md §3; duplication-register.md DUP-03; token-census.md §16 (`c-select`: 1 ref).
- **Affected files:** ~7. **v3 direction:** one styled `Select` and one `Popover` primitive with built-in dismiss + ARIA.

### P2-2. Wizard form kit unused outside the wizard

- **Description:** `console/src/components/wizard/form-primitives.tsx` exports a complete field kit (Field, TextInput, NumberInput, SelectInput, TextArea, CheckboxField) consumed by only 2 wizard files, while 4 dialog surfaces (ConfigEditDialog, ScheduleComposerModal, CreateGroupModal, GroupDetailModal) re-roll the same label+input+helper pattern with raw `c-input`/`c-field-label` classes.
- **Evidence:** duplication-register.md DUP-12; control-catalogue.md §2; component-inventory.md (wizard section).
- **Affected files:** 6+. **v3 direction:** promote the kit to `components/form/` as the canonical form primitives; migrate dialogs.

### P2-3. Two implementations of the conversation view

- **Description:** Inbox's center pane and LineDetail's History tab are the same operator task built twice with divergent pagination (React Query cache append vs parallel local `olderMessages` array) and divergent affordances.
- **Evidence:** ia-workflow-review.md §5.4 (`console/src/pages/Inbox.tsx:128-144` vs `console/src/components/line-detail/HistoryTab.tsx:36-66`).
- **Affected files:** 2 large surfaces + shared message components. **v3 direction:** one `ConversationView` composite consumed by both.

### P2-4. Search input implemented three ways

- **Description:** `shared/SearchInput.tsx` exists, but Inbox and SoupKitchen re-implement the icon+input+clear pattern inline.
- **Evidence:** control-catalogue.md top consolidation candidate 4 (`console/src/pages/Inbox.tsx:287`, `console/src/pages/SoupKitchen.tsx:411`); ia-workflow-review.md §4e.
- **Affected files:** 3. **v3 direction:** adopt `SearchInput` everywhere; add lint guard for `c-input-search` outside it.

### P2-5. Card/panel shells: 4 recipes plus a third styling dialect

- **Description:** `.c-card` (31 refs) overlaps `.c-section` (5 refs), while KpiCard, ChartPanel, and FeedCard re-implement panel chrome; the activity feed is styled in a separate BEM CSS system (~40 selectors, `console/src/index.css:350-719`) — the app currently speaks Tailwind utilities, `c-*` composites, and BEM simultaneously.
- **Evidence:** duplication-register.md DUP-05; token-census.md §16; control-catalogue.md §7.
- **Affected files:** 14+ card consumers; 2 feed components. **v3 direction:** single `Card`/`Panel` primitive with padding/elevation props; fold feed styling into the same system or explicitly charter BEM-for-feed as a documented exception.

### P2-6. Tab systems: the canonical class skips the biggest tab bar

- **Description:** `.c-tab` is used at 3 sites, but LineDetail — the largest tab bar (9 tabs) — draws its own underline treatment; 2 further segmented-control mechanisms exist.
- **Evidence:** control-catalogue.md §6 and summary matrix; `console/src/pages/LineDetail.tsx:215-253`.
- **Affected files:** 4+. **v3 direction:** one `Tabs` primitive (underline + segmented variants), ARIA built in.

### P2-7. Inconsistent destructive-action confirmation policy

- **Description:** Restart is confirmed at 1 of 4 entry points, block-contact at 1 of 2, scheduled-message delete never; recurring schedules cannot be paused.
- **Evidence:** ia-workflow-review.md §4h.
- **Affected files:** 6+ call sites. **v3 direction:** written confirmation policy (severity x reversibility matrix) + `useConfirm` helper so policy is enforced where actions are defined.

### P2-8. Dead affordances visible in the chrome

- **Description:** The nav alert count is a non-interactive span (`console/src/components/Nav.tsx:150-156`); SoupKitchen AlertBanner chips render as buttons with no handler passed (`console/src/components/AlertBanner.tsx:36-48`, `console/src/pages/SoupKitchen.tsx:368`). Closed since the original audit: Cmd/Ctrl+K now focuses the mounted search target (`6a1319b8`), and unknown `/lines/:name` now renders an actionable not-found / failed-load state (`9102a937`).
- **Evidence:** ia-workflow-review.md §5.2.
- **Affected files:** 3 remaining. **v3 direction:** wire alert click-through / chip behavior or remove the interactive styling; design-system rule: nothing that looks interactive may be inert.

### P2-9. Empty/loading/error states are ad hoc

- **Description:** `EmptyState` and `Skeleton` exist, but 6 ad-hoc empty divs and 9 ad-hoc spinners bypass them; route-level Suspense falls back to bare "Loading..." text (`console/src/App.tsx:19-25`); SoupKitchen cold-load is indistinguishable from a filtered-empty table (`console/src/pages/SoupKitchen.tsx:515-520`). Closed since the original audit: UpdateModal's error phase now offers `Try again` (`fee98c17`).
- **Evidence:** duplication-register.md DUP-11; ia-workflow-review.md §5.2, §5.3.
- **Affected files:** 15+. **v3 direction:** canonical Empty/Loading/Error composites with copy guidelines; route skeletons.

### P2-10. Table/list cell treatments: 4 padding schemes

- **Description:** Only the SoupKitchen fleet table adopts `c-cell` (15 refs in 2 files); LogsTab, AccessTab, ScheduledTab and HistoryTab lists each roll their own cell padding; `c-col-header` is also repurposed as a generic section label; two whole log-viewer implementations exist.
- **Evidence:** duplication-register.md DUP-10; control-catalogue.md §12; token-census.md §16.
- **Affected files:** 6+. **v3 direction:** `Table`/`DataList` composites with density tokens.

### P2-11. Vocabulary drift and rebrand leftovers

- **Description:** "Lines" vs "instances" splits at page boundaries; playful naming ("Soup Kitchen") sits next to operational labels; 6 "WhatSoup" occurrences remain in `console/src` (`console/src/types.ts:1`, `console/src/mock-data.ts:1`, `console/src/hooks/use-keyboard-shortcuts.ts:1`, `console/src/hooks/use-fleet.ts:1`, `console/src/components/wizard/ConfigStep.tsx:1`, `console/src/components/UpdateModal.tsx:1`), including user-visible strings per ia-workflow-review.md §3.5.
- **Evidence:** ia-workflow-review.md §3.3-3.5.
- **Affected files:** 6 with literal "WhatSoup" + label sites. **v3 direction:** vocabulary table in the v3 spec (one term per concept, one tone decision), rename sweep.

### P2-12. Semantic color collisions undermine theming

- **Description:** `--color-m-pas` and `--color-s-ok` share the same hex `#2dd4a8` (`console/src/index.css:19,23`), so "passive mode" and "healthy" are visually indistinguishable and cannot diverge per theme; the chat-mode accent doubles as the global focus-ring color (`console/src/index.css:1180`) and `--color-s-ok` doubles as the primary-button fill (`:970`) and checkbox accent (`:242`).
- **Evidence:** token-census.md §3, §4.
- **Affected files:** definition file + all consumers. **v3 direction:** separate semantic roles (`--focus-ring`, `--action-primary`, `--status-ok`, `--mode-passive`) even where values coincide in the dark theme.

---

## P3 — polish debt

### P3-1. Dead CSS and orphan tokens

`.c-toggle` (`console/src/index.css:1162`) and `.c-dialog-body` (`:932`) have zero consumers; 7 orphan tokens (P1-6 list). Evidence: token-census.md §15-17; control-catalogue.md. **Direction:** delete or adopt.

### P3-2. Lint wall evasion shapes

The ~106-selector eslint guard still has evasion shapes: identifier-passed numbers (ChartPanel heights) and Recharts `wrapperStyle`/`contentStyle` props slip through. Closed since the original audit: template-literal arbitrary utility values (`HeartbeatStrip` `w-[3px]`), hardcoded px formulas (`Skeleton` widths), and conditional hardcoded-px branches (`PipelineTab`) are tokenized and pinned by selectors. Evidence: duplication-register.md DUP-08/DUP-09 with selector-line citations into `console/eslint.config.js`. **Direction:** extend selectors to identifier-flow shapes; add wrapperStyle rule.

### P3-3. Time/number formatting helpers duplicated

6 raw `toLocale*` call sites and a date recipe repeated 6 times; `formatCompact` (5 uses) coexists with `toLocaleString` (13 uses) for the same magnitudes; `cronToHuman` exists in both client and server packages. Evidence: duplication-register.md DUP-13/14/15. **Direction:** one `format.ts` helper module; cross-package dedup deferred.

### P3-4. Micro-duplications

Copy-to-clipboard implemented twice; em-dash placeholder declared 5+ times in 3 encodings. Evidence: duplication-register.md DUP-16/17. **Direction:** tiny shared helpers/constants.

### P3-5. Type-scale near-duplicates and unused tracking utilities

`--text-heading` (0.82rem) vs `--text-body` (0.85rem) are 0.5px apart with 1 direct ref each as var(); all 5 `--tracking-*` tokens have zero Tailwind-utility use in TSX (consumed only inside `index.css` composites). Evidence: token-census.md §5, §6. **Direction:** collapse the scale in v3; decide whether tracking is composite-only by design.

### P3-6. Motion token bypass

`--dur-fast/norm/slow` exist, but composites hardcode `0.15s`, `0.2s`, `0.12s`, `0.25s` (`console/src/index.css:1181,1186,1191,1198,1204,1223,1229`), and `0.12s`/`0.25s` have no token at all. Evidence: token-census.md §10. **Direction:** complete the duration scale and consume it.

### P3-7. Spacing half-steps reveal grid friction

`--sp-0h/1h/2h` (3/6/10px) carry 63 combined refs — the 4px grid is routinely escaped; `--msg-pad-h` and `--btn-pad-v` are component paddings in the global namespace. Evidence: token-census.md §11. **Direction:** v3 spacing scale decision (2px base or sanctioned half-steps), component tokens for the two strays.

### P3-8. Orphaned component and accessibility leftovers

`console/src/components/ContactSearch.tsx` has zero importers (superseded by `shared/ContactSearchPicker.tsx`); no dialog implements a focus trap; row-action affordances split between hover-reveal and always-visible with no menu primitive. Evidence: component-inventory.md (orphan note); control-catalogue.md §9, §13. **Direction:** delete the orphan; fold focus management into the P1-2 modal primitive; define a row-action pattern.

---

## Tally

| Priority | Entries |
|---|---|
| P1 | 6 |
| P2 | 12 |
| P3 | 8 |
| Total | 26 |

Cross-reference: duplication-register.md classifies each underlying pattern (primitive/composite/token/helper/docs rule/lint rule/deferred); this register orders them by how hard they block SOUP Design System v3.
