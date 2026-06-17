# Checkbox — the boolean selection primitive

v3.0.0-draft · G2-locked direction · pending G3

Resolves showcase §17. The bare checkbox used inside table cells and
selection bars where the consumer owns the row layout. Distinct from
`CheckboxField` (form-kit, label-wrapped, helper-text capable) and
`Switch` (single on/off setting, role="switch").

## Anatomy

A native `<input type="checkbox">` styled via the project token system:

- 16×16 box (`--sp-4` × `--sp-4`); hairline border (`--bw` + `--border-strong`)
- `--radius-xs` corners
- `--surface-raised` background, `--accent` fill when checked
- Checkmark glyph on the checked state; em-dash hint on indeterminate
- Focus ring via the shared `--focus-ring` recipe (focus-visible only)

## Conceptual props

`checked` (controlled) · `onChange(next: boolean)` · `indeterminate` ·
`disabled` · `label` · `className` · `aria-label` (when no visible label).

## States

- default / hover: border darkens to `--accent`
- focus-visible: 2px outline (`--focus-ring`) with `--bw-accent` offset
- checked: `--accent` fill + checkmark
- indeterminate: `--accent` fill + em-dash; independent of `checked`
  (a "select all" header is `checked=false, indeterminate=true` when
  some but not all rows are selected)
- disabled: `cursor: not-allowed`, `--opacity-muted`; the box is inert
  and the change handler does not fire
- reduced-motion: no transition

## Accessibility

- Native `<input type="checkbox">` gives us DOM tab order and Space
  activation for free; no synthetic key handling.
- The DOM `.indeterminate` property is set via a ref effect; it is a
  live state on `HTMLInputElement` (not a JSX attribute) and is
  announced as "partially checked" by screen readers.
- A visible `label` is rendered as a sibling and wired via
  `aria-labelledby`; an explicit `aria-label` is honored for icon-only
  rows that have no visible label.

## Examples / anti-patterns

- Do: per-row selection in a data table; select-all in a table header;
  the bulk-action bar's "X selected" affordances.
- Don't: re-roll a checkbox with a `<div role="checkbox">` (loses
  native keyboard semantics and the `.indeterminate` DOM property);
  use a `Switch` for a single on/off setting; use `CheckboxField` when
  a label, helper, and Field-style control wrapping is wanted.

## Enforcement hooks

- `checkbox-uses-primitive` — no `<input type="checkbox">` outside the
  `Checkbox` primitive or sanctioned consumers.
- The shadow-lint `no-raw-form-control` rule exempts
  `components/primitives/**`; the primitive IS the canonical renderer.
