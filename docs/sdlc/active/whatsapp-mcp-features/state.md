# WhatSoup MCP Feature Gaps — SDLC State

## Task ID: whatsapp-mcp-features
## Profile: BUILD
## Started: 2026-04-04

## Phase Log
| Phase | Status | Timestamp |
|-------|--------|-----------|
| Normalize | complete | 2026-04-04 |
| Frame | complete | 2026-04-04 |
| Scout | complete | 2026-04-04 (guppy swarm: 14 guppies, 3 waves) |
| Architect | complete | 2026-04-04 (spec + council review: 3C, 5I, 3A findings) |
| Execute | complete | 2026-04-05 |
| Synthesize | pending | — |

## Bead Manifest

| Bead | Type | Status | Runner | Commits | Tests |
|------|------|--------|--------|---------|-------|
| SP1-media-access | implement | merged | Q + BES Bot | 8 | ~30 |
| SP2-content-completeness | implement | merged | Q + BES Bot | 5 | ~25 |
| SP3-search-enhancement | implement | merged | BES Bot | 1 | ~20 |
| SP4-two-way-voice | implement | merged | Q | 4 | ~15 |

## Execution Summary
**Total commits:** 18
**Total new tests:** ~90
**Test suite:** 3253 passed | 1 pre-existing failure (prepare-content.test.ts) | 7 skipped
**TypeScript:** 0 errors
**Regressions:** 0

## Workers
- **Q**: Orchestrator + implementer. Foundation layers (schema, types, helpers) for SP1+SP2. All of SP4 (ElevenLabs provider, voice tool, config, runtime integration).
- **BES Bot**: Implementation partner + reviewer. Parsing/tool layers for SP1+SP2 (download_media, parseIncomingMessage, transcribe_audio). All of SP3 (search_messages_advanced). Independent verification on every sprint.

## Key Artifacts
- Spec: `docs/superpowers/specs/2026-04-04-mcp-feature-gaps-design.md`
- Plans: `docs/superpowers/plans/2026-04-05-sp{1,2,3,4}-*.md`
- Council review: Appendix in spec (3 critical, 5 important, 3 architectural findings)
- Guppy swarm: 14 guppies, 3 waves (appendix in spec)

## Remaining Work
- Fix pre-existing prepare-content.test.ts vi.mock hoisting failure
- Deploy: restart WhatSoup instances to activate SP2/SP3/SP4 (SP1 already demo'd on BES Bot)
- SP4 requires ElevenLabs API key in GNOME Keyring (`secret-tool store --label elevenlabs service elevenlabs`)
