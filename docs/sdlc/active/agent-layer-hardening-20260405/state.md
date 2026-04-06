# Task: Agent Layer Hardening (Phase 6)

**ID:** agent-layer-hardening-20260405
**Created:** 2026-04-05
**Status:** in_progress → nearing completion
**Profile:** BUILD
**Complexity:** complicated
**Cynefin:** complicated
**Parent task:** whatsapp-mcp-features (completed phases 1-5)

## Objective
Harden the WhatsApp agent layer across stability, safety, correctness, and observability. Close 26+ audit findings from the Phase 6 code audit plus 20 additional findings from L's deep explorer pass. Fix agent behavioral issues (echo loops, lost context, config gaps) observed in production multi-agent groups.

## Success Criteria
1. ✅ All High-severity findings (SP1-SP5) implemented and tested
2. ✅ Echo loops eliminated via siblingPhones + group auto-respond fixes
3. ✅ 3454 tests passing (up from 3366)
4. ✅ TypeScript: 0 errors
5. Pending: Load test verification
6. ✅ Connection exhaustion → process.exit(1), systemd restarts

## Source
- Q audit: 26 findings — `docs/superpowers/specs/2026-04-05-phase6-agent-layer-hardening-design.md`
- L audit: 20 additional findings (C1-C2 critical, H1-H6 high, M1-M7 medium, 5 low)
- Agent behavior audit: echo loops, siblingPhones empty, group auto-respond misconfigured

## Phase Log
| Phase | Started | Status |
|-------|---------|--------|
| Normalize | 2026-04-05 | complete |
| Frame (audit) | 2026-04-05 | complete (Q: 26 findings, L: 20 findings) |
| Architect (spec) | 2026-04-05 | complete (13 SPs across 3 tiers) |
| Config fixes | 2026-04-05 | complete (siblingPhones, group auto-respond, phantom service) |
| Execute 6A | 2026-04-05 | **complete** (L: SP1-SP5 all merged to main) |
| Execute 6B | 2026-04-05 | **complete** (L: SP6-SP8, SEC1, SEC3 merged; Q: mention fix) |
| Execute 6C | 2026-04-05 | **complete** (L: SP12 observability merged) |
| Deploy | 2026-04-05 | **complete** — all 6 instances restarted with fixes |
| Synthesize | — | in_progress — remaining items to verify |

## Bead Manifest

### Phase 6A — Stability (CRITICAL)
| Bead | Type | Status | Runner | Commit |
|------|------|--------|--------|--------|
| SP1-ingest-backpressure | implement | **merged** | L | ingest.ts semaphore + overflow queue |
| SP2-connection-exit | implement | **merged** | L | process.exit(1) after 2 exhaustion cycles |
| SP3-queue-caps | implement | **merged** | L | TurnQueue maxDepth with rejection |
| SP4-admin-replay-throttle | implement | **merged** | L | replayedIds dedup + throttle delay |
| SP5-relay-guardrails | implement | **merged** | L | config gate + payload size cap |

### Phase 6A-config — Agent Behavior Fixes
| Bead | Type | Status | Runner | Notes |
|------|------|--------|--------|-------|
| CFG1-sibling-phones | config | **complete** | Q | All 6 instances configured |
| CFG2-group-auto-respond | config | **complete** | Q | Removed from all multi-agent groups |
| CFG3-phantom-service | ops | **complete** | Q | whatsoup@18454179470 stopped |
| CFG4-mention-lid-fix | implement | **merged** | Q | LID-aware formatMentions (cfc03b6) |

### Phase 6B — Correctness
| Bead | Type | Status | Runner | Commit |
|------|------|--------|--------|--------|
| SP6-ratelimit-split | implement | **merged** | L | dfb2e47 |
| SP7-message-types | implement | **merged** | L | 2b81a94 |
| SP8-media-hardening | implement | **merged** | L | 2b81a94 |
| SP9-scheduler-media | implement | pending | — | BLOB storage deferred |
| SP10-fleet-hardening | implement | pending | — | Config validation deferred |
| SP11-socket-isolation | implement | pending | — | Per-connection context deferred |

### Phase 6B-security — Net-New Security Findings (from L's audit)
| Bead | Type | Status | Runner | Commit |
|------|------|--------|--------|--------|
| SEC1-path-traversal | implement | **merged** | L | dfb2e47 |
| SEC2-fts-injection | implement | pending | — | FTS5 sanitization |
| SEC3-ssrf-dns | implement | **merged** | L | 2b81a94 |
| SEC4-reconnect-backoff | implement | **merged** | L | via SP2 exhaustion logic |
| SEC5-exhausted-race | implement | **merged** | L | via SP2 exhaustion logic |

### Phase 6C — Observability + Tests
| Bead | Type | Status | Runner | Commit |
|------|------|--------|--------|--------|
| SP12-observability-pack | implement | **merged** | L | dfb2e47 (LRU, error sanitize) |
| SP13-test-coverage | implement | partial | L | 3454 tests passing |

## Remaining Items (5 of 23 beads)
| Bead | Priority | Effort | Notes |
|------|----------|--------|-------|
| SP9-scheduler-media | Medium | Medium | BLOB storage + size cap + retention |
| SP10-fleet-hardening | Medium | Small | Config validation in discovery |
| SP11-socket-isolation | Medium | Medium | Per-connection session context |
| SEC2-fts-injection | Medium | Small | FTS5 MATCH sanitization |
| SP13-test-coverage | Low | Small | Tests for relay, admin replay, control-plane |

## Workers
- **Q**: Orchestrator. Audit, spec, config fixes, mention fix, coordination, review.
- **L**: Primary implementer. SP1-SP8, SP12, SEC1, SEC3-5, anti-echo, usage-limit suppression.

## Key Artifacts
- Phase 6 spec: `docs/superpowers/specs/2026-04-05-phase6-agent-layer-hardening-design.md`
- This state file: `docs/sdlc/active/agent-layer-hardening-20260405/state.md`
- Key commits: dfb2e47, 2b81a94, 65d6847, f0a38ff, cfc03b6
