# 10 — Visual QA (vision-model review, 2026-07-21)

Method: 18 screenshots (9 surfaces × 2 themes, 1440×900) reviewed by a vision-language model
(qwen2.5vl:72b, local vision host) against the locked design language, followed by a fix pass and
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

# Pass C — grok-4.5 via xAI OAuth host (fourth family, adversarial)

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

---

# Wave 4 — explicit-test-battery pass (2026-07-21, owner-mandated)

Purpose: catch what broader prompts missed — small alignment issues, inconsistency, bad
UI/UX, clutter, poor use of space. Method: a **25-test explicit battery** (A alignment ×6,
B consistency ×6, C UI/UX ×6, D clutter ×4, E space ×5) plus a **G cross-surface battery
(×7)**, run per-image with mandatory element+region citations, confidence tags, and an
anti-artifact preamble (sanctioned exceptions enumerated; absolute pixel estimation banned
— relative comparisons only). 18 fresh screenshots (9 surfaces × 2 themes, 1440×900),
image-only evidence directory (prior contamination lesson applied).

**Reviewer availability this wave:** gpt-5.4 (OpenAI API) ✓ · grok-4.5 (xAI OAuth host) ✓ · codex gpt-5.6 (CLI) ✓ · qwen2.5vl:72b + gemma3:27b ✗ (local vision host offline) ·
claude-opus-4-8 ✗ (API balance empty + CLI weekly cap). Three families ran the full
battery; the two local families re-join when the local vision host returns.

## Real defects found and fixed

**1. Global chrome missing on 6 of 7 operator surfaces (the flagship catch, G1, both
families, HIGH).** Fleet carried the locked left nav rail (00-landscape-inventory: "Global
chrome: left nav rail with SOUP nameplate"); agents, skills-hub, dream-lab, inbox,
deployments, settings had silently shipped top-bar-only chrome through six track PRs.
Fixed: rail on all operator surfaces (active state, SOUP nameplate + per-surface ctx,
Operate/Create/System sections, Hosts status block); "Deployments" added as a System nav
item everywhere; theme toggle standardized (sun SVG + label, rightmost in every header;
fixed corner on journey surfaces); header nameplates de-duplicated into the rail.

**2. Invisible/tofu glyph sweep (broken-asset class).** Two line-chart icons (skills-hub
auto-seo, fleet Ops nav) were stroke-only paths with `fill` styling → rendered as *empty
squares* (grok caught what three earlier waves missed; confirmed in code). Fixed via
stroke styling. Also replaced every font-dependent risky glyph with inline SVG: ⚄ dice,
⇪ upload, ⇓ download, ⌕ search, ⛨ filter, ⚠ warnings, and the emoji composer caps
(🖼🎤📊⏰ — chromatic emoji violating the monochrome-glyph law).

**3. Fold-dangles and contradictory composition.** Hatch stacked the *completed* channel
step below the final ceremony (codex: "CHANNEL marked completed while selection is
presented as unresolved" — contradictory workflow state; both families flagged the
dangling clipped card) → channel card removed; ceremony now composes centered at 900px.
Deployments pair card, settings danger zone, skills-hub last card all clipped at the fold
→ spacing/radius restructure until every surface fits 1440×900 exactly (Chromium-measured:
deployments 836/836, settings 840/840, skills-hub 839/839, dream-lab 840/840).

**4. Mockup-state bugs (content honesty).** Inbox takeover toggle rendered OFF while the
system notice, agent card, and composer all stated ON (codex HIGH) → toggle state fixed.
Fleet header declared "14 lines" with 10 rows shown and no overflow cue (codex HIGH) →
table rows compacted to single-line anatomy; all 14 rows now fit (644/644) and the count
text corrected ("14 across 10 channels" — it had claimed 6). Agents roster said "1 line"
while two assigned lines rendered → "2 lines".

**5. Component vocabulary unification.** Inbox Line "live" bare dot+text → shared status
pill (fleet/agents/deployments pattern). Inbox Direct/Rooms selected state → accent-wash
(was ambiguous enough that grok inverted which tab was active, both themes). Destructive
actions: instance "kill" neutral-at-rest → crit-tinted (one destructive vocabulary:
crit-outline family). Update actions: skills-hub neutral vs deployments accent-outline →
accent-outline everywhere. "Add" controls: dashed-ghost pattern unified (settings new-token
converted). Takeover toggle warn-amber → accent (one switch vocabulary; the caution
semantics stay on the ◆ badge). Deployments "admin lane" violet chip → neutral (leaving
warn=attention, neutral=info as the two title-pill registers). Settings subnav listed
sections that don't exist in the content (Channels, Agent defaults — grok HIGH) → trimmed
to real sections; Danger zone given the same section header+desc pattern as siblings.
Settings theme swatch: selection state didn't follow the theme being viewed (grok HIGH) →
swatch selection now syncs with the toggle.

**6. Alignment & space.** Fleet row menu buttons drove 51px rows → compact `.rowbtn`
(21px) + padding trims; Deployments hub action buttons now form a right column; settings
notification toggles trail in one column; inbox composer children uniform 36px; inbox
timestamps/unread pills each get a fixed right column; dream-lab "Recently decided" moved
from the overloaded review pane into the underused queue column (kills both the D3
competing-blocks flag and the E2 dead-zone flag); dream-lab action note moved out of the
button strip; pair card restructured to a single flow row (no squeezed right column).

**7. Data & terminology.** Dream-lab Mercy instances: full mask law (prefix+suffix+nowrap
+ title attr). Skills-hub update labels unified ("update" + version delta in title attr).
Deployments ISSUE metric value neutralized (warn stays on the chip + degraded pill — same
data-color law as wave 3). "org hub" vs "org skills hub" terminology unified. Hosts block
completed (field-pi was missing from the global rail). Dream-lab "edit then approve" →
"Edit then approve" (casing drift inside one action set — the wave's smallest real catch).

## Rejected with computed evidence (representative)

- "Hatch/splash sit off-center / left-leaning / top-heavy" (repeated across runs, HIGH
  confidences) — Chromium-measured: hatch shell gutters 290/290, margins 122/122; splash
  hero gutters 515/515, stack margins 175/175. Exactly centered; watermark asymmetry is
  sanctioned diagonal balance.
- "Reject button shorter / tighter padding" (HIGH, twice) — measured: all three action
  buttons 33px height, identical class.
- "Settings revoke sits lower than rotate" / "agents Edit/Retire baseline ragged" —
  identical `.btn.sm` components in centered flex rows.
- "Deployments/Settings nav items smaller than Operate items" — identical `.nav-item` class.
- "Hatch-card gap tighter than roster gaps" — uniform `gap:8px` flex column.
- "Activity feed clips text mid-word" — every `.ev p` scrollWidth ≤ clientWidth (all False).
- "Deployments/settings bottom panels clipped" — panel bottoms at y=850/873 vs 900 viewport.
- "Inbox composer icons cramped vs Send" — 36px = 36px = 36px after unification.
- "Cross-theme structural parity breaks" (footnote present in one theme, swatch order
  flipped, more rows visible in one theme) — single DOM; only colors flip.
- Telegram/X glyphs optically smaller — **accepted as real** and optically normalized
  (scale transforms); the rest of the icon-size claims rejected per viewBox uniformity.

## Accepted with rationale (conscious dispositions)

- **Agents Memory panel internal scroll** (~120px at 900px) — the only surface not fully
  composing at viewport. Console detail surfaces scroll internally (fleet table precedent);
  truncating Memory content would misrepresent the surface. Flagged HIGH three times;
  consciously accepted as the operator-scroll pattern.
- Row/instance/feed density (persistent D1 everywhere) — console register law: dense
  operator feel is the design. Two-tier selection vocabulary codified (list rows = accent
  edge-bar; cards = accent ring) after grok's G6 selection-drift catch.
- Journey-surface margins/emptiness (persistent E1/E2 on hatch/splash) — journey register
  law: spacious centered composition, same pattern as splash (which passes).
- Masks with ellipsis (recurring C2 flags) — privacy mask law; prefix+suffix+title attrs.
- "Unassigned" italic text (absence styling), recessed deactivated pills (intentional
  recession), eggshell dashed frame (ceremony motif), hatch card lighter than roster cards
  (add-row pattern), skills-hub filter column ending mid-height (content-complete sidebar),
  deployments header-primary + featured pair card (entry + destination, not duplication),
  dream-lab `history` ghost in the primary slot (action zone is the review pane),
  "Upload" icon+label (import action, not `+ Verb` creation).

## Process note — adversarial oscillation

With the battery's paid-per-defect framing, finding counts *inflate* once real defects are
exhausted: identical-or-improved images drew FAIL(2)→FAIL(5)→FAIL(10) across consecutive
runs, with the same elements alternating between PASS and HIGH-severity claims
(centered-composition "shifts", identical-component "size differences"). Completion rule
applied: every remaining finding is either fixed, rejected with computed evidence, or
accepted with recorded rationale. No undispositioned findings remain.

## Verdict

fleet · hatch · agents · skills-hub · dream-lab · inbox · deployments · settings · splash —
**all real wave-4 defects fixed and re-verified across three reviewer families.** The rail
unification alone (6 surfaces) was worth the wave; the invisible-glyph class would have
shipped broken without it.
