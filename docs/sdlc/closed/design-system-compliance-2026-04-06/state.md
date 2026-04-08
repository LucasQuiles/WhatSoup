# SDLC Task: Design System Compliance

- **ID**: design-system-compliance-2026-04-06
- **Created**: 2026-04-06
- **Phase**: Execute
- **Plan**: `docs/superpowers/plans/2026-04-06-design-system-compliance.md`
- **Complexity**: Complex (34 findings across 6 dimensions, 87 source files, CSS architecture changes)
- **Origin**: Design system audit — 7 specialist agents, cross-referenced findings
- **Baseline updated**: 2026-04-08 (post dashboard-polish session)

## Description

Fix all design system compliance violations discovered during the comprehensive audit of the WhatSoup console frontend. Violations span color tokens, typography rules, inline styles, CSS architecture, spacing grid, component consistency, and ESLint enforcement.

## Baseline Status (2026-04-08)

The dashboard-polish session (2026-04-07/08) resolved significant P0 work ahead of this task:
- ESLint: 0 violations — all enforced rules are passing
- c-btn transitions: already use explicit property lists with design tokens
- c-dialog border: already `var(--b1)`
- !important: zero remaining in index.css
- body::before z-index: -1 with #root isolation: isolate
- form-styles.ts: partially dissolved — only `getBorderColor()` and `confirmCheckStyle` remain

## Beads

| # | Type | Description | Status |
|---|------|-------------|--------|
| 1 | plan | Implementation plan with bead decomposition | complete |
| 2 | build | P0: Enable ESLint enforcement | complete (verified 0 violations) |
| 3 | build | P0: Fix c-btn transition cascade | complete (explicit property transitions in place) |
| 4 | build | P0: Fully dissolve form-styles.ts — inline remaining `getBorderColor` and `confirmCheckStyle` into consuming components, then delete the file | complete (TDD verified, file deleted) |
| 5 | build | P1: Icon strokeWidth normalization — add missing strokeWidth={1.75} to ~10 icons across 7 files. Also replaced AddLineWizard check inline color with text-d0 class. | complete |
| 6 | build | P1: Typography mono/sans corrections | complete (verified: GroupDetailModal, SoupKitchen, ChatListItem, feed toolbar, HeartbeatStrip all already corrected in earlier sessions) |
| 7 | build | P1: Modal border normalization (b2 → b1) | complete (c-dialog already b1) |
| 8 | build | P1: CSS stacking + z-index tokenization | complete (body::before z-1, #root isolation) |
| 9 | build | P2: Color token violations + opacity tokenization | complete (verified 0 named colors, 0 hsl(), 0 raw opacity in codebase) |
| 10 | build | P2: Spacing grid compliance (raw px → tokens) | complete (verified 0 raw px values in style props) |
| 11 | build | P2: CSS class redundancy cleanup | complete (no redundant classes identified in current tree) |
| 12 | build | P2: Add fontSize ESLint rule + fix 162 violations across 39 files | complete (rule added, all violations fixed, 0 eslint errors) |
| 13 | verify | Full regression check — ESLint 0 violations, typecheck clean, 204 test files / 3832 tests / 0 failures | complete |

## Quality Budget

- **Turbulence ceiling**: 3 (max corrections per bead before escalation)
- **SLI target**: 0 ESLint violations on enforced rules after completion
