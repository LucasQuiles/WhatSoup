# SOUP Design System v3 — Research Digest (T3)

Access date for all web evidence: **2026-06-11**. Companion catalogue: `reference-library.md` (authority levels and verification status live there; this file synthesizes).

**Direction candidates referenced throughout** (mocked in T4):

- **A-Instrument** — hardware-instrument discipline: mono-forward type, strict grid, annunciator-style status, Braun/Teenage-Engineering restraint translated to web (no skeuomorphism).
- **B-Editorial** — typographic calm: Vercel/Geist/Linear lineage; sans-led hierarchy, generous-but-disciplined spacing, near-monochrome chrome with one accent.
- **C-Ops** — maximum-density observability: Grafana/Datadog/EUI lineage; compressed controls, panel-grid dashboards, telemetry-first.

All three share the same token architecture (§d), status discipline (§e), contrast strategy (§f), and motion doctrine (§g) — the directions differ in surface, type, and density, not in system mechanics.

---

## 0. What v2 already concluded (carry-forward, do not re-litigate)

Source: `docs/console-mockups/design-principles.html`, `docs/console-mockups/reference-analysis.html` (local, read 2026-06-11).

**Still valid — carried into v3 unchanged:**

1. **Color = meaning, never decorative.** Mode colors (passive teal/emerald, chat cyan, agent violet) and status colors (ok/warn/crit) are load-bearing semantics. Three opacity tiers per color (full / soft ~30% / wash 6–12%).
2. **5-second rule** scan hierarchy: KPI strip → alert banner → status-dot column → pipeline column → feed.
3. **4px base grid**; fixed component dimensions ("same element = same size always").
4. **Mono for data, sans for chrome**; ghost-text structure labels.
5. **Calm by default, alarm by exception**; progressive disclosure (fleet → line → tab → inline expand).
6. **Lucide-only iconography** with fixed sizes per slot (16/20/24) and contextual color inheritance.
7. **Motion with purpose**; no animation on mode switch, tab change, or table sort.
8. Product-flow steals: 3-pane inbox, heartbeat strips, line picker, live KPI cards, click-to-detail.

**Where v2 is insufficient (the v3 gaps this program exists to close):**

- Dark-only. No light theme, hence no theme-portable token model — v2's palette is raw hex (`--d0..d6`, `--t1..t5`) named by *appearance*, not role. Unportable by construction.
- No primitive→semantic→component layering; no elevation/surface model beyond "d0..d6 get lighter".
- No formal type ramp (sizes are ad-hoc rem values in mockups); no motion tokens, no reduced-motion path.
- Brand ("WhatSoup"/"Soup Kitchen") informal; wordmark undesigned.
- v2's reference set was product-flow only (WhatsApp tools + Uptime Kuma); no visual-system references — that's this document.

---

## (a) Dual-theme at high polish — Linear, Vercel/Geist

### Geist: role-banded scales, not named grays

- **Observed:** 10 color scales (gray, gray-alpha, blue, red, amber, green, teal, purple, pink), each banded by function: backgrounds (2 levels), component backgrounds 1–3 (default/hover/active), borders 4–6, high-contrast fills 7–8, text 9–10. Themes = system/light/dark over the same role bands. "High contrast, accessible color system" is a stated principle.
- **Verdict: STEAL (the banding method), ADAPT (the bands themselves).** SOUP scales should be authored per-band-purpose so every step has a contract ("step N is a hover border") that holds in *both* themes. SOUP needs alpha variants of its mode colors (the v2 "wash" tier) as first-class scale members, not ad-hoc `rgba()`.
- **Risk:** copying Geist's bands verbatim imports Vercel's look; SOUP's teal/cyan/violet mode trio needs custom scales tuned to keep mutual distinguishability at low chroma.
- **SOUP decisions affected:** tokens, dark/light strategy, status color.
- **Evidence:** https://vercel.com/geist/colors , https://vercel.com/geist/introduction (fetched 2026-06-11).
- **Directions:** foundation for all three; aesthetic kinship strongest with **B-Editorial**.

### Radix Colors: 12-step contract + paired dark scales

- **Observed:** every scale has 12 steps with fixed designations (app backgrounds → component states → borders → solid fills → text); each scale ships a hand-tuned dark counterpart so "switching to dark theme is as simple as applying a class"; text steps are *guaranteed* to pass contrast against their designated backgrounds, using APCA-informed tuning.
- **Verdict: STEAL the method — "contrast guaranteed by scale construction" is the single most important mechanic in this digest.** If SOUP scales are built so that (text step) over (background step) passes AA *by construction*, then theme-wide AA becomes a property of the palette, not a per-screen audit.
- **Risk:** Radix steps assume Radix's lightness curve; SOUP's near-black ops surfaces (and the mode-color wash tier) need custom curves — adopt the contract, re-derive the values.
- **SOUP decisions affected:** tokens, dark/light strategy, status color, enforcement (lintable: "text tokens may only sit on background tokens").
- **Evidence:** https://www.radix-ui.com/colors (fetched 2026-06-11).
- **Directions:** all three.

### Linear: light and dark as two designed artifacts; chrome recedes

- **Observed (2025 refresh writeup):** goal "a calmer interface for a product in motion." Sidebar made "a few notches dimmer"; separators softened — "structure should be felt not seen"; palette moved from cool blue-grays to warmer grays *in both default light and dark modes*; the tension they manage is preserving "rich density of information" while reducing noise; rollout via feature flags; they built an internal real-time color/palette tool because Figma mockups couldn't evaluate themes against live data.
- **Verdict: STEAL three things.** (1) Chrome dimmer than content — navigation and panel borders sit 1–2 contrast notches below data. (2) Hairline + fill instead of heavy borders — separation via background-delta first, border second. (3) **Evaluate themes against the live console with real fleet data, not static mockups** (T4 mockups must be HTML against realistic mock data — already the plan — and T5 should iterate with a live token switcher).
- **Risk:** Linear's warmth (warm grays) may fight WhatSoup's existing cool teal identity; warm-vs-cool gray is a T4 A/B decision, not an assumption.
- **SOUP decisions affected:** dark/light strategy, navigation, density, tokens, process.
- **Evidence:** https://linear.app/now/behind-the-latest-design-refresh (fetched 2026-06-11).
- **Directions:** strongest for **B-Editorial**; chrome-dimming applies to all.

### Raycast: the dark-surface ladder (secondary source)

- **Observed (third-party teardown; hex values approximate):** near-black ladder of three surfaces (#07080a → #0d0d0d → #101111), hairline 1px borders (~#242728), 6–10px radii, monochrome chrome with a single saturated accent, Inter with ss03 and slightly positive letter-spacing giving "airy" body type on a dark canvas.
- **Verdict: ADAPT.** Confirms that high-polish dark UI uses a *small* surface ladder (3–4 levels) with tiny luminance deltas plus hairlines — not big jumps. SOUP's v2 already has 7 dark levels (`--d0..d6`); v3 should *reduce* to a named 3–4 level surface ladder per theme.
- **Risk:** secondary source — treat specific hexes as illustrative. Marked search-verified.
- **SOUP decisions affected:** surface/elevation model, tokens, typography (letter-spacing on dark).
- **Evidence:** https://getdesign.md/raycast/design-md via search (2026-06-11); https://manual.raycast.com/themes.
- **Directions:** **A-Instrument** and **C-Ops** dark themes.

---

## (b) Dense tables/logs without clutter — Grafana, Datadog, EUI

### Grafana / Saga

- **Observed (search-verified; saga site itself is JS-gated — page-level details Inconclusive):** Saga maintains *parallel* dark and light component libraries (two published Figma kits) rather than one library auto-flipped; an active token-restructuring effort (grafana/grafana #78865, #78866) is rebuilding their theme on a foundations→token hierarchy (color, typography, layout, surface) synced between Figma variables and code. Product-level (known-canon): Grafana ships dark-default with a first-class light theme; dashboards are a grid of self-contained panels each owning its title/legend/toolbar.
- **Verdict: ADAPT.** (1) Two designed theme artifacts over one token vocabulary — matches Carbon and the locked SOUP decision. (2) The *panel* as the dashboard unit (own header, own toolbar, own empty state) is the right container model for Soup Kitchen KPI/chart/feed modules. (3) Their late-stage token retrofit is a cautionary tale: tokenize *before* scaling screens — exactly what T6 does.
- **Risk:** Grafana's visual finish is below SOUP's bar (utilitarian, occasionally inconsistent) — adopt structure, not finish. Honest gap: I could not read Saga's own guidance pages; claims limited to what the kits/issues demonstrate.
- **SOUP decisions affected:** tables, density, dark/light strategy, dashboard layout.
- **Evidence:** https://grafana.com/developers/saga/ ; https://github.com/grafana/design-system ; grafana/grafana issues #78865/#78866; Figma community kits (dark/light) — search-verified 2026-06-11.
- **Directions:** core of **C-Ops**.

### Datadog / DRUIDS

- **Observed (fetched blog):** consistency doctrine — if filtering, time-range scoping, or graph inspection works one way anywhere, it works that way everywhere; 600+ governed React components with code as source of truth; DRUIDS Loupe lets anyone inspect which component renders any pixel; contribution rules cover prop naming, a11y, testing. **The blog explicitly does not document density, dark mode, typography, or token specifics — those remain Inconclusive; no claims made.**
- **Verdict: STEAL the governance posture, scaled down.** SOUP's equivalent of "the same interaction everywhere": one table component, one time-range control, one filter pattern, one log-viewer — used by every page. The existing ESLint design-rule file (106 selector restrictions, verified T1) is SOUP's embryonic Loupe; T7's lint plan should grow it so the component source of truth is enforced, not advisory.
- **Risk:** none material; this is process precedent.
- **SOUP decisions affected:** enforcement, tables, navigation consistency.
- **Evidence:** https://www.datadoghq.com/blog/engineering/druids-the-design-system-that-powers-datadog/ (fetched 2026-06-11); https://druids.datadoghq.com.
- **Directions:** all three.

### Elastic EUI: density as a designed variant

- **Observed (search-verified):** EUI redesigned form controls into **compressed** variants because standard controls were "too bulky for heavy interactive UI"; dark/light switch via `EuiProvider` `colorMode` over one token set (Emotion CSS-in-JS).
- **Verdict: ADAPT.** Don't make SOUP uniformly dense; make *compressed* a designed, tokenized control variant used in table toolbars, filter rows, and the Ops panel, while forms in the setup wizard stay at comfortable scale. Density becomes a component property with rules, not a vibe.
- **Risk:** two densities = two test surfaces; constrain to exactly two (default, compressed) and forbid per-screen ad-hoc sizing.
- **SOUP decisions affected:** density, form controls, tables, tokens (size ramp must encode both densities).
- **Evidence:** https://eui.elastic.co ; https://www.elastic.co/blog/keeping-up-with-kibana-2019-09-16 (search-verified 2026-06-11).
- **Directions:** **C-Ops** primarily; compressed-toolbar pattern useful in all.

### Log/table clutter synthesis (Grafana+Datadog product surfaces, known-canon)

Dense ops tables stay legible through: fixed-width mono for timestamps/ids/numerics (v2 already does this); row hover as wash not border; severity as a thin left edge or dot, never a full-row fill except critical; column headers in ghost text; virtualized scroll with sticky headers; one-line rows with inline expand for detail (matches v2 progressive disclosure). **Adopt as table doctrine.** Affects: tables, status color, density. Directions: all; definitive for **C-Ops**.

---

## (c) Apple HIG consistency mechanics

- **Observed (typography page fetched — summary-level; dark-mode page fetch failed, items marked *known-canon* below):** one typeface family; hierarchy expressed through a *fixed, named* text-style ramp (Large Title → Caption) varying size/weight — never new fonts; semantic text styles rather than arbitrary sizes; minimum ~11pt text. Known-canon from HIG Dark Mode + UIKit docs: semantic/dynamic colors that resolve per appearance; **base vs elevated** background levels in dark mode (elevated surfaces get *lighter* backgrounds); explicit guidance against reusing light-mode colors or merely inverting; test in both appearances and in low/high ambient light; materials/vibrancy used sparingly and only where legibility is preserved.
- **Verdict: STEAL the mechanics:** (1) a closed, *named* type ramp (counted in tokens, e.g. `display / title / heading / body / label / caption / data-lg / data / data-sm` — note the data/mono lane Apple doesn't need but SOUP does); (2) semantic color resolution per appearance; (3) "elevated = lighter in dark, shadowed in light" as the elevation law; (4) both-appearance test discipline as an enforcement gate. **REJECT** vibrancy/translucent materials for SOUP (see anti-patterns; contrast risk on dense data).
- **Risk:** none for mechanics; honesty note — dark-mode specifics here rest on long-established HIG/UIKit documentation, not a fresh fetch (page failed to render to the fetcher on 2026-06-11).
- **SOUP decisions affected:** typography, tokens, dark/light strategy, surface/elevation, enforcement.
- **Evidence:** https://developer.apple.com/design/human-interface-guidelines/typography (fetched, summary-level); https://developer.apple.com/design/human-interface-guidelines/dark-mode (known-canon; fetch failed).
- **Directions:** all three — this *is* the "Apple-level consistency" requirement, operationalized.

---

## (d) Token layering as architecture — Carbon, Primer (+ shadcn convention)

### Carbon: theme = remap of one role vocabulary

- **Observed:** four themes (White, Gray 10, Gray 90, Gray 100) give different values to one token vocabulary; layering model: `background` then `layer-01/-02/-03` stacking in fixed order, with matching per-layer token *sets* (field, border) so a component on layer-01 uses the -01 set; "contextual tokens" auto-resolve to the correct layer; role names like `text-primary`, `border-subtle`, `support-error`.
- **Verdict: STEAL the three-part architecture:** primitives (raw scales, never referenced by components) → semantic roles (theme-remapped: `surface-base/raised/overlay`, `text-primary/secondary/ghost`, `border-subtle/strong`, `status-ok/warn/crit`, `mode-passive/chat/agent`) → component tokens (only where a component must deviate). **ADAPT** the layer-sets idea: SOUP needs at most `surface-base → surface-raised → surface-overlay` plus an inset level for wells/inputs; Carbon's full -01/-02/-03 sets are over-spec for a 4-page console.
- **Risk:** token sprawl. Carbon ships hundreds of tokens with a team to match. Budget SOUP's semantic layer (target: order of 60–90 semantic tokens) and let ESLint forbid raw hex/primitive references in components.
- **SOUP decisions affected:** tokens (the core architecture decision), surface/elevation, enforcement.
- **Evidence:** https://carbondesignsystem.com/elements/color/usage/ ; https://v10.carbondesignsystem.com/guidelines/themes/overview/ (search-verified 2026-06-11; site pages too heavy to fetch directly).
- **Directions:** all three.

### Primer: role-first naming grammar

- **Observed:** functional CSS variables atop base scales: `--fgColor-*`, `--bgColor-*`, `--borderColor-*`, `--shadow-*`, with `-muted`/`-emphasis` intensity modifiers and `-rest/-hover/-active/-disabled` state variants; docs render only the active theme, multi-theme via remap.
- **Verdict: STEAL the grammar** `{property}{Role}-{intensity}-{state}` — it makes lint rules and code review trivially mechanical ("a border may only consume a borderColor token").
- **Risk:** minimal; grammar choice only.
- **SOUP decisions affected:** tokens, enforcement.
- **Evidence:** https://primer.style/foundations/color (fetched 2026-06-11).
- **Directions:** all three.

### shadcn/ui: background/foreground pairing (convention, not skin)

- **Observed:** every surface token pairs with a `-foreground` token ("the base token controls the surface… the -foreground token controls the text and icon color that sits on that surface"); dark mode = same tokens overridden under `.dark`.
- **Verdict: ADAPT the pairing idea** for SOUP's status/mode chips: `status-warn-surface` + `status-warn-foreground` guarantees readable badges in both themes by construction (combines with the Radix contract in §a). **REJECT** shadcn's default visual styling (AI-default look; see anti-patterns).
- **SOUP decisions affected:** tokens, status color, theme approach.
- **Evidence:** https://ui.shadcn.com/docs/theming (fetched 2026-06-11).
- **Directions:** all three.

---

## (e) Status-first color discipline in ops tools

- **Observed across the corpus:** v2 doctrine (color=meaning, three opacity tiers); Braun/instrument-panel annunciator logic (dark = nominal; illumination = exception; position-stable indicators) — stimulus level; Geist/Radix ship full red/amber/green scales rather than single hexes, so status color exists at wash/border/solid/text strengths; Linear keeps chrome monochrome so the rare status color lands hard.
- **Verdict: STEAL/FORMALIZE.** v3 status discipline: (1) each status (ok/warn/crit) and mode (passive/chat/agent) becomes a mini-scale (wash / border / solid / foreground) per theme — replacing v2's ad-hoc opacity math; (2) chrome stays monochrome: the only chromatic pixels on a healthy screen are mode identity accents and ok-dots; (3) annunciator law: a status color may appear only in position-stable slots (dot column, KPI value, left row-edge, badge) — never as decorative tint; (4) **ok-green is mostly absence**: healthy rows don't shout, matching calm-by-default.
- **Risk:** six chromatic channels (3 mode + 3 status) is a lot to keep distinguishable in light mode at AA — light-mode mode-colors will need darker, more saturated variants (teal/cyan especially collide when lightened); this is a named T4/T5 verification item, including a color-vision-deficiency check (teal/cyan vs ok-green proximity).
- **SOUP decisions affected:** status color (primary), tokens, tables, dark/light strategy.
- **Evidence:** local v2 docs; https://vercel.com/geist/colors ; https://www.radix-ui.com/colors ; https://www.vitsoe.com/us/about/good-design (canon) — 2026-06-11.
- **Directions:** all three; the annunciator framing is the heart of **A-Instrument**.

---

## (f) WCAG AA contrast strategy for both modes

- **Observed (fetched):** SC 1.4.3 requires 4.5:1 for normal text, 3:1 for large text (≥18pt / ≥14pt bold ≈ 24px / ~18.5px bold); exceptions for incidental/disabled text and logotypes; SC 1.4.11 extends 3:1 to non-text UI components and graphical objects (focus rings, control boundaries, chart strokes, status dots that are sole indicators).
- **Verdict: ADOPT as hard gates, implemented structurally:** (1) build palettes Radix-style so designated text-on-surface pairs pass AA *by construction* in both themes; (2) v2's 5-level text ladder must be re-derived per theme — its `t4`/`t5` "ghost" levels will not pass 4.5:1 and must be formally classified: either ≥4.5:1, or restricted to *incidental/decorative* roles (placeholder structure, watermark labels) with a lint-enforced "never sole carrier of information" rule; (3) status conveyed by color must always be paired with a second channel (icon shape, text, position) — dots alone fail both 1.4.11 edge cases and CVD users; (4) focus rings ≥3:1 against adjacent colors in both themes; (5) disabled-state styling may drop contrast (exempt) but must be visually unmistakable as disabled.
- **Risk:** the biggest AA risk is **light mode**: thin hairlines and 6–12% washes that read on near-black vanish on white. Light theme needs its own border/wash values (≈8–14% black-alpha vs dark's white-alpha) — another concrete instance of light-is-not-inversion.
- **SOUP decisions affected:** tokens, dark/light strategy, typography (minimum data-text size), status color, enforcement (contrast checks in CI against token pairs).
- **Evidence:** https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html (fetched 2026-06-11).
- **Directions:** all three (non-negotiable layer).

---

## (g) Restrained motion in pro tools

- **Observed:** Linear refresh treats *removing* visual motion/noise as the feature; Kowalski doctrine (search-verified secondary): animation must serve purpose and not announce itself, productivity-tool transitions ≈100–300ms, keyboard-initiated actions should not animate; NN/g duration band ~100–500ms with faster for frequent actions; v2 already bans animation on mode switch/tab/table sort and reserves motion for liveness (dot breathing), arrival (feed prepend), and affordance (hover lift).
- **Verdict: STEAL + FORMALIZE into motion tokens:** duration ramp (e.g., `instant: 0 / fast: ~120ms / base: ~180ms / slow: ~280ms` — exact values fixed in T6), one or two easing tokens (standard ease-out family; v2's `cubic-bezier(0.22,1,0.36,1)` is a candidate `--ease-out-soft`), and a rule table: *state changes the operator caused = instant; spatial changes (drawer, modal, pane) = fast/base; ambient liveness = slow, subtle, loopable*. Every animated property must have a `prefers-reduced-motion` fallback (Framer Motion `MotionConfig reducedMotion="user"` plus CSS media query for non-FM animation). Keyboard-driven actions never animate.
- **Risk:** framer-motion is already in the stack (T1) — the temptation is to use it because it's there. The motion-token table is the budget; anything not in the table is lint-flagged.
- **SOUP decisions affected:** motion (primary), enforcement, modals/drawers.
- **Evidence:** https://linear.app/now/behind-the-latest-design-refresh (fetched); https://www.nngroup.com/articles/animation-duration/ , Kowalski summaries (search-verified); https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion (known-canon) — 2026-06-11.
- **Directions:** all three; **A-Instrument** is the most static (instrument panels don't tween), **B-Editorial** allows the softest spatial transitions.

---

## Supplementary findings

### Typography candidates (decision input for T4)

| Pairing | Verdict | Rationale | Evidence |
|---|---|---|---|
| **Geist + Geist Mono** | Shortlist #1 | OFL, Google Fonts + npm; mono-first family designed for developer UIs; Swiss-leaning industrial-refined tone; true sans/mono pair from one designer. Risk: "looks like Vercel" — mitigated by SOUP's color identity and denser layouts. | https://vercel.com/font (fetched) |
| **IBM Plex Sans + IBM Plex Mono** (keep mono, unify sans) | Shortlist #2 | Lowest churn: Plex Mono already carries all data UI; Plex Sans completes an engineered superfamily with real industrial heritage (Carbon's face). Slightly drier/more bureaucratic tone than Geist. | https://www.ibm.com/plex/ (known-canon) |
| **Inter (+ Plex/JetBrains Mono)** | Shortlist #3 | Maximum neutrality + best tabular/stylistic-set machinery (Raycast's ss03 trick); least distinctive — needs stylistic sets and tight tracking discipline to avoid "default app" look. | https://rsms.me/inter/ (known-canon); Raycast teardown (search-verified) |
| Hanken Grotesk / Mona Sans | B-Editorial alternates | Free Söhne-adjacent warmth (Hanken); GitHub's industrial-era variable grotesque (Mona). | search-verified 2026-06-11 |
| **Outfit (incumbent)** | Replace (pending T4 proof) | Geometric/display-friendly but weak for dense data chrome: rounded geometry reads "consumer startup", and the serious-industrial brief plus tabular-figure needs point elsewhere. Keep as control variant in T4 mockups for an honest comparison. | local v2 + known-canon |
| Space Grotesk | Wordmark-only candidate | Too mannered for body UI; plausible for the SOUP wordmark if A-Instrument wins. | search-verified |
| Söhne / Suisse / Berkeley Mono | Rejected | Commercial licenses; named only as the benchmark our free shortlist approximates. | known-canon |

**Affects:** typography, brand. **Directions:** Geist pair fits A+B; Plex superfamily fits A+C; Inter fits B.

### Iconography

Retain **Lucide** (geometric, strict 24px grid, math-adjustable stroke, tiny bundles, 1,500+ icons, already shipped as lucide-react 1.7.0 with v2 usage doctrine). **Phosphor** (9,000 icons, six hand-drawn weights) rejected for adoption: weight variety multiplies the enforcement surface and its organic forms soften the industrial tone; permitted only as a redrawn-to-grid gap quarry. **Heroicons** rejected: smaller vocabulary, no gain. v3 formalizes: stroke tokenized (single value, v2's 1.75 as default candidate), sizes 16/20/24 only, lint against any non-Lucide icon import. **Evidence:** https://lucide.dev , https://phosphoricons.com , comparison writeups (search-verified 2026-06-11). **Affects:** iconography, enforcement.

### Galleries and hardware stimulus — honesty note

Mobbin, Page Flows, Dribbble, Godly, Siteinspire, Minimal Gallery, and teenage.engineering are image-first surfaces that this research pass could not meaningfully read; no specific observations are claimed from them (see library §1/§2/§6). Their role is bounded: operator-driven mood pulls during T4, stimulus-only authority. The *usable* industrial input is doctrinal and known-canon: Rams ("as little design as possible, thorough to the last detail"), Braun's reserve-color-for-the-control-that-matters, and annunciator-panel logic — all already absorbed into §e.

---

## SOUP Design Direction Signals

Opinionated conclusions from the corpus. These are T3 inputs to the T4 mockups, not locked decisions; G1/G2 lock them.

1. **Density.** Operator-dense by default, with exactly **two designed densities**: `default` and `compressed` (EUI precedent), as component variants driven by the size ramp — never per-screen font-size fiddling. Density is earned through hierarchy (mono data lanes, ghost structure labels, aligned columns), not through cramming. Soup Kitchen and Ops lean compressed; setup wizard and forms stay default.

2. **Surface / elevation model.** A named ladder of **four surfaces per theme**: `surface-base`, `surface-raised` (cards/panels), `surface-overlay` (popovers/modals), `surface-inset` (wells, inputs, code/log beds). Law (Apple/Carbon/Raycast): **dark elevates by getting lighter, light elevates by shadow + hairline at near-constant luminance**. Hairline borders are theme-specific alpha values, never shared hex. No blur-based materials.

3. **Typography.** One sans + one mono, closed named ramp (~8–9 styles incl. a dedicated mono `data` lane with tabular figures), hierarchy by size/weight only (Apple mechanics). Recommendation order: **Geist+Geist Mono**, then **Plex Sans+Plex Mono**, then **Inter+(mono)** — settled by T4 side-by-side against real console data, with Outfit kept as the control. Minimum data text ≥ ~12px equivalent; AA at every ramp step in both themes.

4. **Color & status discipline.** Chrome is monochrome. Six semantic chromatic channels only: modes passive/chat/agent (load-bearing, preserved) + status ok/warn/crit. Each becomes a 4-strength mini-scale (wash/border/solid/foreground) × 2 themes, with surface/foreground pairing (shadcn convention) and contrast-by-construction (Radix method). Healthy = quiet; annunciator law governs where status pixels may appear. Light-mode mode-color variants are a named risk requiring CVD + AA verification.

5. **Navigation.** Keep the shallow IA (4 pages + line-detail tabs). Chrome sits 1–2 contrast notches below content (Linear). Tab switches are instant. Consistency rule (DRUIDS): one filter pattern, one time-range control, one search pattern everywhere. A command palette (Linear/Raycast lineage) is a natural v3+ candidate but **out of scope** for the reskin program — note for backlog only.

6. **Modal / drawer strategy.** Modals only for interrupting decisions (destructive confirm, auth/QR flows); side **drawer/inspector** for object detail and edit-in-context (line quick-view, access-control entries) — preserves fleet context behind it, matching progressive disclosure; inline expand remains first choice inside tables/feeds. All overlays sit on `surface-overlay` with one scrim token; spatial motion at `fast/base` duration, reduced-motion safe (Radix Dialog anatomy as the a11y checklist: focus trap, escape, restore-focus).

7. **Table / data-grid strategy.** One table component (DRUIDS singularity rule): sticky ghost-label headers, mono for numeric/id/timestamp columns, status as dot or left-edge only, hover = wash not border, single-line rows with inline expand, virtualization for logs/history, compressed toolbar variant. No alternate table implementations anywhere in the console — lint-enforced.

8. **Form-control strategy.** Radix/React-Aria anatomy (states, ARIA, focus) with SOUP skin; two sizes (default/compressed); inset surface for fields; visible ≥3:1 focus ring token in both themes; labels above with optional ghost hint; destructive actions always confirm via modal. GOV.UK error-pattern discipline (explicit, textual, never color-only) for wizard validation.

9. **Theme approach — light is not inversion.** One semantic token vocabulary (Carbon), two hand-designed value sets (Grafana's parallel kits, Apple doctrine). Concretely re-derived per theme: elevation direction (lighter-when-raised vs shadow-when-raised), border alphas (white-alpha vs black-alpha at different strengths), status/mode chroma+lightness (darker, more saturated chromatics on white), wash percentages (6–12% dark ≈ 8–14% light, tuned), text ladder values, and shadow tokens (near-none in dark, real in light). Theme switch = token-set swap (`.dark`-style scope or `data-theme`), zero component code branches. Both themes ship at G2 quality simultaneously — light is not a follow-up.

10. **Motion personality.** "Mechanical calm": operator-caused state changes are instant; spatial changes are brief ease-out tweens (~120–280ms ramp); the only ambient motion is liveness (dot breathing, feed arrival). Keyboard actions never animate. Full `prefers-reduced-motion` coverage. Motion tokens are the budget; unbudgeted animation is a lint finding.

11. **Brand voice for the SOUP wordmark.** Per the locked naming decision (professional, calm, precise, slightly playful-ambiguous): treat SOUP as an instrument nameplate — wordmark set in the system's own sans or mono (small-caps/spaced-caps treatment candidate), monochrome with at most a single mode-accent tick; no soup-bowl illustration, no mascot, no gradient mark. The kitchen metaphor may survive in *naming* (Soup Kitchen page) but not in *imagery*. Mock at least one mono-wordmark and one sans-wordmark in T4.

12. **Enforcement implications.** The corpus says systems hold through tooling, not taste: (i) components may reference only semantic tokens — raw hex/primitive references are lint errors (extend the existing 106-rule ESLint design config); (ii) token-pair contrast checks runnable in CI for both themes; (iii) one-component rules (table, modal, drawer, field) via import restrictions; (iv) icon-set and motion-budget lint; (v) both-theme screenshot review as a PR norm (Apple both-appearances discipline). T7 owns the plan; T3's point is that every signal above was chosen to be *mechanically checkable*.

13. **Competitive positioning.** SOUP sits at the empty intersection the corpus reveals: Linear/Geist polish applied to Grafana-class operational density for a **single-operator AI-agent fleet** — a category none of the references serve (v2's gap analysis already showed no product combines per-line runtime semantics, agent-session telemetry, and connection lifecycle). The visual claim: *instrument-grade calm* — denser than Linear, far more finished than Grafana, quieter than Datadog, with mode-semantic color no competitor has. That distinctive mode trio (teal/cyan/violet) is SOUP's brand asset; v3's job is to give it a contrast-proof, dual-theme, token-enforced chassis.

---

*T3 deliverable. Inputs to: T4 (direction mockups A/B/C), T6 (spec), T7 (enforcement/cutover). Verification statuses per claim are in `reference-library.md`; anything marked search-verified or known-canon should be re-confirmed before being cited as normative in T6.*
