# Config Cluster — Specification

## Scope
This specification scopes the config-labeled issue cluster (`label:config`). The config cluster covers configuration-surface concerns: how the application loads, validates, surfaces, and audits its configuration at startup, runtime, and across restarts.

## Open Issues

| Issue | Priority | Title |
|---|---|---|
| #2572 | P1 | reliability(memory): startup readiness and context failures remain invisible to health |
| #2552 | P4 | docs(artifacts): fixed global error/readiness ledgers are stale and collision-prone |
| #2535 | P2 | reliability(recovery): restart-loop guard health hides state failure and ignores configured threshold |

## Desired Outcomes

### 1. Config-Visible Health (addresses #2572)
- Startup readiness is visible to the health endpoint before any work begins
- Configuration parse failures are surfaced with structured error codes (not silent fallbacks)
- Missing or invalid config values emit `CONFIG_MISSING` / `CONFIG_INVALID` health events
- Context initialization failures are attributed to the specific config key that caused them

### 2. Non-Stale Artifact Ledgers (addresses #2552)
- Error and readiness ledgers carry a monotonic generation counter
- Consumers can detect stale ledger entries via generation mismatch
- Ledger collision (two writers for same key) is detected and surfaced as `LEDGER_COLLISION`
- Ledger format is versioned for forward/backward compatibility

### 3. Honest Restart-Loop Guard (addresses #2535)
- The restart-loop guard reports its CONFIGURED threshold, not a hardcoded default
- When state failure is detected, the guard emits the failure reason before restarting
- The guard accepts a configurable threshold (not hardcoded N)
- Health endpoint exposes: `restart_guard_threshold`, `restart_count`, `last_restart_reason`

## Integration
- Config cluster work intersects with:
  - **bot-errors cluster** (PR #2658, #2649, #2639): structured error codes for config failures
  - **reliability cluster** (PR #2659, #2652): durable receipts for config-aware health
  - **health beacon** (#1422, closed): the health endpoint that consumes config visibility
  - **portability cluster** (PR #2638, #2640): config paths that must be portable

## Ring-Based Enforcement (pattern from #2625)
| Ring | Check | Failure |
|---|---|---|
| Ring 0 | Pre-commit: config schema validates against a type definition | Commit rejected |
| Ring 1 | CI lint: config defaults exist for every key; no silent undefined | CI fails |
| Ring 2 | Deploy: config schema is bundled in the deploy artifact | Deploy fails |
| Ring 3 | Health: startup config parse errors are visible in health.json | Health warns |

