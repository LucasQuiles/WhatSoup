# InlineEdit — the edit-in-place primitive

v3.0.0-draft · G2-locked direction · pending G3

Resolves showcase §17. A dashed-underline button (display mode) that swaps
to a `TextInput` on activation. Enter commits via `onCommit` (awaited when
a promise; disabled while pending), Esc and blur cancel (revert, no
commit), an unchanged value exits without committing, and an optional
`validate` blocks invalid input and surfaces an inline error. Distinct
from `Field` + `TextInput` (form-kit, label-wrapped, helper-text capable):
InlineEdit is the single-cell edit-in-place control for summary rows and
read-modes-that-flip-to-edit.

## Anatomy

- Display: a `<button type="button">` carrying `.soup-inline-edit`
  - body face (`--type-body`), `--text-1` ink
  - dashed `--border-hairline` bottom rule; 4px-grid padding (`--sp-1`)
  - a lucide `Pencil` affordance (`aria-hidden`, `--text-3`)
  - accessible name `Edit ${label}` (the button is a real button so
    Click / Enter / Space all activate it natively)
- Edit: a `TextInput` (FormControl primitive) seeded with `value`,
  auto-focused on entry, accessible name `label`
  - Enter → validate → `onCommit`; Escape and blur → cancel
- Error: a `--status-crit-fg` caption bound to the input via
  `aria-describedby` + `aria-invalid`
- Focus ring via the shared `--focus-ring` recipe (focus-visible only)

## Conceptual props

`value` (controlled string) · `onCommit(next: string) => void | Promise<void>` ·
`label` · `validate?(v: string) => string | null` · `placeholder?` ·
`disabled?` · `emptyText?` (default "—").

## States

- default: dashed hairline underline; the pen glyph hints editability
- hover: underline darkens to `--border-strong`
- focus-visible: 2px outline (`--focus-ring`) with `--bw-accent` offset
- edit: TextInput replaces the button; auto-focused
- error: `validate` returned a message → `aria-invalid` + describedby
  caption; the input keeps focus and the edit persists
- busy: `onCommit` is pending → the input is `disabled`; blur during the
  pending commit is ignored (a committing guard prevents accidental cancel)
- disabled: `cursor: not-allowed`, `--opacity-disabled`; the button is
  inert and entry is blocked
- reduced-motion: no transition

## Accessibility

- The display control is a real `<button type="button">`: native tab order,
  Enter AND Space activation, `:focus-visible` for free — no synthetic
  key handling on the display side.
- Button accessible name is `Edit ${label}` so SR users hear intent; the
  input's accessible name is `label`.
- `validate` failures set `aria-invalid="true"` and `aria-describedby`
  pointing at the error caption (which also carries `role="alert"`).
- Esc cancels (revert + exit); blur cancels. Enter commits only when the
  value changed and `validate` accepted it.

## Examples / anti-patterns

- Do: edit-in-place for a single free-text config row (e.g.
  `agentOptions.fallbackModel`); name/tags cells where a full modal is
  heavier than the edit warrants.
- Don't: use InlineEdit where a label, helper text, and Field wrapping are
  wanted — use `Field` + `TextInput`. Don't render the value as a raw
  `<span>`/`<div>` that swaps to an input on click — InlineEdit owns that
  lifecycle (focus, busy, validate, Esc/blur). Don't drop the `Pencil`
  affordance or the `Edit ${label}` name — discoverability and SR intent
  depend on them.

## Enforcement hooks

- `inline-edit-uses-primitive` — free-text edit-in-place cells should
  adopt InlineEdit rather than re-rolling the button/input swap.
- The shadow-lint `no-raw-form-control` rule exempts
  `components/primitives/**`; the primitive IS the canonical renderer
  (the TextInput it composes is the sanctioned form control).
