# Token Census — console/src/index.css

Audit date: 2026-06-11 (branch `design/soup-rebrand`). Source of truth: `console/src/index.css` (1,236 lines).

Method: every `--*` custom property declaration in `console/src/index.css` was extracted with its definition line, then usage was counted across all of `console/src` (`.tsx`, `.ts`, `.css`):

- **var() refs** — exact occurrences of `var(--token)` (or `var(--token,` with fallback) anywhere in `console/src`, including consumption inside composite classes in `index.css` itself.
- **TW refs** — heuristic count of generated Tailwind v4 utility usage in `.tsx`/`.ts` for `@theme` tokens only (e.g. `--color-t2` → `text-t2`/`bg-t2`/`border-t2`; `--text-data` → `text-data`; `--radius-sm` → `rounded-sm`; `--tracking-caps` → `tracking-caps`; `--font-mono` → `font-mono`). `:root` tokens do not generate utilities, so TW refs is 0/blank for them by construction.
- **Orphan** — zero var() refs AND zero TW refs AND no dynamic construction found.

Two token blocks exist: `@theme` (`console/src/index.css:4-70`, 50 tokens — these generate Tailwind utilities) and `:root` (`console/src/index.css:72-222`, 130 tokens — plain CSS variables). That split is itself a design decision worth revisiting in v3 (see inconsistency-register.md).

## 1. Surface / background (dark ramp)

| Token | Value | Defined | var() refs | TW refs | Notes |
|---|---|---|---|---|---|
| `--color-d0` | `#050709` | `console/src/index.css:5` | 7 | 6 | page background (`index.css:264`) |
| `--color-d1` | `#0a0d12` | `console/src/index.css:6` | 9 | 19 | inputs, dialogs, feed container |
| `--color-d2` | `#0f1319` | `console/src/index.css:7` | 10 | 19 | cards/sections (`index.css:941,1104`) |
| `--color-d3` | `#141922` | `console/src/index.css:8` | 7 | 25 | toolbars, hover rows |
| `--color-d4` | `#1a202c` | `console/src/index.css:9` | 20 | 11 | buttons, badges, hover fills |
| `--color-d5` | `#212836` | `console/src/index.css:10` | 2 | 4 | detail card (`index.css:948`) |
| `--color-d6` | `#2a3244` | `console/src/index.css:11` | 1 | 2 | rarest surface step |

7 dark surface steps; d5/d6 are near-unused — consolidation candidates for the v3 primitive ramp.

## 2. Text ramp

| Token | Value | Defined | var() refs | TW refs | Notes |
|---|---|---|---|---|---|
| `--color-t1` | `#edf2f7` | `console/src/index.css:13` | 7 | 25 | headings |
| `--color-t2` | `#a0aec0` | `console/src/index.css:14` | 17 | 43 | body/default |
| `--color-t3` | `#6b7a90` | `console/src/index.css:15` | 12 | 47 | secondary |
| `--color-t4` | `#5a6a82` | `console/src/index.css:16` | 16 | 79 | labels/meta — heaviest TW use |
| `--color-t5` | `#3d4e66` | `console/src/index.css:17` | 11 | 60 | faint/disabled-ish text |

5 text steps, all live. t4 vs t5 distinction is heavily used but visually close (`#5a6a82` vs `#3d4e66`) — contrast review needed for the light theme.

## 3. Mode accents

| Token | Value | Defined | var() refs | TW refs | Notes |
|---|---|---|---|---|---|
| `--color-m-pas` | `#2dd4a8` | `console/src/index.css:19` | 12 | 10 | passive mode; **same hex as `--color-s-ok`** |
| `--color-m-cht` | `#38bdf8` | `console/src/index.css:20` | 29 | 21 | chat mode; doubles as global focus-ring color (`index.css:1180`) |
| `--color-m-agt` | `#a78bfa` | `console/src/index.css:21` | 24 | 18 | agent mode |

Derived mode tints (`:root`): `--m-pas-soft`/`--m-pas-wash` (`console/src/index.css:79-80`, 1/2 refs), `--m-cht-soft`/`--m-cht-wash` (`:81-82`, 8/7 refs), `--m-agt-soft`/`--m-agt-wash` (`:83-84`, 3/5 refs). Tint suffixes: `-soft` = 0.19 alpha, `-wash` = 0.06 alpha.

## 4. Status colors

| Token | Value | Defined | var() refs | TW refs | Notes |
|---|---|---|---|---|---|
| `--color-s-ok` | `#2dd4a8` | `console/src/index.css:23` | 33 | 27 | also primary-button fill (`index.css:970`) and checkbox accent (`index.css:242`) |
| `--color-s-warn` | `#f6ad55` | `console/src/index.css:24` | 22 | 30 | |
| `--color-s-crit` | `#fc8181` | `console/src/index.css:25` | 21 | 41 | |

Derived status tints (`:root`, `console/src/index.css:86-104`) — note the irregular tier coverage per status:

| Token | Value | Defined | var() refs |
|---|---|---|---|
| `--s-ok-glow` | `rgba(45,212,168, 0.25)` | `console/src/index.css:86` | 2 |
| `--s-ok-soft` | `rgba(45,212,168, 0.19)` | `console/src/index.css:87` | 2 |
| `--s-ok-wash` | `rgba(45,212,168, 0.06)` | `console/src/index.css:88` | 5 |
| `--s-ok-ring` | `rgba(45,212,168, 0.3)` | `console/src/index.css:103` | 2 |
| `--s-warn-glow` | `rgba(246,173,85, 0.25)` | `console/src/index.css:89` | 2 |
| `--s-warn-wash` | `rgba(246,173,85, 0.07)` | `console/src/index.css:90` | 18 |
| `--s-warn-soft` | `rgba(246,173,85, 0.19)` | `console/src/index.css:99` | 1 |
| `--s-warn-border` | `rgba(246,173,85, 0.12)` | `console/src/index.css:100` | 2 |
| `--s-warn-ring` | `rgba(246,173,85, 0.3)` | `console/src/index.css:104` | 1 |
| `--s-crit-glow` | `rgba(252,129,129, 0.25)` | `console/src/index.css:91` | 2 |
| `--s-crit-wash` | `rgba(252,129,129, 0.07)` | `console/src/index.css:92` | 11 |
| `--s-crit-soft` | `rgba(252,129,129, 0.19)` | `console/src/index.css:93` | 7 |
| `--s-crit-border` | `rgba(252,129,129, 0.1)` | `console/src/index.css:101` | 3 |
| `--s-crit-ring` | `rgba(252,129,129, 0.3)` | `console/src/index.css:102` | 1 |

Drift inside the tint system: `-wash` is 0.06 for ok but 0.07 for warn/crit; `-border` exists only for warn (0.12) and crit (0.1) at different alphas; ok has no `-border`. All tints are hardcoded rgba duplicates of the base hexes rather than derived (`color-mix` is used only in the wizard accent scope, `console/src/index.css:1145-1146`).

## 5. Type scale

| Token | Value | Defined | var() refs | TW refs | Notes |
|---|---|---|---|---|---|
| `--text-xs` | `0.6rem` | `console/src/index.css:29` | 9 | 35 | |
| `--text-xs--line-height` | `1.4` | `console/src/index.css:30` | 0 | n/a | consumed implicitly by Tailwind `text-xs` utility (not a true orphan) |
| `--text-label` | `0.65rem` | `console/src/index.css:31` | 4 | 20 | |
| `--text-sm` | `0.7rem` | `console/src/index.css:32` | 7 | 29 | |
| `--text-sm--line-height` | `1.4` | `console/src/index.css:33` | 0 | n/a | implicit via `text-sm` |
| `--text-data` | `0.78rem` | `console/src/index.css:34` | 12 | 63 | workhorse size |
| `--text-heading` | `0.82rem` | `console/src/index.css:35` | 1 | 0 | only via `c-heading` (`index.css:797`) |
| `--text-body` | `0.85rem` | `console/src/index.css:36` | 1 | 20 | |
| `--text-lg` | `1rem` | `console/src/index.css:37` | 2 | 9 | |
| `--text-lg--line-height` | `1.35` | `console/src/index.css:38` | 0 | n/a | implicit via `text-lg` |
| `--text-xl` | `1.4rem` | `console/src/index.css:39` | 0 | 2 | |
| `--text-xl--line-height` | `1.2` | `console/src/index.css:40` | 0 | n/a | implicit via `text-xl` |
| `--text-2xl` | `1.7rem` | `console/src/index.css:41` | 1 | 0 | only via `c-kpi-value` (`index.css:820`) |

9 sizes + 4 paired line-heights. `--text-heading` (13.1px) and `--text-body` (13.6px) are 0.5px apart — scale-consolidation candidate.

## 6. Tracking (letter spacing)

| Token | Value | Defined | var() refs | TW refs |
|---|---|---|---|---|
| `--tracking-tighter` | `-0.06em` | `console/src/index.css:44` | 1 | 0 |
| `--tracking-tight` | `-0.04em` | `console/src/index.css:45` | 4 | 0 |
| `--tracking-pill` | `0.02em` | `console/src/index.css:46` | 6 | 0 |
| `--tracking-label` | `0.06em` | `console/src/index.css:47` | 6 | 0 |
| `--tracking-caps` | `0.12em` | `console/src/index.css:48` | 2 | 0 |

All consumed only inside `index.css` composites — no `tracking-*` Tailwind utility usage found in TSX.

## 7. Radius

| Token | Value | Defined | var() refs | TW refs | Notes |
|---|---|---|---|---|---|
| `--radius-xs` | `2px` | `console/src/index.css:51` | 2 | 2 | |
| `--radius-sm` | `4px` | `console/src/index.css:52` | 20 | 36 | |
| `--radius-md` | `6px` | `console/src/index.css:53` | 6 | 28 | |
| `--radius-lg` | `10px` | `console/src/index.css:54` | 3 | 11 | |
| `--radius-circle` | `50%` | `console/src/index.css:55` | 0 | 0 | **Orphan** — circles use Tailwind `rounded-full` instead |

## 8. Border (width + alpha ramp)

| Token | Value | Defined | var() refs | TW refs |
|---|---|---|---|---|
| `--bw` | `1px` | `console/src/index.css:58` | 65 | n/a |
| `--bw-accent` | `2px` | `console/src/index.css:59` | 21 | n/a |
| `--bw-focus` | `1px` | `console/src/index.css:60` | 6 | n/a |
| `--bw-focus-outer` | `1.5px` | `console/src/index.css:61` | 4 | n/a |
| `--b1` | `rgba(255,255,255, 0.05)` | `console/src/index.css:73` | 35 | n/a |
| `--b2` | `rgba(255,255,255, 0.09)` | `console/src/index.css:74` | 27 | n/a |
| `--b3` | `rgba(255,255,255, 0.16)` | `console/src/index.css:75` | 11 | n/a |
| `--b4` | `rgba(255,255,255, 0.24)` | `console/src/index.css:76` | 2 | n/a |

Note: `--b1`..`--b4` are white-alpha and therefore dark-theme-only as written — a primary blocker for the v3 light theme (every border token needs a semantic indirection layer).

## 9. Typography family / weight

| Token | Value | Defined | var() refs | TW refs |
|---|---|---|---|---|
| `--font-sans` | `'Outfit', system-ui, -apple-system, sans-serif` | `console/src/index.css:63` | 7 | 28 |
| `--font-mono` | `'IBM Plex Mono', 'SF Mono', 'Cascadia Code', monospace` | `console/src/index.css:64` | 19 | 138 |
| `--fw-normal` | `400` | `console/src/index.css:67` | 3 | 0 |
| `--fw-medium` | `500` | `console/src/index.css:68` | 8 | 0 |
| `--fw-semibold` | `600` | `console/src/index.css:69` | 5 | 0 |

`font-mono` (138 TSX refs) far outweighs `font-sans` (28) — the console is predominantly a mono-data surface.

## 10. Shadows / overlays / easing / motion

| Token | Value | Defined | var() refs | Notes |
|---|---|---|---|---|
| `--card-shadow` | `0 1px 3px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.04)` | `console/src/index.css:78` | 2 | |
| `--overlay` | `rgba(5,7,9, 0.75)` | `console/src/index.css:94` | 2 | dialog backdrop fill |
| `--overlay-badge` | `rgba(0,0,0, 0.6)` | `console/src/index.css:95` | 1 | |
| `--ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | `console/src/index.css:97` | 73 | most-referenced token in the file |
| `--shadow-inset` | `inset 0 -2px 8px rgba(0,0,0,0.15)` | `console/src/index.css:106` | 2 | |
| `--shadow-md` | `0 8px 24px rgba(0,0,0,0.4)` | `console/src/index.css:107` | 4 | |
| `--shadow-lg` | `0 16px 48px rgba(0,0,0,0.5)` | `console/src/index.css:108` | 7 | |
| `--dur-fast` | `0.15s` | `console/src/index.css:218` | 32 | but several composites hardcode `0.15s`/`0.2s`/`0.12s`/`0.25s` instead (`index.css:1181,1186,1191,1198,1204,1223,1229`) |
| `--dur-norm` | `0.2s` | `console/src/index.css:219` | 21 | |
| `--dur-slow` | `0.3s` | `console/src/index.css:220` | 4 | |

## 11. Spacing

4px grid (`console/src/index.css:205-216`) plus off-grid half-steps (`:199-204`):

| Token | Value | Defined | var() refs |
|---|---|---|---|
| `--sp-0` | `0px` | `console/src/index.css:206` | 1 |
| `--sp-1` | `4px` | `console/src/index.css:207` | 92 |
| `--sp-2` | `8px` | `console/src/index.css:208` | 163 |
| `--sp-3` | `12px` | `console/src/index.css:209` | 128 |
| `--sp-4` | `16px` | `console/src/index.css:210` | 123 |
| `--sp-5` | `20px` | `console/src/index.css:211` | 45 |
| `--sp-6` | `24px` | `console/src/index.css:212` | 8 |
| `--sp-7` | `28px` | `console/src/index.css:213` | 2 |
| `--sp-8` | `32px` | `console/src/index.css:214` | 8 |
| `--sp-10` | `40px` | `console/src/index.css:215` | 4 |
| `--sp-12` | `48px` | `console/src/index.css:216` | 6 |
| `--sp-0h` | `3px` | `console/src/index.css:200` | 19 |
| `--sp-1h` | `6px` | `console/src/index.css:201` | 25 |
| `--sp-2h` | `10px` | `console/src/index.css:202` | 19 |
| `--msg-pad-h` | `14px` | `console/src/index.css:203` | 3 |
| `--btn-pad-v` | `7px` | `console/src/index.css:204` | 1 |

The three half-step tokens (63 combined refs) show the 4px grid is too coarse in practice; `--msg-pad-h` and `--btn-pad-v` are component-specific values living in the global spacing namespace.

## 12. Sizing / layout constants

Layout chrome: `--toolbar-h` `50px` (`console/src/index.css:110`, 8 refs), `--nav-h` `52px` (`:111`, 1 ref).

Dots and avatars: `--dot-table` `8px` (`:113`, 2), `--dot-feed` `6px` (`:114`, 1), `--dot-badge` `5px` (`:115`, 3), `--dot-header` `10px` (`:116`, 6), `--avatar-sm` `32px` (`:117`, 11), `--avatar-md` `36px` (`:127`, 4), `--avatar-lg` `64px` (`:128`, **0 — orphan**).

Component sizes: `--icon-empty` `40px` (`:129`, 2), `--sparkline-h` `32px` (`:130`, 1), `--heatmap-cell` `18px` (`:131`, 3), `--heatmap-h` `64px` (`:132`, 1), `--chart-min-h` `220px` (`:133`, 2), `--contact-search-max-h` `200px` (`:134`, 1), `--config-key-col` `140px` (`:135`, 1), `--badge-unread` `20px` (`:136`, 4).

Panel widths: `--panel-chat-list` `288px` (`:138`, 1), `--panel-contact` `256px` (`:139`, 1), `--panel-actions` `260px` (`:140`, 1), `--panel-history` `288px` (`:141`, 1), `--panel-access-col` `280px` (`:150`, 1).

Log columns: `--log-col-time` `90px` (`:143`, 3), `--log-col-level` `56px` (`:144`, 3), `--log-col-source` `100px` (`:145`, 3). Dropdown: `--dropdown-min-w` `200px` (`:146`, 1).

Text constraints: `--chat-name-max` `140px` (`:148`, **0 — orphan**), `--empty-max-w` `320px` (`:149`, 1), `--media-thumb-h` `200px` (`:151`, 3), `--media-thumb-w` `180px` (`:152`, 1).

SoupKitchen table columns: `--sk-col-mode` `90px` (`:154`, 1), `--sk-col-chats` `60px` (`:155`, 1), `--sk-col-count` `64px` (`:156`, 2), `--sk-col-msg` `68px` (`:157`, 2), `--sk-col-tokens` `80px` (`:158`, 2), `--sk-col-sessions` `72px` (`:159`, 1), `--sk-col-provider` `100px` (`:160`, 1).

Dialog/panel widths: `--panel-confirm` `420px` (`:161`, 4), `--panel-shortcuts` `340px` (`:162`, 1), `--panel-wizard` `720px` (`:163`, 3), `--panel-composer` `540px` (`:164`, 2), `--panel-config-edit` `560px` (`:165`, 1), `--panel-max-inline` `90%` (`:166`, 3), `--panel-max-inline-wide` `95vw` (`:167`, 1), `--modal-min-h` `500px` (`:186`, 1), `--modal-max-h` `85vh` (`:187`, 3), `--modal-max-h-sm` `80vh` (`:188`, 2), `--modal-max-h-lg` `90vh` (`:189`, 1).

Tooltips/toasts/inputs: `--tooltip-min-w` `220px` (`:168`, 1), `--tooltip-val-max` `160px` (`:169`, 1), `--toast-max-w` `360px` (`:170`, 1), `--sep-h` `14px` (`:171`, 1), `--input-h` `32px` (`:172`, 2), `--input-btn` `28px` (`:173`, 3), `--input-number-w` `120px` (`:174`, 2).

Feed: `--feed-min-w` `240px` (`:175`, 1), `--feed-col-time` `68px` (`:176`, **0 — orphan**), `--feed-col-icon` `16px` (`:177`, 9), `--feed-indent` `76px` (`:178`, **0 — orphan**), `--feed-inst-max` `80px` (`:179`, 3), `--feed-preview-max` `120px` (`:180`, 3), `--feed-actions-reserve` `96px` (`:181`, 1).

Wizard: `--stepper-line-w` `32px` (`:183`, 1), `--stepper-dot` `8px` (`:184`, 2), `--qr-size` `256px` (`:185`, 2).

Observation: 60+ of these are single-consumer component dimensions promoted into the global `:root` namespace — v3 should distinguish primitive sizing tokens from component-scoped constants.

## 13. Z-index and opacity scales

| Token | Value | Defined | var() refs | Notes |
|---|---|---|---|---|
| `--z-float` | `10` | `console/src/index.css:191` | 2 | |
| `--z-dropdown` | `50` | `console/src/index.css:192` | 0 | **Orphan** — dropdowns use Tailwind `z-50` instead (e.g. `console/src/components/LinePicker.tsx`, `console/src/components/shared/ChatPicker.tsx`) |
| `--z-overlay` | `100` | `console/src/index.css:193` | 2 | |
| `--opacity-disabled` | `0.45` | `console/src/index.css:195` | 0 | **Orphan** — `.c-btn:disabled` hardcodes `0.45` (`console/src/index.css:983`) instead of consuming it |
| `--opacity-muted` | `0.6` | `console/src/index.css:196` | 4 | |
| `--opacity-soft` | `0.3` | `console/src/index.css:197` | 2 | |
| `--opacity-faint` | `0.4` | `console/src/index.css:198` | 1 | |

## 14. Avatar hues

`--avatar-hue-0` through `--avatar-hue-7` (`console/src/index.css:119-126`), `hsl(N*45, 45%, 55%)`. Zero static `var()` refs, but **consumed dynamically** via template string `` `var(--avatar-hue-${idx})` `` in `console/src/components/line-detail/groups-utils.ts:41`. Not orphans, but invisible to static grep — a documentation/lint hazard.

## 15. Orphan summary (defined but unused)

Genuine orphans (no static, dynamic, or Tailwind-utility consumption found in `console/src`):

| Token | Value | Defined |
|---|---|---|
| `--radius-circle` | `50%` | `console/src/index.css:55` |
| `--avatar-lg` | `64px` | `console/src/index.css:128` |
| `--chat-name-max` | `140px` | `console/src/index.css:148` |
| `--feed-col-time` | `68px` | `console/src/index.css:176` |
| `--feed-indent` | `76px` | `console/src/index.css:178` |
| `--z-dropdown` | `50` | `console/src/index.css:192` |
| `--opacity-disabled` | `0.45` | `console/src/index.css:195` |

7 genuine orphans. Additionally: 4 `--text-*--line-height` tokens have zero direct refs but are consumed implicitly by Tailwind v4's generated `text-*` utilities (not orphans); 8 `--avatar-hue-*` tokens are consumed only dynamically (section 14).

## 16. Composite class census (`c-*` and feed classes)

Counts are occurrences in `.tsx`/`.ts` under `console/src` (word-boundary match, so `c-btn` does not double-count `c-btn-primary`). CSS-internal composition not included.

### Typography roles (`@utility`, `console/src/index.css:741-823`)

| Class | TSX refs | Files |
|---|---|---|
| `c-col-header` | 14 | 8 |
| `c-field-label` | 27 | 8 |
| `c-label` | 38 | 16 |
| `c-section-label` | 5 | 2 |
| `c-data` | 25 | 7 |
| `c-meta` | 5 | 5 |
| `c-heading` | 20 | 10 |
| `c-heading-lg` | 6 | 5 |
| `c-body` | 28 | 6 |
| `c-kpi-value` | 1 | 1 |

### Padding shells (`console/src/index.css:829-831`)

| Class | TSX refs | Files |
|---|---|---|
| `c-cell` | 15 | 2 |
| `c-toolbar` | 17 | 10 |
| `c-kpi-pad` | 1 | 1 |

### Form controls (`console/src/index.css:834-913`)

| Class | TSX refs | Files |
|---|---|---|
| `c-input` | 29 | 12 |
| `c-input-search` | 3 | 3 |
| `c-select` | 1 | 1 |
| `c-input-number` | 1 | 1 |
| `c-helper` | 9 | 4 |
| `c-error` | 6 | 3 |
| `c-checkbox-row` | 1 | 1 |

### Dialog shell (`console/src/index.css:915-937, 1111-1128`)

| Class | TSX refs | Files |
|---|---|---|
| `c-dialog-backdrop` | 9 | 9 |
| `c-dialog` | 5 | 5 |
| `c-dialog-body` | 0 | 0 — **unused** |
| `c-dialog-header` | 4 | 4 |
| `c-dialog-footer` | 3 | 3 |

Adoption gap: 9 backdrops but only 5 `c-dialog` shells, 4 headers, 3 footers — most dialogs use the backdrop and re-roll the rest.

### Cards / sections (`console/src/index.css:940-952, 1103-1108`)

| Class | TSX refs | Files |
|---|---|---|
| `c-card` | 31 | 14 |
| `c-card--detail` | 1 | 1 |
| `c-section` | 5 | 2 |

### Buttons (`console/src/index.css:955-1069`) — 11 variants + 3 label helpers

| Class | TSX refs | Files |
|---|---|---|
| `c-btn` (base) | 104 | 31 |
| `c-btn-primary` | 33 | 15 |
| `c-btn-ghost` | 59 | 21 |
| `c-btn-sm` | 41 | 19 |
| `c-btn-danger` | 10 | 6 |
| `c-btn-xs` | 14 | 3 |
| `c-btn-success` | 3 | 2 |
| `c-btn-warning` | 1 | 1 |
| `c-btn-nav` | 2 | 1 |
| `c-btn-send` | 2 | 2 |
| `c-btn-add` | 1 | 1 |
| `c-btn-nav-label` | 3 | 1 |
| `c-btn-send-label` | 2 | 2 |
| `c-btn-add-label` | 1 | 1 |

Long tail: warning/nav/send/add account for 6 total uses across 4 variants, each carrying its own hover-reveal animation machinery (`console/src/index.css:986-1069`).

### Other interactive primitives

| Class | Defined | TSX refs | Files |
|---|---|---|---|
| `c-tab` | `console/src/index.css:1072` | 11 | 3 |
| `c-kbd` | `console/src/index.css:1092` | 3 | 1 |
| `c-toggle` | `console/src/index.css:1162` | 0 | 0 — **unused** |
| `c-hover` | `console/src/index.css:1185` | 19 | 16 |
| `c-chat-item` | `console/src/index.css:1190` | 1 | 1 |
| `c-msg-bubble` | `console/src/index.css:1197` | 1 | 1 |
| `c-kpi-hover` | `console/src/index.css:1203` | 1 | 1 |
| `c-chart-expand-col` | `console/src/index.css:1212` | 3 | 1 |
| `c-nav-link` | `console/src/index.css:1217` | 3 | 1 |
| `c-dropdown-item` | `console/src/index.css:1222` | 2 | 1 |
| `c-row-hover` | `console/src/index.css:1228` | 3 | 3 |

### Border utilities (`console/src/index.css:1131-1138`)

| Class | TSX refs | Files |
|---|---|---|
| `c-border` | 11 | 9 |
| `c-border-b` | 34 | 19 |
| `c-border-b2` | 5 | 3 |
| `c-border-b-b2` | 3 | 2 |
| `c-border-t` | 9 | 8 |
| `c-border-t-b2` | 1 | 1 |
| `c-border-r` | 4 | 2 |
| `c-border-dashed` | 1 | 1 |

### Animation / misc utilities

| Class | Defined | TSX refs | Files |
|---|---|---|---|
| `animate-breathe-ring` | `console/src/index.css:307` | 1 | 1 |
| `animate-breathe` | `console/src/index.css:331` | 1 | 1 |
| `animate-shimmer` | `console/src/index.css:727` | 2 | 2 |
| `msg-slide-in` | `console/src/index.css:340` | 1 | 1 |
| `scrollbar-hide` | `console/src/index.css:298` | 10 | 5 |
| `typing-dot` | `console/src/index.css:323` | 3 | 1 |
| `wizard-accent-scope` | `console/src/index.css:1141` | 1 | 1 |

### Feed (BEM-style) classes (`console/src/index.css:350-719`)

Base-name refs in TSX (modifier/element classes like `fc-badge--ok`, `feed-toolbar__title` are composed in `console/src/components/ActivityFeed.tsx` and `console/src/components/FeedCard.tsx`): `feed-container` 1, `feed-toolbar` 1, `feed-filters` 1, `feed-stream` 1, `feed-empty` 1, `fc-main` 1, `fc-badge` 2, `fc-inst` 1, `fc-headline` 1, `fc-detail` 1, `fc-meta` 1, `fc-action` 4. The feed is the only surface styled in BEM CSS rather than Tailwind+c-* — a third styling dialect in one app.

## 17. Totals

| Metric | Count |
|---|---|
| Custom properties defined in `console/src/index.css` | **180** (50 in `@theme` `:4-70`, 130 in `:root` `:72-222`) |
| Genuine orphan tokens | **7** (plus 4 implicit line-heights, 8 dynamic-only avatar hues) |
| Composite `c-*` classes defined | **60** (10 typography, 3 padding, 7 form, 5 dialog, 3 card, 14 button incl. labels, 11 interactive/other, 8 border, minus overlaps; enumerated above) |
| Unused `c-*` classes | **2** (`c-toggle`, `c-dialog-body`) |
| Single-use `c-*` classes | 12 (`c-kpi-value`, `c-kpi-pad`, `c-select`, `c-input-number`, `c-checkbox-row`, `c-card--detail`, `c-btn-warning`, `c-btn-add`, `c-chat-item`, `c-msg-bubble`, `c-kpi-hover`, `c-border-t-b2`) |
| Non-`c-*` utility/animation classes | 7 (`animate-*` x3, `msg-slide-in`, `scrollbar-hide`, `typing-dot`, `wizard-accent-scope`) |
| Feed BEM class family | ~40 selectors (`console/src/index.css:350-719`) |
| Most-referenced tokens | `--sp-2` (163), `--sp-3` (128), `--sp-4` (123), `--sp-1` (92), `--ease` (73), `--bw` (65) |

Census method caveat: Tailwind-utility counts are regex heuristics over TSX/TS source (prefix list: bg/text/border/ring/fill/stroke/outline/divide/decoration/accent/caret/shadow/from/to/via, plus rounded-/tracking-/font-); dynamically-constructed class names would be undercounted. All var() counts are exact string matches.
