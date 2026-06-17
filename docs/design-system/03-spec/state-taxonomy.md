# State taxonomy — consolidated index of every component state in the SOUP v3 spec

v3.0.0-draft · cross-linking index, not new law

## 0. Subordination rule (read first)

This page **indexes** the component specs; it defines nothing. Every state listed here is
defined in a component spec `## States` section or a named system-spec section, and that
definition is the authority. **On any conflict between this page and a component spec, the
component spec wins.** Changes to this page are clerical (link and matrix maintenance); a
change to actual state behavior is a component-spec change and must land there first.

Scope: the thirteen component specs under `components/`, plus the system laws they lean on —
[color.md](color.md) (status/severity ink), [motion.md](motion.md) (state transitions),
[interaction-patterns.md](interaction-patterns.md) (focus, errors, confirmation), and the
non-happy-path QA cases in
[../06-implementation/qa-hardening.md](../06-implementation/qa-hardening.md) §4.

Test-evidence classes cited below:

- **jsdom class/ARIA contract** — unit suites under `tests/console/` asserting classes,
  roles, and ARIA state attributes (cannot compute boxes, pseudo-classes, or animations).
- **browser computed/trusted-event** — Playwright-driven suites under `tests/browser/`
  (computed boxes, real `:focus-visible`, trusted keyboard events; context pins reduced
  motion) and `tests/browser-motion/` (animated-exit proofs in a no-reduce context).

Suites live on the implementation branch; paths are repo-relative.

## 1. Canonical state vocabulary

Every entry below was verified against the section linked. States the program still discusses
without a spec home (stale, read-only) are not in this table; they appear in §3 as findings.
The **transport-loss / offline (connection status)** state — formerly finding #3 — now has a
spec home (DD-29, see §1.2 and the disposition note in §3) and appears in the table below.

### 1.1 Interaction states

| State | One-line definition | Defined in | Visual/token channel | Test evidence |
|---|---|---|---|---|
| default | resting appearance; the spec's anatomy as written | every component spec `## States` — e.g. [button.md](components/button.md#states), [table.md](components/table.md#states) | component anatomy tokens (surfaces, inks, edges) | jsdom anatomy/class contracts: `tests/console/primitives-*.test.tsx` |
| hover | pointer-over enhancement; never the only path to anything ([interaction-patterns.md §3](interaction-patterns.md#3-hover-never-required-law)) | [button.md](components/button.md#states), [card.md](components/card.md#states) (interactive KPI only), [input.md](components/input.md#states) (explicitly no change), [log-stream.md](components/log-stream.md#states), [pill.md](components/pill.md#states), [select.md](components/select.md#states), [table.md](components/table.md#interaction), [tabs.md](components/tabs.md#states), [toast.md](components/toast.md#states--motion-budget) (pauses timer), [toolbar.md](components/toolbar.md#states) | `--row-hover`, `--btn-neutral-bg-hover`, `--accent-hover`, pill border to `--border-strong`; color-only transitions at `--dur-fast` ([motion.md §3](motion.md#3-property-allowlist--waiver-process)) | CSS-level; no computed hover suite — covered by class contracts plus the visual QA checkpoints (qa-hardening §2/§5) |
| focus-visible | keyboard-focus ring; one recipe everywhere, never suppressed | [interaction-patterns.md §1](interaction-patterns.md#1-focus-visible-law); every component `## States` section names its treatment | `--focus-ring` (tokens-v3 §3.7), 2px outline + 2px offset (inputs 1px + border recolor; toolbar seg inset); instant ([motion.md §7](motion.md#7-instant-feedback-law)) | browser trusted-event: `tests/browser/smoke.test.tsx` (real `:focus-visible` after trusted Tab), `tests/browser/keyboard-proofs.test.tsx`; lint: `soup/no-focus-suppression` in `tests/console/design-lints.test.ts` |
| active / pressed | press feedback; no extra motion beyond the hover treatment | [button.md](components/button.md#states), [pill.md](components/pill.md#states) ("no extra treatment beyond pressed"), [tabs.md](components/tabs.md#states) ("as selected"), [toolbar.md](components/toolbar.md#states) (seg pressed) | accent fill on seg (`--accent` + `--accent-fg`); otherwise inherits hover channel | jsdom ARIA: `aria-pressed` in `tests/console/primitives-pill.test.tsx`, `tests/console/primitives-toolbar.test.tsx` |
| selected / current | the chosen item among peers; accent-marked, instant | [pill.md](components/pill.md#states) (`aria-pressed="true"`), [tabs.md](components/tabs.md#states) (`aria-selected` + underline), [select.md](components/select.md#states) (option check), [table.md](components/table.md#states) + [drawer.md](components/drawer.md#states--motion) (originating row `aria-current`); [button.md](components/button.md#states) explicitly excludes it | `--accent` underline/border, `--accent-wash` fill, leading check (select) | jsdom ARIA: `tests/console/primitives-tabs.test.tsx`, `tests/console/primitives-pill.test.tsx`, `tests/console/primitives-popover.test.tsx` (`aria-activedescendant`) |
| disabled | present but inoperable; visibly distinct, contrast-exempt | [button.md](components/button.md#states), [input.md](components/input.md#states) (dashed border), [pill.md](components/pill.md#states) (kept in tab order, `aria-disabled`), [select.md](components/select.md#states), [toolbar.md](components/toolbar.md#states) (per contained); [table.md](components/table.md#states) excludes it for rows | `--opacity-disabled` 0.45 (tokens-v3 §6.13), `--text-3` ink, dashed border on fields, `cursor: not-allowed` | jsdom: `tests/console/primitives-button.test.tsx` (disabled + `aria-disabled`), `tests/console/primitives-toolbar.test.tsx` (seg disabled) |
| disabled-with-reason | disabled but focusable, with the reason exposed as tooltip plus `aria-describedby`; a disabled tab without a reason is a defect | [tabs.md](components/tabs.md#states) (the only spec defining it) | `--text-3` ink, `aria-disabled="true"` | jsdom: `tests/console/primitives-tabs.test.tsx` ("disabled tab: aria-disabled, focusable, not selectable, reason exposed") |

### 1.2 Data and lifecycle states

| State | One-line definition | Defined in | Visual/token channel | Test evidence |
|---|---|---|---|---|
| loading / skeleton | content pending; loader appears only after a 150–200ms delay, skeleton mirrors content geometry | [motion.md §6](motion.md#6-loading-choreography); [button.md](components/button.md#states) (spinner + `aria-busy`), [card.md](components/card.md#states), [drawer.md](components/drawer.md#states--motion), [table.md](components/table.md#states), [log-stream.md](components/log-stream.md#states), [select.md](components/select.md#states) (searchable), [modal.md](components/modal.md#states) (async confirm), [input.md](components/input.md#states) (no spin; hint text), [toolbar.md](components/toolbar.md#states) (em-dash ghosts), [tabs.md](components/tabs.md#states) (panel composite, never the tab) | Skeleton component (opacity-only 1200ms pulse), spinner (800ms, the sole linear rotation), `aria-busy` | jsdom: `tests/console/skeleton.test.tsx` (Skeleton, TableSkeleton), `tests/console/primitives-button.test.tsx` (loading block) |
| empty | zero data, with remedy copy; a cold load is never confused with an empty result | [table.md](components/table.md#states), [log-stream.md](components/log-stream.md#states), [card.md](components/card.md#states) (EmptyState composite) | EmptyState composite on the surface bed | jsdom: `tests/console/primitives-log-stream.test.tsx` (empty state block), `tests/console/empty-state.test.tsx` |
| filtered-empty | zero results because of active filters; says so and offers clearing them | [table.md](components/table.md#states), [log-stream.md](components/log-stream.md#toolbar-contract) + [States](components/log-stream.md#states) | EmptyState copy variant; filters remain visible in the fronting Toolbar | jsdom: `tests/console/primitives-log-stream.test.tsx` (`filteredEmptyMessage` case) |
| error | a failed operation rendered with remedy; textual and specific, never color-only, never Close-only | [interaction-patterns.md §6](interaction-patterns.md#6-error-pattern-govuk-discipline); [card.md](components/card.md#states), [drawer.md](components/drawer.md#states--motion) (never an empty drawer), [table.md](components/table.md#states), [log-stream.md](components/log-stream.md#states) (distinct from error-level rows), [modal.md](components/modal.md#states), [tabs.md](components/tabs.md#states) (panel-level), [badge.md](components/badge.md#states) (unknown status renders fail-visible); [button.md](components/button.md#states) and [toolbar.md](components/toolbar.md#states) explicitly exclude it | Error composite with Retry; crit channel ink only in sanctioned slots ([color.md §2](color.md#2-six-channel-discipline)); no error motion ([motion.md §7](motion.md#7-instant-feedback-law)) | jsdom: `tests/console/primitives-log-stream.test.tsx` (error + Retry block), `tests/console/empty-state.test.tsx` (error variant), `tests/console/badge-components.test.tsx` (fail-visible unknown status) |
| validation-error | field-level error: `aria-invalid` + `aria-describedby` to a textual error node, crit border, validate on blur, clear on input | [input.md](components/input.md#states), [interaction-patterns.md §6](interaction-patterns.md#6-error-pattern-govuk-discipline); [select.md](components/select.md#states) and [modal.md](components/modal.md#states) inherit it | `--status-crit-fg` border + inset crit shadow; error text 500 12/16; instant, no shake | jsdom: `tests/console/form-primitives.test.tsx` (error-border and error-vs-helper cases) |
| degraded (status taxonomy) | domain health status of a line — the closed set online · degraded · unreachable · logged_out · config_error · unknown, plus the unlinked linkage marker; rendered only by the Badge renderers and row severity, always shape + color + label | [badge.md](components/badge.md#the-shape-law) (closed taxonomy), [table.md](components/table.md#status--severity-rendering) (`row--warn`/`row--crit`), [color.md §2/§6](color.md#2-six-channel-discipline) | status channel tokens (tokens-v3 §3.5): shape indicator, wash fill + 2px inset edge on severity rows | jsdom: `tests/console/badge-components.test.tsx` (STATUS_MAP closed set, shape law, halo gating) |
| live-updating / live tail | surface auto-updates in place; auto-scroll pauses on user scroll-up and via a visible pause control with labeled paused state | [log-stream.md](components/log-stream.md#states) (live tail), [motion.md §9](motion.md#9-reducedno-motion-contract--off-and-instant) (console-level pause control), [badge.md](components/badge.md#the-shape-law) (breathing halo, the only ambient loop), [toast.md](components/toast.md#accessibility) (`aria-live` stack) | rows append without animation; halo 2400ms loop ([motion.md §8](motion.md#8-ambient-budget-law)); `aria-live` polite/assertive | jsdom: `tests/console/primitives-log-stream.test.tsx` (maxEntries tail slice, focus survives rerender), `tests/console/toast.test.tsx` (aria-live); live-tail streaming itself is open debt (DD-22 in the [debt register](../06-implementation/design-debt-register.md)) |
| transport-loss / offline (connection status) | the console loses its own backend (realtime socket down, or the browser is offline); the app stays usable on cached data and signals the loss app-wide, auto-clearing on reconnect — distinct from a single line's `unreachable`/`unlinked` badge status. The ruling is DD-29 ([decision-log](../02-directions/decision-log.md#transport-loss--connection-status-surface--dd-29-approved)) | `ConnectionBanner` (slim non-blocking warn status bar above `<main>`, shown only while disconnected); `EmptyState variant="offline"` (warn-channel cached-data surface on a failed primary load while disconnected); the recovery toast ("Connection restored") on reconnect. Derived by `useTransportStatus` from `useRealtime().connected` + `navigator.onLine` | warn channel ([color.md §2](color.md#2-six-channel-discipline)) — shape+text co-signal (`WifiOff` glyph + copy, never color alone, color.md §6); `role="status"` + `aria-live="polite"` banner; no infinite motion (reduced-motion safe) | jsdom: `tests/console/use-transport-status.test.ts` (connected/reconnecting/offline derivation, online/offline events, reconnect-once), `tests/console/connection-banner.test.tsx` (disconnected-only render, role/aria-live, warn channel, shape+text), `tests/console/empty-state.test.tsx` (offline variant), `tests/console/app.test.tsx` (recovery toast) |

### 1.3 Disclosure and transition states

| State | One-line definition | Defined in | Visual/token channel | Test evidence |
|---|---|---|---|---|
| open / expanded | an overlay is shown or a row's detail bed is revealed; table/log expansion snaps, overlays animate enter | [modal.md](components/modal.md#states), [drawer.md](components/drawer.md#states--motion), [select.md](components/select.md#states) (popover), [table.md](components/table.md#interaction) (inline expand, `aria-expanded`), [log-stream.md](components/log-stream.md#states) (`is-open`), [interaction-patterns.md §7](interaction-patterns.md#7-progressive-disclosure-ladder) | enter motion per [motion.md §5](motion.md#5-anchored-overlay-rules); expand beds on `--surface-inset`, snap (no slide) | jsdom open/close gates: `tests/console/primitives-modal.test.tsx`, `primitives-drawer.test.tsx`, `primitives-popover.test.tsx`; row expand: `primitives-log-stream.test.tsx`, `primitives-table.test.tsx` |
| closing / exiting | the leaving phase; exits are faster than entrances, visibility gated after the transition | [motion.md §2](motion.md#2-easing-law) (law), [modal.md](components/modal.md#states), [drawer.md](components/drawer.md#states--motion), [toast.md](components/toast.md#states--motion-budget), [select.md](components/select.md#states) (faster out); [pill.md](components/pill.md#states) defines removal as instant (no exit animation) | `--ease-exit` at `--dur-fast` (modal/toast) / `--dur-base` (drawer); scrim out linear | jsdom stubbed-duration closing-phase: `tests/console/primitives-modal.test.tsx`, `primitives-drawer.test.tsx` ("exit presence" blocks); browser animated: `tests/browser-motion/b5-exit-motion.test.tsx` (`data-state="closing"` + exit animation, no-reduce context); browser reduced: `tests/browser/b5-inert-toast.test.tsx` (instant removal) |
| destructive-confirm | a destructive/irreversible action interrupted by a confirm modal; the guard follows the action, outside-click dismiss is off, the danger action is never default-focused | [interaction-patterns.md §5](interaction-patterns.md#5-confirmation-law) (severity × reversibility matrix), [modal.md](components/modal.md#conceptual-props) (`dismissable` off) + [Accessibility](components/modal.md#accessibility), [button.md](components/button.md#variants--sizes) (danger variant) | danger Button (crit wash/fg/border); consequence + preservation copy | jsdom: `tests/console/primitives-modal.test.tsx` (outside-click and focus blocks), `tests/console/confirm-dialog.test.tsx` (backdrop click does not dismiss; `dismissable=false`) |
| reduced-motion (cross-cutting modifier) | under `prefers-reduced-motion: reduce` every animation/transition is removed, not shortened; no information exists only in motion | [motion.md §9](motion.md#9-reducedno-motion-contract--off-and-instant); every component `## States` section carries a reduced-motion line | global media-query kill + per-component JS checks; static shape/label/count renderings remain | jsdom: `tests/console/reduced-motion-config.test.tsx` (app-root MotionConfig); browser: `tests/browser/b5-inert-toast.test.tsx` (reduced-motion exit); the `tests/browser/` context pins `reducedMotion: 'reduce'` for geometry determinism |

Interactive-state target floors (all hover/focus/pressed states sit on hit areas of at least
24px) are proven by the browser computed-box suite `tests/browser/target-size.test.tsx`
(DD-10 closure path) and viewport behavior by `tests/browser/viewport-matrix.test.tsx`.

## 2. Coverage matrix — components × states

Legend — **D**: defined in the linked spec section. **N**: the spec explicitly says
none / not-applicable for this component. **C**: delegated by the spec to contained
components or the owning surface. **—**: the state has no meaning for this component
(clerical judgment; no spec text either way). **GAP**: the state plausibly applies but no
spec text defines it — a finding (§3).

Marks record only what the spec section says; every D/N/C below was verified by reading the
component's `## States` (or named) section.

| Component | default | hover | focus-visible | active/pressed | selected/current | disabled | loading | empty | filtered-empty | error | open/expanded | closing/exiting | live | reduced-motion |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| [badge](components/badge.md#states) | D | N | N | N | N | N | N | — | — | D | — | — | D | D |
| [button](components/button.md#states) | D | D | D | D | N | D | D | — | — | N | — | — | — | D |
| [card](components/card.md#states) | D | D | D | N | N | N | D | D | — | D | — | — | — | D |
| [drawer](components/drawer.md#states--motion) | D | C | D | — | D | C | D | N | — | D | D | D | — | D |
| [input](components/input.md#states) | D | D | D | — | N | D | D | — | — | D | — | — | — | D |
| [log-stream](components/log-stream.md#states) | D | D | D | — | N | N | D | D | D | D | D | — | D | D |
| [modal](components/modal.md#states) | D | C | D | — | C | C | D | — | — | D | D | D | — | D |
| [pill](components/pill.md#states) | D | D | D | D | D | D | N | — | — | N | — | N | — | D |
| [select](components/select.md#states) | D | D | D | — | D | D | D | GAP | GAP | D | D | D | — | D |
| [table](components/table.md#states) | D | D | D | — | D | N | D | D | D | D | D | N | — | D |
| [tabs](components/tabs.md#states) | D | D | D | D | D | D | D | — | — | D | — | N | — | D |
| [toast](components/toast.md#states--motion-budget) | D | D | D | — | N | N | N | — | — | N | D | D | D | D |
| [toolbar](components/toolbar.md#states) | D | D | D | C | D | C | D | — | — | N | — | — | — | D |

Cell notes (all from the linked sections):

- badge error D = the fail-visible rule (unknown status renders outline + raw value); badge
  live D = the breathing halo on live online discs.
- drawer empty N = the spec forbids an empty drawer ("never an empty drawer"); failed loads
  render the error state. drawer selected D = the originating table row's `aria-current`
  treatment, defined in drawer.md. drawer disabled C = the spec's combined disabled/loading
  bullet describes only the loading skeleton; disabled rendering falls to the contained
  components.
- pill closing N = removal is explicitly instant; pill loading/error N = "pills never spin",
  counts update in place.
- table closing N = expand/sort are explicitly instant (snap, no animation); table disabled
  N = "rows are never disabled; actions within may be".
- tabs disabled D includes the disabled-with-reason contract (the only component with it).
- toast error N = a failing action re-toasts with crit tone + remedy (defined behavior, not
  an error state on the toast itself).
- toolbar filtered-empty —: the toolbar drives filtering, but the filtered-empty state
  renders in the fronted table/log, where it is marked D.

## 3. Findings (GAP cells and vocabulary absences) with recommended dispositions

These are register-style findings, not new law. None of them may be resolved by editing this
page; each needs a component-spec amendment, a debt-register entry, or an explicit ruling
per qa-hardening §10.

| # | Finding | Evidence | Recommended disposition |
|---|---|---|---|
| 1 | **select zero-results state undefined** (the two GAP cells): select.md permits a searchable custom popover but defines no empty / no-matches rendering for the option list; table and log-stream both define filtered-empty, the popover does not | [select.md §States](components/select.md#states) has no empty row; [log-stream.md](components/log-stream.md#states) and [table.md](components/table.md#states) do | amend select.md with a no-matches row (reusing the filtered-empty copy pattern) or record an explicit not-applicable ruling; until then classify per surface in the slice QA matrix |
| 2 | **stale is a QA case with no spec home**: qa-hardening §4 requires every migrated surface to classify "stale data", but no component spec defines a stale rendering (no timestamp-age treatment, no stale indicator) | [qa-hardening §4](../06-implementation/qa-hardening.md); no `## States` section mentions stale | debt-register entry; decide per qa-hardening §10 whether stale data is carried by existing renderings (timestamps in mono lanes, feed recency) — then record that interpretation — or a component needs a stale treatment spec'd |
| 3 | **disconnected — RESOLVED (DD-29)**: line-level disconnection stays the Badge taxonomy's job (unreachable / unlinked); the distinct console-transport-loss state (realtime socket down or browser offline) is now ruled to need a dedicated connection-status surface, not the error composites. It has a spec home: the `ConnectionBanner` + `EmptyState variant="offline"` + recovery toast cluster, recorded in §1.2 above | [qa-hardening §4](../06-implementation/qa-hardening.md); [badge.md](components/badge.md#the-shape-law) covers line status only; the ruling is [decision-log DD-29](../02-directions/decision-log.md#transport-loss--connection-status-surface--dd-29-approved) | **RESOLVED**: a connection-status surface was built and ruled (DD-29). Debt-register entry DD-29 is marked resolved; the state is now in the §1.2 table |
| 4 | **read-only is not a spec state**: no component defines a read-only state; fields are either editable or disabled (dashed border). The nearest text is table.md's "static/read-mostly table" semantics rule, which is about ARIA roles, not a visual state | grep across `03-spec/` finds no read-only state definition | clerical exclusion from the vocabulary (this page records it); becomes a spec change only if a read-only field/surface ever ships |
| 5 | **live-tail pause control unimplemented**: log-stream.md defines the live-tail pause/resume contract (WCAG 2.2.2), but no streaming source or pause control exists yet, and no suite covers it | [log-stream.md §States](components/log-stream.md#states); DD-22 in the [debt register](../06-implementation/design-debt-register.md) | already tracked as DD-22 — no new entry; this index links it so the matrix's live column is read with that caveat |
| 6 | **hover has no computed-style evidence class**: hover treatments are spec'd everywhere but proven only via class contracts and manual/visual QA; no browser suite asserts hover-computed styles | tests under `tests/browser/` cover target size, focus, viewport, exit motion — none hover | acceptable under the existing QA-checkpoint regime (qa-hardening §2/§5); record as not-applicable in slice matrices unless a hover regression recurs, in which case add a browser hover proof |

## 4. Maintenance

Update this page when (and only when) a component spec adds, removes, or re-homes a state,
or a cited suite moves. The change is clerical: re-verify the linked section, fix the cell,
keep §0 true.
