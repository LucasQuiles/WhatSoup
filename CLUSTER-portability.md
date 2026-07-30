# portability cross-platform consolidation Cluster

> Draft consolidation PR — 15 uncorrelated issues
> Created 2026-07-30 20:52 UTC

## Goal
Consolidate and resolve uncorrelated cross-platform path, binary, and flag portability issues.

## Constituent Issues

| # | Tier | Title |
|---|---|---|
| #2258 | P2 | portability: /proc/self/fd read has no platform gate — FD health metric silently |
| #2625 | P2 | design: cross-platform portability enforcement system (ring rules, guard, CI) |
| #2259 | P3 | portability: mktemp -t flag is GNU-deprecated and semantically different on BSD/ |
| #2616 | P3 | portability: hardcoded /usr/bin/git path in CI security scripts breaks on macOS |
| #2617 | P3 | portability: XDG directory convention used on macOS instead of ~/Library/Applica |
| #2621 | P3 | portability: systemctl calls in Python deploy scripts have no macOS launchctl fa |
| #2622 | P3 | portability: shell scripts use GNU-only flags incompatible with macOS BSD equiva |
| #2623 | P3 | portability: /proc filesystem reads in health-check.py raise OSError on macOS |
| #2296 | P4 | portability/fragility: console/ directory audit — 6 MED (Linux-only XDG paths in |
| #2297 | P4 | portability/fragility: deploy/ directory audit — 4 HIGH (repo-path hardcode, mac |
| #2299 | P4 | portability: tools/ + plugins/ + phonectl/ audit — HIGH: qsesh hard-refuses Linu |
| #2301 | P4 | test-portability: hardcoded /tmp paths + shared hardcoded mock paths (~45 files) |
| #2322 | P5 | portability/fragility: src/transport/ audit — 2 HIGH (Linux-only /var/run lock,  |
| #2323 | P5 | portability/fragility: src/mcp + src/memory + src/lib audit — 3 MED (incident-br |
| #2353 | P5 | test-portability: verify:push:branch suite flakes on ≤4-core hardware (maxWorker |

## Status
- All issues: untiered audit passed, P* labels present
- No existing PR closes or mentions these issues
- This PR serves as a tracking consolidation; implementation to follow

---
*Assigned to qpi-lab2 for review, cluster refinement, and implementation.*