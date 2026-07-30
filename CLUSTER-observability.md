# observability & console consolidation Cluster

> Draft consolidation PR — 15 uncorrelated issues
> Created 2026-07-30 20:51 UTC

## Goal
Consolidate and resolve uncorrelated observability metrics, logs, fleet health, and console rendering issues.

## Constituent Issues

| # | Tier | Title |
|---|---|---|
| #2341 | P1 | observability: add success-based cadence health for scheduled release-proof prod |
| #2387 | P1 | observability: model irreversible turn outcomes as immutable events instead of r |
| #2447 | P1 | observability: runtime, durability, health, and alert taxonomies lack a canonica |
| #2458 | P1 | observability: release-drift launchd logs are timestamp-free, uncorrelated, and  |
| #2503 | P1 | observability: tree-provenance --fetch can clear from stale refs after refresh f |
| #2197 | P2 | observability: detect unanswered inbound and finalization-leak episodes without  |
| #2518 | P2 | observability(logs): tail truncation, parse loss, and invented timestamps masque |
| #2523 | P2 | observability(console): health cause and confidence are discarded or rendered as |
| #2525 | P2 | observability(feed): minute-bucket dedupe drops occurrences and client event key |
| #2526 | P2 | observability(logs): millisecond truncation and mutable-text collapse corrupt ch |
| #2527 | P2 | observability(console): live-session storage read failures render as no live ses |
| #2529 | P2 | observability(console): per-line metric availability is discarded as zero or no  |
| #2530 | P2 | observability(console): chat and message query failures render as valid empty hi |
| #2531 | P2 | observability(console): deployment reads can fail while the surface reports heal |
| #2282 | P3 | observability(dispatcher): bind storm digests to immutable membership snapshots |

## Status
- All issues: untiered audit passed, P* labels present
- No existing PR closes or mentions these issues
- This PR serves as a tracking consolidation; implementation to follow

---
*Assigned to qpi-lab2 for review, cluster refinement, and implementation.*