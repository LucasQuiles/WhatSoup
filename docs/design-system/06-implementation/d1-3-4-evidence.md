# Slice Evidence — D1.3 (lint shadow stage) + D1.4 (QA remediation)

Worktree `soup-impl`, branch `feat/soup-v3-foundation`, rebased onto current origin/main (`036acfb9`).
Commits: D1.3 `5e7a9979`, D1.4 `472c5b5a`, plus the docs merge bringing `docs/design-system/**`
branch-local. All verification re-run post-rebase.

## D1.3 — Lint shadow stage — **PASS**

Delivered (harvested from an auto-isolated agent worktree, integrator-verified file-by-file):
`console/eslint-rules/index.mjs` (soup/* plugin, 9 implemented + 8 documented stubs),
`console/eslint.config.shadow.mjs` (opt-in, report-only — default lint run untouched because husky
enforces --max-warnings 0), `console/scripts/design-regression.sh` (15 labeled rg checks, exit 0 at
shadow), `console/eslint-waivers.yaml` (WVR-001..006: chart-utils/QrDisplay pixel+hex, shimmer +
typing-bounce ambient loops; all owner/reason/scope/expiry/replacement), scripts `lint:shadow` +
`design:regression`.

**Violation baseline (recorded 2026-06-11):** 615 shadow warnings, 0 errors — legacy tokens 406,
raw buttons 135, raw form controls 38, ad-hoc modals 19, utility smell 9, brand regression 2
(Nav split wordmark caught by the split-sibling detector + UpdateModal ternary), focus suppression 2.
Regression suite: 7 PASS / 8 WARN (legacy tokens 194 var-refs + 348 class-refs are the C2 burn-down
counters; "Soup Kitchen" ×5 → C3/C4; protected contracts all present).

## D1.4 — QA remediation (audit response) — **PASS**

| Fix | Evidence |
|---|---|
| Global reduced-motion off-and-instant | `composites.css` final block: all animation/transition collapse to 0.01ms, iteration-count 1, scroll-behavior auto — system-wide guarantee per motion spec |
| Instant focus feedback | focus-visible ring `transition: none` (was 0.2s) per motion/interaction spec |
| Mobile nav overflow | Nav.tsx responsive: icon-only links below sm (`max-sm:sr-only` keeps accessible names), status text collapses below md, version/separator hidden below md. Measured at 390×844: `nav.scrollWidth` **390** (was 657), overflow false, screenshot evidence |
| Theme persistence tests | new `tests/console/use-theme.test.tsx` (5 tests): default, persisted-light hydration, invalid-value fallback, toggle+persist round-trip, pre-paint script/hook contract parity. Hermetic storage fake per repo convention (this jsdom env lacks localStorage) |
| Branch freshness | rebased onto origin/main (was 2 behind; both upstream commits non-console) |
| Branch-local QA docs | `docs/design-system/**` merged into the implementation branch (specs, lint/cutover plans, qa-hardening protocol, evidence packets) |

**Full verification post-remediation:** lint clean · build green · **1,619/1,619 console tests**
(114 files; +5 new) · lint:shadow exit 0 · design:regression exit 0.

## Consolidated audit disposition (three audit passes, 2026-06-11)

| Audit item | Disposition |
|---|---|
| QA docs not branch-local | **FIXED** — design branch merged in |
| Mobile nav overflow @390 | **FIXED** — measured 390/390 |
| Commit author email (operator-personal address flagged by audit) | **PUSH-GATE, documented** — origin/main's own commits carry this same author email (committer = GitHub noreply via squash); landed identity is controlled at squash time with explicit --author-email per repo convention. No history rewrite to an invented address. Re-evaluate at PR time |
| Theme toggle untested | **FIXED** — 5 direct tests incl. hydration/invalid/persistence |
| DD-4 (Google Fonts) comment-only | **FIXED** — formal entry in debt register below w/ expiry |
| Reduced-motion incomplete | **FIXED** — global off-and-instant policy (the 3s/1.2s/1.5s loops + 0.25s/0.3s timings now neutralize under the media query; loops additionally governed by waivers WVR-005/006 pending C5 motion disposition) |
| Animated focus ring | **FIXED** — transition removed |
| Status law not implemented (StatusDot dot-only; badge test enforces rounded-full) | **DEBT DD-6, phase C2** — canonical Badge/StatusChip primitive (shape law disc/diamond/square/outline + label) replaces StatusDot; `badge-components.test.tsx:83` is updated in the same C2 slice. Until then the old law intentionally stands (no half-migration) |
| Brand/vocabulary incomplete (split wordmark, Soup Kitchen, instance copy) | **SCHEDULED C3/C4** — already lint-tracked (brand-regression 2 hits, vocabulary 5 hits in regression suite); branding-touchpoints.md is the classification evidence, now branch-local |
| Modal focus restoration missing | **DEBT DD-7, phase C2** — `useDismissable` + Modal primitive (spec components/modal.md); lint rule `modal-must-restore-focus` stubbed, activates with primitive |
| --text-3/t5 contrast below 4.5:1 at use sites | **DEBT DD-8, phase C3** — spec restricts text-3/ghost to non-essential metadata; C3 screen polish re-points essential small text to --text-2; use-site audit rides the per-screen migration. (Values are spec-conformant: ghost tier is intentionally sub-AA for decorative metadata) |
| Legacy spacing half-steps (--sp-0h/1h/2h, 14px, 7px) | **DEBT DD-9, phase C2/C3** — tokens-v3 disposition already maps them; consumed via composites which migrate per-directory |
| Touch-target 24px floor unproven | **DEBT DD-10, phase C2** — deterministic measurement lands with primitives (each primitive spec carries min target size; verify via computed-size assertions in primitive tests) |
| Backend-backed negative paths | **INCONCLUSIVE, scheduled C2 pilot** — dev proxy 502s are the mock-mode fallback path working as designed; live-backend verification rides the D3 pilot rehearsal |
| Legacy utility/inline-style debt | **TRACKED** — shadow baseline (615) is the burn-down counter; C2 per-directory flips enforce |

## Design debt register (branch-local SSOT from this slice forward)

| ID | Title | Phase | Expiry/trigger |
|---|---|---|---|
| DD-4 | Geist via Google Fonts runtime import (offline/privacy/CSP impact) | C2 | self-host before any deploy; hard expiry 2026-07-31 |
| DD-5 | Theme toggle minimal ghost button | C3 | nameplate/Nav polish slice |
| DD-6 | Status shape law not yet rendered (StatusDot + test enforce dot-only) | C2 | Badge primitive slice |
| DD-7 | No modal focus-restoration primitive | C2 | Modal/useDismissable slice |
| DD-8 | text-3/t5 essential-use audit | C3 | per-screen migration checklists |
| DD-9 | Legacy half-step spacing aliases | C2/C3 | per-directory migration |
| DD-10 | Touch-target floor unmeasured | C2 | primitive test assertions |
| WVR-001..006 | see console/eslint-waivers.yaml | various | 2026-12-31 |

## Verdict: D1.3 **PASS**, D1.4 **PASS** — D1 (token foundation stage) complete. Next: C2 primitive consolidation, first slice = Badge/StatusChip + Button primitives feeding the Fleet pilot (resolves DD-6 first, the audit's sharpest open conflict).
