# Toolbar — the one pattern that fronts every list, table, and log

v3.0.0-draft · G2-locked direction · pending G3

Locked source: v2.html toolbar spec (C graft, B skin). The DRUIDS consistency law: if filtering,
time-scoping, or search works one way anywhere, it works that way everywhere.

## Anatomy (fixed order)

```
toolbar (--surface-raised, 1px --border-hairline, --r-2, --shadow-raised,
         padding --sp-2 --sp-3, flex wrap, gap --sp-2; flush variant: no radius/side borders,
         joins its table/log block)
├─ filter group — role="group" labeled; interactive Pills with counts
├─ separator — 1px × 16px --border-subtle
├─ seg — segmented time range: 24px buttons, --type-data-sm, 1px --border-strong frame,
│   pressed = --accent fill + --accent-fg; the ONE time-scoping control
├─ spring (flex 1)
├─ search — SearchInput compact (28px), width from the toolbar search component token
└─ primary — one Button primary sm
```

Sections are omittable but never reordered: `[filters | time-range · search · primary]`, used
identically on the Fleet table, the service log, scoped logs, and any future list.

## Conceptual props

`filters` ({label, count, pressed, onToggle}[]) · `range` ({options, value, onChange}) ·
`searchProps` · `primaryAction` · `flush`.

## States

- default: compressed density by construction (28px controls)
- hover: per contained primitives (pill border, seg `--btn-neutral-bg-hover`)
- focus-visible: standard ring; seg buttons pull the ring inset (−2px offset) to stay inside the
  frame
- selected: pill `aria-pressed`; seg pressed = accent fill — both instant
- active/disabled: per contained primitives
- loading: filters render with counts pending as em-dash ghosts; never spinners in the toolbar
- error: n/a (owning surface handles)
- reduced-motion: contained transitions removed

## Accessibility

Filter group and seg each `role="group"` + `aria-label` ("Mode filter", "Time range"); seg
buttons are toggle buttons (`aria-pressed`, exactly one true); filter changes update the table
live — results are announced via the table's count text, not an ARIA storm.

## Examples / anti-patterns

- Do: Fleet — `[all|passive|chat|agent|attention] | [24h|7d|30d] · search · Add line`;
  log toolbar — level pills + `[15m|1h|24h]` + grep search.
- Don't: a second filter idiom (dropdown filters, checkbox rows) for list scoping; two time
  controls on one surface; search boxes outside the toolbar for list filtering; primary buttons
  mid-toolbar; vertical toolbars.

## Migration notes

`c-toolbar` (17 refs/10 files) re-platforms here; `feed-toolbar`/`feed-filters` BEM fold in;
SoupKitchen/Inbox inline search re-rolls adopt the search slot (P2-4); `--toolbar-h` dies —
height emerges from compressed controls + padding (tokens-v3 §6.12); the seg control absorbs the
stray segmented mechanisms (P2-6).

## Enforcement hooks

`single-toolbar-pattern` (import restriction: filter pills/seg/search composition only via this
component), section-order rule (review), one-time-control-per-surface.
