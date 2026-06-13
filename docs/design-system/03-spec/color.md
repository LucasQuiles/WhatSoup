# Color — role-based usage law, channel discipline, per-theme derivation, AA contrast tables

v3.0.0-draft · G2-locked direction · pending G3

Token values live in `tokens-v3.md`; this document is the usage law. Sources: v2.html (locked),
research-digest §a/§e/§f, synthesis-seed-2/3.

## 1. Role-based usage law

Color is consumed by **role**, never by appearance:

- Backgrounds may only use surface tokens (`--surface-*`), channel washes, or interaction washes.
- Text may only use ink tokens (`--text-1/2/3`), channel fg tokens, or `--accent`/`--accent-fg`.
- Borders may only use edge tokens (`--border-*`) or channel border tokens.
- Raw hex, named colors, and primitive-ramp references in component CSS or TSX are lint errors.
- A token may not be borrowed across roles (the legacy radius-as-width and ok-as-primary-button
  bugs are the cautionary precedents — inconsistency-register P1-4, P2-12).

## 2. Six-channel discipline

Chrome is monochrome. On a healthy screen the only chromatic pixels are:

1. The **action accent** (electric blue) — exactly one accent, spent on: primary buttons, links,
   selected/pressed states, focus ring, unread markers, the "now" chart bar.
2. **Mode identity** — passive (teal) / chat (cyan) / agent (violet), each a wash/border/solid/fg
   mini-scale. Load-bearing semantics: mode badges, feed left edges, wizard mode cards.
3. **Status semantics** — ok (green) / warn (amber) / crit (red) mini-scales. Annunciator law:
   status color may appear only in position-stable slots — shape indicator, status label, row
   left-edge + wash, KPI attention card, log level tag, toast edge. Never decorative tint.

That is six chromatic channels plus one accent; nothing else in the product may be chromatic —
save the single constrained provider-identity exception defined in §2.1.
ok-green is mostly absence: healthy rows do not shout (calm-by-default). The nameplate tick uses
`--mode-passive-solid` (brand heritage), not the action accent — see `brand.md`.

### 2.1 Provider identity palette (constrained data-viz exception)

Approved 2026-06-13. Provider identity is the one sanctioned exception to the six-channel law.
Provider colours are **not** status, mode, or action colours. They may appear **only** where the
datum being identified is the provider itself: provider labels, provider legends, provider chart
series, and provider identity chips.

Constraints: provider colours ride a dedicated **muted data-viz palette** (`--provider-*`), must be
AA-checked wherever used as text, and stay visually subordinate to status and the action accent.
They may **never** carry success, warning, failure, selected, focused, unread, or primary-action
meaning, and may never reuse a `--color-s-*` / `--color-m-*` token. Message-volume and other
non-provider chart series take a separate `--data-*` palette, also defined here before use — they
must not borrow status/mode channels either.

## 3. Per-theme derivation laws

- **Dark elevates by lightening.** The surface ladder steps up in luminance
  (`#0A0C0E → #0E1013 → #15181D → #1B1F26`); `--shadow-raised` is `none` — luminance does the work.
- **Light elevates by shadow + hairline.** Raised and overlay surfaces are both `#FFFFFF`;
  elevation is carried by `--shadow-raised`/`--shadow-overlay` plus hairline borders at
  near-constant luminance.
- **Border alphas are re-derived per theme**: white-alpha in dark (0.07/0.11/0.17), black-alpha in
  light (0.08/0.13/0.21). Never a shared hex, never reused across themes.
- **Chroma runs darker and more saturated on white.** Light-theme channel solids are not lightness
  inversions of the dark solids; they are re-engineered (OkLCh, tokens-v3 §2.8) to hold ≥ 4.5:1 on
  white surfaces and on their own washes.
- Wash strength re-tunes per theme: 12% dark, 9% light (`--wash`); channel borders 36%/32%.
- Theme switch = `data-theme` attribute swap; no component branches; both themes ship at equal
  quality (light is not a follow-up).

## 4. WCAG AA contrast tables

Computed (WCAG 2.2 relative luminance) from the locked v2 values; light-theme channel rows show
the v2 value and the §5 must-fix where applicable. AA: ≥ 4.5:1 normal text, ≥ 3:1 large text and
non-text indicators (SC 1.4.3, 1.4.11).

### 4.1 Ink × surface — dark

| Pair | base | raised | overlay | inset | Verdict |
|---|---|---|---|---|---|
| text-1 | 15.82 | 14.77 | 13.72 | 16.27 | pass |
| text-2 | 7.39 | 6.90 | 6.41 | 7.60 | pass |
| text-3 | 4.02 | 3.76 | 3.49 | 4.14 | below 4.5 everywhere — **lawful only because text-3 is classified incidental** (never sole carrier; lint-enforced). Passes the 3:1 non-text floor on all surfaces. |
| accent (links) | 7.73 | 7.22 | 6.71 | — | pass |
| accent-fg on accent | 7.85 | — | — | — | pass |

### 4.2 Ink × surface — light

| Pair | base | raised | overlay | inset | Verdict |
|---|---|---|---|---|---|
| text-1 | 16.20 | 16.91 | 16.91 | 15.10 | pass |
| text-2 | 6.47 | 6.75 | 6.75 | 6.03 | pass |
| text-3 (v2 `#8A919C`) | 3.04 | 3.18 | 3.18 | **2.84** | **MUST-FIX** — fails even the 3:1 incidental/non-text floor on inset (placeholders sit on inset fields). Fix in §5. |
| accent (links) | 4.95 | 5.17 | 5.17 | — | pass |
| accent-fg on accent | 5.17 | — | — | — | pass |

### 4.3 Channel fg × wash and × surface — dark (wash composited over base)

| Channel | solid on base | solid on own wash | shape vs base (3:1 floor) | Verdict |
|---|---|---|---|---|
| ok `#5BD97B` | 10.58 | 8.57 | 10.58 | pass |
| warn `#F5B54A` | 10.52 | 8.49 | 10.52 | pass |
| crit `#F4736F` | 6.83 | 5.87 | 6.83 | pass |
| passive `#3BD6B0` | 10.37 | 8.41 | 10.37 | pass |
| chat `#45C9E8` | 9.77 | 8.00 | 9.77 | pass |
| agent `#A78BFA` | 7.00 | 5.94 | 7.00 | pass |

Wash-over-raised variants sit ~0.6 lower across the board; all still pass (min: agent 5.43).

### 4.4 Channel fg × wash and × surface — light (wash composited over base/raised)

| Channel | solid on base | solid on own wash (base) | on own wash (raised) | Verdict |
|---|---|---|---|---|
| ok (v2 `#1A7F37`) | 4.87 | **4.32** | **4.48** | **MUST-FIX** — fg-on-wash fails 4.5 (pills, buttons, locktags use exactly this pair at 11–12px) |
| warn (v2 `#9A6700`) | 4.66 | **4.17** | **4.33** | **MUST-FIX** |
| crit `#B42318` | 6.30 | 5.45 | 5.65 | pass |
| passive (v2 `#0B7A63`) | 5.06 | **4.46** | 4.66 | **MUST-FIX** (marginal, but the pair is used at caption sizes) |
| chat `#0A6E8C` | 5.55 | 4.88 | 5.10 | pass |
| agent `#6841D6` | 6.07 | 5.31 | 5.54 | pass |

All six light channels pass the 3:1 non-text shape floor (min: warn 4.66 vs base).

### 4.5 Focus ring (SC 1.4.11, ≥ 3:1 vs adjacent surfaces)

| Theme | vs base | vs raised | vs overlay | Verdict |
|---|---|---|---|---|
| dark `#6BA6FF` | 7.73 | 7.22 | 6.71 | pass |
| light `#2563EB` | 4.95 | 5.17 | 5.17 | pass |

## 5. MUST-FIX register (binding value changes vs v2.html)

These adjustments are part of the v3.0 lock; `tokens-v3.md` §3 already carries them. Each keeps the
v2 hue, deepens lightness only (OkLCh-verified), and clears 4.5:1 on every wash/surface bed:

| Token (light theme) | v2 value | v3.0 value | Worst pair after fix |
|---|---|---|---|
| `--status-ok-solid` / `-fg` | `#1A7F37` | `#15722F` | 5.09 on wash(base) |
| `--status-warn-solid` / `-fg` | `#9A6700` | `#855900` | 5.19 on wash(base) |
| `--mode-passive-solid` / `-fg` | `#0B7A63` | `#096853` | 5.65 on wash(base) |
| `--text-3` | `#8A919C` | `#7C8490` | 3.29 vs wash beds, 3.37 on inset — clears the 3:1 incidental floor everywhere (still classified incidental; never sole carrier) |

Dark theme requires no fixes. The mockup is updated to these values at the next v2.html touch or
superseded by the C1 token-foundation implementation, whichever comes first; the spec values are authoritative
now.

## 6. Color-vision deficiency notes

- **Shape law is the independent channel.** Status = shape + color + text label, always travelling
  together (disc/diamond/square/outline — `components/badge.md`). Every status survives grayscale,
  deuteranopia and protanopia by construction; color is never the sole carrier (SC 1.4.1).
- Named CVD risk from research (digest §e): teal (passive) vs cyan (chat) vs green (ok) proximity.
  Mitigations: modes and statuses never appear in the same slot (mode = square dot + word; status =
  shape + word); both always carry their text label in data surfaces.
- Heartbeat strips encode height + color and carry an `aria-label` summarizing counts.
- Log levels carry letter tags (E/W/I/D) inside bordered chips — a second non-color channel.
- Charts: the accent marks "now"; series differentiation must use position/labels, not hue pairs.

## 7. Enforcement hooks

- `no-raw-color-in-components` — hex/rgb/hsl/oklch literals outside the token files.
- `no-primitive-in-component` — `--ramp-*` references outside `tokens-semantic.css`.
- `status-ink-only-in-renderers` — channel fg/wash/border tokens outside StatusCell, Badge, Pill,
  LogStream level tags, Toast edges, Button danger/success/warning variants.
- Token-pair contrast check in CI: the §4 tables re-computed from the live token files for both
  themes; any designated pair below threshold fails the build.
- `incidental-ink-guard` — `--text-3`/`.ghost` may not be the only rendering of a datum.
