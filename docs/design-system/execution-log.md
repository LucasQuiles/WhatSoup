# Execution Log — SOUP Design System v3

Append-only. One entry per task/gate. Verdicts: Pass / Fail / Inconclusive / Blocked.

---

## T1 — Worktree, Discovery, Scaffold — 2026-06-11

**Verdict: Pass**

Commands run:
```
git fetch origin
git worktree add <worktrees>/soup-design -b design/soup-rebrand origin/main
git rev-parse --show-toplevel && git branch --show-current && git rev-parse HEAD
git status --short                       # clean
git -C <main-checkout> status --short | wc -l   # 51 (pre-existing baseline, untouched)
git worktree list                        # 14 worktrees incl. this one
```

State recorded:
- Worktree: `soup-design`, branch `design/soup-rebrand`, base `0ff1fe0ae2f9166a7e25000242283200aa78e457` (origin/main).
- Main checkout on `chore/ff038-eslint-ring` with 51 pre-existing dirty files — NOT touched.
- Remote: `git@github.com:LucasQuiles/WhatSoup.git`. No push authorized this program.

Assumption verification (see README table): A1 ✅, A2 corrected 16.7K→17,971 LOC, A3 ✅ 60, A4 ✅ 4 pages,
A5 ✅ 1,236 lines, A6 corrected 150+→106 selector rules, A7 ✅ 6 v2 mockup files, A9 corrected 120+→113 test files,
A10 ✅, A12 ✅ (`dev`/`build`/`lint`/`preview`).

Gaps/decisions:
- `docs/console-mockups/` has no README/index file → v3 forward pointer SKIPPED per plan rule
  ("only if the relevant file exists"). Gap recorded here; cutover plan may add one later.
- A8 (branding grep audit) deferred to T2/T7 as planned. A11 (screenshot tooling) deferred to T4.

Files created: `docs/design-system/{README.md,execution-log.md}`, `docs/sdlc/active/soup-design-system-v3/state.md`, `beads/`.

Commit: `docs(design): scaffold SOUP design-system v3 program`

---

## T2 — Inventory, IA, Workflow, DRY Audit — 2026-06-11

**Verdict: Pass**

Produced all six `00-inventory/` artifacts via dedicated audit agent; integrator reviewed and committed.

Key verified facts:
- LineDetail tabs: **9** (7 base + 2 MCP-gated: Scheduled, Groups — `console/src/pages/LineDetail.tsx:37-52`).
- A8: `WhatSoup` occurs **6 times in console/src** (1 each: `types.ts`, `mock-data.ts`, `hooks/use-keyboard-shortcuts.ts`, `hooks/use-fleet.ts`, `components/wizard/ConfigStep.tsx`, `components/UpdateModal.tsx`).
- Token census: **180 custom properties** (50 `@theme` / 130 `:root`), 60 `c-*` composite classes, 7 orphan tokens.
- Controls: 135 `<button>`s (24 raw outside `c-btn`/`c-tab` across ~8 recipes), 11 dialog surfaces (0 focus traps, 3 missing Escape), 9+ pill recipes, 4 custom popover dropdowns.
- Drift: 26 ranked entries — 6 P1 (button sprawl; no modal primitive; dark-only token values; status/mode color logic ×8 TS maps + 7 visuals; no pill primitive; token tier pollution), 12 P2, 8 P3.
- Disconfirmed briefing hypotheses logged in `duplication-register.md` (CardSelector/ChartPanel/Nav are not dropdowns; avatar-hue hashing single-sited).
- Hygiene note: guard flagged a doc line naming the literal lint-suppression directive; reworded.

Commit: `8fdc6a37 docs(design): T2 inventory — components, controls, IA, duplication, tokens, drift`

---

## T3 — Research + Reference Library — 2026-06-11

**Verdict: Pass** (motion addendum in progress — see T3b below)

Produced `01-research/reference-library.md` (~50 refs, 10 categories, authority + verification status per ref)
and `01-research/research-digest.md` (per-reference steal/adapt/reject, topics a–g, 13 "SOUP Design Direction Signals").

Honesty marks: Grafana Saga pages JS-gated; Apple dark-mode page fetch failed (known-canon);
Raycast via secondary teardown; galleries/TE marked not-browsed stimulus-only. Search-verified/known-canon
claims need re-confirmation before becoming normative in T6.

Headline conclusions: Radix contrast-by-construction + Carbon theme-as-token-remap + Primer role-first
naming as the token architecture; two designed densities; 4-surface elevation ladder with per-theme
elevation law; Geist > Plex > Inter typeface shortlist (Outfit as control); "mechanical calm" motion;
SOUP wordmark as instrument nameplate; positioning = "instrument-grade calm".

Commit: `44bcb5c8 docs(design): T3 research — reference library and design-direction digest`

---

## T3b — Motion Addendum + Operator Synthesis Seed — 2026-06-11

**Verdict: Pass**

Plan addendum (user-integrated) required motion-reference research. Research agent expanded
`reference-library.md` §8 into 5 sub-sections (philosophy / design-system specs / implementation /
hard gates / expressive boundary) covering Atlassian Motion (fetched: 50–150/150–400ms bands, 4 easings,
exits-faster), Fluent 2 motion taxonomy (fetched), Motion/motion.dev, Sonner, Vaul, Rive (rejected for v3
adoption), MDN reduced-motion + compositor discipline, WCAG 2.2.2 (Level A — directly regulates v2's
breathing dots and live feed; resolved via pause control + static degradation) and 2.3.3 (AAA, adopted
as target), BUCK/Clay/basement (stimulus-only, honestly marked not-browsed).
Digest signal #10 expanded: duration tokens (instant / fast ~120 / base ~180 / slow ~280 / ambient ≥1500ms),
two easings, transform/opacity allowlist + waiver, anchored-overlay specifics, ~150–200ms loader delay,
error-shake banned, full reduced/no-motion contract ("no information may exist only in motion").
Unverifiable: Geist motion docs (none found), Teams specifics, Clay/basement specifics — all marked.

Also added `01-research/synthesis-seed.md`: distillation of operator-provided comprehensive synthesis
report (non-authoritative seed per plan addendum) — studio craft-bar refs (LoveFrom, Clay, BUCK, Instrument,
Work & Co, Fantasy, Metalab), Android/MDN/W3C foundation validation set, seed sizing matrix, T7 lint
tripwires, screenshot QA matrix, and reconciliation notes (digest's ~300ms ceiling stands over seed's
400ms; typeface decision deferred to T4 side-by-side).

Commit: `1a39add8 docs(design): T3b motion research addendum + operator synthesis seed`

---

## T4 — Direction Mockups — 2026-06-11 (IN PROGRESS)

Three parallel direction agents dispatched (criteria incl. plan motion addendum: structural motion,
reduced-motion neutralization, anchored overlays, loading feedback, immediate focus/validation feedback).

- **Direction B (Editorial Precision): Pass.** `direction-b-editorial.html`, 2,337 lines, self-contained,
  dual designed themes, headless-Chrome render clean both themes at 900px+. Geist + Geist Mono;
  electric blue accent (#6BA6FF dark / #2563EB light); "soup." lowercase wordmark with passive-teal
  period. Vocabulary proposal: Soup Kitchen→Fleet, one user-facing noun "Line", "Attention" metric.
  Self-critique recorded (Vercel-adjacency risk; inline-style shortcut; drill-in is a vignette).
  Hygiene note: `====` CSS banners false-positived the conflict-marker guard → converted to dashes.
  Commit: `dc56dd3c`.
- **Direction A (Instrument): Pass after resume** — subagent hit session token limit at 1,544 lines;
  resumed and completed to 1,744 lines (balanced HTML verified). IBM Plex Mono+Sans, instrument orange,
  faceplate nameplate, lamp/shape status coding, focus trap + single-fire Escape in modal,
  stated AA contrast 15.7:1/15.2:1. Render-checked in headless Chrome (dark, top sections).
- **Direction C (Ops): Pass after resume** — same limit at 1,656 lines; completed to 2,265 lines
  (balanced HTML + `node --check` on JS verified by builder). Plex Condensed/Sans/Mono, achromatic
  chrome (color = semantics only), two table densities, toolbar + log-stream specimens, working
  drill-in drawer, SOUP rack-label lozenge. Render-checked (dark, top sections incl. live modal demo).

**T4 Verdict: Pass.** All three directions complete + committed with comparison launcher `index.html`
(neutral chrome) and critique/scorecards in `decision-log.md`. Vocabulary convergence across all three
builders: Soup Kitchen→Fleet, noun "Line", unified "attention" metric.

**A11 (screenshot tooling): Partially Inconclusive.** Headless Chrome viewport captures work at
top-of-page (both themes verified for B, dark verified for A/C); deep-scroll viewport captures return
blank frames in this environment and fullpage capture downscales — content verified via DOM/markdown
extraction instead. G1 review should use a real browser via `file://`; that is the designed review path.

→ **G1 gate: OPEN, awaiting user review.**
