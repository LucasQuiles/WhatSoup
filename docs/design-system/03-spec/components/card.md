# Card / Panel — the single raised container

v3.0.0-draft · G2-locked direction · pending G3

Resolves P2-5 (4 card recipes + the BEM feed dialect). Locked source: v2.html `.card`, `.panel`,
`.kpi`.

## Anatomy

- **Card**: `--surface-raised`, 1px `--border-hairline`, `--r-2`, `--shadow-raised`, padding
  `--sp-4`. The plain raised container.
- **Panel**: Card with a head slot — `panel-head` (`--sp-3 --sp-4`, hairline bottom): title
  (`--type-heading`) + optional meta pill + spring + optional controls (segmented range,
  ActionButton); `panel-body` (`--sp-4`) or flush content (tables/logs/feeds sit flush with
  `toolbar--flush`/`tblwrap--flush` joins).
- **KPI tile**: Card variant — overline label, `--type-data-lg` value (tabular), caption sub-row;
  attention flavor: `--status-warn-wash` fill + `--status-warn-border` + warn-colored label/value;
  interactive KPI renders as a button with `aria-label` and a click-through.

Elevation law: dark = surface luminance (`--shadow-raised: none`); light = white + real shadow.
Cards never nest on cards (layout-density §2).

## Conceptual props

`as` (card/panel) · head slots (`title`, `meta`, `controls`) · `padding` (default/flush) ·
KPI: `label`, `value`, `sub`, `tone` (default/attention), `onClick`.

## States

- default / hover: static; only interactive KPI tiles take a hover treatment (`--row-hover`-class
  wash) and pointer
- focus-visible: interactive tiles get the standard ring
- selected/active/disabled: n/a
- loading: body renders Skeleton mirroring its content geometry
- error / empty: body renders the canonical Error (with Retry) / EmptyState composites
- reduced-motion: nothing animates here by design

## Accessibility

Panels label their content (`aria-label` or heading association); interactive KPI is a real
button ("2 lines need attention — open Ops"); decorative borders carry no semantics.

## Examples / anti-patterns

- Do: Messages chart panel (title + segmented range head, flush chart body); KPI row of 6 tiles;
  activity feed as a Panel with Pause ActionButton.
- Don't: re-rolled panel chrome per feature (KpiCard/ChartPanel/FeedCard drift); a third styling
  dialect (the feed's ~40 BEM selectors fold into Panel + list composition — or BEM-for-feed must
  be explicitly chartered as a documented exception, decision owed at C2); raised-on-raised
  stacking; cards as click targets without button semantics.

## Migration notes

`c-card` (31 refs/14 files) → Card; `c-section` (5 refs) merges into Panel; `c-card--detail`
single-use dies; KpiCard/ChartPanel/FeedCard re-compose; feed BEM family (census §16) re-platforms
onto Panel + Stack + Pill/Badge under the one-dialect rule.

## Enforcement hooks

`card-via-primitive`, one-dialect rule (no new BEM families; review), interactive-card-is-button.
