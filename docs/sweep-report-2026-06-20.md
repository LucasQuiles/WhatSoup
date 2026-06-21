# Sweep Report - 2026-06-20

**Baseline:** `main` at `0d9c65e1c7c302d136ee846886ad25ca75c0a205`
(`fix(substrate): use json_extract for delivered-notification throttle (#1311)`).

**Scope:** artifact-sweep dry run, feature-sweep source map, scattered artifact
cleanup, work-index recanonicalization, and stale current-program pruning.

## Artifact Sweep

Run:

```bash
<artifact-sweep-skill>/scripts/run-sweep.sh --project <repo-root> --format json
```

Local run output for the cleanup pass lives under `.sweep/20260620T162919Z/`.
The final residual dry run lives under `.sweep/20260620T165121Z/`. Both are
intentionally ignored by git.

| Metric | Count |
|---|---:|
| Matched artifacts | 1,898 |
| Report-only residuals | 1,999 |
| Low-confidence report-only artifacts | 1,913 |
| Memories | 44 |
| Plans | 42 |
| Session logs | 1,782 |
| Specs | 23 |
| Task bundles | 7 |

| Source | Count |
|---|---:|
| Claude memory | 41 |
| Claude plans | 30 |
| Claude session logs | 1,580 |
| Claude task dirs | 7 |
| Codex memory | 3 |
| Codex session logs | 202 |
| Project-local docs | 35 |

Decision: do not run broad `--apply`. The dry run matched canonical planning
docs under `docs/specs` and `docs/superpowers`, and
`docs/runbooks/objective-tracking.md` requires an explicit narrow allowlist plus
backup evidence before deleting or relocating originals.

## Narrow Cleanup

The cleanup allowlist was limited to untracked, ignored local-only files under
`artifacts/` and `.codex/`.

| Action | Evidence |
|---|---|
| Archived 163 local-only files | `.sweep/20260620T162919Z/local-ignored-artifacts.tar.gz` |
| Recorded exact archived paths | `.sweep/20260620T162919Z/local-ignored-artifacts.txt` |
| Preserved tracked evidence files | `git ls-files artifacts` still reports 70 tracked files |

The archive is intentionally not committed; it is local backup evidence for the
pruned ignored artifacts.

## Canonicalization

| Artifact | Change |
|---|---|
| `docs/superpowers/plans/2026-06-16-handoff-distiller-wiring.md` | Promoted into the indexed planning set and given a parseable `Status: completed` marker. |
| `docs/specs/2026-06-16-handoff-distiller-wiring-design.md` | Promoted into the tracked internal spec set. |
| Historical `docs/superpowers/*` rows | Normalized 13 stale unknown-status rows with explicit `completed`, `closed`, or supersession metadata. |
| `docs/work-index.json` / `docs/work-index.md` | Regenerated from the current tree. |
| `docs/current-program.md` | Rewritten to remove stale May queue tables and point to current generated counts. |
| `docs/project-map.md` | Added as the current source/docs/feature ownership map. |

Generated work-index result after recanonicalization:

| Status | Count |
|---|---:|
| completed | 30 |
| deferred | 7 |
| pending | 1 |
| closed | 4 |
| active | 0 |

No indexed artifact remains in `unknown`; stale historical rows now carry
authored status metadata and supersession pointers where applicable.

## Feature Sweep

The feature sweep remapped source roots to canonical docs rather than relying on
old planning prose. The durable map now lives in `docs/project-map.md`.

Key observed surfaces:

| Surface | Evidence |
|---|---|
| MCP tools | 20 documented modules under `src/mcp/tools/` plus helper factories; `docs/tools.md` records 162 total tools. |
| Agent runtime | 50 TypeScript files under `src/runtimes/agent/`, including handoff distiller, fallback, polls, media, and response registry. |
| Console primitives | 25 primitive TSX components under `console/src/components/primitives/`. |
| Fleet control plane | `src/fleet/routes/`, health polling, WebSocket, realtime events, credentials, ops, and update checks. |
| Guard surface | package scripts wire doc drift, public-surface drift, work-index, publication, test-integrity, boundary, service-unit, and typecheck gates. |

## Residual Gaps And Sprawl

This refresh did not remove every residual. The remaining items below are either
owner-decision items, intentionally deferred history, ignored local scratch/build
output, or separately tracked refactor debt.

| Residual | Evidence | Disposition |
|---|---|---|
| Pending transport design | `docs/work-index.json` has one `pending` row: `docs/superpowers/specs/2026-04-25-transport-layer-design.md`. | Needs owner disposition: complete, defer, close, or supersede. |
| Deferred fleet-charts cluster | The work index has seven deferred fleet-charts rows and one cross-tree topic cluster between the SDLC state and superpowers plan. | Intentional historical sprawl. Keep until an owner decides whether to collapse it into one state artifact. |
| Broad artifact-sweep residual | `.sweep/20260620T165121Z/manifest.json` reports 1,898 matched artifacts, 1,999 report-only residuals, and 1,913 low-confidence artifacts; project-local matches still include 35 canonical docs. | Do not broad-apply. Any global plan, memory, or session cleanup needs a narrow allowlist plus backup evidence. |
| Ignored local proof/cache/build output | Ignored inventory still includes `.hypothesis`, `.pytest_cache`, `.sweep`, `coverage`, `dist`, root/tool `node_modules`, deploy cache output, and `memory.db`. | Local-only. Do not commit. Optional cleanup can prune caches and older sweep runs after the proof window closes. |
| Ignored experiment doc | `docs/experiments/handoff-seam-results.md` is ignored and untracked. | Decide whether to promote it into tracked docs or archive it under sweep output. |
| Code-level dedup backlog | `docs/reviews/code-quality-dedup-simplify-20260619/state.md` remains `pending` with counts `duplication=31`, `reuse-gap=6`, `dead-code=5`, and `simplification=4`. | Canonical refactor-debt queue; not resolved by documentation canonicalization. |
| UI/design duplication backlog | `docs/design-system/00-inventory/duplication-register.md`, `docs/design-system/00-inventory/inconsistency-register.md`, and `docs/design-system/06-implementation/design-debt-register.md` still name button, status/mode, dropdown, formatting, card, bottom-sheet, and forward-kit residuals. | Canonical design backlog. Do not duplicate these items into ad hoc plans. |
| Product and IA gaps | `docs/design-system/00-inventory/ia-workflow-review.md` still names instance grouping, the rule engine, a fully unified cross-instance inbox, and budget-vs-consumption tracking as open or partial. | Product backlog, not docs drift. |
| Sweep-run retention | Local ignored sweep evidence currently has three run dirs: `.sweep/20260618T033446Z`, `.sweep/20260620T162919Z`, and `.sweep/20260620T165121Z`. | Keep while validating this refresh; prune old run dirs later if no longer useful. |

## Verification

Final focused verification for this documentation refresh:

| Check | Result |
|---|---|
| `npm run guard:doc-drift` | passed |
| `npm run guard:public-surface-drift` | passed |
| `npm run guard:work-index` | passed |
| `npm run guard:publication:all` | passed |
| `npm run guard:publication:staged` | passed |
| `npm run guard:repo:staged` | passed |
| `git diff --cached --check` | passed |
| `hypothesis-runtime ledger gate .hypothesis/ledger.json --json` | passed |

An earlier README wording attempt failed `guard:doc-drift` because the guard
parses the parenthetical module count in the MCP reference row. The README now
uses the guarded wording: 162 tools across 20 documented modules plus the
inline runtime tool.
