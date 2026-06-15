# Card primitive — build spec (DD-38)

Closes the largest spec→impl gap: `card.md:60` mandates `card-via-primitive`, but no `Card.tsx` exists — 13
files render the raw `.c-card` CSS recipe directly, so the primitive's contract (interactive-card-is-button,
one-dialect) is unenforceable. This spec drafts the API + migration so the build is mechanical. Visual target:
showcase §18 (Card primitive family).

## The recipe it absorbs (composites.css:709–721)
```
.c-card        { background: --color-d2; border: --bw solid --b1; border-radius: --radius-lg; box-shadow: --card-shadow }
.c-card--detail{ padding: --sp-3 --sp-4; background: --color-d5; border-color: --b3; box-shadow: --shadow-lg; min-width: --tooltip-min-w }
```
The `--detail` variant is the popover/tooltip surface (MessageBubble DetailCard) — owned by the Tooltip/Popover
primitive, not the general Card; migrate it separately.

## Proposed `Card.tsx` API (mirrors showcase §18 variants)
```ts
interface CardProps {
  variant?: 'base' | 'interactive' | 'kpi' | 'selectable' | 'status-edge'  // default 'base'
  as?: 'div' | 'button' | 'a'        // 'interactive' forces button semantics (interactive-card-is-button law)
  selected?: boolean                  // 'selectable': accent border + inset ring + the check affordance
  edge?: 'ok' | 'warn' | 'crit'       // 'status-edge': 2px channel inset, paired with shape+label (color.md §6)
  onClick?, href?                     // interactive only; destructive routes through ConfirmDialog
  header?, footer?: ReactNode         // optional slots (uicard__h / uicard__f)
  className?, children
}
```
- **base** — the neutral container (the 13 consumers' default). header/body/footer slots, the lit-from-above
  inset edge (`inset 0 1px 0 color-mix(white 7%)`), `--card-shadow`.
- **interactive** — renders `<button>` (never a click-div); hover lift `translateY(-2px)` + the **one focus
  recipe** (`outline:2px solid var(--focus-ring); offset 2px`); `user-select:none`.
- **kpi** — flex-centred body for a headerless stat (tabular-nums numeral + label + trend), per §18 fix.
- **selectable** — `aria-pressed`/`aria-selected` + accent border + inset ring + check; selection survives
  forced-colors via the ring, not colour alone.
- **status-edge** — 2px inset channel border; the severity also carries a shape + text (never colour-only).

## Migration — 13 `c-card` consumers
| Consumer | Current use | → Card variant |
| --- | --- | --- |
| pages/Ops.tsx, SoupKitchen.tsx, Inbox.tsx | panel containers | `base` |
| line-detail/MetricsTab, SummaryTab, LogsTab, ProvidersKeysCard, AccessTab | section panels | `base` (+ `kpi` where a stat leads) |
| line-detail/GroupCard.tsx | clickable group row | `interactive` (it's already a `<Button variant=ghost class=c-card>` — fold into Card) |
| line-detail/ScheduledMessageRow.tsx | expandable row | `base` (+ the future Accordion for the toggle) |
| components/MessageBubble.tsx | the `c-card--detail` hover card | **Tooltip/Popover** primitive, not Card |
| components/ActiveHoursHeatmap.tsx, ErrorBoundary.tsx | wrappers | `base` |

Sequence: build `Card.tsx` + barrel export → migrate the `base` consumers (mechanical) → fold GroupCard's
button-card into `interactive` → route the `--detail` surface to Tooltip/Popover → delete `.c-card`/`.c-card--detail`
from composites.css.

## Enforcement (ratchet to zero, then promote)
A collision-safe frozen-inventory guard `no-card-recipe`: pin the current 13 `c-card` consumers, FAIL on any NEW
raw-`c-card` usage (forces new cards through the primitive), and ratchet the allowlist down as each migrates.
When the allowlist hits zero and `.c-card` is deleted, promote to a `check-design-resilience`/eslint error. This
mirrors the icon-size-ramp / typography-floor ratchets. (Build it when migration starts — guarding a recipe that's
mid-migration is premature; the value is preventing NEW spread, so land it alongside the first migration commit.)

## Status
Scoping/proposal only — the `Card.tsx` build + consumer migration is a product change to land carefully
(explicit-path commits, no push). Visual target is locked (§18). Next: owner go-ahead to build.
