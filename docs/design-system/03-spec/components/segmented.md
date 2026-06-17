# Segmented — the canonical role="group" + aria-pressed exactly-one control

v3.0.0-draft · G2-locked direction · pending G3

Resolves DD-32 (C-B3W2-4 seg naming/extraction ruling). The wave-2 segmented-control
pattern that shipped inline in two dialogs and as `ToolbarTimeRange` is now a single
shared primitive; the rendered recipe (`.soup-toolbar-seg` / `.soup-toolbar-seg__btn`)
is unchanged. `ToolbarTimeRange` survives as a thin alias of `Segmented` for
back-compat with the wave-2 toolbar consumption and the toolbar.md anatomy.

## Anatomy

```
segmented (display: inline-flex; --border-strong 1px; --r-1; overflow hidden)
└─ button × N (height --sp-6; padding 0 --sp-2; --type-data-sm;
                --text-2 idle; 1px --border-strong divider between buttons;
                :last-child drops its right border; exactly one is pressed)
```

The container is a `role="group"` with a required `aria-label`. Each button is a
real `<button type="button">`; pressed state is the standard `aria-pressed` boolean
(exactly-one-true invariant). The CSS family (`.soup-toolbar-seg` /
`.soup-toolbar-seg__btn`) is the same BEM the toolbar seats use — the primitive is
intentionally namespace-free so it can sit in a toolbar, a modal body, or a free
form cluster without an extra wrapper.

## Conceptual props

`label` (string, required) · `options` ({label, value}[]) · `value` (string) ·
`onChange` (value) · `disabled?` (boolean, default undefined).

`value` must equal exactly one `option.value`; the rendered pressed button is the
match. `options` order = visual + DOM order. Disabled is additive: when `true`,
all buttons carry the `disabled` attribute and the `onClick` is short-circuited —
no consumer has to add per-button logic.

## States

- default: idle ink (`--text-2`); pressed button fills with `--accent` / `--accent-fg`
- hover (idle button only): `--btn-neutral-bg-hover` wash, ink lifts to `--text-1`
- focus-visible: 2px `--focus-ring` outline, inset (−2px) so the ring stays inside
  the seg frame
- disabled: `--opacity-disabled`, `cursor: not allowed`; `onChange` is never called
- selected: pressed = accent fill, instant
- loading / error: n/a (owning surface handles)

## Accessibility

`role="group"` on the container with a required `aria-label` exposes the cluster to
AT as a single labeled group. Segments are toggle buttons (`aria-pressed` boolean);
the exactly-one-true invariant is enforced by the controlled `value` prop — the
primitive never owns selection state. Arrow-key roving is intentionally NOT in this
primitive: when the seg lives inside a `Toolbar`, the toolbar's roving handler
already owns arrow/Home/End for the whole toolbar (WAI-ARIA 1.2 §3.25). When the
seg lives outside a toolbar (e.g. `DateTimePicker` recurrence row), individual
buttons are reached by Tab/Shift-Tab and activated with Enter/Space — the standard
HTML button contract.

## Examples / anti-patterns

- Do: toolbar time-range `24h | 7d | 30d` (as `ToolbarTimeRange`); modal recurrence
  row `Once | Daily | Weekly | Cron` (as `<Segmented label="Recurrence" …/>`); any
  exactly-one N-way toggle.
- Don't: a second segmented mechanism (dropdown filters, checkboxes, a 2nd toolbar
  pattern) for an N-way choice; raw `<button>`s with hand-rolled `aria-pressed`
  (a segmented inline pattern that pre-dated this primitive); a 2-state toggle
  (use `Pill` `variant="interactive"`); a multi-select group (use a checkbox row,
  not this primitive).

## Migration notes

Inline `.soup-toolbar-seg` markup in `DateTimePicker` adopts `Segmented` directly
(same DOM, same classes, same a11y); the wave-2 `ToolbarTimeRange` becomes a
thin alias of `Segmented` and the `ToolbarTimeRangeProps` export is preserved.
No CSS changes, no new tokens, no consumer signature churn.

## Enforcement hooks

`soup/no-inline-seg` (the `soup-toolbar-seg` class may only be applied by the
`Segmented` / `ToolbarTimeRange` primitive), `seg-aria-pressed-exactly-one`
(review + behavioural tests), `seg-uses-aria-label` (review).
