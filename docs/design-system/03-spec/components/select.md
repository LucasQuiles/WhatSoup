# Select — native select policy, custom popover anatomy, one dismiss contract

v3.0.0-draft · G2-locked direction · pending G3

Resolves P2-1 (3 native selects ×3 stylings, 4 custom popovers with duplicated dismiss code).

## Policy: native vs custom

- **Native `<select>` is the default** for plain option lists (model pickers, mode filters in
  forms): it gets the system skin (below) and free keyboard/mobile behavior.
- **Custom popover Select** is permitted only when the trigger or options need rich content —
  status shapes, mode badges, meta columns (the line picker), search-within (contact picker).
  Custom selects must use the shared Popover primitive + `useDismissable`; hand-rolled
  outside-click/Escape code is banned.

## Anatomy

**Native skin**: identical box to Input (32px, `--surface-inset`, `--border-strong`, `--r-2`),
`appearance: none`, inline chevron-down glyph at right `--sp-2`, padding-right `--sp-8`.

**Custom select**: trigger styled as Input or as the linepick pattern (status shape + name + meta +
chevron); popover panel on `--surface-overlay`, border `--border-subtle`, radius `--r-2`,
`--shadow-overlay`, min-width = trigger width (dropdown component token for floor); options are
28px rows (compressed density), hover `--row-hover`, selected row `--accent-wash` + leading 16px
check.

## Conceptual props

`options` · `value` · `onChange` · `disabled` · `placeholder` · custom: `renderOption`,
`searchable`.

## States

- default / hover (trigger: neutral hover wash on custom; native unchanged)
- focus-visible: standard ring; popover open state keeps the ring on the trigger
- open (custom): popover fades+scales from anchor at `--dur-fast`–`--dur-base` in, faster out
  (motion.md §5)
- selected option: `--accent-wash` + check + `aria-selected`
- disabled: input-style dashed border, `--text-3`
- error: as Input (border + textual error via the owning Field)
- loading (searchable): inline spinner after the 150–200ms delay
- reduced-motion: popover appears/disappears instantly

## Accessibility

Native: `<label for>`. Custom: trigger `role="combobox"`/`aria-expanded`/`aria-controls`; listbox
+ `role="option"`; full keyboard — Down/Up move, Enter selects, Escape closes one layer and
restores focus to the trigger; type-ahead for long lists. Outside-click closes.
ContactSearchPicker's missing dismiss handling (P2-1) is fixed by construction.

## Examples / anti-patterns

- Do: native select for the conversation-model field; custom for the line picker (shape + meta).
- Don't: a `<select>` disguised as a ghost button (the GroupDetailModal defect); three different
  chevron treatments; popovers without focus restore; menus that trap scroll.

## Migration notes

Restyle the 3 native selects onto one skin; rebuild LinePicker, ChatPicker, ContactSearchPicker,
and the remaining custom dropdown on Popover + `useDismissable` (DUP-03); `c-select` (1 ref) is
absorbed; `--dropdown-min-w` demotes to the Popover component token.

## Enforcement hooks

`popover-via-primitive` (no ad-hoc fixed/absolutely-positioned menus), `dismissable-contract`
(Escape/outside-click/restore-focus from the shared hook only), select-skin single source.
