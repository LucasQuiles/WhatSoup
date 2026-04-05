# SDLC State: Phase 3 Console Features

## Metadata
- **Task ID:** phase3-console-features-20260401
- **Created:** 2026-04-01T23:00:00Z
- **Complexity:** Complex (3 sub-phases, 10 beads, touches fleet API + console + DB)
- **Phase:** 1 — Frame
- **Status:** Active

## Mission Brief
Implement Phase 3 of the WhatSoup Fleet Console: rich media rendering, conversation management (pagination, contacts, search), and instance operations (config editor, mode switch, stop). This makes the console a usable daily-driver for managing WhatsApp instances.

## Source Plan
`docs/plans/2026-04-01-phase3-roadmap.md`

## Bead Registry
| ID | Title | Sub-phase | Status | Depends |
|----|-------|-----------|--------|---------|
| B01 | Inline image thumbnails | 3A | pending | — |
| B02 | Audio message indicator | 3A | pending | — |
| B03 | Document file card | 3A | pending | — |
| B04 | Video thumbnail | 3A | pending | B01 |
| B05 | Cursor pagination | 3B | pending | — |
| B06 | Contact management | 3B | pending | — |
| B07 | Message search | 3B | pending | — |
| B08 | Config editor | 3C | pending | — |
| B09 | Mode switching | 3C | pending | B08 |
| B10 | Stop instance | 3C | pending | — |

## Wave Plan
- **Wave 1 (parallel):** B01, B02, B03, B05, B06, B10 — independent, no cross-deps
- **Wave 2 (after B01):** B04 — reuses image thumbnail pattern
- **Wave 3 (after B08):** B09 — needs config editor foundation
- **Wave 4 (after B05):** B07 — search UX depends on pagination working

## Tech Debt to Address
- Centralize timestamp `>1e12` guard → `toIsoFromUnix()` utility
- Split `mock-data.ts` into types + mock generators
- Delete stale SDLC workflows from previous phases
