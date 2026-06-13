# Interaction patterns — focus, keyboard, overlays, toolbars, confirmation, errors, disclosure

v3.0.0-draft · G2-locked direction · pending G3

Sources: v2.html (locked), research-digest signals 5/6/8, inconsistency-register P1-2, P2-7, P2-8,
seed-2 (PR checklist), seed-4 (hover/pointer awareness).

## 1. Focus-visible law

One exact focus recipe everywhere: `outline: 2px solid var(--focus-ring); outline-offset: 2px;`
with `--r-1` corners (inputs tighten offset to 1px and recolor their border). Measured contrast vs
adjacent surfaces: 7.73 dark / 4.95 light against base — both clear the 3:1 floor (SC 1.4.11) on
every surface (color.md §4.5).

- Focus rings are **never suppressed**. `outline: none` without an equivalent-or-better
  `:focus-visible` treatment is a lint error.
- Focus feedback is instant (motion.md §7).
- The focus ring color is `--focus-ring` — a dedicated semantic token; status/mode colors never
  ring focus (de-collides the legacy chat-accent-as-focus bug, P2-12).

## 2. Keyboard and overlay law

Every overlay (modal, drawer, popover, select popover, toast with action) implements the
`useDismissable` contract:

- **Focus trap** while open (modal/drawer); Tab cycles inside, Shift+Tab reverses.
- **Initial focus** to the first sensible control — never a destructive action.
- **Escape closes exactly one layer** — stacking-aware single-fire: the topmost open surface
  consumes the event (`stopPropagation`); modal-over-modal double-close is the named legacy defect
  (P1-2) this kills.
- **Restore focus** to the opener on close.
- **Outside-click** closes popovers and dismissable modals; destructive-confirm modals require an
  explicit button.
- Keyboard actions never animate (motion instant band).
- Interactive rows (table row drill-in, log rows) are reachable by Tab and activate on
  Enter (and Space where the row is a button).

## 3. Hover-never-required law

Hover is enhancement, never the only path (coarse pointers, touch, keyboard):

- Hover-revealed row actions also reveal on `:focus-within` (the v2 table pattern) and remain
  reachable via the row's drawer/detail surface.
- The reveal-label mechanic shows labels on focus as well as hover.
- Tooltips never carry sole information; anything tooltip-only must also exist in a detail surface.
- `any-pointer`/`any-hover` thinking (seed-4): no critical interaction may depend on hover or on
  fine pointing.
- Hover-revealed content and action labels must reserve their geometry before reveal. The hidden
  state may change opacity or transform, but it may not add width, padding, or gap that moves
  neighboring controls.
- Any hover reveal path must have a keyboard/touch peer: `focus-within`, `focus-visible`, an
  always-visible control at narrow/coarse-pointer breakpoints, or a reachable detail surface.

## 4. Toolbar anatomy law

One toolbar pattern fronts every list/table/log, used identically everywhere (DRUIDS consistency
rule): `[filter group] | [time range] · [search] [primary action]` — filter pills, separator,
segmented time-range (the ONE time-scoping control), spring, search box, primary button.
See `components/toolbar.md`. A second filter pattern, time control, or search recipe anywhere is a
lint finding.

## 5. Confirmation law

Destructive or irreversible actions always confirm via modal — and **the guard follows the action,
not the surface**: every entry point to the same action confirms identically (restart from table
row, drawer, or detail page all confirm). Severity × reversibility matrix:

| Action class | Examples | Treatment |
|---|---|---|
| destructive-irreversible | delete line, delete schedule | modal confirm; consequence copy; danger button; never default-focused |
| destructive-recoverable | block contact, stop line | modal confirm with consequence + preservation copy ("queued messages are preserved") |
| disruptive-recoverable | restart line | modal confirm (the v2 restart copy is the template) |
| safe | mark read, pause feed | no confirm; instant with toast where the result is remote |

Closing a wizard after partial creation offers "save unlinked — link later", never silent deletion.

## 6. Error pattern (GOV.UK discipline)

- Errors are **textual and specific**, never color-only: message starts with "Error:" and states
  the fix with an example ("Error: use E.164 format, for example +15550123.").
- Field error anatomy: label keeps the required marker; input gains `aria-invalid` +
  `aria-describedby` pointing at the error node; the field shows the crit border treatment.
- Validate on blur; clear as soon as fixed (input event); submitting surfaces all errors and moves
  focus to the first invalid field.
- Every error **state** (failed load, failed send) carries a remedy action — Close-only error
  phases are banned (the UpdateModal defect, P2-9). No error motion (motion.md §7).

## 7. Progressive disclosure ladder

Three rungs, in order; pick the lowest that fits:

1. **Inline expand** — row chevron opens an inset detail bed in place (tables, logs). Snaps, no
   slide.
2. **Drawer** — object drill-in that must preserve list context (line inspector). Slides over or
   squeezes the frame (`components/drawer.md`).
3. **Page** — full object workspaces (LineDetail tabs). Navigation, not overlay.

Modals are *not* on this ladder — they are reserved for interrupting decisions (confirmation,
auth/QR, wizard) and never for browsing detail.

## 8. Dead-affordance ban

Nothing that looks interactive may be inert (P2-8): no handler-less buttons, no advertised-but-dead
shortcuts, no non-interactive elements styled as controls. Conversely, interactive KPI tiles and
rows must carry `aria-label`s describing their action.

## 9. Enforcement hooks

`interactive-needs-focus-visible`, `modal-must-restore-focus`, `no-focus-outline-suppression`,
`single-toolbar-pattern` (import restriction), `confirm-on-destructive` (review checklist +
`useConfirm` helper adoption), dead-affordance review lane in the QA matrix.

`design:resilience` is the report-only source audit for hover-only reveal risks, interaction geometry
shifts, and raw layer ownership. It does not replace browser keyboard/focus tests; it only produces
the current inventory that must be burned down or explicitly exempted before a hard lint rule is
promoted.
