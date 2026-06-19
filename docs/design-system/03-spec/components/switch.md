# Switch — the boolean on/off toggle primitive (`role="switch"`)

v3.0.0-draft · G2-locked direction · pending G3

The single-setting boolean toggle. A `Switch` flips one independent on/off setting
(auto-respond, business-hours-only, mute) and the change takes immediate effect;
it is deliberately distinct from `Checkbox` / `CheckboxField`, where a checkbox opts
a value **into a set** and a form-kit field waits on submit. The control is a real
`<button role="switch">` track with a sliding thumb, so native keyboard activation
and `:focus-visible` come for free and there is no synthetic key handling to drift.
Renders the `.soup-switch` / `.soup-switch-row` family; mirrors the showcase Switch
specimen (control-surfaces section; the `.switch` / `.switch-row` recipe).

## Anatomy

```
switch-row (display: flex; align-items: center; justify-content: space-between;
            gap --sp-3)
├─ label span (optional; --text-data; --text-1) — rendered only when `label` set
└─ button[role="switch"] track (--sp-10 × --sp-6; border-radius --sp-6 = pill;
        --bw solid --border-subtle; --surface-inset off / --accent + accent border on;
        cursor pointer; background+border-color transition --dur-fast --ease-enter)
   └─ thumb span[aria-hidden] (--sp-4 square; border-radius 50%; --surface-raised;
        --shadow-hover; offset left --sp-1, vertically centred; on → translateX(--sp-4))
```

The track is namespace-light so it can sit in a settings list row, a modal body, or
an inline cluster without an extra wrapper. The thumb is `aria-hidden` — the track
button owns the accessible state, the thumb is pure affordance.

## Conceptual props

`checked` (boolean, required) · `onChange` ((checked: boolean) ⇒ void, required) ·
`label?` (ReactNode) · `aria-label?` (string) · `disabled?` (boolean, default false) ·
`id?` (string) · `className?` (string, applied to the row wrapper).

The primitive is controlled — it never owns toggle state; `onChange` is called with
the *next* boolean and is short-circuited when `disabled`. Exactly one of `label`
(visible, wired via `aria-labelledby`) or `aria-label` (icon-only rows) supplies the
accessible name. `id` defaults to a `useId`-derived `soup-switch-<id>` when omitted.

## Showcase → token mapping

The raw showcase `.switch` swatch is a styling sketch; the primitive consumes the
token system and adds the affordances a production control needs:

- off track `var(--surface-3)` → `--surface-inset`; on track `var(--accent)` → `--accent`
  (plus an `--accent` border the swatch omits).
- thumb `#fff` (raw white) → `--surface-raised` + `--shadow-hover`.
- fixed `transition: …2s` → `--dur-fast` / `--ease-enter`, **plus** a
  `prefers-reduced-motion` guard the swatch lacks.
- adds a hairline `--bw` `--border-subtle` track frame, a `--focus-ring` focus state,
  and a disabled affordance — none of which exist in the raw recipe.

## States

- **off** (default): `--surface-inset` track, thumb at rest (left).
- **on**: `--accent` track + `--accent` border, thumb translated `--sp-4` right.
- **focus-visible**: 2px `--focus-ring` outline, offset `--bw-accent` (native
  `:focus-visible`, keyboard-only).
- **disabled**: `--opacity-muted`, `cursor: not-allowed`; `onChange` is never called.
- **hover**: no dedicated hover treatment (the row, not the track, carries hover when
  a surface needs it) — `cursor: pointer` only.
- **loading / error**: n/a — the owning surface handles pending writes and failures.

## Accessibility

`role="switch"` with `aria-checked` reflecting the boolean is the whole contract. The
underlying `<button>` gives Space **and** Enter activation and `:focus-visible` natively,
so there is no JS key handling. Naming: when `label` is provided it renders as a sibling
`<span id>` and the control points at it with `aria-labelledby`; for icon-only rows an
explicit `aria-label` is honoured instead (the two are mutually exclusive). Reduced
motion is handled in the stylesheet — the `@media (prefers-reduced-motion: reduce)` block
**removes** (not shortens) the thumb/track transition — so there is no JS media query to
fall out of sync.

## Examples / anti-patterns

- **Do**: a single independent setting whose change applies immediately — "Auto-respond",
  "Business hours only", "Mute notifications". One Switch per setting row.
- **Don't**: use a Switch to opt a value into a multi-select set (use `Checkbox` for a
  bare cell/bulk-bar box, `CheckboxField` for a labelled form-kit field); use it for an
  exactly-one-of-N choice (use `Segmented`); hand-roll a styled `<input type="checkbox">`
  or a `<div onClick>` as a toggle (loses `role="switch"` + native keyboard); leave the
  thumb `<span>` without `aria-hidden` (double-announces).

## Enforcement hooks

- **reduced-motion guard** (active): the `@media (prefers-reduced-motion: reduce)` block
  on `.soup-switch` / `.soup-switch__thumb` is covered by the global motion law
  (`soup/no-infinite-animation` is console-wide; the reduced-variant law is the design
  resilience scan's territory).
- **class ownership** (review-level today): the `soup-switch*` class family should be
  applied only by this primitive — a raw consumer pairing `role="switch"` with a sliding
  thumb is the anti-pattern. A dedicated `soup/no-raw-switch` shadow rule (paralleling
  `soup/no-inline-seg`) is a candidate enforcement; not yet wired.
- **behavioural** (pending G3): `aria-checked` reflects `checked`, Space/Enter toggle,
  and disabled-never-fires want a `tests/console` behavioural suite — none exists for
  Switch yet (`tests/console/*switch*` is absent). Adding it is the G3 gate for this spec.
