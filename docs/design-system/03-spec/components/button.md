# Button — the single button primitive: six variants, three sizes, one reveal-label mechanic

v3.0.0-draft · G2-locked direction · pending G3

Resolves P1-1 (11 legacy variants, 24 raw buttons, 4 reveal-label copies). Locked source: v2.html
buttons spec block.

## Anatomy

`[icon?] [label] [icon?]` in an inline-flex box: height from size, padding `--sp-3` (md) /
`--sp-2` (sm/xs), gap `--sp-2`, radius `--r-2`, `--type-label` (xs drops to 11/16),
`white-space: nowrap`, 1px border (transparent unless the variant colors it).

## Variants × sizes

| Variant | Fill | Ink | Border | Use |
|---|---|---|---|---|
| primary | `--accent` (hover `--accent-hover`) | `--accent-fg` | none | the one primary action per surface |
| neutral | `--btn-neutral-bg` (hover `-hover`) | `--text-1` | `--border-strong` + `--shadow-xs` | secondary actions |
| ghost | none (hover `--btn-neutral-bg`) | `--text-2` (hover `--text-1`) | none | tertiary/cancel |
| danger | `--status-crit-wash` (hover 18% mix) | `--status-crit-fg` | `--status-crit-border` | destructive |
| success | `--status-ok-wash` (hover 18% mix) | `--status-ok-fg` | `--status-ok-border` | confirm-positive |
| warning | `--status-warn-wash` (hover 18% mix) | `--status-warn-fg` | `--status-warn-border` | disruptive (restart) |

Sizes: md 32px (`--btn-h`), sm 28px, xs 24px — xs sits exactly on the WCAG target floor; nothing
smaller exists. Channel variants stay tinted-quiet (wash fill + channel fg), never solid alarm fills.

## ActionButton (reveal-label)

The consolidated icon-action: 28×28px minimum hit area, icon 18px, `--text-2` resting; on hover
**or focus-visible** the text label expands (max-width 0→120px at `--dur-fast`, opacity linear) —
the ONE reveal-label mechanic, shared by nav/send/add/feed/row-action contexts. Danger flavor
recolors to `--status-crit-fg` + `--status-crit-wash`. The `max-width` animation holds the named
waiver in motion.md §3. Reduced motion: label appears instantly.

## Conceptual props

`variant` (primary/neutral/ghost/danger/success/warning) · `size` (md/sm/xs) · `icon`/`iconEnd` ·
`disabled` · `loading` · `type` (defaults to `button`). ActionButton: `label` (required — it is the
accessible name), `danger`.

## States

- default / hover (fill shift, `--dur-fast` color transition only) / active (no extra motion)
- focus-visible: the global 2px `--focus-ring` + 2px offset; never suppressed
- selected: not a button concern — toggles are Pill `aria-pressed` or Tabs
- disabled: `opacity: var(--opacity-disabled)` (0.45), `cursor: not-allowed`, keeps variant colors;
  still ≥ readable as disabled (contrast-exempt by SC 1.4.3)
- loading: spinner (motion.md §6) replaces the start icon, label persists, button inert
  (`aria-busy`), no width jump
- error: buttons have no error state; errors belong to the surface
- reduced-motion: color transitions and reveal animation removed; states snap

## Accessibility

Native `<button>`; icon-only forms require `aria-label`; destructive buttons are never
default-focused in dialogs; loading sets `aria-busy="true"` and keeps the accessible name.

## Examples / anti-patterns

- Do: one primary per toolbar/modal; ghost for cancel; warning for restart with confirm modal.
- Don't: raw `<button>` with utility classes (the **raw-button ban** — only this primitive may
  render a button outside whitelisted files); don't compose a "link that acts" as a button —
  links navigate, buttons act; don't invent a 7th variant (nav/send/add collapse into
  ActionButton).

## Migration notes

`c-btn` family (104 refs/31 files, census §16) maps: primary/ghost/sm/xs/danger/success/warning →
same-named variants; `c-btn-nav`/`-send`/`-add` + their label helpers and `fc-action__label` (4
mechanic copies, DUP-01) → ActionButton; 24 raw buttons re-wrapped; Ops inline size overrides →
`size` prop. Legacy primary fill was `--color-s-ok` — re-points to `--accent` (P2-12).

## Enforcement hooks

`no-raw-button` (import restriction + JSX element ban outside the primitive), 
`button-variant-closed-set`, reveal-label single-source (the mechanic exists only in ActionButton).
