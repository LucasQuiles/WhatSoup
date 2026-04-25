# Baseline Test Failures — Updated 2026-04-25 @ df6d07f (jsx-fix)

| Field | Value |
|---|---|
| Snapshot date | 2026-04-25 |
| Cited SHA | `df6d07f` (original snapshot anchor: `29a0baf` on `main`) |
| Status | Groups A + C resolved by jsx-runtime fix (hoisted console deps to root devDependencies + fixed vitest.config.ts aliases). Group B remains open. |
| Drift detection | Invoked via `scripts/check-baseline-test-drift.sh` |
| Cleanup pointers | `docs/superpowers/specs/2026-04-25-instance-loader-fixture-fix.md` |
| Failure categories | Group B (instance-loader fixture) — only remaining open category |

---

## Summary

| Error class | Count | Affected files |
|---|---|---|
| `ENOENT instances/loops/instance.json` | 1 | 1 |
| **Total** | **1** | **1** |

---

## Group B — `instance-loader` fixture missing

| Field | Value |
|---|---|
| Test file | `tests/instance-loader.test.ts` |
| Test description | `loadInstance — loops instance config > loads the loops instance.json from repo and validates correctly` |
| Expected fixture path | `/Users/q/LAB/WhatSoup/instances/loops/instance.json` |
| Why it's missing | `instances/*/instance.json` is intentionally `.gitignore`d (line 33 in the repo's `.gitignore`) because real configs hold phone numbers and API keys. The test was written against a developer-machine-local config and was never adapted with a sanitized fixture. |

---

## Drift detection format

The blocks below are the canonical machine-readable form consumed by `scripts/check-baseline-test-drift.sh`. The `baseline-failures` block contains one `<test_file_path>::<test_description>` tuple per line (named-test failures). The `collection-failures` block contains one file path per line (file-level collection failures).

```baseline-failures
tests/instance-loader.test.ts::loadInstance — loops instance config > loads the loops instance.json from repo and validates correctly
```

```collection-failures
```

---

## Cleanup

This baseline file should be updated (rows removed from Group B and the `baseline-failures` block) when the instance-loader fixture spec lands its fix. Once all groups are empty, this file should be deleted.
