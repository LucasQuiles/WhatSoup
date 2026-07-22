# Current Program - WhatSoup

This document is the human-maintained synthesis over the generated planning
index. Treat `docs/work-index.json` and `docs/work-index.md` as the mechanical
source of truth for scoped planning artifacts.

**Last refreshed:** 2026-07-22
**Index source:** `docs/work-index.json` schema v5, generated at
`2026-07-22T10:09:01Z` from `308b08069da327ce38b16c7e0206593a5eee4529`
**Policy:** [`docs/canonical-status-policy.md`](canonical-status-policy.md)
**Review cadence:** [`docs/runbooks/objective-tracking.md`](runbooks/objective-tracking.md)
**Project map:** [`docs/project-map.md`](project-map.md)
**Latest sweep:** [`docs/sweep-report-2026-06-20.md`](sweep-report-2026-06-20.md)

Static GitHub issue and PR enumerations are intentionally not maintained here.
Use live `gh issue list` and `gh pr list --state open` output when queue state
matters.

## Current State

| Status | Count | Meaning |
|---|---:|---|
| active | 17 | Authored artifacts currently declare active work; the CI/CD control-plane initiative is the current lane normalized in this refresh. |
| pending | 15 | Authored artifacts declare pending work and require their own owner disposition. |
| completed | 32 | Historical plans/specs marked complete or landed. |
| deferred | 7 | Fleet-charts artifacts are explicitly shelved. |
| closed | 4 | Historical artifacts retained without claiming completion. |
| unknown | 5 | Five artifacts lack a policy-vocabulary status and remain visible for triage. |

The work index has 80 total rows, zero inconsistencies, five unknown-status rows, and four
cross-tree topic clusters: `design`, `fleet-charts`, `requirements`, and `tasks`.

## Canonical Surfaces

| Surface | Owner |
|---|---|
| `README.md` / `CLAUDE.md` | Entry point, runtime model, instance model, and contributor conventions. |
| `docs/project-map.md` | Current source, feature, docs, and artifact ownership map. |
| `docs/tools.md` | Generated MCP tool reference for the 162-tool surface. |
| `docs/public-surface.md` | Guarded registry for public HTTP, MCP, config, deploy, and artifact surfaces. |
| `docs/configuration.md` | Environment variables, `config.json`, XDG paths, and instance configuration. |
| `docs/runbook.md` plus `docs/runbooks/` | Operator procedures and focused runbooks. |
| `docs/work-index.*` | Generated planning registry for `docs/sdlc`, `docs/superpowers`, and `docs/plans`. |
| `docs/publication-audit.md` | Required classification table for tracked internal docs. |
| `docs/design-system/` | SOUP v3 design program, specs, inventories, and implementation evidence. |

## Feature Map

| Area | Code roots | Canonical docs |
|---|---|---|
| Bootstrap and configuration | `src/main.ts`, `src/bootstrap*.ts`, `src/config*.ts`, `src/instance-loader.ts` | `README.md`, `docs/configuration.md`, `docs/runbook.md` |
| Core data and messaging | `src/core/`, `src/lib/` | `docs/durability.md`, `docs/reply-guarantee.md`, `docs/runbook.md` |
| Transport layer | `src/transport/` | `README.md`, `docs/runbooks/twilio-transport.md`, `docs/specs/*transport*` |
| MCP tools | `src/mcp/`, `src/mcp/tools/` | `docs/tools.md`, `docs/public-surface.md` |
| Agent runtime | `src/runtimes/agent/` | `docs/runbooks/error-response-workflows.md`, `docs/runbooks/agent-decision-polls.md`, `docs/configuration.md` |
| Chat runtime and memory | `src/runtimes/chat/`, `src/memory/` | `docs/configuration.md`, `docs/explainers/byok-memory-config-migration.md` |
| Fleet control plane | `src/fleet/`, `deploy/` | `README.md`, `docs/runbook.md`, `docs/runbooks/macos-launchd-deployment.md` |
| Console | `console/src/` | `docs/console-guide.md`, `docs/design-system/README.md` |
| Guardrails and release gates | `scripts/`, `.arc/`, `.claude/fitness`, `.claude/test-integrity` | `docs/contributing/quality-guardrails-checklist.md`, `docs/architecture/fitness-taxonomy.md` |
| Substrate and reliability runner | `src/core/substrate/`, `docs/reliability-runner/` | `docs/runbooks/substrate-slice-1.md`, `docs/reliability-runner/feature-matrix.md` |

## Program Queue

### Current normalized lane

| Path | Role | State |
|---|---|---|
| `docs/superpowers/specs/2026-07-20-cicd-enforcement-control-plane-design.md` | approved architecture and evidence contract | active; implementation remains unproven |
| `docs/superpowers/plans/2026-07-20-cicd-enforcement-control-plane-program.md` | recursive dependency and trust-boundary ledger | active; future lanes require their named admission plans |
| `docs/superpowers/plans/2026-07-20-cicd-control-foundation.md` | first executable source-only plan | active; the admitted source split is staged for a hook-bound preservation checkpoint, while newly observed `main` lease work requires non-rebase integration and reassessment before exact-set verification; CP-F2f/F4/CP-TR1/F5 remain incomplete and CP-WA1 is not credited before that audit |
| `docs/superpowers/plans/2026-07-20-cicd-workflow-portability.md` | protected workflow and native portability follow-on | pending; current source has partial `merge_group` and action-pin coverage, but protected policy, exact-set gates, live queue evidence, and native portability remain incomplete |

The remaining active and pending artifacts are listed mechanically in
`docs/work-index.md`; this synthesis does not imply that they share the CI/CD initiative's
authority or priority. Deferred and closed rows remain historical. The five unknown rows
must receive an authored status or structured supersession marker before they can be
treated as complete, deferred, or active.

## Sweep Notes

The 2026-06-20 artifact sweep residual dry run matched 1,898 artifacts across
global agent logs, memories, task bundles, and project-local planning docs. A
broad sweep apply was intentionally not run: the dry-run project-local matches
include canonical docs, and `docs/runbooks/objective-tracking.md` requires a
narrow allowlist plus backup evidence before deletion.

Narrow cleanup performed during this refresh:

- promoted `docs/superpowers/plans/2026-06-16-handoff-distiller-wiring.md` into
  the indexed planning set and marked it `completed`;
- promoted `docs/specs/2026-06-16-handoff-distiller-wiring-design.md` into the
  tracked specs set;
- normalized 13 stale `unknown` rows with explicit `completed`, `closed`, or
  supersession metadata;
- archived 163 ignored, untracked local-only files from `artifacts/` and
  `.codex/` into the ignored sweep run archive.

See `docs/sweep-report-2026-06-20.md` for the detailed sweep, feature-sweep
record, and residual gap itemization. The remaining residuals are owner-decision
items, deferred historical clusters, ignored local evidence, or canonical
code/design backlog debt.

## Maintenance Rules

1. Regenerate `docs/work-index.*` with `npm run work-index:regen` after changing
   indexed planning artifacts.
2. Run `npm run guard:work-index` before claiming the planning index is clean.
3. Update `docs/publication-audit.md` when adding or removing tracked internal
   docs covered by the publication guard.
4. Keep dated queue tables out of this file unless they are explicitly marked as
   historical evidence.
5. Use `docs/project-map.md` for area ownership and feature navigation instead
   of scattering new map prose across README, runbooks, and plans.
