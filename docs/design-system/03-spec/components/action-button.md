# ActionButton — the reveal-label icon-action button

v3.0.0-draft · G2-locked direction · pending G3

The one reveal-label icon-action mechanic (governed by `button.md`): a compact
icon-only button whose text label **expands on hover / focus-visible**, used for row
and toolbar actions where a full label per row would be too heavy. 28×28 minimum hit
area; an optional `danger` flavor recolors to the crit channel. The `label` is
**required** — it is both the accessible name and the revealed text. Renders
`.soup-actbtn`.

## Anatomy

```
button.soup-actbtn[aria-label=label] (min --input-btn 28×28 hit area; padding 0 --sp-1h;
        --r-1; border none; transparent; --text-2 idle)
├─ span[aria-hidden] {icon}                 (18px recommended; omitted if no icon)
└─ span.soup-actbtn__label[aria-hidden] (max-width 0 → --feed-preview-max 120px on
        hover/focus; --type-label; margin-left --sp-1h when revealed)
```

Both the icon and the visible label are `aria-hidden` — the accessible name comes
**solely** from `aria-label`, so it stays stable whether the label is revealed or
collapsed (no double-announce, no name churn on hover).

## Conceptual props

`label` (string, **required** — accessible name AND reveal text) · `icon?` (ReactNode,
18px) · `danger?` (boolean — crit recolor on hover/focus) · plus all native
`ButtonHTMLAttributes` (`onClick`, `disabled`, `aria-*`, …); `type` defaults to
`"button"`, `className` is appended to `.soup-actbtn`.

## Showcase → token mapping

ActionButton is the `button.md` row-action mechanic (not a standalone numbered
showcase specimen). It consumes the button token set — `--input-btn` (hit area),
`--btn-neutral-bg` (hover), `--status-crit-fg`/`--status-crit-wash` (danger),
`--focus-ring`, `--type-label` — and the reveal cap reuses `--feed-preview-max`
(120px). The reveal + danger + focus behaviors are all token-driven; no raw values.

## States

- **idle**: icon only, `--text-2`, transparent; the label is `max-width: 0` (collapsed).
- **hover / focus-visible**: `--text-1` ink, `--btn-neutral-bg`; the label expands to
  `--feed-preview-max` (120px) with a left margin — hover and keyboard focus reveal
  identically.
- **focus-visible**: 2px `--focus-ring` outline, offset `--bw-accent`.
- **danger** (`--danger`): hover/focus recolor to `--status-crit-fg` +
  `--status-crit-wash`.
- **disabled**: native `disabled` (no hover reveal, not focusable).
- **reduced motion**: the label appears **instantly** at full width (no width
  animation) — same end state, no transition.

## Accessibility

`aria-label={label}` is the single source of the accessible name; the icon span and
the reveal-label span are both `aria-hidden`, so AT announces one stable name in
every reveal state. It is a real `<button type="button">` — native Space/Enter
activation and `:focus-visible` for free. The reveal is **progressive enhancement of
the visible affordance, never of the semantics**: a keyboard or SR user has the full
name immediately via `aria-label`, independent of the hover animation. Danger is a
colour *flavor* layered on an already-named action — never colour-as-sole-meaning.

## Examples / anti-patterns

- **Do**: table/list row actions (edit, pause, copy) where a reveal-on-hover label
  keeps the row scannable; a toolbar icon-action cluster; a destructive row action
  with `danger` (paired with a `ConfirmDialog` at the call site).
- **Don't**: omit `label` (it is the accessible name — an icon-only button with no
  name is unusable to SR); rely on the *revealed* text for the accessible name (it is
  `aria-hidden` — `aria-label` carries it); use `danger` alone to signal a destructive
  action without routing the action through confirmation; reach for ActionButton when a
  full always-visible label fits (use a plain `Button`); hand-roll a hover-reveal icon
  button instead of this primitive.

## Enforcement hooks

- **named-button law** (active): `label` is required by the type — an ActionButton can
  never ship without an accessible name; the broader `soup/no-raw-button` rule
  (console-wide) keeps raw `<button>` icon-actions from bypassing this primitive.
- **reduced-motion** (active): the reveal transition is removed under
  `prefers-reduced-motion`, covered by the motion law.
- **class ownership** (review-level): `soup-actbtn*` belongs to this primitive; a
  `soup/no-raw-actbtn` ratchet is a candidate (not yet wired).
- **behavioural** (pending G3): "accessible name stable across reveal" + "danger never
  the sole signal" want a `tests/console` behavioural suite — that is the G3 gate.
