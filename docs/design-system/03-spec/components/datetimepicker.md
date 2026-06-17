# DateTimePicker — scheduled-time + segmented recurrence composite

v3.0.0-draft · G2-locked direction · pending G3

Resolves the modal-level patch in `ScheduleComposerModal.tsx` — a bare
`<input type="datetime-local">`, a `recurring` boolean toggle, three preset buttons (Daily /
Weekly / Monthly), and a free-text cron box — into a single reusable primitive. The headline
is a **segmented recurrence row (Once · Daily · Weekly · Cron)**.

**Phase A.** This primitive still renders the native `<input type="datetime-local">` for the
date+time portion. The custom calendar popover is implemented in
[Phase B](#phase-b-calendar-popover--implemented).

## Anatomy

```
DateTimePicker (flex column, --sp-3 gap)
├─ Field (label = "Scheduled time (local)", optional error, helper)
│  └─ <input type="datetime-local"> (mono, c-input, c-field plumbing)
├─ [soup-toolbar-seg] role="group" aria-label="Recurrence"
│  └─ soup-toolbar-seg__btn × 4 — Once | Daily | Weekly | Cron (aria-pressed)
└─ [if Cron] TextInput (free-text cron) + .c-meta preview line (cronToHuman output)
```

Tokens reused (no new tokens in Phase A): `--sp-*`, `--r-1`, `--border-strong`, `--accent`,
`--accent-fg`, `--text-2`, `--status-crit-fg`, `--focus-ring`, `--opacity-disabled`. All
visual hooks route through the existing `.soup-toolbar-seg` BEM family (see primitives.css
`segmented time-range control` block) — **no new BEM family**.

## Conceptual props

`value` (datetime-local string) · `onChange(value)` · `recurrence: RecurrenceValue` ·
`onRecurrenceChange(r)` · `error?: string` · `label?: string` (default "Scheduled time
(local)") · `minNow?: boolean` · `id?: string`.

`RecurrenceValue` is a discriminated union:

```ts
type RecurrenceValue =
  | { kind: 'once' }
  | { kind: 'daily' }    // → '0 9 * * *'
  | { kind: 'weekly' }   // → '0 9 * * 1'
  | { kind: 'cron'; expr: string }
```

Helpers exported from the primitive's barrel: `recurrenceToCron(r)` (Once → undefined,
Daily/Weekly → preset, Cron → trimmed expression or undefined) and `cronToRecurrence(expr)`
(undefined → once, presets → daily/weekly, anything else → `{kind:'cron',expr}` — preserves
non-preset entries verbatim). Constants: `DAILY_CRON`, `WEEKLY_CRON`.

## Variants

Phase A has one variant (default). Variants are not exposed — the headline is fixed at four
segments (Once · Daily · Weekly · Cron) so the modal's recurrence UX stays calm. The "Monthly"
preset from the prior modal (`0 9 1 * *`) folds into the Cron segment so any dom-of-month
cadence is reachable via the same free-text entry.

## States

- **default** — native input calm; Once segment pressed; no free-text cron row.
- **Daily / Weekly pressed** — date+time field still required, no cron row.
- **Cron pressed** — date+time field + free-text cron input + human preview line
  (`cronToHuman(expr)`).
- **error** — `Field` passes `aria-invalid="true"` + `aria-describedby` to the native input,
  border recolors to `--status-crit-fg` (Field's error contract, input.md §error).
- **disabled** — n/a (the primitive does not own a disabled flag; callers can disable the
  whole modal).
- **loading** — n/a (async validation is a parent concern).
- **reduced-motion** — the `.soup-toolbar-seg__btn` `background-color`/`color` transitions
  inherit the existing `--dur-fast` tokens; reduced-motion is already covered globally.

## Accessibility

- `Field` provides the label-association, error description wiring, and required-marker support
  (input.md §States, §Accessibility).
- The segmented row carries `role="group"` + `aria-label="Recurrence"` and exactly one button
  carries `aria-pressed="true"` at all times (the segment-aria contract mirrors
  `ToolbarTimeRange`).
- The free-text cron input, when revealed, is a real `<input type="text">` (via the `TextInput`
  primitive) with its own placeholder, no `aria-hidden` — AT users can edit it independently.
- The human preview line is rendered with `.c-meta` (caption ink) and is purely informational
  (no `role`, not focusable).
- No raw `outline-none` is added; the seg buttons inherit the existing `focus-visible` 2px ring
  from the `.soup-toolbar-seg__btn:focus-visible` rule.

## Examples / anti-patterns

- Do: render `<DateTimePicker value={...} onChange={...} recurrence={...} onRecurrenceChange={...} />`
  inside `ScheduleComposerModal`; on submit call `recurrenceToCron(recurrence)` and only set
  `body.recurrence` when the result is defined; on edit-load call `cronToRecurrence(editMessage.recurrence)`.
- Do: reuse this primitive anywhere a single-shot / recurring cron schedule is captured.
- Don't: re-roll a date+time + recurrence row inline (`c-input` + ad-hoc segmented buttons);
  this is the one canonical pattern.
- Don't: invent a new segmented BEM family — the row reuses `.soup-toolbar-seg` deliberately.
- Don't: replace the native `<input type="datetime-local">` with a third-party calendar in
  Phase A — the popover is Phase B (see below).

## Phase B (calendar popover) — implemented

The custom calendar popover is now part of the primitive. A "Pick from calendar" trigger
(adjacent to the Field-wrapped native input so Field still owns the input's error contract)
opens a `Popover` (generic-content mode) carrying the `Calendar` component:

- **Grid:** `role="grid"`, a Monday-first 6×7 month view (fixed height across months). Day
  cells are `role="gridcell"` buttons; weekday headers are `role="columnheader"`.
- **States (shape + token, never colour alone):** today → `aria-current="date"` + ring;
  selected → `aria-selected="true"` + accent fill; past days → `disabled` + `--text-3`;
  spillover (other-month) days dimmed. The selected/today checks read ONLY the date portion
  of the datetime-local value; on pick, the parent preserves the time via `setDateOnly`.
- **Navigation:** prev/next month buttons (labelled with the target month).
- **Keyboard (WAI-ARIA grid):** roving tabindex; Arrow keys move by day/week, Home/End to
  week ends, PageUp/PageDown change month, Enter/Space select; Escape closes via the Popover.
- **Tokens (`--cal-*`, the only Phase B token tier):** `--cal-cell` (`var(--sp-8)`, 32px,
  on-grid), `--cal-gap` (`var(--sp-1)`, 4px) — both grid-aligned references; colours reuse
  existing `--accent`/`--text-*`/status tokens so theme-parity stays symmetric.

Date helpers live in `calendar-utils.ts` (kept separate from `Calendar.tsx` so the component
module stays Fast-Refresh-clean); both are barrel-exported.

## Migration notes

- `ScheduleComposerModal.tsx` collapses `recurring: boolean` + `cronExpr: string` into a single
  `recurrence: RecurrenceValue`. Submit pipeline is `recurrenceToCron(recurrence)` →
  `body.recurrence = cron` (when defined; omitted for Once — matches the prior
  `recurring=false` branch). Edit-load pipeline is `cronToRecurrence(editMessage.recurrence)`.
- All other modal behavior (validation, content-type branches, save success/error paths,
  reset-on-open, focus traps, Escape, dismissable=false backdrop) is unchanged.
- `RECURRENCE_PRESETS` and `RECURRENCE_OPTIONS` consts in the modal are deleted; they have
  no other consumers (grep-verified).
- `cronToHuman` is imported from `console/src/components/line-detail/scheduled-utils.js` —
  the dependency direction (primitives → line-detail) is acknowledged in the leaf and is the
  simplest path that avoids re-implementing the formatter; moving `cronToHuman` to a
  primitives-adjacent location is a follow-up if a second primitive ever needs it.
- The Monthly preset is folded into the Cron segment (any `dom` cadence is reachable as
  `0 9 <dom> * *`); no behaviour change for Monthly users, but a `recurrence: '0 9 1 * *'`
  row now edits back into the Cron segment carrying `expr: '0 9 1 * *'` rather than a
  Monthly-specific slot.

## Enforcement hooks

`datetimepicker-via-primitive` (no raw date+time + ad-hoc recurrence re-rolls in modals),
`one-dialect rule` (no new segmented BEM — must reuse `.soup-toolbar-seg`). Phase B adds the
`--cal-*` token tier (the only new tokens) and reuses the `Popover` primitive (generic-content
mode) rather than hand-rolling positioning.