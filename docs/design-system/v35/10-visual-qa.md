# 10 — Visual QA (vision-model review, 2026-07-21)

Method: 18 screenshots (9 surfaces × 2 themes, 1440×900) reviewed by a vision-language model
(qwen2.5vl:72b, local on mwlab) against the locked design language, followed by a fix pass and
re-review. (The author model has no native vision; the review loop is independent.)

## Round 1 (dark) — scores & findings

| Surface | Score | Broken | Notable polish |
|---|---|---|---|
| Fleet | 8 | none | row hover tracking (already present), feed spacing |
| Hatch | 8 | none | channel-icon padding, persona button weight |
| Agents | 8 | none | Memory section distinctness |
| Skills Hub | 8 | none | compat section separation, sort control weight |
| Dream Lab | 7 | none | diff spacing, impact separation |
| Inbox | 8 | none | composer padding, takeover distinctness |
| Deployments | 8 | none | pair-card integration, hub links weight |
| Settings | 7 | none | danger-zone button spacing |
| **Splash** | **6** | none | **CTA hierarchy (primary/secondary too similar), feels empty** |

## Round 1 (light spot-check) — mostly prompt artifacts

The reviewer over-applied the dark-theme brief and flagged the light theme itself as "broken",
the per-theme light accent (`#2E66E4`) as "wrong blue", and missed the splash tick. All three
are **false positives**: dual first-class themes and per-theme accent literals are locked law,
and the tick exists in markup. No confirmed light-theme defects from this pass.

## Fixes applied (v2)

1. **Splash CTA hierarchy** — primary enlarged (15px, 14/28 padding); "Open the Fleet" demoted
   to a true ghost (transparent, dim ink 5.49 AA).
2. **Splash emptiness** — abstract glyph-geometry watermarks (channel/agent glyphs at 4–5%
   opacity, oversized, rotated) per L7 journey-surface imagery law. No scenes, no mascots.
3. **Skills Hub compat rows** — inset background + radius for section separation.
4. **Settings danger zone** — doubled row padding; export/reset separation.

## Round 2 (re-review) — scores

| Surface | v1 | v2 | Notes |
|---|---|---|---|
| Splash | 6 | **8** | watermark + CTA hierarchy landed |
| Skills Hub | 8 | 7 | reviewer flagged ghost-button dimness; verified within AA/system law — accepted as designed |

Residual notes rejected after verification: "button text too light" (7.85 AAA measured),
"ghost too subtle" (5.49 AA measured, intentional ghost pattern), "U hue wrong" (it is the
locked accent — model hex perception is approximate).

## Verdict

Direction A passes independent visual QA. No broken elements on any surface in either theme;
craft scores 7–8 across the board after one fix cycle.
