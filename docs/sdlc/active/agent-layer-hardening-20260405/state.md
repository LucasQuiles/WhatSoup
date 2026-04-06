# Task: Agent Layer Hardening (Phase 6)

**ID:** agent-layer-hardening-20260405
**Created:** 2026-04-05
**Status:** in_progress
**Profile:** BUILD
**Complexity:** complicated
**Cynefin:** complicated
**Parent task:** whatsapp-mcp-features (completed phases 1-5)

## Objective
Harden the WhatsApp agent layer across stability, safety, correctness, and observability. Close 26+ audit findings from the Phase 6 code audit plus 20 additional findings from L's deep explorer pass. Fix agent behavioral issues (echo loops, lost context, config gaps) observed in production multi-agent groups.

## Success Criteria
1. All High-severity findings (SP1-SP5) implemented and tested
2. Echo loops eliminated via siblingPhones + group auto-respond fixes
3. All existing 3366+ tests pass + new tests for hardened paths
4. TypeScript: 0 errors
5. Load test: 200-message burst → no OOM, bounded concurrency
6. Connection exhaustion → process exits, systemd restarts

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
| Execute 6A | 2026-04-05 | in_progress (L implementing SP1-SP5) |
| Execute 6B | — | pending |
| Execute 6C | — | pending |
| Synthesize | — | pending |
| Deploy | — | pending |

## Bead Manifest

### Phase 6A — Stability (CRITICAL)
| Bead | Type | Status | Runner | Branch |
|------|------|--------|--------|--------|
| SP1-ingest-backpressure | implement | in_progress | L | TBD |
| SP2-connection-exit | implement | in_progress | L | TBD |
| SP3-queue-caps | implement | in_progress | L | TBD |
| SP4-admin-replay-throttle | implement | in_progress | L | TBD |
| SP5-relay-guardrails | implement | in_progress | L | TBD |

### Phase 6A-config — Agent Behavior Fixes
| Bead | Type | Status | Runner | Notes |
|------|------|--------|--------|-------|
| CFG1-sibling-phones | config | complete | Q | All 6 instances configured |
| CFG2-group-auto-respond | config | complete | Q | Removed from all multi-agent groups |
| CFG3-phantom-service | ops | complete | Q | whatsoup@18454179470 stopped |

### Phase 6B — Correctness (pending 6A)
| Bead | Type | Status | Runner | Branch |
|------|------|--------|--------|--------|
| SP6-ratelimit-split | implement | pending | TBD | — |
| SP7-message-types | implement | pending | TBD | — |
| SP8-media-hardening | implement | pending | TBD | — |
| SP9-scheduler-media | implement | pending | TBD | — |
| SP10-fleet-hardening | implement | pending | TBD | — |
| SP11-socket-isolation | implement | pending | TBD | — |

### Phase 6B-security — Net-New Security Findings (from L's audit)
| Bead | Type | Status | Runner | Notes |
|------|------|--------|--------|-------|
| SEC1-path-traversal | implement | pending | TBD | H3: unsanitized fileName extension |
| SEC2-fts-injection | implement | pending | TBD | H4: raw user input in FTS5 MATCH |
| SEC3-ssrf-dns | implement | pending | TBD | H5: DNS rebind bypass in link preview |
| SEC4-reconnect-backoff | implement | pending | TBD | C1: restartRequired tight loop |
| SEC5-exhausted-race | implement | pending | TBD | C2: handleExhausted self-race |

### Phase 6C — Observability + Tests (pending 6B)
| Bead | Type | Status | Runner | Branch |
|------|------|--------|--------|--------|
| SP12-observability-pack | implement | pending | TBD | — |
| SP13-test-coverage | implement | pending | TBD | — |

## Workers
- **Q**: Orchestrator. Audit, spec, config fixes, coordination, review.
- **L**: Primary implementer. 6A code changes (SP1-SP5), parallel agent execution.

## Key Artifacts
- Phase 6 spec: `docs/superpowers/specs/2026-04-05-phase6-agent-layer-hardening-design.md`
- This state file: `docs/sdlc/active/agent-layer-hardening-20260405/state.md`
