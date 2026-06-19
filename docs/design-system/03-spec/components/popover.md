# Popover — the `role="listbox"` anchored picker panel

v3.0.0-draft · G2-locked direction · pending G3

The `select.md`-canonical anchored panel for picker surfaces (B2). It is the
`role="listbox"` combobox sibling of `Menu` (`role="menu"`): both ride the shared
`useDismissable` stack, but the Popover keeps **focus on the trigger/input**
(`aria-activedescendant` tracks the active option) where the Menu moves focus into
the surface. Ships as the `Popover` panel plus two co-located exports —
`popoverOptionId` (id builder) and `usePopoverKeyboard` (the combobox key contract).
Renders `.soup-popover` and portals to `document.body` so it is never clipped by an
ancestor `overflow:hidden`. Canonical for picker surfaces — **not** "the only
popover"; legacy dialogs hand-roll their own overlays until B3.

## Anatomy

```
portal → div.soup-popover[data-state] (--surface-overlay; --bw --border-subtle; --r-2;
         --shadow-overlay; min-width = --popover-min-w OR trigger width; max-height
         --popover-max-h ≈ 5 compressed rows; soup-popover-in/out keyframes)
└─ EITHER ul.soup-popover__list[role="listbox", aria-label]            ← listbox mode
│  └─ li.soup-popover__option[role="option", aria-selected, data-active]
│       (height --row-compressed 28px; --type-label; optional accent check · label)
│  OR  {children}  ← generic-content mode (panel carries children directly; B Phase)
```

Positioning is written to the portalled node in a `useLayoutEffect`
(getBoundingClientRect of the anchor) — no ref read during render, no setState
cascade.

## Conceptual props

`open` (boolean) · `onClose` (() ⇒ void) · `anchorRef` (ref to the trigger — panel
anchors below it) · `options?` (`PopoverOption[]` — listbox path) · `activeValue?`
(string|null — `aria-activedescendant` target) · `onSelect?` ((value) ⇒ void) ·
`listboxLabel?` · `listboxId?` (exposed so the combobox trigger can wire
`aria-controls`/`aria-activedescendant`) · `placement?` (`'span'` default = match
trigger width | `'start'` = `--popover-min-w` floor only) · `className?` · `children?`
(generic-content mode).

`PopoverOption`: `value` · `label` · `selected?` (→ `aria-selected` + `--accent-wash`)
· `renderOption?`. **When both `children` and `options` are passed, `children` wins**
(documented; Phase B callers supply children only).

`usePopoverKeyboard({open, options, activeValue, onOpen, onClose, onSelect,
onActiveChange})` → `{ handleKeyDown }` for the combobox trigger.

## Showcase → token mapping

The showcase `.select-pop` swatch (`--surface-1`, `--hair-2`, `--accent-wash` on the
active row) is the picker sketch; the primitive consumes the overlay token set
(`--surface-overlay`, `--border-subtle`, `--shadow-overlay`, `--r-2`,
`--popover-min-w`/`--popover-max-h`, `--row-compressed`, `--row-hover`, `--accent-wash`)
and adds the dismissal/keyboard/portal machinery. The active row uses `--row-hover`
(hover and `aria-activedescendant` share it); selected uses `--accent-wash` + an
`--accent` check glyph.

## States

- **closed**: unmounted (after the `soup-popover-out` dwell via `useExitPresence`).
- **open**: portalled, `soup-popover-in` (`--dur-fast`); focus **stays on the trigger**.
- **option active** (`data-active` / `--active`): `--row-hover`, mirrored by
  `aria-activedescendant` — keyboard and pointer converge on one highlight.
- **option selected** (`aria-selected`): `--accent-wash` + accent check; persists
  across active/hover.
- **dismiss**: outside-click, or **Escape** (capture-phase, one layer only — see
  Accessibility), focus already on the trigger.
- **reduced motion**: the in/out keyframes are removed.

## Accessibility

`role="listbox"` panel with `role="option"` rows; the **combobox trigger keeps focus**
and wires `aria-controls` + `aria-activedescendant` (via `listboxId` /
`popoverOptionId`). **Menu vs Popover** (the contract to keep straight, from the
listbox side):

| | Popover (`role="listbox"`) | Menu (`role="menu"`) |
|---|---|---|
| focus | **stays on trigger/input**; `aria-activedescendant` tracks | moves into the surface; roving `tabindex` |
| Down/Up | move the active option (clamp at ends) | move roving focus (wrap) |
| Enter | select active (caller sequences the close) | activate focused item |

**Escape is capture-phase + `stopPropagation`** through `useDismissable`, which fixes
the recorded Escape-layering defect: a Popover open inside a legacy bubble-phase
dialog consumes Escape **first** — one Escape per layer, the dialog stays open.
`trapFocus:false` + `autoFocus:false` (no focus steal). Options use `onMouseDown`
(not click) with `preventDefault` so selecting never blurs the trigger ahead of the
outside-click handler.

## Examples / anti-patterns

- **Do**: a `Select` options list; a filterable model picker (with an empty-state
  row); a calendar grid (`role="grid"`) via **generic-content mode** in
  `DateTimePicker`; any anchored panel that must escape `overflow:hidden`.
- **Don't**: build a row-action menu as a Popover (use `Menu` `role="menu"` — focus
  moves in); expect a collision-flip — Popover is **bottom-only by design** (DD-23,
  C-B2-2 non-goal; if a surface must flip above/below, that's `Tooltip`'s
  `resolveViewportPlacement`, not this); move focus into the panel (breaks the
  combobox `aria-activedescendant` contract); use `click` for option select (blurs
  the trigger first).

## Enforcement hooks

- **dismissal/focus law** (shared, active): `useDismissable` (capture-phase Escape,
  outside-click, `trapFocus:false`) is the same stack as `Menu`/`Modal` — one law,
  tested in the dismissable suite; the layering fix is regression-guarded there.
- **bottom-only non-goal** (documented): no collision engine — keep it that way
  (DD-23); a future "needs flip" requirement is a `Tooltip`/placement-owner concern.
- **multi-export waiver** (active): the component + `popoverOptionId` + the
  `usePopoverKeyboard` hook co-export under `react-refresh/only-export-components`
  waiver **WVR-012** (expires 2026-12-31) — registered in `eslint-waivers.yaml`,
  enforced by `check-waiver-sync.mjs`.
- **reduced-motion** (active): in/out keyframes removed under `prefers-reduced-motion`.
