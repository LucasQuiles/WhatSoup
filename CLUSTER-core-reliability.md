# Core Reliability & Remaining P1/P2 Cluster

> Draft consolidation PR — 19 uncorrelated P1/P2 issues
> Created 2026-07-30 21:27 UTC

## Goal
Consolidate and resolve remaining uncorrelated P1/P2 issues: BOT ERRORS heartbeat/watchdog integrity, agent session safety, iMessage events, substrate beads lifecycle, ops rollout proof, and transport fragility.

## Sub-Clusters

### BOT ERRORS Watchdog & Heartbeat (P1)
- #2459 Terminal relay archive retention
- #2460 Queue backlog vs watchdog disagreement
- #2465 Zero/unknown check → false-green health
- #2466 No macOS heartbeat-watchdog schedule
- #2461 Split contract docs from stale history

### Agent & Session Safety (P1/P2)
- #2354 Extended fallback → dropped replay-safe turns
- #2357 Slash-prefixed human directive bodies lost
- #2235 Liveness decisions not generation-safe

### Transport & Fragility (P2)
- #2284 imsg-port missing socket close handler
- #2288 Incident-breaker crash-safe persistence
- #2289 Transport async-rejection gaps
- #2290 Unguarded JSON.parse + UTF-8 corruption

### Operations & Recovery (P1/P2)
- #2155 Evidence-gated blocked-unsafe turn workflow
- #2189 iMessage read-receipt subscriptions
- #2384 Overdue bead proposals lifecycle
- #2467 GUI-session monitor coverage erasure
- #2481 Rollout proof vs missing health invariants
- #2486 Unavailable service inventory → empty coverage
- #2511 Restart marker suppresses real crash

## Constituent Issues

| # | Tier | Title |
|---|---|---|
| #2155 | P1 | reliability: add an evidence-gated operator workflow for blocked-unsafe turn rec |
| #2189 | P1 | iMessage: advertised read-receipt subscriptions never receive inbound events |
| #2354 | P1 | agent: extended fallback windows can drop retained replay-safe turns |
| #2357 | P1 | Preserve human directive bodies in slash-prefixed multi-line messages |
| #2459 | P1 | Terminal BOT ERRORS relay archive has no retention contract and preserves stale  |
| #2460 | P1 | Queue backlog health and watchdog disagree on event age after retries |
| #2465 | P1 | Heartbeat watchdog silently accepts zero/unknown checks and refreshes false-gree |
| #2466 | P1 | BOT ERRORS has no declared macOS heartbeat-watchdog schedule despite parity clai |
| #2467 | P1 | GUI-session monitor reports success and erases coverage when fleet inventory is  |
| #2486 | P1 | health: unavailable active-service inventory is treated as complete empty covera |
| #2511 | P1 | recovery: one-shot restart marker can suppress a real crash or lose completion o |
| #2235 | P2 | hardening(agent): make liveness decisions generation-safe and interrupt teardown |
| #2284 | P2 | fragility: imsg-port has no socket 'end'/'close' handler — pending RPCs hang 30s |
| #2288 | P2 | durability: incident-breaker and process-lock state lack validated crash-safe pe |
| #2289 | P2 | fragility: transport async-rejection and error-isolation gaps (rejectCall, pollO |
| #2290 | P2 | fragility: unguarded JSON.parse in beads + stdout UTF-8 boundary corruption in a |
| #2384 | P2 | substrate: give overdue bead proposals a bounded terminal lifecycle |
| #2461 | P2 | Split BOT ERRORS contract documentation from stale deployment and topology histo |
| #2481 | P2 | ops: rollout proof does not block live runtimes that are missing merged health i |

## Status
- All issues: tier audit passed, P* labels present
- No existing PR closes or mentions these issues
- This PR serves as a tracking consolidation; implementation to follow

---
*Assigned to qpi-lab2 for review, cluster refinement, and implementation.*