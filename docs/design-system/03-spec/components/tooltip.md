# Tooltip — the hover/focus accelerator bubble (`role="tooltip"`)

v3.0.0-draft · G2-locked direction · pending G3

A `role="tooltip"` bubble revealed on hover **or** keyboard focus, associated with
its trigger via `aria-describedby`. Retires the hand-rolled `DetailCard` in
`MessageBubble.tsx` (showcase §24, DD-43): one bubble on the paid tokens
(`--tooltip-min-w` / `--tooltip-val-max`) with the single focus recipe, Esc-dismiss,
top/bottom collision flip, and the lift removed (not shortened) under reduced motion.
Governed by interaction-patterns.md §45 — **the bubble is never the sole carrier of
information**, only an accelerator.

## Anatomy

```
span.soup-tooltip (positioned wrapper; owns mouseenter/leave + focus/blur + Esc)
├─ {trigger} — the child element, cloned with aria-describedby=<bubbleId> merged in
│             (stays focusable; the handlers live on the wrapper, not the trigger)
└─ span#<bubbleId>.soup-tooltip__bubble[role="tooltip"] (--tooltip-min-w; max
      --tooltip-min-w + --sp-12; --surface-overlay; --bw --border-hairline;
      --radius-md; --shadow-overlay; --text-1; --text-data; opacity 0 → 1 on --show)
   └─ span.soup-tooltip__caret (--sp-2 rotated-45 square; edge flips with placement)
```

The bubble is rendered for measurement but only painted (`opacity`/`transform`) when
`--show` — CSS owns the reveal motion. `data-placement` reflects the resolved side.

## Conceptual props

`content` (ReactNode — the bubble body; **must also live durably elsewhere** per §45) ·
`children` (a single focusable `ReactElement` — the trigger that receives
`aria-describedby`) · `id?` (string — the bubble id / describedby target) · `className?`
(on the positioned wrapper span).

The primitive injects `aria-describedby` onto the real trigger node via `cloneElement`
(merging any existing value); pointer/focus/Esc handlers sit on the wrapper span (whose
`onFocus`/`onBlur` catch the bubbling `focusin`/`focusout`) so the trigger is never
handed a ref-bearing prop.

## Showcase → token mapping

Showcase §24 shows the bubble geometry as literals (`--tooltip-min-w 220`,
`--tooltip-val-max 160`); the primitive consumes those component tokens plus the
shared overlay set (`--surface-overlay`, `--border-hairline`, `--shadow-overlay`,
`--radius-md`, `--text-data`). It adds the full interaction contract the static
swatch only annotates — hover **and** focus reveal, `aria-describedby` association,
Esc-dismiss, collision flip, and the reduced-motion guard.

## States

- **hidden** (default): `opacity: 0`, `aria-hidden="true"`, not interactive.
- **shown** (`--show`): hover OR focus → `opacity: 1`, lift settles to rest; the
  reveal is OR-gated so pointer and keyboard are independent.
- **placement above / below**: `resolveViewportPlacement` flips the bubble (and the
  caret edge) when it would clip the top edge; default `above`.
- **dismiss**: mouseleave, blur, or **Escape** (without moving focus off the trigger).
- **reduced motion**: the translate lift is **removed** (not shortened) — the bubble
  appears in place.

## Accessibility

The bubble is `role="tooltip"` and is associated with the trigger by
**`aria-describedby` on the anchor** — never a `title`-only string a keyboard or SR
user can't reach. The trigger **stays focusable**; reveal is bound to both pointer
(`mouseenter`/`leave`) and keyboard (`focus`/`blur`). **Escape dismisses without
moving focus** and `stopPropagation`s so a tooltip inside a dialog does not also close
the dialog (one-layer law §2). Per §45 the tooltip is an **accelerator, never the only
path to the fact** — anything shown here must also exist in a durable detail surface.
This is the canonical "disabled-with-reason" surface: it pairs with a control's
`disabledReason` (e.g. `Menu`'s `MenuItem`) so the *why* is reachable, not hidden in a
`title`.

## Examples / anti-patterns

- **Do**: a hint accelerator on a control whose meaning also lives in a panel/label
  ("Billing requires a linked channel"); a disabled-with-reason explainer reached via
  `aria-describedby`; a truncated-value expander (`--tooltip-val-max`).
- **Don't**: put information **only** in a tooltip (§45 — it must exist durably
  elsewhere); use a `title` attribute (unreachable by keyboard/SR, no styling, no
  collision flip); make the trigger non-focusable (keyboard users never see it); use
  raw `matchMedia`/`innerWidth` for placement (use `resolveViewportPlacement`, the
  sanctioned viewport owner — `soup/no-raw-viewport-js`); let Esc bubble and close an
  enclosing dialog.

## Enforcement hooks

- **viewport-owner law** (active): placement goes through `resolveViewportPlacement`;
  raw `matchMedia`/`innerWidth` in component code is caught by `soup/no-raw-viewport-js`
  (the `isViewportOwnerFile` allowlist is pinned to the exact owner files).
- **never-sole-carrier** (review + behavioural, pending G3): §45 cannot be fully
  mechanised — a behavioural test should assert the `aria-describedby` association and
  Esc-dismiss-without-focus-move; the durable-elsewhere rule stays a review check.
- **adoption** (open, separate slice): `MessageBubble` `DetailCard` + `PipelineTab`
  `NodeDetailCard` are still hand-rolled hover cards (DD-43) — migrating them to this
  primitive, then a `soup/no-raw-tooltip` ratchet, is the GATED adoption follow-up.
- **reduced-motion** (active): the lift is removed under `prefers-reduced-motion`,
  covered by the motion law.
