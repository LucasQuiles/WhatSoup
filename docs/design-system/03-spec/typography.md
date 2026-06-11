# Typography — Geist pair, closed named ramp, casing and figure laws

v3.0.0-draft · G2-locked direction · pending G3

Ramp definitions live in `tokens-v3.md` §2.6; this document is the usage law. Sources: v2.html
(locked), research-digest §c + typography shortlist, seed-3 (sentence case), seed-4 (≤3 tiers,
70–80ch).

## 1. Faces

- **Geist** (`--font-sans`) — all chrome, labels, prose. Weights 400/500/600 only.
- **Geist Mono** (`--font-mono`) — all data lanes: numerics, ids, timestamps, phones, log text,
  KPI values, and the nameplate. Weights 400/500/600.
- Fallback stacks (tokens-v3 §2.1) are metric-tolerant; offline render degrades without breakage.
- No third face, ever. No italic except the typing indicator. Hierarchy is expressed by size and
  weight only — never by a new font.

## 2. The named ramp (closed)

Twelve named styles (tokens-v3 §2.6): display, title, heading, body, body-st, label, caption,
overline, data-lg, data, data-sm, nameplate. Properties:

- All leadings sit on the 4px grid (16/20/24/28/32).
- Minimum data text is 12px (`--type-data-sm`); nothing in the product renders smaller.
- `--type-nameplate` is **reserved**: mono spaced-caps for the SOUP mark only, never content
  (`brand.md`). Emitting it elsewhere is a lint error.
- A new ramp style is a spec change (version bump here), not a one-off `font:` declaration.

Components consume the ramp via the type utilities (`.t-display` … `.t-data-sm`, `.overline`) —
the only sanctioned type utilities (tokens-v3 §8). Raw font sizes in TSX are lint errors.

## 3. Sentence-case law

All UI copy — labels, buttons, headings, tabs, table headers' *content*, empty states, errors — is
sentence case. No all-caps for emphasis (seed-3/Fluent). Exactly two sanctioned uppercase styles
exist, both structural rather than emphatic:

- `--type-overline` (+0.08em) — ghost structure labels: table column headers, kv keys, section
  overlines.
- `--type-nameplate` (+0.38em) — the SOUP mark.

Anything else uppercase is a lint finding. Title Case is banned everywhere.

## 4. Tabular figures law

Every numeric or data lane sets `font-variant-numeric: tabular-nums` via the data-lane utilities
(`.num`, `.t-data*`): table numeric columns, KPI values, timestamps, counts, unread badges, token
totals, durations, phone numbers. Proportional figures are permitted only inside prose sentences.
Columns of numbers that wiggle on update are a defect.

## 5. Measure law

Prose runs at a maximum 80ch measure (Prose primitive, tokens-v3 §8; seed-2/4: 70–80ch). Applies
to: section intros, annotations, modal body copy, empty-state descriptions (those cap tighter at
36ch for scanability). Data tables are exempt — they take the widest practical width
(layout-density.md).

## 6. Max ~3 size tiers per view

Any single view (page, modal, drawer) uses at most ~3 sans size tiers for its hierarchy (seed-4 /
NN/g), plus the mono data lanes. Example — Fleet: display (page title) / heading (panel titles) /
body+label (content), with data/data-lg as mono lanes. If a design needs a fourth sans tier, the
hierarchy is wrong; restructure instead of adding size.

## 7. Weights and emphasis

- 400 = default ink; 500 = strong body (`--type-body-st`), labels; 600 = headings, display,
  overline, nameplate.
- Emphasis inside running text: weight 500 + `--text-1` against `--text-2` context (the v2 feed
  pattern) — never color-only, never italics, never caps.

## 8. Migration notes (from the inventory)

- Outfit and IBM Plex Mono are replaced by the Geist pair (census §9; digest shortlist #1).
- The legacy 9-size scale (census §5) collapses onto the ramp; `--text-heading`/`--text-body`
  0.5px near-twins merge (P3-5); `--text-xs` (9.6px) dies below the 12px floor.
- Legacy `c-*` typography utilities (`c-label`, `c-data`, `c-heading` … census §16) map 1:1 onto
  ramp utilities during component migration; `c-col-header`'s double duty as a section label splits
  into overline (structure) vs heading (sections).
- The mono-dominant reality (138 mono TSX refs vs 28 sans) is preserved: data lanes stay mono.

## 9. Enforcement hooks

- `type-via-ramp-utilities` — no raw `font-size`/`font:` in components.
- `no-new-uppercase` — `text-transform: uppercase` outside overline/nameplate utilities.
- `tabular-nums-in-data-lanes` — numeric table cells and KPI values must use a data-lane utility.
- `nameplate-reserved` — `--type-nameplate`/`.t-nameplate` outside the Nameplate component.
