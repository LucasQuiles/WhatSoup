# Operator-Provided Design Synthesis (Seed Material)

> **Provenance & authority:** distilled from a comprehensive design-synthesis report supplied by the
> operator on 2026-06-11 and integrated into the program plan as **seed material only — explicitly
> non-authoritative and non-implementation**. Where it conflicts with the verified findings in
> `research-digest.md`, the digest wins; where it adds checks, those were folded into T6/T7 task
> criteria. Citation markers from the source report were stripped; claims below inherit the source
> report's verification, not this program's.

## Core thesis (consistent with our digest)

High-end product design signal is **not maximal spectacle**: it is semantic design systems, high
information clarity, keyboard-first workflows, careful motion, and *selective* moments of delight.
Best teams separate **operational UI from brand theater** — trustworthy efficient product shell,
richer craft only in deliberate layers (first-run, empty states, celebratory confirmations,
marketing). The biggest strategic mistake: overfitting to "Dribbble candy."

## Additions beyond our T3 corpus

### Studio/benchmark references (craft bar, stimulus/study)

| Entity | Signal | SOUP relevance |
|---|---|---|
| LoveFrom | Cross-disciplinary material sensitivity and restraint | Benchmark for seriousness/industrial polish |
| Instrument | Brand+product+marketing coherence | Governance of cross-touchpoint consistency |
| Work & Co | Product rigor at scale | Systems/rollout discipline |
| Clay | Enterprise/SaaS design-system reskinning | Directly relevant to cutover framing |
| BUCK | Motion-rich production craft (incl. Rive work) | Celebration-moment boundary examples |
| Fantasy, Metalab | Strategic product storytelling; interface-first craft | Vision/presentation surfaces |
| Awwwards SOTD (2026) | Expressive craft signal (motion/typography/3D/transitions) | **Marketing surfaces only** — never operational UI |

### Foundation sources added as validation set

Android/Material semantic color-role + grid guidance (roles describe *use not hue*; 8-unit layout
grid, 4-unit icon grid; Compact/Medium/Expanded size classes); MDN View Transition API
(motion = continuity/cognitive-load reduction), `requestAnimationFrame` (time-based, never
frame-count-based — 60/75/120/144Hz reality), `prefers-reduced-motion`, `font-variant-numeric`,
variable fonts; W3C WCAG 2.2 (contrast-minimum, target-size-minimum) + WAI-ARIA APG; IBM Plex;
Lucide + Heroicons icon discipline; Rive (ship-the-asset motion tooling — niche, brand moments).

### Motion duration bands (seed recommendation — reconcile with digest §(g) tokens)

| Category | Duration | Note |
|---|---|---|
| Hover/focus/press | 80–140ms | crisp; opacity/transform only |
| Tooltip/menu/popover | 140–220ms | fade + slight translate; never long fly-ins |
| Expand/collapse | 160–240ms | prefer mask/clip + opacity over height |
| Panel/drawer/modal | 180–280ms | one dominant axis, no layered secondaries |
| View-to-view | 220–400ms | continuity only — digest caps SOUP at ~300ms |
| Success micro-moment | 120–220ms | sparing; never every save |

Rule of thumb: **shorter for control feedback, longer for spatial change.**

### Tasteful-effects boundary table (seed)

Tonal layering first, shadow second; small tokenized elevation scale; translucency only on sparse
chrome (never content backgrounds); texture/grain only marketing/empty states; edge highlights
reserved for hero elements; bloom/blur/lens default-rejected (explicit justification required).
Apple "Liquid Glass" cycle cited as the cautionary case: borrow the restraint, not the controversy.

### Sizing matrix (seed values — verify against T2 density audit before adoption in T6)

| Element | Dense | Standard |
|---|---|---|
| Toolbar | 40px | 48px |
| Button/input height | 32px | 40px |
| List/menu item | 32px | 40px |
| Table row | 36px | 44px |
| Card/panel padding | 16px | 20–24px |
| Radii scale | 8/12/16 | (tight; no radius sprawl) |
| Icon slots | 16/20/24 | tied to component size tokens |

### Enforcement tripwires (adopted into T7 lint-plan scope)

Greppable anti-patterns: hardcoded hex colors; inline styles; untokenized
spacing/radii/z-index/blur/shadow; `transition: all`; `animation: ... infinite` in product UI;
focus suppression (`outline: none` / `focus:outline-none`); direct status color words instead of
semantic tokens; tables/metrics missing `tabular-nums`; duplicated panel/drawer/modal/toolbar
shells. Treated as **tripwires for review**, not perfect truth.

### Visual QA screenshot matrix (adopted into T7 cutover-plan scope)

Theme (light/dark) × width class (compact/medium/expanded) × density (dense/standard) ×
state (default/hover/focus/active/disabled) × async (loading/empty/success/warning/error) ×
navigation (base/panel/modal/command) × data (sparse/normal/stress) × accessibility
(keyboard-only focus path, reduced-motion equivalent).

### Prioritized rules (P0 subset, consistent with digest signals)

1. Semantic tokens are the only allowed language for color/elevation/border/radius/motion.
2. Primitive ownership split from component ownership (SSOT).
3. Accessibility states are first-class component states.
4. One calm core shell for operational UI; expressive layer separate (brand/theater).
5. One spacing rhythm + one size-family matrix locked before mockup proliferation.

## Reconciliation notes (digest vs seed)

- Seed's 220–400ms view-transition band exceeds the digest's ~300ms ceiling (Atlassian's 400ms also
  rejected there) — **digest ceiling stands**.
- Seed proposes IBM Plex Sans+Mono as a top pairing; digest shortlist is Geist > Plex > Inter —
  **T4 side-by-side settles it** (Plex is Direction C's natural voice; Geist is Direction B's).
- Seed's command-palette enthusiasm matches digest signal 5: noted as **v3+ backlog, out of scope**.
- Seed studio list (LoveFrom/Clay/BUCK et al.) added above as craft-bar references; treated
  stimulus/study-only, consistent with reference-library authority levels.
