# Tokens v3 — the single source of truth for every design token in the SOUP console

v3.0.0-draft · G2-locked direction · pending G3

Locked source of values: `docs/design-system/02-directions/iterations/v2.html` (G2, Option A).
Current-state evidence: `docs/design-system/00-inventory/token-census.md` (180 tokens),
`docs/design-system/00-inventory/inconsistency-register.md` (P1-3, P1-6, P2-12, P3-5/6/7).
After G3, a change to any value in this file requires a version bump and a changelog row; the mockup
is no longer authoritative.

## Changelog

| Version | Date | Change |
|---|---|---|
| 3.0.0-draft | 2026-06-11 | Initial promotion of the G2-locked v2 (Blend) token set out of the mockup into SSOT. Adds the full legacy disposition table, migration aliases, light-theme AA must-fix values, and the utility-class anti-pattern register (G2 open item 3). |
| 3.0.0-draft | 2026-06-16 | Records the DD-26 closeout bridge: 8 consumed `--type-*` names and the `--r-1/--r-2/--r-3` aliases are now defined in `tokens.primitive.css`, but the final 12-token type ramp below remains the SSOT and still requires the DD-26/DD-37 visual/spec closure pass. |
| 3.0.0-draft | 2026-06-18 | Adds 10 off-grid component-geometry tokens to `tokens.component.css` so the remaining raw fixed dimensions move off literal lengths (raw-dimension-css burndown 11→0): `--typing-dot` 5px, `--toggle-w` 36px, `--modal-pad-max` 80px (modal backdrop clamp upper bound), `--skeleton-bar-h` 10px, `--log-lvl-chip-w` 18px, `--tab-underline-h` 2px, and the `--popover-check-{l,t,w,h}` checkmark-glyph geometry (3/2/6/10px). These are component-scoped deviations with no on-grid `--sp-*` equivalent (and deliberately not half-step, a tracked at-ceiling category); values are byte-equivalent to the originals, so no visual change. |

## 1. Architecture — three layers with must-not-own boundaries

| Layer | Owns | Must NOT own | Consumed by |
|---|---|---|---|
| **Primitive** | Raw ramps and physics: color ramps, spacing steps, radii, durations, easings, type ramp definitions, density constants | Theme decisions, component dimensions, screen semantics | Semantic layer only. A component referencing a primitive is a lint error (`no-primitive-in-component`). |
| **Semantic** | Role names remapped per `[data-theme]`: surfaces, inks, edges, action accent, mode/status channels, focus ring, scrim, chrome glass, shadows | Raw hex (except as the per-theme value assignment), component geometry, workflow logic | Components and screens. **This is the only layer components may use.** |
| **Component** | Scoped deviations declared with the component: row densities, panel widths, control heights, nameplate style | Anything reused by a second component (promote to semantic instead), raw values duplicating a primitive | The owning component only. Lives in the component's scope (CSS custom property on the component class), not global `:root`. |

Naming grammar (Primer-derived): `--{role}-{variant}` for semantic, `--{component}-{property}` for
component tokens. State variants append `-hover`/`-active`/`-disabled`.

## 2. Primitive layer

Theme-agnostic. Never referenced from component CSS or TSX.

### 2.1 Typeface stacks

| Token | Value |
|---|---|
| `--font-display` | `"Bricolage Grotesque", "Hanken Grotesk", "Helvetica Neue", Arial, sans-serif` |
| `--font-sans` | `"Hanken Grotesk", "Helvetica Neue", "Segoe UI", Arial, sans-serif` |
| `--font-mono` | `"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` |

### 2.2 Spacing — 4px grid, no half steps

| Token | Value | | Token | Value |
|---|---|---|---|---|
| `--sp-1` | 4px | | `--sp-5` | 20px |
| `--sp-2` | 8px | | `--sp-6` | 24px |
| `--sp-3` | 12px | | `--sp-8` | 32px |
| `--sp-4` | 16px | | `--sp-10` | 40px |
| | | | `--sp-12` | 48px |

The legacy half-step tokens (`--sp-0h/1h/2h`, 63 combined refs — census §11) are **not carried**.
Their use cases resolve to: icon-text gaps → `--sp-1` or component tokens; chip padding → component
tokens on Pill; anything else is a migration-time rounding to the nearest grid step. The grid is closed.

### 2.3 Radii

| Token | Value | Use |
|---|---|---|
| `--r-1` | 4px | badges, small controls, focus-ring corners |
| `--r-2` | 6px | buttons, inputs, cards, panels |
| `--r-3` | 8px | overlays only (modal, toast) |

### 2.4 Density constants

| Token | Value | Use |
|---|---|---|
| `--row-default` | 36px | browse surfaces, forms-adjacent lists |
| `--row-compressed` | 28px | ops surfaces: Fleet table, toolbars, logs |

Exactly two designed row heights exist. A third density is a spec change, not a CSS edit.

### 2.5 Motion

| Token | Value | Spent on |
|---|---|---|
| (instant) | 0 — no token; absence of transition | tabs, sort, theme swap, every keyboard/operator-caused state change |
| `--dur-fast` | 120ms | hover washes, label reveal, chevron; modal EXIT |
| `--dur-base` | 180ms | modal/toast/feed entry; drawer EXIT |
| `--dur-slow` | 280ms | drawer entry — the largest spatial move |
| `--ease-enter` | `cubic-bezier(0.2, 0, 0, 1)` | everything arriving — decelerate into place |
| `--ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | everything leaving — accelerate away |
| `--ease-linear` | `linear` | opacity-only fades; spinner rotation |
| (ambient) | 2400ms loop | ok-disc breathing only — see `motion.md` |

Closed set. The legacy `--ease` `cubic-bezier(0.22,1,0.36,1)` (73 refs) is superseded by the
enter/exit pair; the legacy untokenized literals `0.12s`/`0.25s` (P3-6) map to fast/slow.

### 2.6 Type ramp — closed, named, 4px-grid leadings

Full usage law in `typography.md`. The ramp is a primitive; components consume it via the semantic
type utilities, never via raw `font:` declarations.

| Token | Value | Extras |
|---|---|---|
| `--type-display` | `700 26px/32px var(--font-display)` | tracking −0.04em (`--tracking-tight`) |
| `--type-title` | `700 19px/24px var(--font-display)` | tracking −0.04em (`--tracking-tight`) |
| `--type-heading` | `600 15px/20px var(--font-sans)` | |
| `--type-body` | `400 14px/20px var(--font-sans)` | |
| `--type-body-st` | `500 14px/20px var(--font-sans)` | |
| `--type-label` | `500 12px/16px var(--font-sans)` | |
| `--type-caption` | `400 12px/16px var(--font-sans)` | |
| `--type-overline` | `600 11px/16px var(--font-sans)` | tracking +0.08em, uppercase |
| `--type-data-lg` | `500 22px/28px var(--font-mono)` | tabular figures |
| `--type-data` | `400 13px/20px var(--font-mono)` | tabular figures |
| `--type-data-sm` | `400 12px/16px var(--font-mono)` | tabular figures |
| `--type-nameplate` | `800 18px/24px var(--font-display)` | tracking −0.06em, uppercase — **the SOUP Bricolage wordmark** (accent "U"), reserved for the SOUP mark, see `brand.md` |

Implementation status (DD-26/DD-37): `tokens.primitive.css` currently carries a fallback-preserving
bridge for the 9 consumed type tokens (`--type-heading`, `--type-body`, `--type-body-st`,
`--type-label`, `--type-caption`, `--type-overline`, `--type-data`, `--type-data-sm`, and
`--type-nameplate`) so existing `var(--type-*, fallback)` consumers no longer depend on undefined
names. Those bridge values mirror today's fallbacks and intentionally differ from this final ramp
where a visual/type-floor pass is still owed — except `--type-nameplate`, whose bridge value already
equals this final ramp (`600 14px/24px var(--font-mono)`); it was promoted from pending to consumed
when the SOUP nameplate landed (Nav lockup, `brand.md` §1) and remains reserved to the single
`.soup-nameplate__wm` consumer. The display tier (`--type-display` 26/32, `--type-title` 19/24) was
promoted from pending to implemented at its §2.6 spec value (F-TYPE-3 display-tier slice); only
`--type-data-lg` remains pending. `tests/console/design-token-type-ramp.test.ts` pins the bridge
inventory and the pending spec token; it does not replace final primitive spec-drift enforcement.

### 2.7 Channel-tint strengths

| Token | Dark | Light |
|---|---|---|
| `--wash` | 12% | 9% |
| `--chan-border` | 36% | 32% |

These are the only alpha-strength knobs; every wash/border tint is derived (`color-mix`) from them —
never hand-copied rgba (replaces the 14 hardcoded tint tokens, census §4).

### 2.8 Color ramps — OkLCh engineering method

v3 primitives are **engineered ramps, not hand-picked hexes**. Method (research-digest §a Radix
contract + seed-3 OkLCh):

1. Work in `oklch()`. For each ramp, fix the hue and chroma curve, then place steps at predetermined
   lightness values so that designated text-over-background pairings pass AA **by construction**.
2. **The v2 hex values are the reference targets**: each engineered step must land within a
   just-noticeable difference (ΔE OK < 0.02) of the corresponding v2 hex listed in §3. Where
   engineering and v2 hex disagree beyond that, the v2 hex wins for v3.0 and the delta is logged for
   a v3.1 ramp correction.
3. One **neutral ramp** generates the surface ladders and ink ladders of both themes from one
   lightness scale read in opposite directions. Per decision-log #4 ("warmth from neutrals, not
   chroma"), the surface ramp is **warm**: hue ~70° (yellow-amber), chroma ≤ 0.012 — a subtly warm
   near-black for dark and a warm bone/paper for light, matched to the warm reference in the identity
   showcase. The electric-blue action accent (§3.4) stays locked and is *not* part of this ramp, so
   warmth comes only from the neutrals. Dark surface ladder
   (`#14110C`→`#1B1610`→`#231D15`→`#2E261B`) and light surface ladder (`#FBF6EC` paper for
   base/raised/overlay, `#ECE3D2` for inset) are the implemented values in §3.1; the light ink ladder
   is correspondingly warmed (§3.2) so text clears AA on the warmer paper.
4. Six **chromatic channel ramps** — status ok/warn/crit + mode passive/chat/agent — each generate
   exactly two solids (one per theme) plus derived wash/border tints via `--wash`/`--chan-border`.
   Light-theme solids sit darker and more saturated (chroma +15–25%) so every channel holds ≥ 4.5:1
   on white surfaces (see `color.md` contrast tables and must-fix list).
5. The action-accent ramp (electric blue) contributes `--accent`/`--accent-hover` per theme.

Primitive ramp steps are named `--ramp-{neutral|ok|warn|crit|passive|chat|agent|blue}-{step}` and
exist only in the token build file; nothing outside §3's semantic assignments may reference them.

## 3. Semantic layer — the only layer components may use

Every token below has a dark AND a light value, lifted from v2.html. Light is designed, not
inverted: dark elevates by lightening, light elevates by shadow + hairline; border alphas re-derived
per theme. Values marked **(must-fix)** replace the v2 value for AA — see `color.md` §5.

### 3.1 Surface ladder

| Token | Dark | Light | Role |
|---|---|---|---|
| `--surface-base` | `#1B1610` | `#FBF6EC` | app canvas |
| `--surface-raised` | `#231D15` | `#FBF6EC` (+ `--shadow-raised`) | cards, panels, toolbars |
| `--surface-overlay` | `#2E261B` | `#FBF6EC` (+ `--shadow-overlay`) | modals, drawer, popovers, toasts |
| `--surface-inset` | `#14110C` | `#ECE3D2` | wells, fields, log beds |

### 3.2 Ink ladder

| Token | Dark | Light | Role |
|---|---|---|---|
| `--text-1` | `#F2EBDC` | `#221C12` | primary ink |
| `--text-2` | `#BEB29C` | `#524833` | secondary ink |
| `--text-3` | `#897E6B` **(warm-ink; clears AA on the warm-dark surface ramp)** | `#645849` **(warm-ink; clears AA on the warm-light paper ramp)** | incidental only — lint-banned as sole information carrier |

### 3.3 Edge ladder

| Token | Dark | Light |
|---|---|---|
| `--border-hairline` | `#352C20` | `#D8CBB2` |
| `--border-subtle` | `#463A2B` | `#C5B69A` |
| `--border-strong` | `#574A38` | `#B0A084` |

### 3.4 Action accent

| Token | Dark | Light |
|---|---|---|
| `--accent` | `#6BA6FF` | `#2563EB` |
| `--accent-fg` | `#0A0E14` | `#FFFFFF` |
| `--accent-hover` | `#85B6FF` | `#1D52C9` |
| `--accent-wash` | `color-mix(in srgb, var(--accent) 12%, transparent)` | same formula at 9% |

### 3.5 Status channels — wash / border / solid / fg strengths

| Token | Dark | Light |
|---|---|---|
| `--status-ok-solid` | `#5BD97B` | `#15722F` **(must-fix; v2 was `#1A7F37`)** |
| `--status-warn-solid` | `#F5B54A` | `#855900` **(must-fix; v2 was `#9A6700`)** |
| `--status-crit-solid` | `#F4736F` | `#B42318` |
| `--status-{ok,warn,crit}-fg` | = solid | = solid (separate token so fg may diverge from fill in a future minor without breakage) |
| `--status-{ok,warn,crit}-wash` | `color-mix(in srgb, var(--status-X-solid) var(--wash), transparent)` | same formula, light `--wash` |
| `--status-{ok,warn,crit}-border` | `color-mix(in srgb, var(--status-X-solid) var(--chan-border), transparent)` | same formula, light `--chan-border` |

### 3.6 Mode channels — wash / border / solid / fg strengths

| Token | Dark | Light |
|---|---|---|
| `--mode-passive-solid` | `#3BD6B0` | `#096853` **(must-fix; v2 was `#0B7A63`)** |
| `--mode-chat-solid` | `#45C9E8` | `#0A6E8C` |
| `--mode-agent-solid` | `#A78BFA` | `#6841D6` |
| `--mode-{passive,chat,agent}-fg` | = solid | = solid |
| `--mode-{passive,chat,agent}-wash` / `-border` | derived via `--wash` / `--chan-border` | same formulas |

Mode-passive and status-ok are **distinct tokens with distinct values** in both themes — the legacy
`#2dd4a8` collision (P2-12) is resolved by construction.

### 3.6a Provider identity and chart data palettes

Provider identity is the only sanctioned chromatic exception outside accent, mode, and status
(`color.md` §2.1). Provider tokens may identify providers only; chart/data-series tokens may identify
non-provider data dimensions only.

| Token | Dark | Light | Role |
|---|---|---|---|
| `--provider-claude-fg` | `#B8A6D9` | `#6B5A9E` | Claude provider identity text/legend/series |
| `--provider-claude-wash` | `color-mix(in srgb, var(--provider-claude-fg) var(--wash), transparent)` | `color-mix(in srgb, var(--provider-claude-fg) var(--wash), transparent)` | Claude provider chip wash |
| `--provider-codex-fg` | `#8FA8C8` | `#486985` | Codex provider identity text/legend/series |
| `--provider-codex-wash` | `color-mix(in srgb, var(--provider-codex-fg) var(--wash), transparent)` | `color-mix(in srgb, var(--provider-codex-fg) var(--wash), transparent)` | Codex provider chip wash |
| `--provider-gemini-fg` | `#C5A878` | `#7E6432` | Gemini provider identity text/legend/series |
| `--provider-gemini-wash` | `color-mix(in srgb, var(--provider-gemini-fg) var(--wash), transparent)` | `color-mix(in srgb, var(--provider-gemini-fg) var(--wash), transparent)` | Gemini provider chip wash |
| `--provider-openai-fg` | `#86AAA6` | `#3E6D68` | OpenAI provider identity text/legend/series |
| `--provider-openai-wash` | `color-mix(in srgb, var(--provider-openai-fg) var(--wash), transparent)` | `color-mix(in srgb, var(--provider-openai-fg) var(--wash), transparent)` | OpenAI provider chip wash |
| `--provider-anthropic-fg` | `#BBA593` | `#74604F` | Anthropic provider identity text/legend/series |
| `--provider-anthropic-wash` | `color-mix(in srgb, var(--provider-anthropic-fg) var(--wash), transparent)` | `color-mix(in srgb, var(--provider-anthropic-fg) var(--wash), transparent)` | Anthropic provider chip wash |
| `--provider-opencode-fg` | `#9FB3A6` | `#536F5C` | OpenCode provider identity text/legend/series |
| `--provider-opencode-wash` | `color-mix(in srgb, var(--provider-opencode-fg) var(--wash), transparent)` | `color-mix(in srgb, var(--provider-opencode-fg) var(--wash), transparent)` | OpenCode provider chip wash |
| `--provider-unknown` | `var(--text-3)` | `var(--text-3)` | neutral fallback for unrecognized provider IDs |
| `--data-inbound-solid` | `#6B8299` | `#456073` | inbound/message received chart series |
| `--data-outbound-solid` | `#9AB2C4` | `#5E7E94` | outbound/message sent chart series |
| `--data-media-solid` | `#B39B72` | `#7A6238` | media/message attachment chart series |
| `--data-activity-solid` | `#7B9487` | `#4E6C5E` | active-hours heatmap intensity anchor; mix with surface for lower buckets |
| `--data-token-input-solid` | `#8798B8` | `#536985` | token input / prompt-side volume series |
| `--data-token-output-solid` | `#B99AA8` | `#785C68` | token output / completion-side volume series |
| `--data-session-active-solid` | `#83A7B0` | `#4E7280` | active sessions area series |
| `--data-session-started-solid` | `#B4A477` | `#76653F` | sessions started event series |

### 3.6b v2 mockup property → v3 SSOT name (renames at promotion)

The mockup used short channel names; v3 namespaces them. Disposition of every renamed v2 property:

| v2.html property | v3 token |
|---|---|
| `--ok-solid` / `--warn-solid` / `--crit-solid` | `--status-{ok,warn,crit}-solid` |
| `--ok-wash` / `--warn-wash` / `--crit-wash` | `--status-{ok,warn,crit}-wash` |
| `--ok-border` / `--warn-border` / `--crit-border` | `--status-{ok,warn,crit}-border` |
| `--mode-passive` / `--mode-chat` / `--mode-agent` | `--mode-{passive,chat,agent}-solid` |
| `--passive-wash` / `--chat-wash` / `--agent-wash` | `--mode-{passive,chat,agent}-wash` |
| `--passive-border` / `--chat-border` / `--agent-border` | `--mode-{passive,chat,agent}-border` |
| `--blue-500` / `--blue-600` (annotation illustration of tier 1) | `--ramp-blue-*` primitive steps feeding `--accent` per theme (§2.8) |

All other v2 properties keep their names (§2, §3.1–3.5, §3.7–3.8).

### 3.7 Focus, scrim, chrome glass, grain, shadows

| Token | Dark | Light |
|---|---|---|
| `--focus-ring` | `#6BA6FF` | `#2563EB` |
| `--scrim` | `rgba(4,6,9,0.62)` | `rgba(23,26,31,0.45)` |
| `--chrome-glass` | `color-mix(in srgb, var(--surface-base) 86%, transparent)` | `color-mix(in srgb, var(--surface-base) 86%, transparent)` |
| `--grain` | `0.045` | `0.030` | atmospheric noise-overlay strength (`body::before`), matched to the identity showcase
| `--shadow-raised` | `none` | `0 1px 0 rgba(255,255,255,0.55), 0 2px 6px -1px rgba(60,46,20,0.13), 0 8px 20px -6px rgba(60,46,20,0.12)` |
| `--shadow-overlay` | `0 16px 48px rgba(0,0,0,0.5)` | `0 1px 0 rgba(255,255,255,0.55), 0 8px 24px -6px rgba(60,46,20,0.18), 0 24px 56px -18px rgba(60,46,20,0.30)` |
| `--shadow-xs` | `none` | `0 1px 2px rgba(60,46,20,0.10)` |
| `--shadow-hover` | `0 4px 12px rgba(0,0,0,0.3)` | `0 1px 0 rgba(255,255,255,0.50), 0 4px 14px -2px rgba(60,46,20,0.18)` |

`--chrome-glass` is the only sanctioned translucent substrate; it may back the sticky header chrome
only. It derives from `--surface-base` so surface-ramp decisions carry glass with the ramp.
`--scrim` is the only other translucency. Glass under data is banned (seed 2).

### 3.8 Interaction washes

| Token | Dark | Light |
|---|---|---|
| `--btn-neutral-bg` | `rgba(255,255,255,0.06)` | `#FFFFFF` |
| `--btn-neutral-bg-hover` | `rgba(255,255,255,0.10)` | `#F2F3F5` |
| `--row-hover` | `rgba(255,255,255,0.035)` | `rgba(16,18,22,0.035)` |
| `--chart-bar` | `rgba(255,255,255,0.22)` | `rgba(16,18,22,0.22)` |

## 4. Component layer

Declared with the owning component, scoped to its class — never in global `:root`. Initial set
promoted from v2 + the legacy census:

| Token | Value | Owner |
|---|---|---|
| `--row-default` / `--row-compressed` | 36px / 28px | Table (defined in §2.4 as primitives because two components — Table and Toolbar — share them; consumed only via the density props) |
| `--type-nameplate` | §2.6 | Nameplate (brand.md) |
| `--btn-h` / `--btn-h-sm` / `--btn-h-xs` | 32px / 28px / 24px | Button (24px = WCAG floor) |
| `--input-h` / `--input-h-compact` | 32px / 28px | Input |
| `--drawer-w` | `min(360px, 86%)` | Drawer |
| `--modal-w-sm` / `--modal-w-md` / `--modal-w-lg` | 480px / 560px / 720px | Modal (lg carries the legacy wizard width) |
| `--panel-side-w` | 320px | Fleet dashboard side column |
| `--rail-w` / `--rail-w-collapsed` | 220px / 64px | Nav left rail (vertical app chrome; collapsed = narrow/icon-only state, decision-log "top bar → left rail") |
| `--inbox-pane-chats` / `--inbox-pane-contact` | 264px / 248px | Inbox |
| `--chart-panel-h` / `--chart-panel-h-expanded` | 140px / 240px | ChartPanel |
| `--pipeline-node-pad-y` | 5px | PipelineNode |
| `--message-bubble-max-w` | 65% | MessageBubble |
| `--heartbeat-bar-w` | 3px | HeartbeatStrip |
| `--toast-w-min` / `--toast-w-max` | 280px / 380px | Toast |
| `--log-col-time` / `--log-col-level` / `--log-col-comp` | 72px / 24px / 96px | LogStream |
| `--container-max` | 1280px | page shell |
| `--landing-max-w` | 1080px | Landing splash container max inline size |
| `--landing-hero-measure` / `--landing-prose-measure` | 16ch / 52ch | Landing hero headline + supporting-copy measures (§5 measure law) |
| `--cal-cell` | `var(--sp-8)` (32px) | DateTimePicker Calendar — single day-cell box (on-grid via `--sp-8`) |
| `--cal-gap` | `var(--sp-1)` (4px) | DateTimePicker Calendar — gap between day cells (on-grid via `--sp-1`) |

Single-consumer dimensions from the legacy census (`--sk-col-*`, `--feed-*`, `--qr-size`, …) are
**demoted** to this layer where the component survives, or rejected where it does not — full
disposition in §6.

## 5. Tailwind v4 mechanics — the cutover P0 CSS split

The legacy file mixes 50 `@theme` tokens (utility-generating) with 130 plain `:root` tokens
(census intro). v3 splits deliberately:

- **`tokens-primitive.css`** — primitives (§2) in a plain `:root` block. Not registered with
  `@theme`: primitives must not generate utilities, otherwise `bg-ramp-neutral-2` becomes writable
  in TSX and the layer boundary dies.
- **`tokens-semantic.css`** — semantic tokens (§3) defined under `:root, [data-theme="dark"]` and
  `[data-theme="light"]` scopes, then registered with **`@theme inline`**. `inline` is mandatory:
  these tokens resolve through `var()` indirection per theme scope, and plain `@theme` would freeze
  the dark value into the generated utility at build time. With `@theme inline`, `bg-surface-raised`
  and `text-status-warn-fg` exist as utilities and still re-resolve when `data-theme` flips.
- **`tokens-component.css`** (or co-located component CSS) — component tokens scoped to component
  classes. Never registered with `@theme`; no utilities.
- Theme switch is one attribute swap on `<html data-theme>`; zero component code branches.

This file split is the first cutover step (the "P0 CSS split"): create the three files,
alias the legacy names (§7), and only then begin component migration.

## 6. Legacy disposition table — all 180 census tokens

Disposition vocabulary: **formalized** (concept survives; legacy name aliased to the v3 token in
§7 where listed) · **component** (demoted to a component-scoped token) · **rejected-superseded**
(role replaced by the v3 system; no alias; migration rewrites call sites) · **rejected-orphan**
(zero consumers; deleted outright — the 7 census orphans).

### 6.1 Surfaces (7)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--color-d0` | formalized | `--surface-base` (value changes `#050709` → `#0E1013`) |
| `--color-d1` | formalized | `--surface-inset` |
| `--color-d2` | formalized | `--surface-raised` |
| `--color-d3` | rejected-superseded | toolbars/hover rows → `--surface-raised` + `--row-hover` |
| `--color-d4` | rejected-superseded | buttons/badges → `--btn-neutral-bg`, channel washes |
| `--color-d5` | rejected-superseded | → `--surface-overlay` |
| `--color-d6` | rejected-superseded | near-unused (1 ref); ladder is 4 steps, not 7 |

### 6.2 Text ramp (5)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--color-t1` | formalized | `--text-1` |
| `--color-t2` | formalized | `--text-2` |
| `--color-t3` | rejected-superseded | → `--text-2` (5-step ladder collapses to 3) |
| `--color-t4` | rejected-superseded | → `--text-2` or `--text-3` per call site (79 TW refs — biggest single migration) |
| `--color-t5` | formalized | `--text-3` (incidental-only law attaches) |

### 6.3 Mode accents (3 + 6 tints)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--color-m-pas` | formalized | `--mode-passive-solid` (de-collided from ok) |
| `--color-m-cht` | formalized | `--mode-chat-solid` (focus-ring duty removed → `--focus-ring`) |
| `--color-m-agt` | formalized | `--mode-agent-solid` |
| `--m-pas-soft` / `--m-cht-soft` / `--m-agt-soft` | rejected-superseded | 0.19-alpha tier has no v3 strength; → `-wash` or `-border` per site |
| `--m-pas-wash` / `--m-cht-wash` / `--m-agt-wash` | formalized | `--mode-{passive,chat,agent}-wash` (now derived, not hardcoded) |

### 6.4 Status colors (3 + 14 tints)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--color-s-ok` | formalized | `--status-ok-solid` (primary-button and checkbox duties move to `--accent`) |
| `--color-s-warn` / `--color-s-crit` | formalized | `--status-{warn,crit}-solid` |
| `--s-ok-wash` / `--s-warn-wash` / `--s-crit-wash` | formalized | `--status-{ok,warn,crit}-wash` (derived; the 0.06-vs-0.07 drift dies) |
| `--s-warn-border` / `--s-crit-border` | formalized | `--status-{warn,crit}-border` (ok gains a border peer — irregular coverage fixed) |
| `--s-ok-soft` / `--s-warn-soft` / `--s-crit-soft` | rejected-superseded | 0.19 tier → `-wash` or `-border` |
| `--s-ok-glow` / `--s-warn-glow` / `--s-crit-glow` | rejected-superseded | glow effects are off-language in the blend |
| `--s-ok-ring` / `--s-warn-ring` / `--s-crit-ring` | rejected-superseded | focus is always `--focus-ring`; status never colors a focus ring |

### 6.5 Type scale (13)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--text-xs` (0.6rem) | rejected-superseded | below the 12px data floor; → `--type-data-sm`/`--type-caption` |
| `--text-label` | formalized | `--type-label` |
| `--text-sm` | rejected-superseded | → `--type-caption` or `--type-data-sm` |
| `--text-data` | formalized | `--type-data` |
| `--text-heading` | formalized | `--type-heading` (0.5px twin of body collapses — P3-5) |
| `--text-body` | formalized | `--type-body` |
| `--text-lg` | rejected-superseded | → `--type-title` |
| `--text-xl` | rejected-superseded | → `--type-title`/`--type-display` per site |
| `--text-2xl` | formalized | `--type-data-lg` (KPI value lane) |
| `--text-{xs,sm,lg,xl}--line-height` (4) | rejected-superseded | leadings are baked into the `--type-*` shorthand ramp |

### 6.6 Tracking (6)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--tracking-tighter` | rejected-superseded | display tracking is part of the ramp (−0.02em) |
| `--tracking-tight` | rejected-superseded | title tracking is part of the ramp (−0.01em) |
| `--tracking-pill` | component | Pill component token (0.01em, baked into `.pill` style) |
| `--tracking-label` | rejected-superseded | labels are sentence-case untracked in v3 |
| `--tracking-caps` | formalized | overline tracking +0.08em, baked into `--type-overline` usage |
| `--tracking-wide` | component | expanded uppercase tracking (0.08em) for plugin-category headers (ConfigStep); defined to retire its dangling reference |

### 6.7 Radius (5)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--radius-xs` (2px) | rejected-superseded | sub-grid; nameplate tick corner is a component literal |
| `--radius-sm` (4px) | formalized | `--r-1` |
| `--radius-md` (6px) | formalized | `--r-2` |
| `--radius-lg` (10px) | rejected-superseded | overlays use `--r-3` (8px) |
| `--radius-circle` | **rejected-orphan** | use `border-radius: 50%` / `rounded-full` |

### 6.8 Border widths + alpha ramp (8)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--bw` (1px) | rejected-superseded | 1px is the only border width; literal |
| `--bw-accent` (2px) | rejected-superseded | left-edge status uses 2px inset shadow (table.md); literal |
| `--bw-focus` / `--bw-focus-outer` | rejected-superseded | one focus recipe: 2px ring + 2px offset (`interaction-patterns.md`) |
| `--b1` | formalized | `--border-hairline` |
| `--b2` | formalized | `--border-subtle` |
| `--b3` | formalized | `--border-strong` |
| `--b4` | rejected-superseded | 3-step edge ladder; strongest sites → `--border-strong` |

### 6.9 Family / weight (5)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--font-display` | formalized | `--font-display` (Bricolage Grotesque, showcase display tier) |
| `--font-sans` | formalized | `--font-sans` (value: Outfit → Geist → Hanken Grotesk; Geist woff2 removed) |
| `--font-mono` | formalized | `--font-mono` (value: IBM Plex Mono → Geist Mono → IBM Plex Mono; Geist woff2 removed) |
| `--fw-normal` / `--fw-medium` / `--fw-semibold` | rejected-superseded | weights are baked into the named ramp |

### 6.10 Shadows / overlays / motion (10)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--card-shadow` | formalized | `--shadow-raised` |
| `--overlay` | formalized | `--scrim` |
| `--overlay-badge` | rejected-superseded | media-badge tint → component token if MediaMessage keeps it |
| `--ease` | rejected-superseded | → `--ease-enter` / `--ease-exit` per direction |
| `--shadow-inset` | rejected-superseded | inset wells are flat on `--surface-inset` |
| `--shadow-md` | rejected-superseded | → `--shadow-raised` or `--shadow-overlay` |
| `--shadow-lg` | formalized | `--shadow-overlay` (dark value identical) |
| `--dur-fast` (0.15s) | formalized | `--dur-fast` (value → 120ms) |
| `--dur-norm` (0.2s) | formalized | `--dur-base` (value → 180ms) |
| `--dur-slow` (0.3s) | formalized | `--dur-slow` (value → 280ms) |

### 6.11 Spacing (16)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--sp-0` | rejected-superseded | zero needs no token |
| `--sp-1` … `--sp-12` (10 on-grid) | formalized | same names, §2.2 (note: legacy `--sp-7` 28px is dropped — off the v3 step list; → `--sp-6` or `--sp-8`) |
| `--sp-0h` / `--sp-1h` / `--sp-2h` | rejected-superseded | grid is closed; see §2.2 note |
| `--msg-pad-h` | component | Card/bubble padding token on the message bubble |
| `--btn-pad-v` | rejected-superseded | buttons are fixed-height; vertical padding dies |

### 6.12 Sizing / layout constants (65)

| Legacy group | Disposition | v3 target |
|---|---|---|
| `--toolbar-h`, `--nav-h` | rejected-superseded | header is 56px chrome (component literal); toolbar height emerges from `--row-compressed` + padding |
| `--dot-table/-feed/-badge/-header` (4) | rejected-superseded | one shape size: 8px (Badge spec); 6px mode dot is a Badge component literal |
| `--avatar-sm` / `--avatar-md` | component | Avatar tokens 32px / 48px (md re-derived; v2 uses 32/48) |
| `--avatar-lg` | **rejected-orphan** | deleted |
| `--icon-empty` | rejected-superseded | empty-state icon = 20px ramp step (iconography.md) |
| `--sparkline-h`, `--chart-panel-h`, `--chart-panel-h-expanded`, `--heatmap-cell`, `--heatmap-h`, `--chart-min-h` | component | chart-family tokens, co-located with chart components |
| `--contact-search-max-h`, `--config-key-col`, `--badge-unread` | component | owning components (ContactPicker, ConfigTab, Badge) |
| `--panel-chat-list`, `--panel-contact`, `--panel-actions`, `--panel-history`, `--panel-access-col` (5) | component | Inbox/LineDetail pane tokens; chat-list and contact panes take v2 values 264/248 |
| `--pipeline-node-pad-y` | component | PipelineNode static vertical padding, retained as local compact-pill geometry |
| `--message-bubble-max-w` | component | MessageBubble max inline size, retained as local chat-bubble geometry |
| `--heartbeat-bar-w` | component | HeartbeatStrip bar width, retained as local telemetry geometry |
| `--log-col-time/-level/-source` (3) | component | LogStream tokens (values → 72/24/96 per v2) |
| `--dropdown-min-w` | component | Select popover token |
| `--chat-name-max` | **rejected-orphan** | deleted |
| `--empty-max-w` | rejected-superseded | empty-state copy uses 36ch measure |
| `--media-thumb-h/-w` | component | MediaMessage tokens |
| `--sk-col-*` (7) | rejected-superseded | Fleet table columns are content-sized with priority collapse (drawer.md/table.md), not fixed widths |
| `--panel-confirm/-shortcuts/-wizard/-composer/-config-edit` (5) | rejected-superseded | → `--modal-w-sm/-md/-lg` (3 widths, not 5) |
| `--panel-max-inline/-wide`, `--modal-min-h`, `--modal-max-h/-sm/-lg` (6) | rejected-superseded | one modal sizing law: `min(Wpx, calc(100% - 32px))`, max-height 85dvh (modal.md) |
| `--tooltip-min-w`, `--tooltip-val-max` | component | Tooltip tokens (carried as-is) |
| `--toast-max-w` | formalized | `--toast-w-max` (value → 380px) |
| `--sep-h` | rejected-superseded | toolbar separator is 16px (component literal) |
| `--input-h` | formalized | `--input-h` (32px, unchanged) |
| `--input-btn` | rejected-superseded | → `--btn-h-sm` (28px) |
| `--input-number-w` | component | Input number-lane width token |
| `--feed-min-w`, `--feed-col-icon`, `--feed-inst-max`, `--feed-preview-max`, `--feed-actions-reserve` (5) | component | ActivityFeed tokens (feed survives as a card composition) |
| `--feed-col-time` / `--feed-indent` | **rejected-orphan** ×2 | deleted |
| `--stepper-line-w`, `--stepper-dot` | component | Wizard step tokens (v2: 16px separator, 18px circled number) |
| `--qr-size` | component | LinkStep token (256px, carried) |

### 6.13 Z-index and opacity (7)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--z-float` | formalized | `--z-float` 10 (sticky table headers sit below chrome) |
| `--z-dropdown` | **rejected-orphan** | replaced by the v3 stacking scale: chrome 50, drawer 30, modal 100, toast 110 (component literals per overlay spec) |
| `--z-overlay` | formalized | `--z-overlay` 100 (modal layer) |
| `--opacity-disabled` | **rejected-orphan** as legacy; re-introduced as `--opacity-disabled: 0.45` AND actually consumed by Button/Input disabled states (fixes the self-bypass at its own use site) |
| `--opacity-muted` / `--opacity-soft` / `--opacity-faint` | rejected-superseded | ink hierarchy comes from the ink ladder, not opacity stacks |

### 6.14 Avatar hues (8)

| Legacy | Disposition | v3 target |
|---|---|---|
| `--avatar-hue-0` … `--avatar-hue-7` | component | Avatar component tokens. The dynamic template-string consumption (`groups-utils.ts:41`) is **documented as a contract**: the Avatar spec declares the 8-token set as its public API; a code comment at the definition site must name the dynamic consumer. Grep-invisibility is acceptable only because it is now declared. |

### 6.15 Disposition counts

| Disposition | Count |
|---|---|
| formalized (carried into v3 primitive/semantic with alias where listed in §7) | 49 |
| component (demoted to component-scoped tokens) | 40 |
| rejected-superseded (role replaced; call sites rewritten at migration) | 84 |
| rejected-orphan (deleted; the census's 7) | 7 |
| **Total** | **180** |

## 7. Migration aliases and deprecation schedule

During the C0–C1 stages the legacy names below are shipped as aliases so the console keeps rendering while
components migrate. Aliases live in a clearly marked `tokens-legacy-aliases.css` block.

| Legacy alias | Points at |
|---|---|
| `--color-d0` | `var(--surface-base)` |
| `--color-d1` | `var(--surface-inset)` |
| `--color-d2` | `var(--surface-raised)` |
| `--color-d3` | `var(--surface-raised)` |
| `--color-d4` | `var(--btn-neutral-bg)` |
| `--color-d5`, `--color-d6` | `var(--surface-overlay)` |
| `--color-t1` | `var(--text-1)` |
| `--color-t2`, `--color-t3` | `var(--text-2)` |
| `--color-t4` | `var(--text-2)` (sites needing ghost re-point manually) |
| `--color-t5` | `var(--text-3)` |
| `--b1` | `var(--border-hairline)` |
| `--b2` | `var(--border-subtle)` |
| `--b3`, `--b4` | `var(--border-strong)` |
| `--color-m-pas` / `--color-m-cht` / `--color-m-agt` | `var(--mode-{passive,chat,agent}-solid)` |
| `--color-s-ok` / `--color-s-warn` / `--color-s-crit` | `var(--status-{ok,warn,crit}-solid)` |
| `--ease` | `var(--ease-enter)` |
| `--dur-norm` | `var(--dur-base)` |

Schedule: aliases ship at C0 (CSS split) → every alias consumption is a lint **warning**
from C2 → aliases removed at the end of C4 (rename sweep); any survivor is then a build
error. No alias may appear in new code at any phase. Tokens not in this table get no alias — their
call sites are rewritten during their component's migration PR.

## 8. Open item 3 resolved — v2 utility classes: primitives or anti-patterns

Every utility/spec-smell class in v2.html is dispositioned. Categories: **composition primitive**
(survives as a sanctioned utility or layout component), **component token** (folds into a component
spec), **forbidden** (documented anti-pattern; lint guard listed).

| v2 class | Disposition | Rule |
|---|---|---|
| `.t-display` … `.t-data-sm` | composition primitive | the only sanctioned type utilities; generated 1:1 from `--type-*` ramp tokens. Raw `font:`/`text-[..]` in TSX is a lint error. |
| `.overline` | composition primitive | part of the type utility set (style + tracking + uppercase). |
| `.t-nameplate` | component token | reserved; only the Nameplate component may emit it (brand.md). Use elsewhere is a lint error. |
| `.mono` | forbidden | bare font-family swap invites un-ramped type; use a `--type-data*` utility instead. |
| `.num` | composition primitive | renamed `data-lane` semantics: mono + `tabular-nums`; the sanctioned numeric-cell utility (typography.md tabular-figures law). |
| `.muted` / `.ghost` | composition primitive | ink utilities mapping 1:1 to `--text-2` / `--text-3`; `.ghost` content must never be the sole information carrier (lint pairs with the text-3 law). |
| `.txt-ok` / `.txt-warn` / `.txt-crit` | forbidden outside status renderers | status ink may only be emitted by StatusCell/Badge/log-level renderers; ad-hoc status coloring is the P1-4 disease. |
| `.wrap` | composition primitive | page Container primitive (`--container-max` 1280px + `--sp-6` gutters). |
| `.row` / `.row-3` / `.grow` | forbidden | ad-hoc flex shorthand; use the Stack/Cluster layout primitive with a `gap` prop bound to spacing tokens (layout-density.md §6). |
| `.mt-1` … `.mt-5`, `.mb-2` | forbidden | margin utilities break composability (`no-margin` rule family, seed 2); spacing comes from parent `gap`/Stack. |
| `.w-120` / `.w-160` / `.w-200` / `.w-240` | forbidden | magic widths; each call site maps to a component token (`--search-w` 200px on Toolbar search, 160px compact variant) or intrinsic sizing. |
| `.measure` | composition primitive | Prose primitive: `max-width: 80ch` (typography.md measure law). |
| `.ic` / `.ic-sm` / `.ic-x10` / `.ic-x14` / `.ic-x20` | partially formalized | icon sizing collapses to the 16/18/20/24 ramp (iconography.md). `.ic-x10` (10px) is forbidden — below the 12px informational floor. 12px (`.ic-sm`) is informational-only. |
| `.skel-row .w38/.w52/.w44/.end14/.end18/.end22` | component token | skeleton geometry belongs to the Skeleton component (mirrors table column layout via data-driven custom properties); the global width classes are forbidden. |
| `--h` (chart bar inline custom property) | composition primitive (pattern) | the sanctioned inline-style form: an inline style may only set or reference a custom property carrying data (bar height) or a token — raw CSS values inline are a lint error (`inline-style-token-only`). |
| `.demo-*`, `.spec-*`, `.ramp*`, `.sw*`, `.ladder*`, `.anno*`, `.vtable`, `.flowcap`, `.fmark`, `.codeblock`, `.foot`, `.locktag`, `.p1tag`, `.grafttag`, `.jumpnav`, `.vocab-strip`, `.stage*`, `.hdr*` | not carried | specimen/scaffolding classes for the mockup document itself; they have no production disposition. |

Enforcement hooks for this section (T7 wires them): `no-margin-utilities`, `no-magic-width`,
`inline-style-token-only`, `status-ink-only-in-renderers`, `type-via-ramp-utilities`,
`no-primitive-in-component`. Waivers follow the 5-field policy (owner, reason, scope, expiry,
replacement plan); no lint-suppression directive may be used inline without a waiver record.

## 9. Acceptance trace

- Every CSS custom property declared in v2.html appears above: primitives §2 (fonts 2, spacing 9,
  radii 3, density 2, motion 6, type 12, strengths 2), semantic §3 (surfaces 4, inks 3, edges 3,
  accent 4, status 12, mode 12, focus/scrim/glass 3, shadows 3, interaction 4), data-carrier `--h`
  §8. The mockup's tier-3 illustration (`--kpi-value-size`) is realized as the KPI component's
  use of `--type-data-lg`.
- All 180 legacy tokens dispositioned in §6 (counts §6.15).
- Light-theme AA failures and fixes: `color.md` §5.

## 10. v3.5 addendum (docs/design-system/v35/16-tokens-v3-addendum.md, landed b-01)

Additive names; v3 names stay live for current surfaces; v3.5 surface beads consume
`-v35` per-surface (staged cutover, no global flip).

- **§A gentle-warm ramp (L1) + refined accent (L2)** — per-theme literals under
  `--{surface,text,border,accent,shadow}-*-v35` in `console/src/styles/tokens.semantic.css`
  (dark base `#1E1A15`, light accent `#2E66E4`; WCAG values verified in
  `docs/design-system/v35/09-design-language-decisions.md`).
- **§B `channel-*` structural slots** — `--channel-glyph-ink/-dim`, `--channel-tag-bg/-keyline`;
  channels identify by glyph shape only, no hues (gate: no `channel-*` token carries a hue).
- **§C `agent-*` identity slots** — `--agent-hue-0..7` = `hsl(H,38%,34%)`, H ∈
  {0,30,60,100,140,250,285,325} (L3), `--agent-avatar-ink #FFF`, `--agent-dream`,
  `--agent-ring-sel`. Avatar-only; identity, not state.
- **§D `--presence-*` aliases** — live/paused/draft/deactivated, each resolving to the
  status channel with its shape mandatory (color-only presence is a violation).
- **§E register namespaces (L4)** — `--r-console-{sm,md,lg}` 4/6/8px;
  `--r-journey-{sm,md,lg}` 8/12/16px. Per-surface consumption; cross-register use is a
  lint error (L4 broad enforcement).

Theme-parity token count moves 123 → 139 (+16 v3.5 names in each scope).

## 11. v3.5 chrome geometry (docs/design-system/v35/mockups/*.html, landed b-02)

Component-tier dimension tokens in `console/src/styles/tokens.component.css`, single
`:root` scope (theme-independent geometry; parity count unaffected). The mockup
literals are the visual SSOT — they live here, dimension-allowlisted, so the chrome
stylesheet (`console/src/styles/chrome.css`) consumes `var()` only: colors from the
`-v35` semantic addendum (§A), radii from the console register (`--r-console-md`, L4).

- **Rail** — `--chrome-rail-w` 212px (expanded), `--chrome-rail-pad`, `--chrome-rail-gap`;
  collapse width stays `--rail-w-collapsed` 64px (breakpoint moves 760px → 1100px per
  mockup `@media (max-width:1100px)`). Legacy `--rail-w` 220px retired.
- **Nameplate/sections/items** — `--chrome-nameplate-pad`, `--chrome-sec-pad`,
  `--chrome-item-pad`, `--chrome-item-gap`, `--chrome-icon` 16px (11-channel-glyphography
  §1 floor), `--chrome-dot` 6px (inbox attention dot + host status dot).
- **Hosts block** — `--chrome-hosts-pad-top`, `--chrome-hostchip-pad`.
- **Header** — `--chrome-header-pad`, `--chrome-header-gap`, `--chrome-btn-pad`
  (header button), `--tracking-chrome-title` −0.02em (Bricolage h1),
  `--tracking-ctx` 0.18em (nameplate ctx caps), `--tracking-sec` 0.12em (rail section
  caps).
- **Shape details** — `--chrome-micro-radius` 1px (tick/dot/host-warn corner; badge.md
  shape family), `--chrome-pill-radius` 99px + `--chrome-attn-pad` (header attn pill).

## 12. v3.5 fleet geometry (docs/design-system/v35/mockups/fleet.html, landed b-03)

Component-tier `--fleet-*` dimension + tracking tokens in
`console/src/styles/tokens.component.css`, single `:root` scope (theme-independent
geometry; parity count unaffected). The mockup literals are the visual SSOT — they
live here, dimension-allowlisted, so the fleet stylesheet
(`console/src/styles/fleet.css`) consumes `var()` only. Full trace table:
`docs/design-system/v35/16-tokens-v3-addendum.md` §5.

- **Layout** — `--fleet-pagerow-gap` 14px / `--fleet-pagerow-pad` 14px 22px 12px
  (surface h1 row, mockup `header` literals — same rhythm as the global header,
  independently owned so chrome changes cannot shift the surface), `--fleet-pad-x`
  22px (content gutter), `--fleet-activity-w` 320px
  (activity column; mockup `.content` grid stacks at `max-width:1100px`),
  `--fleet-panelhead-pad`, `--fleet-panelhead-gap`. Shared *laws* stay under the
  b-02 chrome prefix and are consumed by design: `--chrome-micro-radius`,
  `--chrome-pill-radius` (badge.md shape family), `--chrome-icon` (glyph floor),
  `--tracking-chrome-title` (h1 voice).
- **KPI strip** — `--fleet-kpi-pad`, `--fleet-kpi-lift` 2px (hover lift),
  `--fleet-kpi-d-mt`, `--tracking-kpi` 0.1em.
- **Lines table** — `--fleet-row-pad`, `--fleet-head-pad`, `--fleet-lcell-maxw` 26ch,
  `--tracking-fleet-head` 0.08em; `--fleet-chan-box` 22px + `--fleet-chan-tag-keyline`
  2px + `--fleet-chan-tag-offset` (channel glyph + state tag, 11-channel-glyphography
  §1), `--fleet-avatar-box` 22px, `--fleet-mode-gap`/`--fleet-mode-dot` 6px,
  `--fleet-grant-box` 18px + `--fleet-grant-gap`, `--fleet-spark-h` 16px /
  `--fleet-spark-w` 3px / `--fleet-spark-gap` (7d sparkbar),
  `--fleet-badge-pad`/`--fleet-badge-gap` + `--tracking-badge` (state pill),
  `--fleet-rowbtn-pad` (row action).
- **Activity feed + heartbeat rail** — `--fleet-ev-pad`, `--fleet-hb-gap`,
  `--fleet-hb-bar-gap`.
- **Documented deviations (carried features, no mockup row)** —
  `--fleet-current-edge` 3px (drawer-current row accent), `--fleet-select-inset` 6px
  (bulk-select checkbox overlay), `--fleet-filterpop-pad` (filter popover search).

Half-step tokens (`--sp-*h`, DD-9 retirement queue) are not consumed by the Fleet
surface.

## 13. v3.5 agents geometry (docs/design-system/v35/mockups/agents.html, landed b-04)

Component-tier `--agents-*` dimension + tracking tokens in
`console/src/styles/tokens.component.css`, single `:root` scope (theme-independent
geometry; parity count unaffected). The mockup literals are the visual SSOT — they
live here, dimension-allowlisted, so the agents stylesheet
(`console/src/styles/agents.css`) consumes `var()` only.

- **Page row** — `--agents-pagerow-gap` 14px / `--agents-pagerow-pad` 14px 22px 12px
  (surface h1 row, mockup `header` literals — same rhythm as the global header,
  independently owned), `--tracking-agents-crumb` 0.1em (ROSTER / NAME caps).
- **Roster** — `--agents-roster-w` 300px + pad/gap; `.agents-acard` geometry
  (`--agents-acard-pad/-radius/-gap/-meta-mt/-hover-lift`), search box
  (`--agents-search-*`), kind caps `--tracking-agents-kind` 0.06em.
- **Avatar slots (12-agent-identity §2)** — `--agents-avatar-md` 34px/8px radius
  (roster card), `--agents-avatar-xl` 56px/14px radius (detail head),
  `--agents-avatar-xs` 22px (instance-row floor); fills consume `--agent-hue-0..7`
  (avatar fills only, §A gate).
- **Presence (§4)** — `--agents-stat` 8px shape; live disc / paused diamond /
  draft hollow square / deactivated recessed outline, colors from the
  `--presence-*` aliases, never avatar fill.
- **Detail** — `--agents-detail-pad`/`--agents-detail-gap`,
  `--agents-dhead-gap(-sm)`, panel geometry (`--agents-panel-*`), kv/swapbar
  (`--agents-swapbar-*`), tool toggle (`--agents-tgl-w/h/knob/inset`),
  assigned-line rows + grant chip (`--agents-grant-box` 18px), instance rows
  (`--agents-irow-who` 86px / `--agents-irow-ago` 46px / `--agents-ibtn-*`),
  skills chips, memory stats (`--agents-mstat-*`, `--tracking-agents-mstat`),
  `--agents-mrow-t-w` 38ch-class memory rows. Micro-geometry (burndown-class
  literals, all mockup-traced): `--agents-crumb-mt`, `--agents-icon-search/-meta/
  -line`, `--agents-search-icon-stroke`, `--agents-soul-mt`, `--agents-sub-mt`,
  `--agents-dhead-actions-gap`, `--agents-pill-gap/-pad`, `--agents-kv-gap/-pad-y`,
  `--agents-trow-pad-y`, `--agents-lrow-pad-y`, `--agents-irow-pad-y/-st`,
  `--agents-tgl-travel` (knob travel = track − knob − 2×inset),
  `--agents-integ-gap/-pad-y/-st`, `--agents-inote-mt`, `--agents-mstats-mb`,
  `--agents-mstat-v-mt`, `--agents-empty-pad-y`, `--agents-roster-empty-pad`,
  `--agents-presence-bw` 1.5px (§4 hollow-stroke floor). Font SIZES ride the
  `--text-*` scale + `--type-display` composite (weight/leading raw, fleet
  idiom); hairlines are `var(--bw)`; avatar ink is `--agent-avatar-ink`.
- **Stacking breakpoint is the mockup's own** — agents.html `@media
  (max-width:1000px)` stacks `.agents-wrap` and `.agents-grid`; NOT the
  chrome/fleet 1100px idiom (pinned in viewport-matrix at 999/1000/1001).
- **Shared laws consumed by design** (same ruling as b-03): `--chrome-micro-radius`
  + `--chrome-pill-radius` (badge.md shape family), `--tracking-chrome-title`
  (product h1 voice). Agents *layout* never reads chrome tokens.

Half-step tokens (`--sp-*h`, DD-9 retirement queue) are not consumed by the Agents
surface.

## 14. v3.5 skills-hub geometry (docs/design-system/v35/mockups/skills-hub.html, landed b-05)

Component-tier `--skills-*` dimension + tracking tokens in
`console/src/styles/tokens.component.css`, single `:root` scope (theme-independent
geometry; parity count unaffected). The mockup literals are the visual SSOT — they
live here, dimension-allowlisted, so the skills stylesheet
(`console/src/styles/skills.css`) consumes `var()` only.

- **Page row** — `--skills-pagerow-gap` 14px / `--skills-pagerow-pad` 14px 22px 12px
  (surface h1 row, mockup `header` literals — same rhythm as the global header,
  independently owned).
- **Hub mode toggle** — `--skills-modebar-gap/-pad/-radius` + button
  `-btn-pad/-btn-radius`.
- **Filters rail** — `--skills-filters-w` 196px + pad; `--skills-fsec-m`,
  `--skills-fitem-pad/-gap/-radius`, `--tracking-skills-fsec` 0.1em,
  `--skills-legend-lh` 1.8. Rail hides at the mockup's own `@media
  (max-width:900px)` — NOT the chrome/fleet 1100px or agents 1000px idioms
  (third distinct SSOT breakpoint, browser-pinned at 899/900/901).
- **Results column** — `--skills-main-pad`, toolbar (`--skills-toolbar-gap/-mb`,
  `--skills-search-*`, `--skills-icon-search` + stroke).
- **Result cards** — `--skills-scard-pad/-mb/-radius/-gap/-hover-lift`,
  `--skills-sicon` 34px + radius + 16px glyph, source badge
  (`--skills-src-pad`, `--tracking-skills-src` 0.06em), `--skills-acts-gap`.
- **Compat strip** — `--skills-compat-mt/-pad/-gap/-radius`,
  `--tracking-skills-compat`; cells `--skills-cdot-h/minw/pad-x/radius` +
  `--skills-cdot-warn-radius` (partial = rotated diamond per the shape law).
- **Warn-note** — `--skills-warnnote-mt/-pad/-gap/-radius` (third-party
  publisher caution block) + `--skills-warnnote-icon-mt`. Micro-geometry:
  `--skills-desc-mt`, `--skills-empty-pad-y` (documented deviation).

Font SIZES ride the `--text-*` scale (weight/leading raw, fleet idiom); hairlines
are `var(--bw)`; compat-cell washes consume the status-channel color-mix idiom.
Half-step tokens (`--sp-*h`, DD-9 retirement queue) are not consumed by the
Skills Hub surface.

## 15. v3.5 dream-lab geometry (docs/design-system/v35/mockups/dream-lab.html, landed b-06)

Component-tier `--dream-*` dimension + tracking tokens in
`console/src/styles/tokens.component.css`, single `:root` scope (theme-independent
geometry; parity count unaffected). The mockup literals are the visual SSOT — they
live here, dimension-allowlisted, so the dream stylesheet
(`console/src/styles/dream.css`) consumes `var()` only.

- **Page row** — `--dream-pagerow-gap/-pad` (mockup `header` literals, independently
  owned) + queued pill (`--dream-qpill-gap/-pad`).
- **Queue rail** — `--dream-queue-w` 340px + pad/gap; section heads
  (`--dream-qhead-pad/-mt`, `--tracking-dream-qhead` 0.1em), filters strip
  (`--dream-fstrip-*`), dream cards (`--dream-dcard-*`), type tag
  (`--dream-dtag-pad`, `--tracking-dream-dtag`), history rows
  (`--dream-hrow-*`, `--dream-hst-pad`, `--dream-hwhen-pad`).
- **Avatar slots (12-agent-identity §2)** — `--dream-avatar-sm` 26px/7px radius
  (queue card), `--dream-avatar-lg` 44px/11px radius (review head); fills consume
  `--agent-hue-0..7` (avatar fills only, §A gate); the ✦ rationale accent is
  `--agent-dream` (agent-mode channel, not identity).
- **Review pane** — `--dream-review-pad/-gap`, rhead + meta, panels
  (`--dream-panel-*`), rationale (`--dream-rationale-*`, quote capped 68ch),
  **diff capped `--dream-diff-maxw` 72ch (acceptance item)** + line/section
  geometry, impact columns, decision actions + tucked note. Micro-geometry:
  `--dream-dcard-what-mt`, `--dream-hist-pad-y`, `--dream-impact-col-minw`
  (documented deviation — wrap guard), `--dream-empty-pad-y` (deviation).
- **Stacking breakpoint is the mockup's own** — dream-lab.html `@media
  (max-width:980px)` stacks `.wrap`; the fourth distinct SSOT breakpoint
  (chrome/fleet 1100px, agents 1000px, dream 980px, skills 900px), browser-pinned
  at 979/980/981.

Font SIZES ride the `--text-*` scale + `--type-title` composite (weight/leading
raw, fleet idiom); hairlines are `var(--bw)`; diff del/add washes consume the
status-channel color-mix idiom. Half-step tokens (`--sp-*h`, DD-9 retirement
queue) are not consumed by the Dream Lab surface.
