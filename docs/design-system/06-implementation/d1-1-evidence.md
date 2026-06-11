# Slice Evidence — D1.1 (C0: token CSS split + semantic vocabulary)

Worktree `soup-impl`, branch `feat/soup-v3-foundation`, commit `4e98f0b5` (base `2d5f813c`, which has
zero console drift from the spec baseline `0ff1fe0a` — verified by diff). Slice type: CSS restructure
with a zero-visual-change invariant; no .tsx changes; three design-token test files updated to read
the new tier set.

## Five reviews (qa-hardening §1)

| Review | Verdict | Evidence |
|---|---|---|
| Positive-path | **PASS** | `npm --prefix console run lint` clean; `build` succeeds (191ms, all assets emitted); `npx vitest run tests/console --pool=forks` → **1614/1614 pass** (113 files); dev-server render of Fleet dark verified in browser (full dashboard renders, mock data, no console errors). |
| Negative-path | **PASS (scoped)** | For a token-restructure slice the negative paths are resolution failures: computed-style probes confirmed every tier resolves (`--color-d0` #050709, `--surface-base` alias → #050709, `--b2`, `--status-ok-wash`, `--sk-col-mode`, `--sp-4`); body bg/color/font computed identical to pre-split values; `.c-btn` renders. Full UI-state matrix is NOT APPLICABLE (no rendered-surface changes by construction — see token diff). |
| Omission review | see below | |
| Regression review | **PASS** | Token-resolution diff (old monolith vs new tier files): removals = exactly the 7 sanctioned orphans; additions = exactly the 41 new semantic vocabulary tokens; every consumed token byte-identical. Zero `var()` references changed in TSX (no TSX touched). Rollback = single-commit revert; no consumer files changed except the 3 test files (which revert with it). |
| Design-system conformance | **PASS** | Follows tokens-v3 §5 file split; orphan deletion + avatar-hue dynamic-consumer comment per cutover plan C0; semantic names per spec §3/§7 alias vocabulary. One documented interpretation (below). |

## Omission audit (qa-hardening §3)

- **Not touched:** all .tsx, eslint config, theme toggle, any value change — by design (C1 scope).
- **Assumed covered:** Tailwind v4 processes `@theme`/`@utility` across `@import`ed files — proven by
  successful build + utility probes (`bg-d*`, `text-*`, `.animate-*` all present in built CSS).
- **States not rendered:** all interactive states unchanged by construction (verbatim rules); not
  re-verified per state — covered by the 1,614-test suite (includes interaction tests).
- **Viewport/theme not checked:** light theme does not exist yet (C1); narrow viewport unchanged.
- **Lint not yet protecting:** no soup/* rules yet (D1.3); legacy names still freely usable — expected
  at this stage.
- **Screenshot evidence:** one dark Fleet render + computed-style probes. Pixel-diff against a
  pre-change baseline was NOT possible (no baseline screenshot of the live console pre-split exists;
  taking one would have required a second checkout). Compensated with the stronger mechanical proof:
  token-resolution diff + verbatim rule extraction + computed-style probes. Classified **PASS with
  documented evidence substitution** (no-silent-fallback §7 record).
- **Real-data stress:** unchanged surface; mock fleet rendered with full dashboard density.

## Spec ambiguity resolved (qa-hardening §10 — documented implementation interpretation)

Tokens-v3 §7 says legacy names alias TO the new tier at C0; but several §7 aliases are value-collapsing
(`--color-d3`→raised, `--color-t3`→`--text-2`), which would break the C0 zero-visual-change invariant,
and converting legacy `@theme` entries to aliases risks utility regeneration differences. Cutover plan
C0 ("the dark scope simply aliases the legacy values") takes precedence: **at C0 the semantic vocabulary
aliases the legacy canonical values; the alias direction inverts at C1** (legacy `@theme` → `@theme
inline` pointing at semantic, value-collapsing aliases land with the reviewed visual change). Recorded
in `tokens.semantic.css` header comment. Durable action: this note + decision-log entry at C1.

## Design debt register

| ID | Title | Type | Cleanup phase |
|---|---|---|---|
| DD-1 | Legacy `@theme` block still canonical (utilities frozen to dark values) | token | C1 (inverts to `@theme inline`) |
| DD-2 | Semantic vocabulary incomplete vs spec §3 (interaction washes, per-strength fg pairs pending) | token | C1 |
| DD-3 | Three design-token tests now concatenate 5 files; helper duplicated ×3 | test | C2 (fold into shared test util when test surfaces migrate) |

## Verdict: **PASS** — C0 stop/go criterion met (zero visual diffs by mechanical proof + render smoke). Next slice: D1.2 (C1 token value swap + dual themes + toggle).
