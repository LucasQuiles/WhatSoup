# Operator-Provided Research Synthesis 2 (Seed Material)

> **Provenance & authority:** distilled from a second operator-supplied research report
> ("SOUP Design Research Synthesis", 2026-06-11), integrated per plan as **non-authoritative seed**.
> Where it conflicts with `research-digest.md`, the digest wins. Citation markers stripped; claims
> inherit the source report's verification, not this program's. Arrived at G1; folded into T5–T7 inputs.

## Convergent validation

The report's closing direction statement — *"make SOUP feel like a professional instrument panel,
not a concept shot"* — independently matches the T3 digest's "instrument-grade calm" positioning and
the G1-approved blend. Its core doctrine: **expressiveness at the system edge, task core ruthlessly
usable** (Apple Liquid Glass / Material 3 Expressive push expressiveness at the platform shell while
Atlassian/Carbon/Primer/Radix keep the task layer semantic, accessible, consistent).

## Items adopted into task criteria

### T5/T6 (visual + spec)
- **Glass/translucency:** accent-only — overlays and chrome, never a substrate for dense data
  (Liquid Glass legibility caution; Apple reportedly raised opacity post-launch).
- **Easing set candidates** (reconcile with T3b motion tokens): enter `cubic-bezier(0.2, 0, 0, 1)`,
  exit `cubic-bezier(0.4, 0, 1, 1)`, `linear` for opacity-only, lightly damped spring for direct
  manipulation only. Exits faster than entrances. Reduced motion = **off-and-instant**, not smaller.
- **Sizing/accessibility floors:** 24×24 CSS px minimum target size (WCAG 2.2), 44px desirable for
  touch-heavy contexts; 320px reflow floor without 2-D scrolling; ~80-char reading measure for dense
  prose; container-query-aware responsive thinking (Tailwind model) over device-class metaphors.
- **Semantic token starter table** (Carbon/Primer-flavored values, e.g. `color.surface.canvas`
  #FFFFFF/#161616, `color.action.brand` #0969DA/#78A9FF): treated as a **comparison set** for T6
  contrast tables — NOT adopted values; SOUP palettes come from the G1-approved blend.

### T7 (enforcement/cutover) — strong adopts
- **Progressive lint lifecycle:** observe → educate → warn → gate-new-code → gate-all → autofix
  (merged with the plan's proposed→shadow→warn→scoped-error→global-error→deprecated→removed states).
- **Waiver policy, 5 mandatory fields:** owner, reason, scope, expiry, replacement plan. No silent
  inline disables; no permanent waivers; expired waivers fail CI.
- **Precedent rule families** (Atlassian design-system + Primer ESLint plugins):
  `use-tokens-space/typography/motion`, `prefer/use-primitives`, `no-margin`, `no-nested-styles`,
  `no-physical-properties`, `no-deprecated-imports`, `no-unsafe-style-overrides`. Proves
  enforceable-design-system is established practice, not invention.
- **Layer ownership map with "must-not-own" boundaries:** tokens (values; not structure) →
  primitives (layout/accessible behavior; not screen semantics) → components (reusable units; not
  workflow logic) → patterns (validated compositions; not business rules) → screens (orchestration;
  not raw values or style forks).
- **PR review checklist:** semantic tokens only; reuse before invent; light/dark parity; reduced-motion
  usable; keyboard/focus/target-size preserved; one migration concern per PR; screenshots for all
  affected states (error/loading/empty/high-density).
- **G2 acceptance enrichment:** ownership map approved; visual QA matrix defined; migration slices
  scoped; rollback documented.

## Reference additions (stimulus/study buckets)
- Awwwards most-awarded studios — Locomotive, Immersive Garden, Resn, Monks, Active Theory,
  Hello Monday, Louis Paquet, Zhenya Rynzhuk → **stimulus-only** (transition craft, premium surface
  treatment; onboarding/brand moments at most).
- Mobbin emphasized as the strongest *real-flow* source vs galleries (consistent with reference-library
  authority levels already assigned).
- Material 3 Expressive (secondary reporting): hierarchy/focal-point lessons for onboarding and empty
  states only; rejected for core console voice.

## Reconciliation notes (digest vs this seed)
- Motion bands largely agree with T3b (hover 80–150, local state 120–180, overlays 180–320); the seed's
  400–700ms "celebration" tier is **out of scope** for v3 core UI (digest's structural-only rule stands;
  expressive zone limited to rare brand moments and requires explicit spec sanction in `motion.md`).
- The seed's "pilot slice pack" is already satisfied by T4/T5 mockup surfaces (dense-data, form-heavy,
  nav shell, both themes, reduced-motion notes) — mapped, no scope added.
- Seed's Figma-centric tooling chain (variables/Dev Mode/visual regression) recorded as implementation-
  program candidates; this docs-only program encodes the equivalent guarantees via specs + lint plan.
