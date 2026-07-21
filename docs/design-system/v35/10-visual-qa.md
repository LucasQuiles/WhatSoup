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

## Round 2 — codex (gpt-5.6) cross-validation

A second independent reviewer (codex CLI, high reasoning) audited the v2 set and caught 6 real
defects the first pass missed:

| # | Finding | Fix | Re-review |
|---|---|---|---|
| C1 | Theme toggle rendered as tofu (`◐` not in font stack) — hatch + splash | inline SVG sun icon on all 10 files | FIXED |
| C2 | Instance identifiers over-truncated (agents) | longer prefix+suffix mask + `title` attrs | FIXED |
| C3 | Dream Lab decision timestamps nearly clipped | pill-inset timestamps | FIXED |
| C4 | Skills Hub compat strips too small/low-contrast | 18px cdots, 9.5px codes, t2 labels | FIXED |
| C5 | Settings page too narrow + truncated admin identity | 1080px measure, full identity string | FIXED |
| C6 | Splash secondary CTA invisible after ghost demotion | hairline-bordered ghost, t2 ink | FIXED |
| C7 | Agents instances: 4-of-9 shown, no overflow cue | "show all 9 instances ▾" control | FIXED |

Final re-review verdict: **PASS — all prior issues visibly resolved.**

## Final craft scores (codex, v4)

fleet 8 · hatch 8 · agents 9 · skills-hub 8 · dream-lab 9 · inbox 7 (truncation inherent to
list density, accepted) · deployments 8 · settings 9 · splash 9 — **mean 8.3, floor 7.**

## Verdict

Direction A passes two independent visual QA loops (qwen2.5vl:72b + codex gpt-5.6) with zero
remaining broken elements on any surface in either theme.

---

# Double-blind adversarial passes (2026-07-21, owner-mandated)

Purpose: prove the earlier passes weren't pacification. Two fresh reviewers, different model
families, unprimed and adversarially framed, no access to prior verdicts.

## Pass A — gemma3:27b (blind, zero design context)

High noise: flagged intentional masked IDs as "information loss", hallucinated truncations,
confused surfaces between batches. Useful signal anyway: **no new structural defects
confirmed**, and grant-chip size joined a second reviewer flag. Most items rejected as
mask-by-design or model error (e.g. "SOUP invisible on light" — 15.69 AAA measured).

## Pass B — gpt-5.4 API (adversarial, spec-armed)

Sharp and systemic. Confirmed REAL conformance violations the first two rounds missed:

| Violation | Class | Fix |
|---|---|---|
| Status color-only in agents roster, instances, deployments, inbox, skills-hub, dream-lab | shape law | shape-coded markers (disc/diamond/square/outline or explicit glyphs) everywhere |
| Blue as data color (sparklines, me-bubble tint, unread badges, pairing code, qpill) | single-accent law | neutralized to ink/neutral |
| Grant pills hue-coded (P violet / S cyan) | channel collision | neutral letter-coded chips |
| Hatch done-steps green, selected glyph accent-tinted, glow persisted past the beat | ceremony/accent law | neutral steps, neutral glyph, glow fades to 0 |
| Sub-11px labels systemic | type floor | surgical 11px floor sweep (after one bad regex attempt broke dimensions — restored from git and redone surgically) |
| Masked IDs without suffix (l.quiles@…, help@…, lhquiles@…, 18459780···@s.w…) | mask law | prefix+suffix masks |
| Bare-text actions (⋯ menus, pull updates, choose brain, skip ceremony) | affordance law | bordered buttons / bordered ghost |
| Dream-lab selection in violet, approve in green | accent law | selection → accent, approve → accent |
| Deployments pair card dashed = disabled-read | state legibility | solid hairline + inset |

## Contamination lesson (process)

A re-audit run recycled stale findings from report files left in the analysis directory — the
reviewer read its own prior output instead of the images. Mitigation: reports archived outside
the analysis dir; final passes run with image-only inputs from a clean directory. Recorded so
future QA loops isolate evidence from commentary.

## Final verdicts (fresh-image adversarial audits)

fleet PASS · hatch PASS · agents PASS · skills-hub PASS · dream-lab PASS · inbox PASS ·
deployments PASS · settings PASS · splash PASS — 9/9 after three fix cycles. Two findings
rejected with spec citation: wordmark accent-'U' (brand.md §1.1 locked) and the marketing
headline accent word (Landing precedent + D4).

---

# Pass C — grok-4.5 via xAI OAuth on maclab (fourth family, adversarial)

Returned 0/9 FAIL — the harshest verdict. Disposition of its findings:

**Rejected with evidence (majority of claims):**
- "Blue leakage: chat mode cyan / local badge cyan" — mode channels (teal/cyan/violet) are
  sanctioned law since v3 (6 channels + 1 accent); the audit prompt under-specified the
  mode-color exception. Mode cyan ≠ action blue.
- All Rule-4 "below 11px" claims — Chromium-computed font sizes for every flagged class:
  exactly 11px at the floor everywhere. Pixel-estimation errors.
- "WA glyphs green / brand tints" — state dots are the sanctioned status channel; glyphs are
  neutral `currentColor`.
- "Splash gradient orbs" — flat 4–5% opacity glyph geometry, not gradients.
- "Hatch avatar halo" — ceremony-scoped one-shot, fades to 0 post-beat.

**Real items found and fixed (3 — the codex pass missed these):**
1. Skills Hub source badges were chromatically typed (official/community/local tinted) →
   neutral pills; thirdparty keeps risk tint (status semantics).
2. Inbox Line card "live" was text-only → shape marker added.
3. `.btn.ghost` had no visible affordance anywhere → hairline border on all surfaces.

**Verdict after fixes:** grok's FAIL resolves to PASS with the same two spec citations as
before. The 3 real items would not have been found without a fourth family — reviewer
diversity is doing its job.
