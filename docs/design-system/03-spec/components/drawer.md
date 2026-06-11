# Drawer / Inspector — contextual drill-in with the squeeze-layout production rule

v3.0.0-draft · G2-locked direction · pending G3

Resolves **G2 open item 1** (mandatory): the v2 mockup overlays the compressed table's right
columns; production must squeeze, not just overlay. Locked source: v2.html drawer + decision-log
Round 1 self-critique (1).

## Purpose

Object drill-in that preserves list context: the line inspector opens beside/over the Fleet frame
with status, remedies, and a scoped log — drill-in is contextual, not navigational
(interaction-patterns §7 rung 2).

## Anatomy

```
framewrap (the host frame: toolbar + table + drawer share one container)
└─ drawer (--surface-overlay, left border --border-subtle, --shadow-overlay, width --drawer-w)
   ├─ head: [status shape] [title --type-title] [mode badge] [spring] [close X] — --sp-3 --sp-4,
   │        hairline bottom
   └─ body (scrolls): kv block · divider · remedy actions (Button sm stack + guard note) ·
      divider · scoped log block (LogStream, last N)
```

`--drawer-w: min(360px, 86%)` (component token).

## The squeeze-layout production rule (normative)

The drawer has two layout modes, chosen by **container width of the host frame**, measured with a
container query (flex-basis fallback where container queries are unavailable):

1. **Squeeze mode — container ≥ 1080px.** The drawer participates in layout as a flex sibling of
   the content region (`flex: 0 0 var(--drawer-w)`); the content region shrinks
   (`flex: 1 1 auto; min-width: 0`) and the table **reflows narrower** instead of being covered.
   No scrim. The drawer still animates `translateX` on open/close; the content region's width
   change rides the same 280/180ms timing (width is a layout property — the squeeze is sanctioned
   as a one-shot layout transition on this container only, or implemented scrim-free with the
   table reflow snapping at open/close under the compositor budget; either way row internals never
   tween).
2. **Overlay fallback — container < 1080px.** Exactly the v2 behavior: the drawer slides over the
   frame (`position: absolute; right: 0`) with a scrim over the covered content; below this
   threshold a squeezed table would fall under its minimum useful width (~640px for the Fleet
   collapse set), so covering beats crushing.

**Column priority order for collapse (Fleet table under squeeze).** As the squeezed container
narrows, columns hide in this order (first dropped first):

1. Provider
2. Phone
3. Last
4. Uptime
5. Tokens
6. Today

Never dropped: **Line, Mode, Status, row actions**. Dropped columns' data remains reachable — it
is exactly what the drawer/inline-expand shows ("more items vs more detail",
layout-density §5). Each table consumer declares its own priority list using this format;
the Fleet list above is normative for Fleet/Ops.

## Conceptual props

`open` · `onClose` · `anchor` (edge of the frame it belongs to; default right) · `width` (token
override only) · header slots (shape, title, mode) · `mode` is derived, not set (squeeze/overlay
is the container's decision, not a prop).

## States & motion

- enter: `translateX` 100% → 0, `--dur-slow` `--ease-enter` (the largest spatial move)
- exit: `--dur-base` `--ease-exit` — faster out; visibility gated after transition
- retarget (open → different row): content swaps in place, no re-animation
- focus-visible: standard ring inside; close X receives focus on open (v2 behavior) unless an
  `initialFocus` is supplied
- hover/selected: per contained components; the originating table row may show `aria-current`
  styling (`--accent-wash` edge) while its drawer is open
- disabled/loading: body sections may skeleton (mirroring kv geometry) while the line detail loads
- error: failed load renders the error state with Retry inside the body — never an empty drawer
- reduced-motion: drawer and squeeze appear/disappear instantly

## Accessibility

`role="complementary"` (non-modal squeeze mode) with `aria-label` "Line inspector"; overlay mode
behaves modally-lite: Escape closes (single-fire, one layer), focus moves in on open and restores
to the originating row on close; in squeeze mode Escape also closes while table interaction stays
live; the row that opened it keeps a programmatic reference for focus restore. Keyboard: rows open
on Enter.

## Token references (both themes)

`--surface-overlay`, `--border-subtle`, `--border-hairline`, `--shadow-overlay`, `--scrim`
(overlay mode only), `--drawer-w`, `--dur-slow`/`--dur-base`, easings, spacing/type via contained
components.

## Examples / anti-patterns

- Do: degraded-line triage — warn row click → inspector with status, heartbeat, Restart (confirmed)
  + scoped log, Fleet still visible.
- Don't: drawer as navigation to unrelated content; background scale theatrics; a second drawer
  stacking over the first (retarget instead); covering the table when there is room to squeeze;
  per-screen drawer widths.

## Migration notes

The console has no drawer today (v1 drill-in was a static vignette; LineDetail is a full page).
The drawer is **net-new**: build on `useDismissable` + the Table collapse contract. The legacy
fixed `--sk-col-*` widths must die first — squeeze requires content-sized columns with the
priority list (tokens-v3 §6.12).

## Enforcement hooks

`drawer-via-primitive`, `dismissable-contract`, container-query lint (no viewport-width media
queries for the squeeze decision), column-priority declaration required for any table consumed
inside a squeezable frame (review checklist).
