# Pill — one primitive: tone × size × static/interactive/removable

v3.0.0-draft · G2-locked direction · pending G3

Resolves P1-5 (9+ pill/tag/badge recipes). Consolidates FilterPill, TagInput chips, LineTags,
count badges, log-level filter chips, version tags. Status/mode *indicator* rendering is
`badge.md`; Pill is the chip/tag/filter family.

## Anatomy

Inline-flex: height 20px static (16px sm; **24px when interactive** — target floor), padding
`0 --sp-2` (sm `--sp-1`), font 500 11/16 sans (+0.01em, the Pill tracking component token), radius
`--r-1`, 1px border, optional leading count/number in the data lane, optional trailing remove
button (16px visual, padded to a 24px hit area).

## Tones

| Tone | Ink | Fill | Border |
|---|---|---|---|
| neutral | `--text-2` | `--btn-neutral-bg` | `--border-subtle` |
| ok / warn / crit | `--status-X-fg` | `--status-X-wash` | `--status-X-border` |
| passive / chat / agent | `--mode-X-fg` | `--mode-X-wash` | `--mode-X-border` |
| accent | `--accent` | `--accent-wash` | accent 30% mix |

## Conceptual props

`tone` · `size` (default/sm) · `interactive` (renders `<button>` with `aria-pressed`) ·
`removable` (`onRemove` + accessible name) · `count` (data-lane number).

## States

- static default: as table above
- interactive hover: border → `--border-strong` (`--dur-fast` color only)
- interactive pressed/selected (`aria-pressed="true"`): ink `--text-1`, border `--accent`, fill
  `--accent-wash`
- focus-visible: standard ring
- active: no extra treatment beyond pressed
- disabled (interactive): `--opacity-disabled`, not focusable-skipped (kept in tab order with
  `aria-disabled`) when it communicates an unavailable filter
- loading/error: n/a — pills never spin; counts update in place
- remove affordance: opacity 0.7 → 1 on hover/focus; removal is instant (no exit animation)
- reduced-motion: border transition removed

## Accessibility

Filter pills are toggle buttons (`aria-pressed`), grouped under `role="group"` with a label
(toolbar.md); removable pills expose `aria-label="Remove tag X"` on the remove button; counts are
part of the accessible name ("warn, 7").

## Examples / anti-patterns

- Do: mode filter `[all 8][passive 2][chat 2][agent 4]`; removable `env:prod`; sm version tag
  `v2.3.1` in the data lane.
- Don't: a 20px clickable pill (interactive must be 24px); tone for decoration (channel tones mean
  the channel); re-rolled chip recipes in feed/picker/banner (compose this primitive); pills as
  status indicators (that's Badge: shape + label).

## Migration notes

FilterPill, TagInput chips, LineTags, `fc-inst`/`fc-badge`, picker chips, AlertBanner chips,
GroupCard badges (DUP-02, control-catalogue §5) all become compositions; the LogsTab/Ops log-level
chip drift (text-label vs text-xs) collapses onto the single 11px spec; unread-count rendering in
chat rows stays Badge-side (accent disc, badge.md).

## Enforcement hooks

`pill-via-primitive` (no ad-hoc chip recipes — border+radius+11px combos flagged in review),
`interactive-pill-target-floor`, tone-token-only colors.
