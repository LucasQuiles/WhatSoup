# Tabs — instant underline tabs with ARIA built in

v3.0.0-draft · G2-locked direction · pending G3

Resolves P2-6 (canonical class skips the 9-tab LineDetail bar; 2 extra segmented mechanisms).
Locked source: v2.html tabs spec. The segmented time-range control is Toolbar's (toolbar.md), not
a Tabs variant.

## Anatomy

```
tabs (flex, gap --sp-1, hairline bottom; inset variant adds --sp-4 side padding)
├─ tab — --type-label, --text-2, padding --sp-2 --sp-3, top radius --r-1
│   └─ selected: --text-1 + 2px --accent underline flush to the baseline rule
└─ tabpanel — padding --sp-3 0; hidden panels use the hidden attribute
```

## Conceptual props

`tabs: {id, label, disabled?, disabledReason?}` · `selected` · `onSelect` · `inset`.

## States

- default / hover: ink lifts `--text-2` → `--text-1`, no underline preview, no motion
- selected: `aria-selected="true"`, accent underline — **switches are instant**: no indicator
  tween, no panel crossfade (motion instant band)
- focus-visible: standard ring
- active: as selected
- **disabled-with-reason**: `--text-3` ink, not selectable, `aria-disabled="true"`, kept in the
  tab list and focusable so the reason is discoverable — exposes `disabledReason` as a tooltip
  AND inline `aria-describedby` text ("Logs — unavailable while line is unlinked"). A disabled tab
  without a reason is a defect.
- loading: a tab never spins; its panel shows the loading composite
- error: panel-level error with remedy; the tab itself may carry a crit count Pill
- reduced-motion: nothing to remove — already instant

## Accessibility

`role="tablist"` (labeled) / `role="tab"` `aria-controls` / `role="tabpanel"` `aria-labelledby`;
keyboard: Left/Right move focus (roving tabindex), Home/End jump, Enter/Space select (or
selection-follows-focus — pick one console-wide; default: activate on Enter/Space to avoid
loading 9 LineDetail panels while traversing).

## Examples / anti-patterns

- Do: LineDetail's 9 tabs on this primitive; counts as trailing data-lane numbers.
- Don't: custom underline treatments (the LineDetail re-roll); tabs as navigation between routes
  without tablist semantics matching (use links styled as tabs only with `aria-current`); hiding
  disabled tabs (operators must see what exists); animating the indicator.

## Migration notes

`c-tab` (3 sites) and the LineDetail hand-rolled bar converge here; the two segmented-control
mechanisms re-platform: time-ranges → Toolbar's `seg`, mode pickers → radio-card (wizard) or
filter pills. Tab count cap: a surface needing more than ~9 tabs needs IA work, not scroll.

## Enforcement hooks

`tabs-via-primitive`, `tab-disabled-needs-reason`, instant-switch rule (no transition properties
on tab/tabpanel).
