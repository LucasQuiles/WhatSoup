# Code-Quality & Cleanup Consolidation

> Draft consolidation PR — 23 uncorrelated issues
> Created 2026-07-30

## Goal
Consolidate and resolve remaining standalone code-quality, dead-code removal, documentation, and housekeeping issues.

## Sub-Clusters

### Tech-Debt Refactor (13 issues)
- #2190 [P4] 240 bare catch{} blocks — ESLint no-empty enforcement
- #2191 [P4] 30+ as any/as unknown SQLite casts — typed wrappers
- #2193 [P3] ?? vs || vs truthiness inconsistency across codebase
- #2205 [P4] 37 test files copy-paste tmpDirs/mkdtempSync/afterEach
- #2211 [P4] 26 hand-rolled typeof+trim non-empty-string checks
- #2212 [P3] ValidationError and ExtractionError byte-identical shapes
- #2213 [P3] get*/load*/fetch* DB-read prefix inconsistent in 52 fns
- #2215 [P3] loadOrCreateFleetTokens exported from 2 files
- #2219 [P3] 81 PNG files (~4.7 MB) in git under artifacts/ and doc/
- #2224 [P4] verify:* push-gate pipelines are single-line ~4KB strings
- #2225 [P4] 0-byte decoy instance DBs mislead operator audits
- #2249 [P3] CircuitState triple-duplication across 3 files
- #2250 [P3] getInboundStatus widens to string — escape hatch

### Dead Code Removal (5 issues)

- #2194 [P5] 4 resolve*Config functions in config.ts — zero callers
- #2195 [P5] auth-loss-mode-bucket-producer-artifact.ts — 0 importers
- #2196 [P5] isLoggedOutStatusCode — zero external callers
- #2218 [P3] @deprecated symbols with zero callers — doc/code lies
- #2327 [P4] SaveContactDialog dead code after v3.5 removal

### Documentation Cleanup (4 issues)

- #2536 [P4] provenance: replace unresolved lane-artifact references
- #2547 [P4] lifecycle: completed artifacts remain executable-looking
- #2551 [P4] transport: stable error registry needs operator runbooks
- #2552 [P4] artifacts: stale global error/readiness ledgers

### Miscellaneous (1 issue)

- #2222 [P3] SSOT: fitness ratchet ceilings are hand-maintained twins

## Constituent Issues

| # | Tier | Title |
|---|---|---|
| #2190 | P4 | 240 bare catch{} blocks — ESLint no-empty enforcement |
| #2191 | P4 | 30+ as any/as unknown SQLite casts — typed wrappers |
| #2193 | P3 | ?? vs || vs truthiness inconsistency across codebase |
| #2205 | P4 | 37 test files copy-paste tmpDirs/mkdtempSync/afterEach |
| #2211 | P4 | 26 hand-rolled typeof+trim non-empty-string checks |
| #2212 | P3 | ValidationError and ExtractionError byte-identical shapes |
| #2213 | P3 | get*/load*/fetch* DB-read prefix inconsistent in 52 fns |
| #2215 | P3 | loadOrCreateFleetTokens exported from 2 files |
| #2219 | P3 | 81 PNG files (~4.7 MB) in git under artifacts/ and doc/ |
| #2224 | P4 | verify:* push-gate pipelines are single-line ~4KB strings |
| #2225 | P4 | 0-byte decoy instance DBs mislead operator audits |
| #2249 | P3 | CircuitState triple-duplication across 3 files |
| #2250 | P3 | getInboundStatus widens to string — escape hatch |
| #2194 | P5 | 4 resolve*Config functions in config.ts — zero callers |
| #2195 | P5 | auth-loss-mode-bucket-producer-artifact.ts — 0 importers |
| #2196 | P5 | isLoggedOutStatusCode — zero external callers |
| #2218 | P3 | @deprecated symbols with zero callers — doc/code lies |
| #2327 | P4 | SaveContactDialog dead code after v3.5 removal |
| #2536 | P4 | provenance: replace unresolved lane-artifact references |
| #2547 | P4 | lifecycle: completed artifacts remain executable-looking |
| #2551 | P4 | transport: stable error registry needs operator runbooks |
| #2552 | P4 | artifacts: stale global error/readiness ledgers |
| #2222 | P3 | SSOT: fitness ratchet ceilings are hand-maintained twins |

## Status
- All issues: tier audit passed, P* labels present
- These are the final uncorrelated orphans — standalone housekeeping tasks
- No existing PR addresses any of these

---
*Assigned to qpi-lab2 for review and implementation.*