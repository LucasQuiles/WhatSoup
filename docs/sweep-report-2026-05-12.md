# Sweep Report - 2026-05-12

**Baseline:** `origin/main` at `2c31aa82` (`test(console): cover SummaryTab provider KPI card`)

**Scope:** artifact sweep, feature sweep, central tracking audit, GitHub issue/PR reconciliation, and targeted registry repair.

**Live queue note:** GitHub issue/PR tables in this report are a dated reconciliation snapshot from the sweep, not a current queue. Run `gh issue list` and `gh pr list --state open` for live state.

**Closed note:** Access-mode registry / validation-set duplication entries below
were superseded by PR #369 at commit `9b828823` after this sweep snapshot. Keep
the rows as historical evidence, not current actionability.

**Method:** three independent specialist reviews plus controller verification against the codebase. Findings below are recorded only when they were verified against current files, generated indexes, or GitHub state. Masked or environment-only failures are treated as inconclusive.

## Central Tracking Surfaces

| Surface | Role | Sweep finding | Action in this branch |
|---|---|---|---|
| `docs/work-index.json` / `docs/work-index.md` | Generated canonical registry for scoped SDLC/superpowers/plans markdown | Primary registry is present and guarded, but one status row was misclassified because explanatory text contained a later status word. | Fixed scanner and regenerated index. |
| `docs/current-program.md` | Human narrative over the generated work index | Useful but manually maintained; static counts can drift. | Added this sweep report as the latest refresh reference. |
| `docs/canonical-status-policy.md` | Status vocabulary and policy | Still authoritative for status meanings. | No change needed. |
| `docs/work-index-repair-matrix.md` | Historical normalization repair matrix | Historical/supporting surface, not current queue truth. | No change needed. |
| `docs/duplicates-report.md` | Duplicate-code backlog from the dedup sweep | Still contains actionable and already-completed items; not integrated into the generated work index. | Keep as historical evidence and issue-conversion input; live items must be promoted before execution. |
| `.tmup-artifacts/dedup-triage-021.md` | Prior dedup triage artifact | Classifies duplicate-report items as done, partial, or pending, but lives outside the generated registry. | Keep as historical evidence and issue-conversion input; live items must be promoted before execution. |
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

Open issue state as of 2026-05-12 09:13Z, preserved as historical sweep evidence:

| Issue | State | Coverage |
|---|---|---|
| none | Closed | No open GitHub issues remain after PR `#401` closed `#393`. |

Recently closed or covered workstreams:

| Workstream | Evidence |
|---|---|
| `#349` `mcp: stream outbound media instead of buffering whole file` | Closed after sweep by merged PR `#371`. |
| `#353` `transport: wire isDurableEventKind into dispatch path` | Closed after sweep by merged PR `#365`. |
| `#363` `agent: honor HTTP provider apiKeyService config` | Closed after sweep by merged PR `#370`; duplicate PR `#367` closed. |
| `#364` `docs: clarify typing_update is not a refetch invalidation` | Closed after sweep by merged PR `#368`; duplicate PR `#366` closed. |
| `#348` Tailwind warning cleanup | Closed by merged PR `#360`. |
| `#352` provider KPI on summary | Closed by merged PR `#361`; provider display code and direct test are on current main. |
| `#376` dependency pinning README claim | Closed by merged PR `#381` (`cd018ce5`). |
| `#377` README Fleet API table | Closed by merged PR `#384` (`43db13a3`). |
| `#378` console Mock Mode fallback claim | Closed by merged PR `#383` (`10c0459f`). |
| `#382` Line Detail scheduled/groups guide status | Closed by merged PR `#388` (`1c60ffd6`). |
| `#385` health token mutation scope docs | Closed by merged PR `#387` (`e04ea9f`). |
| `#389` direct typing health endpoint auth | Closed by merged PR `#395` (`703a489e`). |
| `#390` MCP read-tool limit bounds | Closed by merged PR `#399` (`79fce765`). |
| `#391` workspace MCP config symlink writes | Closed by merged PR `#396` (`24002d11`). |
| `#393` root fleet token query-string removal plan | PR `#397` (`57a7c6d1`) adds one-shot `http_legacy_token_path` warnings and docs; PR `#401` (`f9427b4e`) sets removal date to 2026-06-30 and closes the issue. |
| Private config write | PR `#374` merged at `6c18169d` (`6c18169dee0ddcb69c180d22043058d080a92f3b`). |
| `#251` LID conflict reporting | PR series landed through `#344`; latest LID conflict docs event work also landed. |
| `#324` work-index scanner | `#340` merged. |
| `#331` Node matrix CI | `#338` merged. |
| `#332` transcription coverage | `#341` merged. |
| Console guide metrics refresh | `#358` merged into current baseline. |
| Tailwind warning cleanup | `#360` merged into current baseline. |
| Provider KPI direct coverage | `#361` merged into current baseline. |

Ready-for-review PRs: none as of 2026-05-12 09:13Z. Draft PR details from that sweep are intentionally not maintained here; use `gh pr list --state open --draft` for the live draft queue.

## Verified Findings

| Finding | Severity | Verdict | Evidence | Remediation path |
|---|---|---|---|---|
| Memory migration mappings | Critical claim, false positive | Not actionable | `src/config-memory-migration.ts` already maps `recencyHalfLifeDays` and `maxAgeDays`; `tests/scripts/migrate-memory-config.test.ts` covers the migration. | No PR. Keep closed. |
| Private config write | High | Merged via PR `#374` | `src/main.ts` wrote an instance `config.json` update with string encoding only; private-write tests covered other paths, not this intro-sent write. | PR `#374` merged at `6c18169d` with a private intro-sent config writer plus direct mode/symlink regression coverage. |
| Provider KPI missing | Critical claim, false positive | Not actionable | `console/src/components/line-detail/SummaryTab.tsx` already computes and displays provider; `tests/console/summary-tab-provider-card.test.ts` exists on current main. | No new feature PR. |
| Disconnect policy consolidation | High | Covered by updated draft PR `#297` | `src/transport/auth.ts` and `src/transport/connection.ts` carried separate disconnect decision logic; connection path adds flapping behavior. | PR `#297` now routes both call sites through the shared policy and adds explicit restart-required flapping policy coverage. |
| Access-mode constant reuse | High | Closed / superseded | Snapshot finding: `src/config.ts` had a local `VALID_ACCESS_MODES` set while `src/core/agent-config-validator.ts` exported the canonical set through `src/instance-loader.ts`. Superseded by PR `#369` at `9b828823`. | No new action from this historical report. |
| Direct validator coverage | High | Actionable | `src/core/agent-config-validator.ts` has direct validation logic but no `tests/core/agent-config-validator.test.ts`; route tests cover it indirectly. | Add direct validator contract tests. |
| Root fleet token query-string auth | Medium | Removal plan defined; issue `#393` closed | `src/fleet/index.ts` still accepts root fleet token `?token=` during the deprecation window; PR `#397` warns once per server lifetime on successful query-token HTTP auth, and PR `#401` publishes `removeAfter: "2026-06-30"`. | Execute the removal after 2026-06-30; prefer query credentials only for scoped tickets/SSE constraints. |

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

1. Disconnect policy consolidation: covered by updated draft PR `#297`; do not duplicate while that PR is active.
2. Access-mode constant reuse: superseded by merged PR `#369` at `9b828823`; do not duplicate from this historical report.
3. Direct validator coverage: covered by draft PR `#372`; do not duplicate while that PR is active.
4. Root fleet token query-string removal execution: schedule after the documented 2026-06-30 deadline; no open issue remains today.

Recently merged PRs `#360`, `#361`, `#365`, `#368`, `#370`, `#371`, `#374`, `#381`, `#383`, `#384`, `#387`, `#388`, `#392`, `#395`, `#396`, `#397`, `#399`, and `#401` should not be duplicated.

## Follow-Up Registry Work

- Treat `docs/duplicates-report.md` plus `.tmup-artifacts/dedup-triage-021.md` as historical evidence and issue-conversion input. Promote any still-actionable dedup item to a GitHub issue or indexed `docs/sdlc` / `docs/superpowers` artifact before treating it as active work.
- Consider a generated GitHub issue/PR reconciliation section in `docs/current-program.md`; manual tables drift quickly.
- Run artifact sweep apply mode only after an operator-approved retention policy for session logs, task bundles, memories, and historical plans.
