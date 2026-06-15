# Table — the first-class data surface: one component, two densities

v3.0.0-draft · G2-locked direction · pending G3

Resolves P2-10 (4 padding schemes, 2 log viewers) and carries the C-graft density model. Locked
source: v2.html table spec + Fleet table. The DRUIDS singularity rule applies: **no alternate
table implementation anywhere in the console**.

## Anatomy

```
tblwrap (--surface-raised, 1px --border-hairline, --r-2, --shadow-raised, overflow auto)
└─ table (border-collapse separate, spacing 0)
   ├─ thead th — sticky ghost headers: --type-overline +0.08em uppercase, --text-2, 28px,
   │   --surface-raised fill, --border-subtle bottom, z above rows
   ├─ tbody tr — height --row-default 36px (compressed 28px), --border-hairline row rules
   │   ├─ td (default --type-body; compressed --type-caption)
   │   ├─ td.num / td.data — mono data lanes: --type-data (compressed --type-data-sm),
   │   │   tabular figures, .num right-aligned
   │   ├─ statuscell — shape + name at the position-stable LEFT edge (column 1, always)
   │   ├─ expander — 24px chevron, rotates 90° when open
   │   └─ rowactions — hover/focus-within revealed ActionButtons
   └─ row-expand tr — inset bed (--surface-inset), auto height, kv grid, snaps open
```

## Densities

`density="default"` (36px — browse, forms-adjacent) / `density="compressed"` (28px — Fleet, Ops,
logs). One density token apart; never per-screen font fiddling. Forms/wizard tables stay default
(layout-density §3).

## Status & severity rendering

- Status: shape + label in the left-edge statuscell (badge.md); never color-only.
- Row severity: `row--warn`/`row--crit` = channel wash fill + 2px inset left edge in the channel
  solid; hover deepens the wash to a 16% mix. Severity full-row fills are reserved for warn/crit
  only — healthy rows are quiet.
- Timestamps, counts, tokens, uptime, phones: mono data lanes with tabular figures, em-dash
  (`--text-3` ghost) for absent values.

## Interaction

- Hover: `--row-hover` wash (`--dur-fast`), never border changes.
- Row link (`row--link`): pointer cursor, Enter activates (drill-in → drawer).
- Inline expand: chevron toggles the row-expand bed; **snaps** (no slide); `aria-expanded` on the
  expander; one bed per row.
- Sort: header click cycles asc/desc/none with an inline sort glyph; **instant** — no animation;
  `aria-sort` on the th.
- Filter/search/time-range live in the fronting Toolbar, never inside the table.
- Truncation: cells `white-space: nowrap` with ellipsis; truncated cells must surface full content
  in expand/drawer (hover-never-required).
- Row actions: revealed on hover **and** `:focus-within`; also available in the drawer.
- Responsive collapse: per-consumer column priority list ("more items vs more detail"); Fleet's
  normative order in drawer.md §4. Horizontal scroll is the documented 320px-reflow exception.
- Virtualization: required for unbounded data (logs, history); sticky headers must survive it.

## States

- loading: Skeleton rows mirroring the table's exact column geometry — a cold load is never
  confused with a filtered-empty result (P2-9)
- empty: EmptyState in the body with remedy; filtered-empty says so and offers clearing filters
- error: error state + Retry in the body
- focus-visible: ring on interactive cells/rows; selected row (drawer open) carries `--accent-wash`
  + inset accent edge
- disabled rows: n/a (rows are never disabled; actions within may be)
- reduced-motion: hover transitions removed; everything already snaps

## WAI table-vs-grid law

A static/read-mostly table is `<table>` semantics and **stays a table**. The moment cells become
editable/navigable (cell-level focus, arrow-key navigation, selection model) the component must
graduate to `role="grid"` with **managed focus** (roving tabindex, directional navigation, one tab
stop). No half-grid: an interactive grid without managed focus is a defect. The Fleet table today
is a table with interactive rows (link semantics), not a grid.

## Token references (both themes)

`--surface-raised/-inset`, `--border-hairline/-subtle`, `--row-default/-compressed`,
`--row-hover`, channel wash/solid tokens, `--type-overline/body/caption/data/data-sm`, `--r-2`,
`--shadow-raised`, `--dur-fast`.

## Examples / anti-patterns

- Do: Fleet compressed with statuscell left edge, mono lanes, expander; default-density schedule
  list in forms context.
- Don't: a second log-viewer/table implementation; per-table cell padding; status as a colored dot
  alone; animated sorts/expands; fixed pixel column widths (kills the squeeze rule); data tables
  nested inside data tables.

## Migration notes

Adopt for SoupKitchen/Fleet (currently the only `c-cell` consumer), LogsTab, AccessTab,
ScheduledTab, HistoryTab lists (DUP-10); the two log-viewer implementations collapse (LogStream
composes Table conventions — log-stream.md); `c-col-header`'s section-label moonlighting splits
out (typography §8); fixed `--sk-col-*` widths die for the collapse contract.

## Enforcement hooks

`table-via-primitive` (import restriction), `no-fixed-column-widths` (squeezable frames),
`tabular-nums-in-data-lanes`, `skeleton-mirrors-geometry` (review), grid-requires-managed-focus
(review checklist).
