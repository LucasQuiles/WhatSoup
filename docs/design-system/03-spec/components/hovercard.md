# HoverCard

`v3.0.0-draft · G2-locked direction · pending G3`

Interactive hover/focus disclosure card (showcase §43, DD-43). Retires the hand-rolled
detail cards in `MessageBubble.tsx` and `PipelineTab.tsx`.

## Distinct from Tooltip

A **Tooltip** is a non-interactive accelerator bubble that closes the instant the pointer
leaves the trigger. A **HoverCard**'s content is **interactive** — the pointer must be able
to travel onto the card to read, copy, or click it. HoverCard therefore adds the two things
the Tooltip contract cannot provide: a **hover-bridge** (the card stays open while the pointer
is over the trigger *or* the card) and **open/close debounce**.

## Anatomy

```
[trigger] ──hover/focus──▶ [card panel — role="group", aria-label, above|below]
```

- **Trigger**: a single focusable element. Receives `aria-expanded` + `aria-controls`.
- **Panel**: `.soup-hovercard__panel` — `--surface-overlay` bg, `--shadow-overlay`, `--bw`
  `--border-hairline` border, `--radius-md`, padding `--sp-3`, `--z-toast`. Above/below flip
  via `resolveViewportPlacement`. `pointer-events: auto` only while shown (enables the bridge).

## Props

`card` (ReactNode, interactive) · `cardLabel` (string — accessible name for the `role="group"`
region) · `children` (the focusable trigger) · `id?` · `openDelay?` (default 150ms) ·
`closeDelay?` (default 180ms) · `className?`.

## A11y acceptance matrix (interaction-patterns.md §45)

| Behavior | Contract | Verified by |
|---|---|---|
| Hover-bridge | Pointer trigger→card keeps the card open (single wrapper enter/leave region) | JSDOM mechanics test + **browser proof (B2)** |
| Open debounce | `openDelay` suppresses flicker on fast traversal | JSDOM fake-timer test |
| Close debounce | `closeDelay` lets the pointer cross the gap onto the card | JSDOM fake-timer test |
| Focus path | Focus on the trigger opens immediately — **hover is never required** | JSDOM test |
| Escape | Closes the card, focus **stays on the trigger**, `stopPropagation` (single-layer) | JSDOM test |
| Hover-never-sole-carrier | Same info lives durably elsewhere; trigger carries `aria-expanded`+`aria-controls` | JSDOM test + review |
| Portal / clip-escape | **Owned by the consumer-migration packet (B2)** — needs real-browser proof; not in B1 | **browser proof (B2)** |
| Reduced motion | Lift removed (not shortened) under `prefers-reduced-motion` | **browser proof (B2)** |

## Decision notes

- **Not a modal.** No focus trap, no inert backdrop (`useDismissable` would apply only if it
  grew modal semantics; HoverCard is a non-modal disclosure).
- **Portal deferred to B2.** Clip-escape via a portal requires browser-visual proof (placement,
  theme, reduced-motion, mobile/desktop framing) that JSDOM cannot give; B1 ships the
  hover-bridge/debounce/focus/Escape mechanics inline, B2 adds portal + the browser-proof gate.

## Enforcement hooks

- After both consumers migrate (B3): a `no-raw-hover-card` inventory ratchet (fall-only
  allowlist + honesty test + firing negative fixture) freezes the debt closed.
