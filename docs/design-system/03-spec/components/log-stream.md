# LogStream — the first-class log surface: one viewer, everywhere

v3.0.0-draft · G2-locked direction · pending G3

Locked source: v2.html log spec (C graft, B skin) ×3 (specimen, service log, drawer-scoped).
Kills the two-implementation drift (P2-10).

## Anatomy

```
log (--surface-inset bed, 1px --border-hairline, flush-joins its toolbar, --type-data,
     max-height + overflow auto, role="list")
└─ log__row (grid: time 72px · level 24px · component 96px · 1fr message — the three column
             widths are LogStream component tokens; 24px min row height, hairline rules,
             role="listitem", tabindex 0)
   ├─ time — --type-data-sm, --text-2 (DD-8 decision: time is an essential scan
   │         anchor and carries AA ink in both themes; it recedes via the 11px
   │         data-sm size and mono weight, never via sub-AA color)
   ├─ lvl — bordered LETTER tag: 18×16px chip, 600 9px mono, E/W/I/D
   ├─ component — --type-data-sm, --text-2, ellipsis
   ├─ message — --type-data-sm, --text-1 (warn rows: warn fg; error rows: crit fg), ellipsis
   └─ log__detail — expanded context: pre-wrap, --text-2, indented under the message column;
       includes remedy lines where known
```

Level tags (the second non-color channel): E = crit fg + crit border + crit wash · W = warn
fg/border/wash · I = neutral (`--text-2`, `--border-strong`) · D = `--text-2` + dashed border (amended 2026-07-19, DD-8 close: the letter is a sole-rendering datum carrier; the dashed border + quiet border ink keep debug distinct from info).

## Toolbar contract

Every LogStream is fronted by THE Toolbar (flush): level filter pills with counts
(all/error/warn/info/debug), segmented time range, grep search. Live filtering hides non-matching
rows; filtered-empty states say so.

## Conceptual props

`entries` ({time, level, component, message, detail}) · `maxHeight` · `follow` (tail mode) ·
`onLevelFilter`/`onSearch` (or self-managed via the toolbar contract).

## States

- default / hover: `--row-hover` wash
- expanded (`is-open`): detail block visible, row keeps the hover wash; toggles on click and
  Enter/Space; **snaps** (no slide)
- focus-visible: standard ring on the row
- selected/disabled: n/a
- loading: skeleton rows mirroring the column grid
- empty: "No log entries in this range" + range-widening remedy
- error (fetch failure): error composite + Retry — distinct from rendered error-level rows
- live tail: new rows append without animation; **auto-scroll pauses on user scroll-up and via the
  pause control** (WCAG 2.2.2 — motion.md §9); paused state visibly labeled with a resume action
- reduced-motion: hover transition removed; tail behavior unchanged (scroll position is not motion)

## Accessibility

Rows are focusable and expandable by keyboard; level conveyed by letter + color + border style
(triple channel); the stream is `role="list"` (not a live region — log spam would drown screen
readers; the attention metric and feed carry escalation); timestamps are mono tabular.

## Performance

Virtualization required for unbounded streams (service log, history); the drawer-scoped log
(last N) may render plain. Row recycling never animates.

## Examples / anti-patterns

- Do: service log with 12 mixed-level rows, level filters, grep; drawer-scoped last-4 with the
  same anatomy.
- Don't: a second log renderer (LogsTab vs Ops drift); full-row crit fills (the level tag + message
  ink carry severity); ANSI-style rainbow logs; auto-scroll that fights the operator; monospace
  below 12px.

## Migration notes

Replace both legacy log viewers (DUP/P2-10); legacy `--log-col-time/-level/-source` re-value to
72/24/96 as LogStream component tokens (tokens-v3 §6.12); the LogsTab vs Ops level-chip drift
collapses into the lvl tag spec.

## Enforcement hooks

`log-via-primitive` (one implementation, import-restricted), toolbar-contract (every LogStream is
fronted by Toolbar), `virtualize-unbounded-lists` (review), pause-control presence (QA matrix).
