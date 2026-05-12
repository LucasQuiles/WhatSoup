# Sweep Report - 2026-05-12

**Baseline:** `origin/main` at `2c31aa82` (`test(console): cover SummaryTab provider KPI card`)

**Scope:** artifact sweep, feature sweep, central tracking audit, GitHub issue/PR reconciliation, and targeted registry repair.

**Method:** three independent specialist reviews plus controller verification against the codebase. Findings below are recorded only when they were verified against current files, generated indexes, or GitHub state. Masked or environment-only failures are treated as inconclusive.

## Central Tracking Surfaces

| Surface | Role | Sweep finding | Action in this branch |
|---|---|---|---|
| `docs/work-index.json` / `docs/work-index.md` | Generated canonical registry for scoped SDLC/superpowers/plans markdown | Primary registry is present and guarded, but one status row was misclassified because explanatory text contained a later status word. | Fixed scanner and regenerated index. |
| `docs/current-program.md` | Human narrative over the generated work index | Useful but manually maintained; static counts can drift. | Added this sweep report as the latest refresh reference. |
| `docs/canonical-status-policy.md` | Status vocabulary and policy | Still authoritative for status meanings. | No change needed. |
| `docs/work-index-repair-matrix.md` | Historical normalization repair matrix | Historical/supporting surface, not current queue truth. | No change needed. |
| `docs/duplicates-report.md` | Duplicate-code backlog from the dedup sweep | Still contains actionable and already-completed items; not integrated into the generated work index. | Listed as a secondary backlog requiring owner triage. |
| `.tmup-artifacts/dedup-triage-021.md` | Prior dedup triage artifact | Classifies duplicate-report items as done, partial, or pending, but lives outside the generated registry. | Listed as a secondary evidence surface requiring owner triage. |
| GitHub issues / PRs | Current externally visible queue | Open issues and PRs remain the live execution queue. | Reconciled below. |

## Artifact Sweep

The artifact sweep was run in dry-run/report mode only. No artifact deletion or relocation was applied.

| Metric | Count |
|---|---:|
| Matched artifacts | 1621 |
| Report-only artifacts | 6819 |
| Low-confidence artifacts | 789 |
| Beads | 250 |
| Memories | 98 |
| Plans | 96 |
| Session logs | 1122 |
| Specs | 39 |
| Tasks / bundles | 16 |

The dry-run result confirms there is enough historical material to justify a separate artifact retirement pass, but this branch only records the inventory outcome and registry findings.

## GitHub Reconciliation

Open issue state at sweep time:

| Issue | State | Coverage |
|---|---|---|
| `#349` `mcp: stream outbound media instead of buffering whole file` | Closed after sweep | PR `#371` merged. |
| `#353` `transport: wire isDurableEventKind into dispatch path` | Closed after sweep | PR `#365` merged. |
| `#363` `agent: honor HTTP provider apiKeyService config` | Closed after sweep | PR `#370` merged; duplicate PR `#367` closed. |
| `#364` `docs: clarify typing_update is not a refetch invalidation` | Closed after sweep | PR `#368` merged; duplicate PR `#366` closed. |
| `#348` Tailwind warning cleanup | Closed | PR `#360` merged. |
| `#352` provider KPI on summary | Closed | PR `#361` merged; provider display code and direct test are on current main. |

Recently closed or covered workstreams:

| Workstream | Evidence |
|---|---|
| `#251` LID conflict reporting | PR series landed through `#344`; latest LID conflict docs event work also landed. |
| `#324` work-index scanner | `#340` merged. |
| `#331` Node matrix CI | `#338` merged. |
| `#332` transcription coverage | `#341` merged. |
| Console guide metrics refresh | `#358` merged into current baseline. |
| Tailwind warning cleanup | `#360` merged into current baseline. |
| Provider KPI direct coverage | `#361` merged into current baseline. |

Draft PRs still open at sweep time: `#256`, `#271`, `#272`, `#281`, `#286`, `#293`, `#297`.

## Verified Findings

| Finding | Severity | Verdict | Evidence | Remediation path |
|---|---|---|---|---|
| Memory migration mappings | Critical claim, false positive | Not actionable | `src/config-memory-migration.ts` already maps `recencyHalfLifeDays` and `maxAgeDays`; `tests/scripts/migrate-memory-config.test.ts` covers the migration. | No PR. Keep closed. |
| Private config write | High | Covered by branch `fix/private-config-write-mode-20260512` | `src/main.ts` wrote an instance `config.json` update with string encoding only; private-write tests covered other paths, not this intro-sent write. | Branch adds a private intro-sent config writer plus direct mode/symlink regression coverage. |
| Provider KPI missing | Critical claim, false positive | Not actionable | `console/src/components/line-detail/SummaryTab.tsx` already computes and displays provider; `tests/console/summary-tab-provider-card.test.ts` exists on current main. | No new feature PR. |
| Disconnect policy consolidation | High | Actionable | `src/transport/auth.ts` and `src/transport/connection.ts` still carry separate disconnect decision logic; connection path adds flapping behavior. | Extract shared disconnect decision policy with explicit flapping branch tests. |
| Access-mode constant reuse | High | Actionable | `src/config.ts` has a local `VALID_ACCESS_MODES` set while `src/core/agent-config-validator.ts` exports the canonical set through `src/instance-loader.ts`. | Import the canonical set and keep validation messages stable. |
| Direct validator coverage | High | Actionable | `src/core/agent-config-validator.ts` has direct validation logic but no `tests/core/agent-config-validator.test.ts`; route tests cover it indirectly. | Add direct validator contract tests. |

## Registry Repair Applied

The work-index scanner previously treated this status text as `pending`:

```md
**Status:** unknown — stalled at SPEC stage; never became an SDLC epic. Kept for historical reference. _Originally marked "SPEC — team consensus pending"._
```

That violated the status policy because the leading explicit status token should win. This branch adds a regression test and changes the normalizer so leading policy vocabulary is authoritative before fallback text scanning.

Generated index effect:

| Metric | Before | After |
|---|---:|---:|
| Pending rows | 39 | 38 |
| Unknown rows | 17 | 18 |

The affected row is `docs/superpowers/plans/2026-04-05-phase5-analytics-observability.md`, now correctly listed under unknown-status triage.

## Recommended PR Queue

1. Private config write: covered by branch `fix/private-config-write-mode-20260512`; do not duplicate while that branch is active.
2. Disconnect policy consolidation: extract helper and test restart-required/flapping semantics.
3. Access-mode constant reuse: covered by draft PR `#369`; do not duplicate while that PR is active.
4. Direct validator coverage: covered by draft PR `#372`; do not duplicate while that PR is active.

Recently merged PRs `#360`, `#361`, `#365`, `#368`, `#370`, and `#371` should not be duplicated.

## Follow-Up Registry Work

- Decide whether `docs/duplicates-report.md` plus `.tmup-artifacts/dedup-triage-021.md` should become live work-index rows or remain historical evidence.
- Consider a generated GitHub issue/PR reconciliation section in `docs/current-program.md`; manual tables drift quickly.
- Run artifact sweep apply mode only after an operator-approved retention policy for session logs, task bundles, memories, and historical plans.
