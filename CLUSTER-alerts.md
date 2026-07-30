# Alerts Recovery Cluster

> Draft consolidation PR — 41 uncorrelated issues
> Created 2026-07-30 20:49 UTC

## Goal
Consolidate and resolve uncorrelated alerts issues across incident lifecycle, recovery-clear, flap detection, delivery retries, and fleet sentinel domains.

## Constituent Issues

| # | Tier | Title |
|---|---|---|
| #2147 | P1 | alerts: make fault-taxonomy source-policy coverage explicit and mechanically com |
| #2373 | P1 | alerts: preserve maintenance severity and fail visibly when the sink rejects an  |
| #2388 | P1 | alerts: provider_unknown_terminal is incorrectly declared auth_terminal and carr |
| #2390 | P1 | alerts: standing incidents can auto-close while recovery proof is still pending |
| #2393 | P1 | alerts: flap-storm consolidation re-pages critical on a fixed 30-minute cadence  |
| #2417 | P1 | alerts: forbidden-target trigger retirement lacks recovery and failed-emission o |
| #2419 | P1 | alerts: relay_host_recovered does not close surfaced relay_host_down incidents |
| #2420 | P1 | alerts: remote writefail harvest clears before the failed record recovers |
| #2421 | P1 | alerts: meta dead-letter incident never closes after final audited disposition |
| #2422 | P1 | alerts: runner drops launch exceptions before durable failure emission |
| #2424 | P1 | alerts: accepted notifications can replay after crash before dispatcher state co |
| #2425 | P1 | alerts: deadman records rejected notifications as sent and failed recovery as re |
| #2426 | P1 | alerts: browser-debug visibility loss falsely clears active unattended-session i |
| #2428 | P1 | alerts: flap detector counts delivery retries as distinct fault trips |
| #2469 | P1 | alerts: fatal selfcheck runs leave the prior central heartbeat healthy, then deg |
| #2471 | P1 | alerts: fleet-sentinel remediation and escalation outbox has no consumer |
| #2473 | P1 | alerts: sequential sentinel sweep can publish a stale, incoherent aggregate snap |
| #2483 | P1 | alerts: deadman and watchdog treat freshly failed dispatcher cycles as healthy |
| #2507 | P1 | alerts: lossy incident-key normalization lets distinct sources suppress or clear |
| #2510 | P1 | alerts: capture-only sink is production-reachable while reporting durably queued |
| #2399 | P2 | alerts: fallback prerequisite incidents have no contributor-aware recovery lifec |
| #2402 | P2 | alerts: daily-health member alerts and recovery clears use divergent incident id |
| #2403 | P2 | alerts: flush and retry pending stale-autoclose digests without requiring anothe |
| #2405 | P2 | alerts: clear remote-writefail-ack-failed after all remote ack failures recover |
| #2406 | P2 | alerts: substrate-inline-hook incidents never clear after verified database reco |
| #2407 | P2 | alerts: operator-actionable runtime tool failures are auto-closed as self-correc |
| #2409 | P2 | alerts: connected health degradation is blanket-downgraded without cause-aware i |
| #2412 | P2 | alerts: pinecone_degraded lacks contributor-aware recovery across operations |
| #2413 | P2 | alerts: auth-terminal recovery clears only the quarantine symptom and orphans th |
| #2414 | P2 | alerts: outbound_flood can lose lifecycle ownership on failed emission or sustai |
| #2415 | P2 | alerts: scheduler de-link hold latches before delivery and never clears on relin |
| #2416 | P2 | alerts: llm_total_failure conflates failed chat turns with proven all-route outa |
| #2429 | P2 | alerts: destructive state replacement can orphan active incident lifecycles |
| #2430 | P2 | alerts: recovered-before-delivery suppression drops daily-health freshness |
| #2431 | P2 | alerts: heartbeat watchdog clears incidents outside conclusively evaluated scope |
| #2434 | P2 | alerts: failed legacy fallback is throttled into a false success |
| #2435 | P2 | alerts: dispatcher retries accepted email fallbacks and dead-letters them as und |
| #2437 | P2 | alerts: malformed delivery metadata permanently blocks the dispatcher queue |
| #2438 | P2 | alerts: sentinel reports a capped action-outbox depth when pruning fails |
| #2439 | P2 | alerts: verbose event formatting truncates evidence and requested action |
| #2474 | P2 | alerts: unlink-after-unlock splits sentinel/selfcheck advisory locks |

## Sub-Clusters

### Incident Recovery & Clear
- Issues where recovery proof does not close the surfaced incident
- Restart-lost recovery authority; per-conversation vs asset-level identity

### Flap-Storm & Deduplication
- Delivery retries counted as distinct fault trips
- Fixed-cadence re-paging; stale aggregate snapshots

### Deadman & Watchdog Integrity
- Zero/unknown check counts treated as healthy
- Freshly-failed dispatcher cycles passed as green

### Fleet Sentinel
- Undeployed sentinel with missing authoritative fleet health
- Advisories that never clear after remediation

## Status
- All issues: untiered audit passed, P* labels present
- No existing PR closes or mentions these issues
- This PR serves as a tracking consolidation; implementation to follow

---
*Assigned to qpi-lab2 for review, cluster refinement, and implementation.*