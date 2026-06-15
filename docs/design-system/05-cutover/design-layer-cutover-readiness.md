# SOUP v3 — Design-Layer Cutover Readiness

Owner: Design corpus (single-seat as of 2026-06-14). Scope: the SOUP v3 design layer only — enforcement,
tokens, primitives, debt register, showcase. NOT the fleet estate (worktrees/branches/stashes/merge), which
remains owner/Systems-gated. Evidence-based; re-run the gate before relying on any line here.

## Gate status — GREEN
- **`verify:console-design` umbrella: PASS** (verdict PASS; 14 test files / 169 tests). This is the authoritative
  design gate — every `design:*` check + the design-guard suite passed at HEAD `80a55185`.
- **Design-seat categorical guards: 18/18 green** — `typography-floor`, `icon-size-ramp`, `css-focus-suppression`,
  `viewport-height-unit`, `tabpanel-primitive-adoption`. Several have been **promoted to first-class rules** by the
  (now-departed) Systems seat: `soup/no-static-viewport-height`, css-focus-suppression → design-resilience,
  `soup/no-raw-viewport-js`, dimensional/conditional/template-px sizing.
- **Burndown trending down, in sync:** `654 total / 590 blocking` across 11 categories (from 683/617 mid-wave);
  shadow lint `348` warnings at ceiling 348 (from 397) — no regressions, queue in sync.

## Enforcement inventory (what now protects the corpus)
- **Resilience gate** (`check-design-resilience.mjs`): no-unsafe-truncation, scroll-owner-required,
  no-layout-shift-interaction, no-hover-only-content, no-vw-font-size, no-raw-viewport-js, layer-owner-required,
  no-static-viewport-height.
- **Browser proofs:** `viewport-matrix` (6 views × {390/768/1024/1280/1440/+1440×500}, asserts no horizontal page
  overflow at any width), `target-size` (WCAG 24px floor), browser-motion.
- **Categorical frozen-inventory ratchets** (Design seat): typography 12px floor, icon size ramp, CSS focus
  suppression, viewport-height dvh.
- **Catalogue:** `design-debt-register.md` DD-5…DD-45 is the SSOT; DD-36…45 were added this wave (typography,
  icon-ramp, Card, color-mix fallback, modal dvh→closed, focus-suppression, toolkit gaps, avatar contrast, dvh).

## Remaining design debt (open DD, owner = corpus; mostly migration, not blocking the gate)
- **Long poles (Systems-style migration, now corpus-owned):** `legacy-token-tsx` + `legacy-var-css` dominate the
  590 blocking — token migration in product source. Falls as surfaces migrate; the gate stays green throughout.
- **Verified findings to action:** DD-38 Card primitive un-built (13 `c-card` consumers); DD-44 avatar hue-fill
  initials fail AA (dark all 8 hues, light 4/8 — fix: darken hues to L≈40% or fixed-contrast ink); DD-8 ghost-tier
  per-screen pass; DD-39 color-mix `@supports` fallback; DD-43 toolkit gaps (Tooltip/DateTimePicker/Bottom-sheet
  specimens remain).
- **Showcase target deck:** §11–23 built (the out-of-repo `soup-showcase` exploration artifact, per brand.md §66).
  Remaining specimens: Tooltip, DateTimePicker, Bottom-sheet.

## What is NOT in scope here (owner/named-approval gated — do not execute from the design seat)
- **Estate cleanup:** ~40 worktrees, 40+ branches, a **10-deep shared stash stack** (shared across all worktrees —
  popping/dropping risks grabbing a foreign stash). Most worktrees are other workstreams (provider-hardening,
  health-poller, systemd, credential-write, codex-review). A `docs/parallel-worktree-triage` workstream owns this.
- **Branch reconcile/merge:** `feat/soup-v3-foundation` is **behind 89** of origin/main — needs a reconcile/rebase
  before any merge to main. Merge, push, branch-deletion, worktree-removal, and stash-drop are all irreversible
  publish-boundary actions requiring explicit named approval.

## Design-layer cutover verdict
The **design layer is gate-green and cutover-ready on its own terms** (enforcement live, gate PASS, burndown
falling, no Design-seat WIP — tree clean, all guards/DD committed). It does not block cutover. The open items are
(a) owner-gated estate/merge mechanics and (b) continued token-migration burndown, which proceeds under the green
gate. Next design work continues under the established wave cadence (remaining specimens + verified-finding fixes).
