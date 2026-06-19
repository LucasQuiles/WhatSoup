# Menu — the `role="menu"` row-action surface

v3.0.0-draft · G2-locked direction · pending G3

The row / bulk action surface (showcase §22, DD-43). Ships as `Menu` (trigger +
portalled surface) with `MenuItem`, `MenuSection`, and `MenuSeparator`. It is the
`role="menu"` sibling of `Popover` (a `role="listbox"` combobox picker): the two
share the `useDismissable` stack — one focus + dismissal law — but carry **different
ARIA + keyboard contracts** (see Accessibility). Renders the `.soup-menu` family and
portals to `document.body` so it is never clipped by an ancestor `overflow:hidden`
row.

## Anatomy

```
Menu
├─ button.soup-menu-trigger (Menu owns it; aria-haspopup="menu"; aria-expanded;
│                            ArrowDown/Enter/Space open)
└─ portal → div.soup-menu[role="menu", aria-label] (--surface-overlay; --bw
            --border-subtle; --r-2; --shadow-overlay; min-width --popover-min-w;
            padding --sp-1; soup-menu-in/out keyframes)
   ├─ div.soup-menu__section[role="group", aria-labelledby]
   │  └─ div.soup-menu__label (overline; mono-feel uppercase; --text-3)
   ├─ div.soup-menu__item[role="menuitem" | "menuitemcheckbox"] (--type-label; --text-2;
   │     leading icon|check · label · trailing <kbd> shortcut · sr-only reason)
   └─ div.soup-menu__sep[role="separator"] (--border-hairline hairline)
```

## Conceptual props

**Menu:** `label` (string, required — surface `aria-label`) · `triggerLabel`
(ReactNode — Menu owns the trigger button) · `triggerLabelText?` (string — trigger
accessible name, defaults to `label`) · `triggerClassName?` · `children`
(items/sections) · `className?` (panel).

**MenuItem:** `children` (label) · `onSelect?` (() ⇒ void) · `shortcut?` (string —
trailing `<kbd>`) · `icon?` (ReactNode, decorative) · `disabled?` · `disabledReason?`
(string — required when disabled; exposed via `aria-describedby`) · `checkable?` +
`checked?` (→ `menuitemcheckbox`) · `destructive?` + `confirmTitle?`/`confirmBody?`/
`confirmLabel?` (route through `ConfirmDialog`).

**MenuSection:** `label` (string, group heading) · `children`.
**MenuSeparator:** none.

## Showcase → token mapping

The showcase §22 `.menu` swatch is a styling sketch (`--surface-3`, `--hair`,
`color-mix(--accent 12%)` hover, `--crit` for danger); the primitive consumes the
semantic tokens — `--surface-overlay`, `--border-subtle`/`--border-hairline`,
`--accent-wash`, `--status-crit-fg`/`--status-crit-wash` — and adds the affordances
the swatch only implies: a `--focus-ring` focus state, the `prefers-reduced-motion`
guard, and the full keyboard + ARIA machinery (roving, sections, checkable, disabled
reason, destructive routing). The hue *family* matches; the canonical values are the
tokenised ones.

## States

- **closed**: only the trigger renders; `aria-expanded="false"`.
- **open**: surface portalled and animated in (`soup-menu-in`, `--dur-fast`); focus
  moves to item 0.
- **item idle / hover / focus**: idle `--text-2`; hover **and** roving-focus →
  `--accent-wash` + `--text-1`; focus-visible adds a 2px `--focus-ring` outline.
- **checkable**: `aria-checked` with an accent leading check; activating keeps the
  surface **open** (several toggles read as one task).
- **destructive**: `--status-crit-fg` ink, `--status-crit-wash` hover; activation
  **closes the menu and opens `ConfirmDialog`** — the action never fires from the click.
- **disabled**: `--text-3`, no hover background, **stays arrow-reachable**; the
  `disabledReason` is announced.
- **closing**: `data-state="closing"` plays `soup-menu-out`, then unmounts (deferred
  via `useExitPresence`; instant in jsdom). Reduced motion removes both keyframes.

## Accessibility

`role="menu"` with an `aria-label`; the trigger carries `aria-haspopup="menu"` +
`aria-expanded`. **Menu vs Popover** (the one contract to keep straight):

| | Menu (`role="menu"`) | Popover (`role="listbox"`) |
|---|---|---|
| focus | **moves into** the surface; roving `tabindex` walks items | stays on trigger/input; `aria-activedescendant` tracks |
| activate | Enter/Space on the focused item | Enter selects the active option |
| Esc | closes **and restores focus to the trigger** | closes, focus already on trigger |

Keyboard (WAI-ARIA menu pattern, via `useDismissable` + the panel roving handler):
ArrowDown/ArrowUp move between items **including disabled ones** (wrap), Home/End
jump to first/last, Enter/Space activate, Escape closes one layer (stacking-aware)
and restores focus. Items: `menuitem` / `menuitemcheckbox` (`aria-checked`);
sections are `role="group"` + `aria-labelledby` (the mono label is `aria-hidden`,
named via the group); separators are `role="separator"`. **Disabled is never
silent** — `disabledReason` is surfaced via `aria-describedby` (never a bare `title`)
and the item remains focusable. The accent check is identity/selection, never a
status channel.

## Examples / anti-patterns

- **Do**: a row context menu (`Open logs ⌘L` / `Pause` / `Edit tags` / —— /
  `Delete line`); a bulk-action menu with checkable filters; sectioned actions under
  mono group labels.
- **Don't**: fire a destructive action straight from the click (must route through
  `ConfirmDialog`); use a `title` attribute for a disabled reason (use
  `disabledReason` → `aria-describedby`); skip disabled items in arrow navigation
  (they stay reachable so their reason can be read); build a combobox/option-picker
  as a Menu (use `Popover` `role="listbox"`); hand-roll a `role="menu"` div with a
  static dropdown instead of this primitive.

## Enforcement hooks

- **dismissal/focus law** (shared, active): `useDismissable` owns Escape, Tab
  trapping, outside-click, and focus restoration — the same stack as `Modal`/`Popover`
  (one law, tested in the dismissable suite). A Menu must not re-implement dismissal.
- **destructive-confirm** (review + behavioural, pending G3): "destructive never
  fires from the menu click" wants a behavioural test asserting the `ConfirmDialog`
  gate; the `data-destructive` hook is present for a future scan.
- **class ownership** (review-level): the `soup-menu*` classes + `role="menu"` belong
  to this primitive; a `soup/no-raw-menu` shadow rule is a candidate (not yet wired).
- **reduced-motion** (active): the `soup-menu-in`/`-out` keyframes are removed under
  `prefers-reduced-motion`, covered by the motion law.
