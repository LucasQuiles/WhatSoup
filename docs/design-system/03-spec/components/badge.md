# Badge — status and mode renderers: the only status visuals in the product

v3.0.0-draft · G2-locked direction · pending G3

Resolves P1-4 (8 TS color maps, 7 visual implementations). Locked source: v2.html status/mode spec
(A graft formalized). Chips/tags/filters are `pill.md`; Badge renders **state**.

## The shape law

Status is shape + color + label, always travelling together — never color-only:

| Status | Shape | Color | Label |
|---|---|---|---|
| online | **disc** (8px, 50% radius) | `--status-ok-solid` | "online" |
| degraded | **diamond** (8px square rotated 45°, scaled 0.92) | `--status-warn-solid` | "degraded" (warn ink) |
| unreachable | **square** (8px, 1px radius) | `--status-crit-solid` | "unreachable" (crit ink) |
| logged_out | **square** (8px, 1px radius) | `--status-crit-solid` | "logged out" (crit ink) |
| config_error | **square** (8px, 1px radius) | `--status-crit-solid` | "configuration error" (crit ink) |
| unknown | **diamond** (8px square rotated 45°, scaled 0.92) | `--status-warn-solid` | "awaiting health signal" (warn ink) |
| unlinked | **outline disc** (transparent, 1px `--border-strong`) | — | "unlinked" |

The live online disc may carry the breathing halo — the system's only ambient loop (motion.md §8);
static under reduced motion. Crit never blinks (G2: crit-blink rejected).

## Renderers (the only two)

- **StatusCell**: `[shape] [name --type-body-st]` or `[shape] [status label --type-label]`;
  position-stable left-edge slot in tables, drawer heads, line pickers.
- **ModeBadge**: 6px square dot (2px radius) + word, 500 11/16, in the mode channel fg —
  passive/chat/agent. Modes are identity, not health; they never use status shapes.

Supporting state visuals built on the same map: heartbeat strip (height+color bars + aria-label
summary), unread count (accent disc, 18px, mono tabular), KPI attention tile (card.md).

## One canonical map

One TypeScript module exports the status→{shape, token, label} and mode→{token, label} maps keyed
to **semantic tokens**. Every renderer imports it; literal status hexes/classes outside the module
are lint errors. Line-health taxonomy is closed: online · degraded · unreachable · logged_out ·
config_error · unknown. The same shape law also renders the visual linkage marker unlinked.

## Conceptual props

StatusCell: `status` · `name?` · `live?` (halo) · `labelStyle` (name/status). ModeBadge: `mode`.

## States

- default: as specified; hover/active/selected/disabled/loading: none — badges are pure renderers
- focus-visible: n/a (non-interactive; interactive wrappers own focus)
- error: an unknown status value renders the unlinked outline + the raw value as label (fail
  visible, never fail blank)
- reduced-motion: halo removed; shape + color + label remain

## Accessibility

Shape+label makes status grayscale- and CVD-proof (color.md §6); standalone shapes (rare, e.g.
toast edge) pass 3:1 against their surface in both themes (color.md §4); heartbeat strips carry
`role="img"` + counted `aria-label`.

## Examples / anti-patterns

- Do: `[disc] support · online`; `[diamond] sales · degraded` with warn ink.
- Don't: a dot without a label in any data surface; recoloring shapes outside the map; inline
  `getModeColor` copies; sizing dots with non-Badge tokens (the radius-as-width bug); inventing a
  status without a spec change.

## Migration notes

Collapse the 8 TS maps (DUP-06/07) into the canonical module; replace the 7 visual
implementations with StatusCell/ModeBadge (LineDetail's inline re-rolls first); the 4 legacy dot
size tokens die (tokens-v3 §6.12); the legacy passive/ok hex collision is already de-collided at
the token layer.

## Enforcement hooks

`status-via-canonical-map` (no status/mode literals outside the module),
`status-never-color-only` (review + axe lane), `badge-renderers-only` (StatusCell/ModeBadge import
restriction for shape classes).
