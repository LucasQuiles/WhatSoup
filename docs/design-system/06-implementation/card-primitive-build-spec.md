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
**CLOSED 2026-07-19 (DD-38 closeout).** All consumers migrated (W2-S4 wave); the recipe
was absorbed — Card.tsx renders `.soup-card` (primitives.css, declarations verbatim + the
`[tabindex]:focus-visible` rule); the legacy `.c-card` composite recipe is deleted; the guard's
allowlist is empty (promoted state). Historical record below.

**Was: IN PROGRESS (owner-approved 1→2→3, item 2).** `Card.tsx` built (5-variant API: base/interactive/kpi/
selectable/status-edge) + barrel export + `tests/console/primitives-card.test.tsx` (6 contract tests). The
`base` variant renders the `.c-card` recipe verbatim → zero visual change for migrated consumers. Token-only;
typecheck:all + `verify:console-design` PASS; shadow baseline fell 348→346 as raw usages left.

Deferred (held for separately-gated steps): the §18 "lit-from-above" inset highlight (needs a new token →
theme-parity/token-drift/burndown surface); ref forwarding (polymorphic div|button|a ref needs typed overload +
trips react-hooks/refs — added when a consumer needs it).

**Migrated onto `<Card>` so far (allowlist 13 → 11):**
- `components/ErrorBoundary.tsx` — base (single panel; `style` forwarded)
- `line-detail/LogsTab.tsx` — base (single panel)

**Remaining consumers (11), with the handling each needs (NOT a plain base swap — left for later passes):**
- `pages/Ops.tsx` — has an **interactive** card (`c-card c-hover cursor-pointer`) → `interactive` variant (div→button).
- `pages/SoupKitchen.tsx` — a `<motion.div>` c-card (framer-motion) → needs motion-aware handling, not a plain `<Card>`.
- `pages/Inbox.tsx` — 3 base panels but in a deeply-nested file; migrate carefully (open/close matching).
- `components/ActiveHoursHeatmap.tsx` — uses `<section>` (landmark) → needs `as="section"` support or stays.
- `line-detail/{AccessTab,MetricsTab,SummaryTab}` — multi-card (3–4 each), some KPI-leading → `base` + `kpi`.
- `line-detail/{ProvidersKeysCard}` — single base panel (clean; next-up candidate).
- `line-detail/GroupCard.tsx` — already a `<Button variant=ghost class=c-card>` → fold into `interactive`.
- `line-detail/ScheduledMessageRow.tsx` — expandable row → base + future Accordion for the toggle.
- `components/MessageBubble.tsx` — the `.c-card--detail` hover card → Tooltip/Popover primitive, **not** Card.

Final steps (deferred): migrate the rest → delete `.c-card`/`.c-card--detail` from composites.css → promote the
`no-card-recipe` guard to a resilience/eslint error. **No push** until all of item 2 lands (push is item 3).
