# SOUP Design System v3 — Reference Library (T3)

Research date: **2026-06-11**. Part of the SOUP design program (`docs/design-system/README.md`).

## How to read this library

Every reference carries an **authority level** that bounds what it is allowed to influence:

| Level | Meaning |
|---|---|
| **adopt-pattern** | A concrete mechanic we intend to adopt (possibly adapted). Can be cited in the T6 spec as precedent. |
| **study** | Product-truth source for system mechanics. Informs decisions; nothing is copied wholesale. |
| **stimulus-only** | Aesthetic/mood input only. Carries **zero** decision authority — may not be cited to justify a token, component, or interaction. |
| **rejected** | Anti-pattern. Cited only to explain what SOUP must NOT do. |

**Verification status** is recorded honestly: `fetched` (read on 2026-06-11 via web fetch), `search-verified` (claims drawn from search results / secondary writeups), `known-canon` (widely documented, not re-fetched today — treat specific numbers as unconfirmed), `not-browsed` (image-heavy gallery we could not meaningfully read; listed for the operator's manual use only).

**v2 precedent:** `docs/console-mockups/reference-analysis.html` (Wati, Respond.io, Chatwoot, Uptime Kuma) and `docs/console-mockups/design-principles.html` remain valid for *product-flow* analogy and the semantic-color/spacing doctrine. This library supersedes v2's reference set for *visual system* questions; v2's product-flow steals (3-pane inbox, heartbeat strips, line picker, live KPI cards) carry forward unchanged. See the digest §0.

---

## 1. Real Product Flows

Sources that show how shipped products actually behave (screens, flows). Useful for sanity-checking IA, not for visual style.

| Reference | URL | Description | Authority | Verified |
|---|---|---|---|---|
| Mobbin | https://mobbin.com | Large library of real shipped app screens/flows, searchable by pattern (settings, onboarding, tables). Useful to check how real ops/SaaS products handle a flow before inventing one. | stimulus-only | not-browsed (image-heavy; subscription-gated browsing) |
| Page Flows | https://pageflows.com | Video recordings of real product flows (onboarding, upgrade, settings). Same role as Mobbin. | stimulus-only | not-browsed |
| v2 reference analysis (Wati / Respond.io / Chatwoot / Uptime Kuma) | `docs/console-mockups/reference-analysis.html` | v2's product-flow steals: line picker + per-line filtering (Wati); 3-panel inbox, hover quick-actions, live count widgets (Respond.io); live KPI cards, heatmap, tab filtering (Chatwoot); heartbeat strips, collapsible groups, click-to-detail (Uptime Kuma). | **adopt-pattern** (flows only, not visuals) | fetched (local) |

## 2. Visual Inspiration Galleries

Image-first galleries. Explicitly **stimulus-only**: we could not meaningfully browse these in this research pass and will not fabricate observations from them. They exist in this library so the operator can pull mood references during T4 iteration if desired.

| Reference | URL | Description | Authority | Verified |
|---|---|---|---|---|
| Godly | https://godly.website | Curated "astronomically good" web design; skews dark, dev-tool, marketing-site aesthetics. | stimulus-only | not-browsed |
| Siteinspire | https://www.siteinspire.com | Long-running curated gallery, filterable by style (e.g., minimal, monochrome). | stimulus-only | not-browsed |
| Minimal Gallery | https://minimal.gallery | Minimalist-only curation; closest gallery to the "heavy design, minimalist presentation" brief. | stimulus-only | not-browsed |
| Dark Design | https://www.dark.design | Dark-theme-only website gallery (hosts a Raycast entry). | stimulus-only | search-verified (existence only) |
| Dribbble | https://dribbble.com | Concept-shot gallery. Dominated by unbuildable fantasy dashboards. | **rejected** as a direction source (see §10) | not-browsed |

## 3. Mature Design Systems

Product-truth sources for **system mechanics**: token architecture, theming, type ramps, governance. Study level — SOUP borrows mechanics, never skins.

| Reference | URL | Description | Authority | Verified |
|---|---|---|---|---|
| Vercel Geist | https://vercel.com/geist/introduction , https://vercel.com/geist/colors | "Design system for building consistent web experiences" aimed at developers; high-contrast accessible color system; 10 color scales with role-banded steps (backgrounds → component states → borders → high-contrast → text); system/light/dark themes. The closest published system to SOUP's target tone. | **adopt-pattern** (scale banding, dual-theme discipline) | fetched |
| IBM Carbon | https://carbondesignsystem.com/elements/color/usage/ , https://v10.carbondesignsystem.com/guidelines/themes/overview/ | Four themes (White, Gray 10, Gray 90, Gray 100) remapping one role-token vocabulary; explicit layering model (`background`, `layer-01..03` sets); contextual tokens that resolve per-layer. The strongest published precedent for primitive→semantic→component token layering. | **adopt-pattern** (token layering + theme-as-token-remap) | fetched + search-verified |
| GitHub Primer | https://primer.style/foundations/color | Two-layer color system: foundational scales beneath functional CSS variables named by role (`--fgColor-*`, `--bgColor-*`, `--borderColor-*`, `--shadow-*`) with `-muted`/`-emphasis` modifiers and state variants; multi-theme via variable remap. | **adopt-pattern** (role-first naming grammar) | fetched |
| Apple HIG | https://developer.apple.com/design/human-interface-guidelines/typography , https://developer.apple.com/design/human-interface-guidelines/dark-mode | Consistency mechanics: one typeface, hierarchy by size/weight via a fixed named text-style ramp; semantic/dynamic colors; dark mode with base vs elevated background levels and explicit "don't merely invert" guidance. | **study** (consistency doctrine) | typography fetched (summary-level); dark-mode page fetch failed — claims marked known-canon in digest |
| Shopify Polaris | https://polaris.shopify.com | Merchant-admin design system; strong density/table/form patterns for admin surfaces; token-based theming. | study | known-canon (not fetched) |
| Atlassian Design System | https://atlassian.design | Token architecture with semantic color tokens and explicit light/dark theme files; good precedent for migration tooling from raw values to tokens. | study | known-canon |
| Microsoft Fluent 2 | https://fluent2.microsoft.design | Cross-platform system; ramp-based neutrals, elevation via shadow+layer in light and luminance in dark. | study | known-canon |
| Material Design 3 | https://m3.material.io | Tonal-palette → role-token mapping (primary/on-primary, surface-container levels). Useful as a *contrast* reference: its expressive/branded look is what SOUP should not feel like, but its surface-container level system is solid mechanics. | study (mechanics) / stimulus-rejected (aesthetic) | known-canon |
| Adobe Spectrum | https://spectrum.adobe.com | Pro-tool design system (Creative Cloud); dark-first pro-app surfaces, large data tables, platform-scale theming. | study | known-canon |
| GOV.UK Design System | https://design-system.service.gov.uk | Accessibility-first, evidence-backed components; the benchmark for "every pattern justified by user need", WCAG-rigorous forms and error patterns. | study (a11y + form discipline) | known-canon |
| Elastic UI (EUI) | https://eui.elastic.co , https://github.com/elastic/eui | Kibana's design system: first-class light/dark via `EuiProvider` `colorMode`; **compressed** density variants for forms/controls built for dense analyst UIs. Closest published "density mode" precedent. | **adopt-pattern** (compressed density variants) | search-verified |
| Salesforce Lightning (SLDS) | https://www.lightningdesignsystem.com | Originator of large-scale design-token practice in enterprise UI; data-dense record pages. | study | known-canon |

## 4. Component Primitive Libraries

Anatomy and accessibility study **only**. These define what parts/states/ARIA a component must have. They carry **no visual adoption authority** — SOUP's look is decided by SOUP tokens, not by a library default theme.

| Reference | URL | Description | Authority | Verified |
|---|---|---|---|---|
| Radix Primitives | https://www.radix-ui.com/primitives | Unstyled, WAI-ARIA-faithful component anatomy (Dialog, Popover, Tabs, DropdownMenu). The anatomy checklist for SOUP component specs. | study (anatomy/a11y only) | known-canon |
| Radix Colors | https://www.radix-ui.com/colors | 12-step functional scales: 1–2 app backgrounds, 3–5 component states, 6–8 borders, 9–10 solid fills, 11–12 text; paired dark scales ("dark mode just works"); APCA-informed contrast guarantees per step. | **adopt-pattern** (step semantics as scale-design method) | fetched |
| React Aria (Adobe) | https://react-spectrum.adobe.com/react-aria/ | Behavior/a11y hooks and components; the most rigorous published treatment of focus management, keyboard interaction, and ARIA in React. | study (interaction/a11y truth) | known-canon |
| shadcn/ui | https://ui.shadcn.com/docs/theming | Copy-in components over Radix; notable for its theming convention: semantic CSS-variable **background/foreground pairs** (`card`/`card-foreground`, `muted`, `accent`, `destructive`, `border`, `ring`) with dark mode as a `.dark`-scope token override. | study (token-pair convention); its default look is **rejected** as "AI-default" styling | fetched |
| Ariakit | https://ariakit.org | Unstyled accessible components; alternative anatomy cross-check to Radix. | study | known-canon |
| Headless UI | https://headlessui.com | Tailwind Labs' unstyled components; smaller surface, same role. | study | known-canon |
| Ark UI | https://ark-ui.com | State-machine-driven (Zag.js) headless components; useful for complex widget state modeling (e.g., combobox). | study | known-canon |
| Base UI | https://base-ui.com | Successor effort from Radix/MUI/Floating-UI people; unstyled primitives. Watch-level. | study | known-canon |

## 5. Operator / Observability Consoles

Closest product analogues: serious tools operating fleets, infra, and telemetry. These are the **center of gravity** for SOUP.

| Reference | URL | Description | Authority | Verified |
|---|---|---|---|---|
| Linear | https://linear.app , https://linear.app/now/behind-the-latest-design-refresh | The benchmark for calm, dense, keyboard-first product polish. 2025 refresh writeup documents: dimming navigation chrome, softening separators ("structure should be felt not seen"), warmer gray palette, density preserved while reducing noise, motion restraint. | **adopt-pattern** (calm-chrome doctrine, theme craft) | fetched |
| Vercel Dashboard | https://vercel.com/dashboard | Geist applied to a real ops surface: deploy tables, log views, env-var forms, first-class dual theme. | study | known-canon (product UI not directly browsable; mechanics covered via Geist docs, fetched) |
| Grafana / Saga | https://grafana.com/developers/saga/ , https://github.com/grafana/design-system | Open-source observability design system; maintained dark AND light Figma component libraries; design-token restructuring effort (grafana/grafana issues #78865, #78866) moving to a foundations-based token hierarchy. The product is the reference for time-series panels + dense ops dashboards. | **study** (panel/dashboard + token migration precedent) | search-verified; site itself JS-gated (Inconclusive on page-level details) |
| Datadog / DRUIDS | https://druids.datadoghq.com , https://www.datadoghq.com/blog/engineering/druids-the-design-system-that-powers-datadog/ | Internal design system ("easy to understand, implement, contribute"); consistency-at-scale doctrine — same filtering/time-range/graph interactions everywhere; DRUIDS Loupe (inspect any UI element → its component). Blog gives governance truth, **not** density/token specifics. | study (consistency governance) | fetched (blog); product UI not browsable |
| Raycast | https://www.raycast.com , https://manual.raycast.com/themes | Dark-first launcher with extreme finish. Third-party teardown (getdesign.md) documents: near-black surface ladder (#07080a → #0d0d0d → #101111), hairline 1px borders (#242728), 6–10px radii, Inter with ss03, slightly positive letter-spacing, single saturated accent against monochrome. | study (dark-surface craft) | search-verified (secondary teardown — treat hex specifics as approximate) |
| Warp | https://www.warp.dev | GPU terminal; blocks-based output, command-palette UX, mono-typography-led UI. | stimulus-only (no published system docs found) | not-browsed |
| Tailscale Admin Console | https://login.tailscale.com/admin | Quiet, text-first device/ACL admin: dense machine tables, restrained color, exemplary plain-language microcopy. | study (table + microcopy tone) | not-browsed (auth-gated); Inconclusive on specifics — listed from operator familiarity |
| Teleport | https://goteleport.com | Infra-access console; session/audit-log UI for security operators. | stimulus-only | not-browsed |
| Retool | https://retool.com | Internal-tool builder; its component density defaults are a useful *median* for ops UIs — and a warning: density without typographic care reads as clutter. | stimulus-only | not-browsed |
| Uptime Kuma | https://github.com/louislam/uptime-kuma | (Carried from v2.) Heartbeat strips, grouped monitors, ops-dark aesthetic. Flow-level steal already absorbed in v2. | adopt-pattern (heartbeat flow, via v2) | fetched (v2 local analysis) |

## 6. Industrial / Hardware Inspiration

Mood and discipline only. Nothing here maps 1:1 to a web console; everything here informs *restraint*.

| Reference | URL | Description | Authority | Verified |
|---|---|---|---|---|
| Dieter Rams — 10 Principles | https://www.vitsoe.com/us/about/good-design | "Good design is as little design as possible"; honest, unobtrusive, thorough down to the last detail. The philosophical anchor for "heavy design, minimalist presentation". | **study** (doctrine) | known-canon |
| Braun product archive | https://www.braun-audio.com / design-history writeups | Functional color discipline: near-monochrome chassis, color reserved for controls that matter (the one orange/green switch). Direct ancestor of SOUP's "status colors only where they mean something". | stimulus-only | known-canon |
| Teenage Engineering | https://teenage.engineering | Instrument-panel aesthetic: strict grids, mono labels, functional color coding, playful-but-precise. The visual seed of direction **A-Instrument** — to be borrowed at the *discipline* level (labeled controls, grid rigor), never as kitsch skeuomorphism. | stimulus-only | not-browsed (image-heavy) |
| Aviation/audio instrument panels (general) | — | Annunciator-light logic: dark = nominal, illumination = exception; consistent placement so operators scan by position, not by reading. Matches v2's "calm by default, alarm by exception". | stimulus-only | known-canon |

## 7. Typography / Identity

Current: **Outfit** (sans) + **IBM Plex Mono**. Candidates below are open-license and Google-Fonts-or-npm installable (constraint: no commercial font licensing).

| Candidate | URL | Rationale | Authority | Verified |
|---|---|---|---|---|
| Geist + Geist Mono | https://vercel.com/font | OFL-licensed; on Google Fonts and npm; Thin→Ultra Black weights; "simplicity, minimalism, speed", Swiss-influenced; mono designed first, sans matched to it — a true pair. Strongest single-family candidate for an industrial-refined console; risk: reads "Vercel". | **adopt-pattern** (shortlist #1) | fetched |
| Inter / Inter Display | https://rsms.me/inter/ | The neutral UI workhorse: huge glyph set, tabular figures, optical sizes, `ss`-sets (Raycast uses Inter+ss03 to get its signature look). Safest body choice; least distinctive without stylistic-set tuning. | study (shortlist #2) | known-canon |
| IBM Plex Sans + IBM Plex Mono | https://www.ibm.com/plex/ | Keeping Plex Mono (current) and unifying chrome onto Plex Sans gives a single engineered superfamily with genuine industrial heritage (Carbon's typeface). OFL. | study (shortlist #3 — lowest-churn option) | known-canon |
| Hanken Grotesk | https://fonts.google.com/specimen/Hanken+Grotesk | Search-verified as the strongest free Söhne-adjacent grotesk body workhorse; warmer than Inter. Candidate if direction B-Editorial wins. | study | search-verified |
| Mona Sans | https://github.com/github/mona-sans | GitHub's OFL variable grotesque, explicitly "industrial-era" inspired; wide weight/width axes; pairs with Primer thinking. | study | search-verified |
| Space Grotesk | https://fonts.google.com/specimen/Space+Grotesk | Proportional derivative of Space Mono; techy display character. Display/wordmark candidate only — too mannered for dense body UI. | stimulus-only (display use at most) | search-verified |
| JetBrains Mono | https://www.jetbrains.com/lp/mono/ | OFL mono tuned for code reading (tall x-height, distinct l/1/I). Mono alternative if Plex Mono is replaced. | study | known-canon |
| Commit Mono | https://commitmono.com | OFL "neutral" programming mono with smart kerning; quieter than JetBrains Mono. | study | known-canon |
| Outfit (incumbent) | https://fonts.google.com/specimen/Outfit | Current sans. Geometric, rounded, display-leaning — sits closer to "friendly startup" than "industrial instrument"; weak tabular-figure/data credentials vs Inter/Geist/Plex. Candidate for *replacement*, pending T4 mockup proof. | study (incumbent under review) | known-canon |
| Söhne, Suisse Int'l, Berkeley Mono (commercial) | klim.co.nz / swisstypefaces.com / usgraphics.com | Named for orientation only — the commercial "industrial-refined" benchmarks our free shortlist approximates. **Not candidates** (licensing). | rejected (license) | known-canon |

## 8. Motion / Interaction

| Reference | URL | Description | Authority | Verified |
|---|---|---|---|---|
| Linear design refresh | https://linear.app/now/behind-the-latest-design-refresh | Motion subordinated to calm: reduce chrome, don't animate structure. | **adopt-pattern** | fetched |
| Emil Kowalski — animation principles | https://emilkowal.ski (essays); secondary summaries | Restraint doctrine for productivity tools: animations serve purpose and "don't announce themselves"; UI transitions ≲200–300ms; keyboard-initiated actions should not animate. Source of Sonner/Vaul motion craft. | **adopt-pattern** (doctrine) | search-verified (secondary; exact thresholds treated as guidance, not gospel) |
| Framer Motion (motion.dev) | https://motion.dev | Already in the stack (framer-motion 12.x, verified T1). Study for: `MotionConfig reducedMotion`, layout animations, exit transitions. Authority is *implementation*, not personality. | study | known-canon |
| MDN `prefers-reduced-motion` | https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion | OS-level reduced-motion media query; the enforcement hook for motion discipline (every SOUP animation must have a reduced-motion path). | **adopt-pattern** | known-canon |
| NN/g animation duration | https://www.nngroup.com/articles/animation-duration/ | Research-backed duration bounds (~100–500ms band; faster for frequent actions). | study | search-verified |
| v2 motion doctrine | `docs/console-mockups/design-principles.html` §5 | "Motion with purpose": status-dot breathing, staggered load, hover lift; **no** animation on mode switch/tab/table-sort. Carries forward; needs added reduced-motion + duration-token formalization. | adopt-pattern (carry-forward) | fetched (local) |

## 9. Iconography

| Reference | URL | Description | Authority | Verified |
|---|---|---|---|---|
| Lucide (incumbent) | https://lucide.dev | Current set (lucide-react 1.7.0, verified T1; v2 doctrine: 1.75px stroke, 16/20/24 sizes). Geometric, strict 24px grid, mathematically adjustable strokeWidth, ~1,500+ icons, tiny per-icon bundle. | **adopt-pattern** (retain) | search-verified + v2 local |
| Phosphor | https://phosphoricons.com | 9,000+ icons in six hand-drawn weights (thin→fill/duotone); more organic/"friendly" than Lucide. Weight variety is attractive but multiplies enforcement surface; rounder forms fight the industrial tone. | study (rejected for adoption, kept as gap-filler quarry — redrawn to Lucide grid if ever used) | search-verified |
| Heroicons | https://heroicons.com | Tailwind Labs set; outline/solid/mini/micro variants. Smaller vocabulary than Lucide; switching buys nothing. | study (rejected for adoption) | known-canon |
| v2 icon doctrine | `docs/console-mockups/design-principles.html` §4 | "Never mix icon sets; icons inherit contextual text color; fixed sizes per slot." Carries forward verbatim into T6. | adopt-pattern (carry-forward) | fetched (local) |

## 10. Rejected References / Anti-Patterns

Named so the T4 mockups and T6 spec can cite what SOUP must not become.

| Anti-pattern | Where seen | Why rejected for SOUP |
|---|---|---|
| Dribbble-concept dashboards | dribbble.com "dashboard" tag | Optimized for thumbnail drama, not operation: 3 KPIs in 40% of viewport, unlabeled donut charts, white-on-gradient text. SOUP is a working console; density and legibility outrank spectacle. |
| Glassmorphism-heavy UI | Concept shots; parts of consumer OS chrome | Translucent blur stacks destroy text contrast (WCAG AA both modes becomes unprovable), cost GPU on dense tables, and make elevation ambiguous. SOUP elevation must be a *token-defined* surface ladder, not blur. Limited, opaque "material" use is allowed only if it passes contrast in both themes. |
| AI-slop gradient aesthetic | Default LLM-generated UIs; shadcn-default purple-gradient hero look | Purple/indigo gradients, glowing borders, emoji-laden cards signal template, not brand. Worse for SOUP: **purple is load-bearing** (agent mode); decorative purple would collide with a semantic channel. Color must remain meaning-only (v2 doctrine). |
| Fake skeuomorphism / instrument kitsch | Synth-UI concepts, knob/LED web toys | Rendering fake hardware (knobs, brushed metal, LED bevels) adds noise without affordance and ages instantly. Direction A-Instrument borrows hardware *discipline* (grid, labels, annunciator logic) — never hardware *cosplay*. |
| Cyberpunk/HUD ops aesthetic | Game UIs, "SOC dashboard" concepts | Scanlines, neon glows, animated radar sweeps fatigue real operators and violate calm-by-default. Glow is permitted solely as the existing status-dot liveness cue, tokenized and reduced-motion-safe. |
| Inverted-light dark theme (and vice versa) | Naive `filter: invert()` / auto-darkened admin templates | Produces washed shadows, blown borders, wrong elevation. Both Apple HIG and Carbon model dark as its *own* design (elevated-darker vs elevated-lighter logic differs per mode). SOUP light mode must be designed, not derived — this is a locked user decision. |
| Density theater (Retool-default cram) | Internal-tool defaults | Density without typographic hierarchy (mono-for-data, ghost labels, aligned columns) is clutter, not information. v2's density doctrine stands: density is earned by hierarchy. |

---

*Prepared for T3. Companion synthesis: `research-digest.md` (same directory). Every entry above maps to at least one decision in the digest's "SOUP Design Direction Signals".*
