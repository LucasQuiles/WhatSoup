# Layout & density — grid, surface usage, two-density model, target and reflow floors

v3.0.0-draft · G2-locked direction · pending G3

Sources: v2.html (locked), research-digest signals 1/2, seed-2 (24px target, 320px reflow),
seed-3 ("more items vs more detail", touch targets), inconsistency-register P3-7.

## 1. The 4px grid

Every dimension — spacing, control heights, row heights, leadings, icon boxes — sits on the 4px
grid: spacing steps 4/8/12/16/20/24/32/40/48, control heights 24/28/32, row heights 28/36,
leadings 16/20/24/28/32. The grid is closed: no half steps (the legacy 3/6/10px tokens are
rejected — tokens-v3 §6.11). Off-grid values are lint findings; the only exceptions are 1px
hairlines and component-internal optical corrections declared in a component spec.

## 2. Surface ladder usage

Four named surfaces per theme (tokens-v3 §3.1); assignment is by role:

| Surface | Used for | Never used for |
|---|---|---|
| `--surface-base` | app canvas, page background, thread bed | cards, overlays |
| `--surface-raised` | cards, panels, toolbars, table wraps, KPI tiles | modals, inputs |
| `--surface-overlay` | modals, drawer, popovers, toasts | page-level content |
| `--surface-inset` | input wells, log beds, code blocks, expanded-row beds, radio cards | anything floating |

Stacking depth is at most: base → raised → overlay. Nesting raised-on-raised is banned; content
inside a panel sits directly on the panel or in an inset well.

## 3. Two-density model

Exactly two designed densities, carried by `--row-default` (36px) and `--row-compressed` (28px):

| Density | Surfaces |
|---|---|
| **compressed** (28px rows, compact controls 28px, `--type-caption`/`--type-data-sm` lanes) | Fleet table, Ops, log streams, toolbars, any monitoring/triage list |
| **default** (36px rows, 32px controls, `--type-body`/`--type-data` lanes) | forms, the add-line wizard, settings, browse lists, Inbox panes |

Density is a component property (`density="compressed"`), never a per-screen font-size override.
A third density does not exist; per-screen ad-hoc sizing is a lint finding. Forms and the wizard
never go compressed (EUI precedent, digest §b).

## 4. Target floors

- **24×24 CSS px minimum** for every interactive element (WCAG 2.2). The xs button (24px) sits
  exactly on the floor; nothing interactive goes below it. Small visual elements (pill close
  buttons, expanders) reach the floor through padded hit areas (`min-width/min-height: 24px`).
- **44px touch-desirable**: any surface designed for touch-heavy contexts (future mobile/pairing
  flows, QR link step) raises primary targets to 44px. Density never undercuts tap targets.
- Choice rows (checkbox/radio/switch labels) give the full-height 24px target row.

## 5. Reflow and breakpoint posture

- **320px reflow floor**: every surface remains operable at 320px viewport width without
  two-dimensional scrolling (WCAG 1.4.10), except data tables, which may scroll horizontally as a
  documented exception while their toolbar and headers reflow.
- **Breakpoints are content-driven, never device names.** Layout changes happen where the layout
  visibly stresses (the v2 thresholds: side column folds under ~1080px, contact pane hides, radio
  cards stack under ~920px) — expressed as container queries on the stressed container wherever
  possible, viewport queries otherwise. No `sm/md/lg` device-class semantics in specs; name the
  threshold after the stress ("inbox loses contact pane", "dashboard single-column").
- **"More items vs more detail" rule** (seed-3): when space shrinks, prefer showing *more items
  with less detail per item* on monitoring surfaces (drop columns, keep rows) and *more detail on
  fewer items* on focus surfaces (Inbox keeps the active conversation, drops the contact pane).
  Each list/table spec declares its column-collapse priority (e.g. `components/drawer.md` §4 for
  the Fleet table squeeze).

## 6. Composition primitives (replacing layout utilities)

Open-item-3 consequence (tokens-v3 §8): ad-hoc flex/margin utilities are forbidden. Layout is
composed from:

- **Container** — page shell, `--container-max` 1280px, `--sp-6` gutters.
- **Stack** — vertical flow, `gap` bound to spacing tokens.
- **Cluster** — horizontal wrap-row, `gap` bound to spacing tokens, alignment props.
- **Prose** — 80ch measure for running text.

Margins between siblings are banned (`no-margin`); parents own spacing via `gap`.

## 7. Panel and drawer widths

Component-owned width tokens (tokens-v3 §4): drawer `min(360px, 86%)`; modal 480/560/720; Fleet
side column 320px; Inbox panes 264px (chats) / 248px (contact). Panels are content-height; only
scroll regions (table wraps, log beds, chat lists, drawer body) scroll internally.

## 8. Resilience rules of thumb

These rules are binding design law before they become hard lint:

- **Text wraps by default.** Operator names, provider names, routes, sockets, paths, errors, IDs,
  user-authored text, and protocol-adjacent labels may truncate only when a full-value path exists
  (`title`, `aria-label`, `data-full-value`, a documented details surface, or `aria-describedby`
  only when the described node itself carries the full value; generic helper/error descriptions do
  not qualify).
- **One scroll owner per axis.** Pages, modals, drawers, tables, logs, and chat panes declare the
  element that owns vertical and horizontal scrolling. Scrollable flex/grid children carry the
  matching min-size escape (`min-h-0` for vertical, `min-w-0` for horizontal) or a documented
  exception.
- **Interaction states reserve geometry.** Hover, focus, active, loading, badge count, reveal-label,
  and validation states do not change sibling layout. Reserve stable width/height/gap/padding,
  margin, border width, and grid tracks in the base state; state changes may alter color, opacity,
  transform, or content inside the reserved box.
- **Typography never scales with viewport width.** Compact layouts use the type scale and density
  tokens, not `vw` font sizes or viewport-based `clamp()` math.
- **Layering is named.** Floating UI uses layer tokens (`--z-*`) or a documented layer owner. Raw
  numeric `z-*` values are temporary findings until the layer owner is encoded.
- **Reduced-height viewports are first-class.** 1440x500 and 390x844 must keep primary actions,
  focus rings, validation text, and one-axis scroll reachable without hiding the only exit path.

## 9. Migration notes

- Legacy half-steps and the 60+ globalized component dimensions: dispositions in tokens-v3 §6.11–12.
- The legacy `--sk-col-*` fixed column widths are replaced by content-sized columns + the collapse
  priority list (drawer.md).
- Route-level layout (4 pages + line-detail tabs) is unchanged — this program reskins page-level IA, it
  does not restructure it. **Exception (user-approved):** the app **chrome** is restructured from a
  horizontal top bar to a vertical **left rail** (decision-log "top bar → left rail"). The rail is a
  fixed-width column (`--rail-w` = 220px, tokens-v3 §4) docked left of `<main>` (shell flips
  `flex-col` → `flex-row`); nameplate top, Fleet/Inbox/Ops stacked as icon+label rows, secondary
  controls bottom-docked, the active item marked by a left-edge accent bar. At ≤760px it collapses to
  an icon-only rail (`--rail-w-collapsed` = 64px, labels visually hidden) so `<main>` keeps its width;
  reduced height is owned by an internal scroll region. Destinations are unchanged — the chrome moved,
  the IA did not gain pages.

## 10. Enforcement hooks

`no-margin-utilities`, `no-magic-width`, `no-off-grid-values`, `density-as-prop` (no font-size
overrides on table/list internals), and the 320px reflow check in the visual QA matrix (both
themes, per cutover plan).

The blocking `design:resilience` source audit covers unsafe truncation, scroll-owner proof,
layout-shifting interaction states, viewport-width typography, static viewport-height sizing,
hover-only content, raw viewport JS, and raw layer values. Promotion is allowed only after current
findings are inventoried, false positives are classified, visual/behavior proof exists for the
affected surfaces, and sanctioned exceptions are documented; the current lanes have reached that
state and now fail the package script on any finding.
