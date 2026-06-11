# Input — text, number, textarea, and search fields on the inset surface

v3.0.0-draft · G2-locked direction · pending G3

Resolves P2-2 (wizard form kit unused outside the wizard) and P2-4 (search ×3). Locked source:
v2.html form-controls spec block.

## Anatomy

**Field** wrapper (grid, gap `--sp-1`, max-width 320px / 480px wide / none full):
`[label] [control] [hint | error]`.

- Label: `--type-label`, `--text-1`; required marker `*` in `--status-crit-fg`.
- Control: height `--input-h` 32px (compact 28px), padding `0 --sp-3`, `--type-body`, ink
  `--text-1`, background `--surface-inset`, border 1px `--border-strong`, radius `--r-2`,
  placeholder `--text-3`.
- Hint: `--type-caption`, `--text-2`. Error: 500 12/16, `--status-crit-fg`, replaces/joins hint.

## Variants

- **text** — default.
- **number lane** (`input--num`): `--type-data` + tabular figures; numeric/tel `inputmode`; width
  may take the number-lane component token.
- **textarea**: auto height, min-height 80px, padding `--sp-2 --sp-3`, vertical resize only;
  composer flavor (single-row grow) for the Inbox reply box.
- **search**: leading 16px search icon (absolute, `--text-3`), padded left `--sp-8`; optional
  clear button (24px hit area, appears only with content). One SearchInput component — inline
  re-implementations are banned.

## Conceptual props

`label` · `hint` · `error` · `required` · `size` (default/compact) · `disabled` · `value` etc. ·
search: `onClear`.

## States

- default / hover (no visual change — fields are calm)
- focus-visible: 2px `--focus-ring` at 1px offset + border recolors to `--focus-ring`; instant
- error: border `--status-crit-fg` + inset 1px crit shadow (reads as 2px), `aria-invalid="true"`,
  `aria-describedby` → error node; GOV.UK textual error (interaction-patterns §6); appearance is
  instant, no shake
- disabled: ink `--text-3`, background `--surface-base`, **dashed** border — unmistakable;
  contrast-exempt
- loading: fields don't spin; async validation renders as hint text until resolved
- reduced-motion: border-color transition removed
- selected: n/a

## Accessibility

`<label for>` always (no placeholder-as-label); hint joined via `aria-describedby`; error wiring
per interaction-patterns §6; clear button has `aria-label="Clear search"`; choice rows
(checkbox/radio/switch — specified with this family) give 24px full-height label targets and
focus-visible on the proxy box.

## Examples / anti-patterns

- Do: validate on blur, clear on input; mono lane for ports/phones; disabled provider field shows
  dashed border rather than vanishing.
- Don't: placeholder-only labeling; color-only error; per-dialog re-rolls of label+input+helper;
  half-height compact fields below 28px; search boxes given magic widths (use the toolbar's
  component token).

## Migration notes

Promote `wizard/form-primitives.tsx` (Field, TextInput, NumberInput, SelectInput, TextArea,
CheckboxField) to `components/form/` as the canonical kit (DUP-12); migrate ConfigEditDialog,
ScheduleComposerModal, CreateGroupModal, GroupDetailModal off raw `c-input`/`c-field-label`;
adopt SearchInput in Inbox and Fleet (P2-4). Legacy `--input-h` carries; `--input-btn` →
`--btn-h-sm`.

## Enforcement hooks

`form-via-field-kit` (no raw `c-input`-style recipes), `search-input-single-source`,
`input-error-aria-wiring` (review checklist), focus-visible rule.
