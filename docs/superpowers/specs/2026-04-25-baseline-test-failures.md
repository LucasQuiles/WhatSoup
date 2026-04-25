# Baseline Test Failures — Frozen 2026-04-25 @ 29a0baf

| Field | Value |
|---|---|
| Snapshot date | 2026-04-25 |
| Cited SHA | `29a0baf` (`main` branch) |
| Status | Descriptive only — no fix is implemented in this spec. |
| Drift detection | Invoked via `bash scripts/check-baseline-test-drift.sh` |
| Cleanup pointers | `docs/superpowers/specs/2026-04-25-console-test-jsx-runtime-fix.md`, `docs/superpowers/specs/2026-04-25-instance-loader-fixture-fix.md` |
| Failure categories | Group A (named-test jsx failures), Group B (instance-loader fixture), Group C (file-level collection failures) |

---

## Summary

| Error class | Count | Affected files |
|---|---|---|
| `Cannot find module 'react/jsx-dev-runtime'` (named tests) | 18 | 6 |
| `Cannot find module 'react/jsx-dev-runtime'` (collection failures) | 7 | 7 |
| `ENOENT instances/loops/instance.json` | 1 | 1 |
| **Total** | **26** | **14** |

---

## Group A — `react/jsx-dev-runtime` failures

These 18 tests fail because the Vitest environment cannot resolve `react/jsx-dev-runtime` when the test runner imports a `.tsx` component or page.

| # | Test file | Test description | Importing source file |
|---|---|---|---|
| 1 | `tests/console/chart-panel.test.ts` | `ChartPanel > renders loading shimmer when isLoading is true` | `console/src/components/ChartPanel.tsx` |
| 2 | `tests/console/chart-panel.test.ts` | `ChartPanel > renders error state with retry button` | `console/src/components/ChartPanel.tsx` |
| 3 | `tests/console/chart-panel.test.ts` | `ChartPanel > renders empty state when hasData is false` | `console/src/components/ChartPanel.tsx` |
| 4 | `tests/console/chart-panel.test.ts` | `ChartPanel > renders children when hasData is true` | `console/src/components/ChartPanel.tsx` |
| 5 | `tests/console/chart-panel.test.ts` | `ChartPanel > shows warning pill when instancesFailed > 0` | `console/src/components/ChartPanel.tsx` |
| 6 | `tests/console/line-detail-history-metrics.test.ts` | `line-detail tab components > barrel exports all expected tab components` | `console/src/components/line-detail/SummaryTab.tsx` |
| 7 | `tests/console/line-detail-history-metrics.test.ts` | `line-detail tab components > barrel exports dialog components` | `console/src/components/line-detail/SummaryTab.tsx` |
| 8 | `tests/console/line-detail-history-metrics.test.ts` | `line-detail tab components > exports exactly 10 named items` | `console/src/components/line-detail/SummaryTab.tsx` |
| 9 | `tests/console/line-detail-history-metrics.test.ts` | `ActiveHoursHeatmap > is exported from components/ActiveHoursHeatmap` | `console/src/components/ActiveHoursHeatmap.tsx` |
| 10 | `tests/console/line-detail-history-metrics.test.ts` | `LineDetail page structure > is a default export` | `console/src/pages/LineDetail.tsx` |
| 11 | `tests/console/modal-workflows.test.ts` | `AddLineWizard > is a default export (lazy-loadable)` | `console/src/components/AddLineWizard.tsx` |
| 12 | `tests/console/modal-workflows.test.ts` | `RelinkModal > is a default export (lazy-loadable)` | `console/src/components/RelinkModal.tsx` |
| 13 | `tests/console/modal-workflows.test.ts` | `ConfirmDialog > is a default export` | `console/src/components/ConfirmDialog.tsx` |
| 14 | `tests/console/nav-status.test.ts` | `Nav component > is a default export` | `console/src/components/Nav.tsx` |
| 15 | `tests/console/nav-status.test.ts` | `realtime provider exports > exports RealtimeProvider and useRealtime` | `console/src/hooks/use-websocket.tsx` |
| 16 | `tests/console/ops-actions.test.ts` | `Ops page structure > Ops component is a default export` | `console/src/pages/Ops.tsx` |
| 17 | `tests/console/ops-actions.test.ts` | `Ops page structure > imports required hooks and components` | `console/src/pages/Ops.tsx` |
| 18 | `tests/console/soup-kitchen.test.tsx` | `SoupKitchen structural composition > is exported as default` | `console/src/pages/SoupKitchen.tsx` |

---

## Group B — `instance-loader` fixture missing

| Field | Value |
|---|---|
| Test file | `tests/instance-loader.test.ts` |
| Test description | `loadInstance — loops instance config > loads the loops instance.json from repo and validates correctly` |
| Expected fixture path | `/Users/q/LAB/WhatSoup/instances/loops/instance.json` |
| Why it's missing | `instances/*/instance.json` is intentionally `.gitignore`d (line 33 in the repo's `.gitignore`) because real configs hold phone numbers and API keys. The test was written against a developer-machine-local config and was never adapted with a sanitized fixture. |

---

## Group C — File-level collection failures

These 7 test files fail at the collection stage — the entire file cannot be loaded before any individual test runs. The root cause is the same as Group A (`Cannot find module 'react/jsx-dev-runtime'`); the collection-failure manifestation occurs when ALL imports in the file fail, preventing vitest from even enumerating tests.

| # | Test file | Error class |
|---|---|---|
| 1 | `tests/console/design-system-accessibility.test.tsx` | `Cannot find module 'react/jsx-dev-runtime'` |
| 2 | `tests/console/error-boundary.test.ts` | `Cannot find module 'react/jsx-dev-runtime'` |
| 3 | `tests/console/line-detail-card-shells.test.tsx` | `Cannot find module 'react/jsx-dev-runtime'` |
| 4 | `tests/console/line-detail-mode-tab.test.ts` | `Cannot find module 'react/jsx-dev-runtime'` |
| 5 | `tests/console/nav-status.test.tsx` | `Cannot find module 'react/jsx-dev-runtime'` |
| 6 | `tests/console/search-highlight.test.ts` | `Cannot find module 'react/jsx-dev-runtime'` |
| 7 | `tests/console/structural-sharing.test.ts` | `Cannot find module 'react/jsx-dev-runtime'` |

---

## Drift detection format

The blocks below are the canonical machine-readable form consumed by `scripts/check-baseline-test-drift.sh`. The `baseline-failures` block contains one `<test_file_path>::<test_description>` tuple per line (named-test failures). The `collection-failures` block contains one file path per line (file-level collection failures). When a follow-up spec lands its fix, the corresponding rows should be removed from each block.

```baseline-failures
tests/console/chart-panel.test.ts::ChartPanel > renders loading shimmer when isLoading is true
tests/console/chart-panel.test.ts::ChartPanel > renders error state with retry button
tests/console/chart-panel.test.ts::ChartPanel > renders empty state when hasData is false
tests/console/chart-panel.test.ts::ChartPanel > renders children when hasData is true
tests/console/chart-panel.test.ts::ChartPanel > shows warning pill when instancesFailed > 0
tests/console/line-detail-history-metrics.test.ts::line-detail tab components > barrel exports all expected tab components
tests/console/line-detail-history-metrics.test.ts::line-detail tab components > barrel exports dialog components
tests/console/line-detail-history-metrics.test.ts::line-detail tab components > exports exactly 10 named items
tests/console/line-detail-history-metrics.test.ts::ActiveHoursHeatmap > is exported from components/ActiveHoursHeatmap
tests/console/line-detail-history-metrics.test.ts::LineDetail page structure > is a default export
tests/console/modal-workflows.test.ts::AddLineWizard > is a default export (lazy-loadable)
tests/console/modal-workflows.test.ts::RelinkModal > is a default export (lazy-loadable)
tests/console/modal-workflows.test.ts::ConfirmDialog > is a default export
tests/console/nav-status.test.ts::Nav component > is a default export
tests/console/nav-status.test.ts::realtime provider exports > exports RealtimeProvider and useRealtime
tests/console/ops-actions.test.ts::Ops page structure > Ops component is a default export
tests/console/ops-actions.test.ts::Ops page structure > imports required hooks and components
tests/console/soup-kitchen.test.tsx::SoupKitchen structural composition > is exported as default
tests/instance-loader.test.ts::loadInstance — loops instance config > loads the loops instance.json from repo and validates correctly
```

```collection-failures
tests/console/design-system-accessibility.test.tsx
tests/console/error-boundary.test.ts
tests/console/line-detail-card-shells.test.tsx
tests/console/line-detail-mode-tab.test.ts
tests/console/nav-status.test.tsx
tests/console/search-highlight.test.ts
tests/console/structural-sharing.test.ts
```

---

## Cleanup

This baseline file should be updated (rows removed from Groups A and B and the `baseline-failures` block) as each follow-up spec lands its fix. Once both groups are empty, this file should be deleted.
