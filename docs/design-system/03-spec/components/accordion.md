# Accordion / Disclosure — progressive-disclosure primitive

v3.0.0-draft · G2-locked direction · pending G3

Resolves DD-43 (P0 toolkit gap — no disclosure primitive). The progressive-
disclosure principle is structurally absent today; the only consumer-class
target is `ScheduledMessageRow`'s hand-rolled `useState` toggle (and any future
expand-rows). The Popover-backed pickers and Table sort are NOT in scope here
— those are Popover / Table's domain.

## Anatomy

- **`AccordionItem`** — one disclosure row built on the native `<details>` /
  `<summary>` element pair (native semantics carry the open/closed state,
  Space/Enter activation, and focus on the summary for free — no hand-rolled
  `aria-expanded`):
  - `<summary>` carries the `label` (ReactNode; plain text the common case)
    plus a 16px `ChevronRight` glyph (lucide) that rotates 90° when the
    `<details>` is open. The summary uses the ONE canonical focus recipe
    (2px `var(--focus-ring)` outline, 2px offset — lifted verbatim from
    `Card.tsx`). The native disclosure triangle is hidden via
    `list-style:none` + `::-webkit-details-marker { display:none }` so the
    chevron is the sole affordance.
  - `<details>` body region (`.soup-accordion__body`) renders the folded
    `children`. Role="region" + `aria-labelledby` wires the summary/body
    association for assistive tech.
  - `defaultOpen` — paints the row open on first render (native `<details open>`).
- **`Accordion`** — optional group wrapper (`.soup-accordion`). Renders a
  `surface-raised` card with hairline-divided rows. Each item is an independent
  `<details>`; opening one does not close the others (single-open exclusivity is
  OUT OF SCOPE for this primitive — consumers coordinate via their own state
  if they need that behaviour).
- **Chevron rotation** — `transform: rotate(0→90deg)` at `--dur-fast
  --ease-enter`. REMOVED (not shortened) under `prefers-reduced-motion` per
  motion.md §9.

Tokens only — no raw `px` / `hex` / `z-index`. Spacing uses `--sp-*`, radius
uses `--r-2` (cards family), borders use `--bw` / `--border-hairline`,
typography uses the existing `--type-label` and `--type-body` ramps.

## Conceptual props

- `AccordionItem` — `label` (ReactNode), `defaultOpen?` (boolean), `children`
  (ReactNode), `className?` (string).
- `Accordion` — `children` (ReactNode), `className?` (string).

## States

- **default** — closed; chevron points right; label ink `--text-1`.
- **open** — `<details open>`; chevron rotated 90° (down); body revealed.
- **focus-visible** — the summary carries the 2px `--focus-ring` outline at
  2px offset (the one focus recipe, identical to Card / Menu / Tab etc).
- **hover** — summary text → `--text-1` (already at `--text-1`); native
  browser treatment only — no extra wash.
- **reduced-motion** — chevron snaps to the open/closed angle instantly
  (transition removed, not shortened).

## Accessibility

Native `<details>` / `<summary>` give the disclosure semantics for free:
the summary is the focusable, activatable control; Space / Enter toggle the
open state; assistive tech announces the disclosure state. The body region
is `role="region"` with `aria-labelledby` pointing at the summary id so
screen readers can navigate from summary to body. The chevron is `aria-hidden`
(a decorative indicator). Focus recipe on the summary is the shared one
(2px `--focus-ring`, 2px offset).

## Examples / anti-patterns

- Do: `ScheduledMessageRow`'s expand-row → `<Accordion>` (or `<AccordionItem>`
  in isolation); FAQ sections; settings groups folded under a summary.
- Don't: Popover-backed pickers (`LinePicker` / `ChatPicker` /
  `ContactSearchPicker`) or Table sort — those are Popover / Table's domain;
  migrate only true disclosure surfaces here.
- Don't: hand-roll a new `aria-expanded` disclosure toggle outside this
  primitive once it lands (the planned frozen-inventory guard pins the current
  ScheduledMessageRow pattern and fails on new ones).
- Don't: nest accordions inside accordions (layout-density §2 — no
  raised-on-raised stacking).
- Don't: single-open exclusivity via `<details name="…">` — that's out of
  scope for this primitive; consumers must coordinate via state if needed.

## Migration notes

`ScheduledMessageRow`'s inline `useState` toggle → `<AccordionItem>` (the row's
own expandable region) or `<Accordion>` (when grouping multiple disclosure rows).
A follow-up leaf adopts existing consumers; this leaf builds the primitive only.

## Enforcement hooks

- `accordion-via-primitive` — disclose via the primitive, not hand-rolled
  `useState` + `aria-expanded`.
- Frozen-inventory guard (planned, lands with the adoption leaf) — "no
  hand-rolled `aria-expanded` disclosure toggle outside the Accordion primitive".
- The one focus recipe — applied verbatim from `Card.tsx`; never invent a
  second focus ring.
- Reduced-motion law (motion.md §9) — chevron rotation REMOVED, not
  shortened, under `prefers-reduced-motion: reduce`.